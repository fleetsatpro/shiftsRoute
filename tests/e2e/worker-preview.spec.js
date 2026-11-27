import { test, expect } from '@playwright/test';

const previewPin = process.env.E2E_DEMO_PIN || '';

test.describe('real Cloudflare Worker + isolated D1 Preview', () => {
  test.skip(!process.env.E2E_BASE_URL, 'Requires the deployed Cloudflare Worker Preview URL.');

  test('serves synthetic D1 data, authenticates a real session, and renders desktop/mobile workspaces', async ({ page }, testInfo) => {
    expect(previewPin).toMatch(/^\d{6}$/);
    const isMobile = page.viewportSize().width <= 768;

    // No API route mocks: requests reach the deployed Worker and remote D1.
    await page.goto('/');
    const health = await page.evaluate(async () => {
      const response = await fetch('/api/health', { cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const options = page.locator('#personSelect option');
    await expect(options).toHaveCount(3);
    const people = await options.allTextContents();
    expect(people).toEqual(expect.arrayContaining([
      expect.stringContaining('Demo Administrator'),
      expect.stringContaining('Demo Operator'),
      expect.stringContaining('Night Controller'),
    ]));
    expect(people.join(' ')).not.toMatch(/Stephen|Charles|Daisy|Tabitha|Patrick/i);

    await page.locator('#personSelect').selectOption('e2e-admin');
    await page.locator('#pinInput').fill(previewPin);
    const loginResponsePromise = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/auth/login'
      && response.request().method() === 'POST'
    );
    await page.locator('#loginBtn').click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.status()).toBe(200);

    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#meName')).toHaveText('Demo Administrator');
    await expect(page.locator('#workspaceHero')).toBeVisible();
    await expect(page.locator('#heroDepartment')).toHaveText('ISOC');
    await expect(page.locator('#heroStaffCount')).toHaveText('3');
    await expect(page.locator('#heroAssignmentCount')).toHaveText('0');

    if (isMobile) {
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, 0);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const layout = await page.evaluate(() => {
        const bounds = selector => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        };
        return { header: bounds('#app > header'), nav: bounds('.mobile-nav'), hero: bounds('#workspaceHero') };
      });
      expect(layout.header).not.toBeNull();
      expect(layout.nav).not.toBeNull();
      expect(layout.hero).not.toBeNull();
      expect(layout.nav.top).toBeGreaterThanOrEqual(layout.header.bottom - 1);
      expect(layout.hero.top).toBeGreaterThanOrEqual(layout.nav.bottom - 1);
    }

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.screenshot({
      path: testInfo.outputPath(isMobile ? 'preview-mobile-workspace.png' : 'preview-desktop-workspace.png'),
      fullPage: false,
    });

    await page.locator(isMobile ? '.mobile-nav [data-tab="staff"]' : 'aside [data-tab="staff"]').click();
    await expect(page.locator('#tab-staff')).toBeVisible();
    await expect(page.locator('#staffTableBody tr')).toHaveCount(3);
    await page.locator('#staffSearch').fill('Demo Operator');
    await expect(page.locator('#staffTableBody tr:visible')).toHaveCount(1);
    await expect(page.locator('#staffTableBody tr:visible')).toContainText('Demo Operator');
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.screenshot({
      path: testInfo.outputPath(isMobile ? 'preview-mobile-staff.png' : 'preview-desktop-staff.png'),
      fullPage: false,
    });

    await page.locator('#logoutBtn').click();
    await expect(page.locator('#loginScreen')).toBeVisible();
    const sessionStatus = await page.evaluate(async () => {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      return response.status;
    });
    expect(sessionStatus).toBe(401);
  });
});
