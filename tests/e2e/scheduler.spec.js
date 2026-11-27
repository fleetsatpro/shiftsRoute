import { test, expect } from '@playwright/test';

const admin = { id: 'admin-1', name: 'Test Admin', department_id: 'ISOC', role: 'admin' };
const staff = [
  { id: 'admin-1', name: 'Test Admin', department_id: 'ISOC', role: 'admin', pin_set: 1 },
  { id: 'staff-2', name: 'Test Operator', department_id: 'ISOC', role: 'staff', pin_set: 1 },
  { id: 'staff-3', name: 'Night Controller', department_id: 'ISOC', role: 'staff', pin_set: 1 },
];

async function installIsolatedApi(page, role = 'admin') {
  let authenticated = false;
  let loginAttempts = 0;
  const currentUser = role === 'admin' ? admin : {
    id: 'staff-2', name: 'Test Operator', department_id: 'ISOC', role: 'staff',
  };

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/auth/me' && method === 'GET') {
      if (!authenticated) {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentUser) });
      }
      return;
    }
    if (path === '/api/auth/people' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staff) });
      return;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      loginAttempts++;
      authenticated = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (path === '/api/staff' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staff) });
      return;
    }
    if (path === '/api/leave' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }
    if (path === '/api/schedules' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }
    if (path === '/api/swap-requests' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  return { getLoginAttempts: () => loginAttempts };
}

test('login screen loads directory and rejects a malformed PIN before network login', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await page.goto('/');
  await expect(page.getByLabel('Who are you?')).toContainText('Test Admin');
  await page.locator('#pinInput').fill('123');
  await page.locator('#loginBtn').click();
  await expect(page.locator('#loginError')).toContainText('exactly 6 digits');
  expect(api.getLoginAttempts()).toBe(0);
  await expect(page.locator('#loginScreen')).toBeVisible();
});

test('admin can sign in, navigate to staff management, and filter the directory at each viewport', async ({ page }, testInfo) => {
  await installIsolatedApi(page, 'admin');
  const isMobile = page.viewportSize().width <= 768;
  await page.goto('/');
  await page.locator('#pinInput').fill('123456');
  await page.locator('#loginBtn').click();

  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#meName')).toHaveText('Test Admin');
  await expect(page.locator('#tab-team')).toBeVisible();

  await page.locator(isMobile ? '.mobile-nav [data-tab="staff"]' : 'aside [data-tab="staff"]').click();
  await expect(page.locator('#tab-staff')).toBeVisible();
  await expect(page.locator('#staffTableBody tr')).toHaveCount(3);

  await page.locator('#staffSearch').fill('Night Controller');
  await expect(page.locator('#staffTableBody tr:visible')).toHaveCount(1);
  await expect(page.locator('#staffTableBody tr:visible')).toContainText('Night Controller');

  if (isMobile) {
    await expect(page.locator('aside')).toBeHidden();
    await expect(page.locator('.mobile-nav')).toBeVisible();
    await expect(page.locator('.mobile-nav')).toHaveCSS('display', 'flex');
    const tableScroller = page.locator('#tab-staff .panel > div');
    await expect.poll(() => tableScroller.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('admin-mobile-staff-directory.png'), fullPage: true });
    await tableScroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await expect.poll(() => tableScroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await expect(page.locator('#staffTableBody tr:visible button').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('admin-mobile-staff-actions.png'), fullPage: true });
  } else {
    await expect(page.locator('aside')).toBeVisible();
    await expect(page.locator('.mobile-nav')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('admin-desktop-staff-directory.png'), fullPage: true });
  }
});

test('staff account cannot see admin navigation or privileged controls', async ({ page }) => {
  await installIsolatedApi(page, 'staff');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.locator('#pinInput').fill('123456');
  await page.locator('#loginBtn').click();

  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#meName')).toHaveText('Test Operator');
  await expect(page.locator('aside [data-tab="team"]')).toBeHidden();
  await expect(page.locator('aside [data-tab="staff"]')).toBeHidden();
  await expect(page.locator('#generateBtn')).toBeHidden();
  await expect(page.locator('#publishBtn')).toBeHidden();
  await expect(page.locator('#tab-mine')).toBeVisible();
});
