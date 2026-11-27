import test from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, safeShiftCode, safeStatus } from './public/ui-utils.js';

test('HTML escaping neutralizes text and attribute metacharacters', () => {
  assert.equal(escHtml(`<img src=x onerror="alert(1)">'&`), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;');
  assert.equal(escHtml(null), '');
});

test('rendering accepts only known shift codes and status values', () => {
  for (const code of ['D', 'N', 'DC', 'NC', 'O', 'L']) assert.equal(safeShiftCode(code), code);
  assert.equal(safeShiftCode('<script>'), 'O');
  assert.equal(safeStatus('published'), 'published');
  assert.equal(safeStatus('onmouseover=alert(1)'), 'unknown');
});
