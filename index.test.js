import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv, isValidCalendarDate, isValidMonth } from './helpers.js';

test('calendar validation rejects impossible and malformed dates/months', () => {
  assert.equal(isValidCalendarDate('2026-11-27'), true);
  assert.equal(isValidCalendarDate('2026-02-29'), false);
  assert.equal(isValidCalendarDate('2026-2-09'), false);
  assert.equal(isValidCalendarDate('not-a-date'), false);
  assert.equal(isValidMonth('2026-11'), true);
  assert.equal(isValidMonth('2026-13'), false);
  assert.equal(isValidMonth('2026-1'), false);
});

test('CSV export quotes fields and neutralizes spreadsheet formulas', () => {
  const csv = buildCsv([
    { staff_id: 's1', staff_name: '=HYPERLINK("https://evil.test","click")', department_id: '+CMD', date: '2026-11-01', shift_code: 'D' },
    { staff_id: 's2', staff_name: 'Normal, Name', department_id: 'SCE', date: '2026-11-01', shift_code: 'N' },
    { staff_id: 's3', staff_name: 'Cross Desk', roster_department_id: 'ISOC', home_department_id: 'SCE', date: '2026-11-02', shift_code: 'FSA', coverage_department_id: 'ISOC', coverage_shift_code: 'D' },
  ], '2026-11');
  assert.ok(csv.includes('"\'=HYPERLINK(""https://evil.test"",""click"")"'));
  assert.ok(csv.includes('"\'+CMD"'));
  assert.ok(csv.includes('"Normal, Name"'));
  assert.ok(csv.includes('"ISOC","Cross Desk","SCE"'));
  assert.ok(csv.includes('"FSA:ISOC/D"'));
  assert.ok(csv.startsWith('"Department","Staff","Home Team","2026-11-01"'));
});
