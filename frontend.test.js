import test from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, safeShiftCode, safeStatus } from './public/ui-utils.js';

test('HTML escaping neutralizes text and attribute metacharacters', () => {
  assert.equal(escHtml(`<img src=x onerror="alert(1)">'&`), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;');
  assert.equal(escHtml(null), '');
});

test('rendering accepts only known shift codes and status values', () => {
  for (const code of ['D', 'N', 'DC', 'NC', 'O', 'L', 'PL', 'ML', 'SL', 'T', 'FSA', 'X']) {
    assert.equal(safeShiftCode(code), code);
  }
  assert.equal(safeShiftCode('<script>'), 'UNKNOWN');
  assert.equal(safeStatus('published'), 'published');
  assert.equal(safeStatus('onmouseover=alert(1)'), 'unknown');
});

import { readFile } from 'node:fs/promises';

test('frontend is externally loaded, mobile navigable, and free of inline event handlers', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('./public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.ok(html.includes('<script type="module" src="/app.js"></script>'));
  assert.ok(html.includes('class="mobile-nav"'));
  assert.ok(html.includes('id="teamMetrics"'));
  assert.ok(html.includes('id="staffSearch"'));
  assert.ok(html.includes('class="skip-link"'));
  assert.ok(html.includes('aria-modal="true"'));
  assert.doesNotMatch(app, /\bonclick\s*=/i);
});


test('schedule renderer uses a prototype-safe staff ID dictionary', async () => {
  const app = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const byStaff = Object\.create\(null\);/);
});

test('dialogs support keyboard dismissal and focus containment', async () => {
  const app = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
  assert.match(app, /e\.key === 'Escape'/);
  assert.match(app, /e\.key === 'Tab' && openDialog/);
  assert.match(app, /first\.focus\(\)/);
  assert.match(app, /last\.focus\(\)/);
});

test('premium theme system exposes five palettes, persists selection, and respects reduced motion', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('./public/app.js', import.meta.url), 'utf8'),
  ]);
  for (const theme of ['aurora', 'obsidian', 'amethyst', 'ember', 'arctic']) {
    assert.match(html, new RegExp('value="' + theme + '"'));
    if (theme !== 'aurora') assert.ok(html.includes('[data-theme="' + theme + '"]'));
  }
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(app, /localStorage\.setItem\('shiftsroute-theme'/);
  assert.match(app, /localStorage\.getItem\('shiftsroute-theme'/);
});
