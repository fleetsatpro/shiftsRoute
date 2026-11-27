import test from 'node:test';
import assert from 'node:assert/strict';
import { daysInMonth, dateStr, generateSchedule } from './solver.js';

const dept = {
  id: 'TEST', day_code: 'D', night_code: 'N',
  day_min: 1, day_max: 1, night_min: 1, night_max: 1,
  night_rest_rule: 1, weekend_staffed: 1,
};

test('calendar helpers handle leap years and zero padding', () => {
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(daysInMonth('2025-02'), 28);
  assert.equal(dateStr('2026-03', 4), '2026-03-04');
});

test('month boundary: a prior-month night worker is not assigned day shift on day one', () => {
  const staff = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const result = generateSchedule({
    month: '2026-07',
    department: dept,
    staff,
    leaveByStaff: {},
    priorFinalState: { a: { lastShift: 'night', consecutiveWork: 1 } },
  });
  assert.notEqual(result.assignments.a['2026-07-01'], 'D');
});

test('month boundary: balancing cannot reintroduce a night-to-day violation', () => {
  const staff = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` }));
  const result = generateSchedule({
    month: '2026-07',
    department: { ...dept, day_min: 2, day_max: 2, night_min: 2, night_max: 2 },
    staff,
    leaveByStaff: {},
    priorFinalState: { s0: { lastShift: 'night', consecutiveWork: 1 } },
  });
  assert.notEqual(result.assignments.s0['2026-07-01'], 'D');
});

test('schedule contains exactly one assignment per staff/day and valid shift codes', () => {
  const staff = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` }));
  const result = generateSchedule({
    month: '2026-04',
    department: dept,
    staff,
    leaveByStaff: { s0: new Set(['2026-04-03']) },
  });
  for (const person of staff) {
    assert.equal(Object.keys(result.assignments[person.id]).length, 30);
    for (const code of Object.values(result.assignments[person.id])) {
      assert.ok(['D', 'N', 'O', 'L'].includes(code));
    }
  }
});


test('solver never assigns a night shift to day-only technical support', () => {
  const staff = [
    { id: 'a', can_day: 1, can_night: 0 },
    { id: 'b', can_day: 1, can_night: 1 },
    { id: 'c', can_day: 1, can_night: 1 },
    { id: 'd', can_day: 1, can_night: 1 },
  ];
  const result = generateSchedule({
    month: '2026-07',
    department: { ...dept, day_min: 1, day_max: 1, night_min: 1, night_max: 1 },
    staff,
    leaveByStaff: {},
  });
  assert.ok(Object.values(result.assignments.a).every(code => code !== 'N'));
});

test('solver honors configurable maximum consecutive work days', () => {
  const staff = [
    { id: 'a', can_day: 1, can_night: 0, max_consecutive_days: 2 },
    { id: 'b', can_day: 1, can_night: 1, max_consecutive_days: 5 },
    { id: 'c', can_day: 1, can_night: 1, max_consecutive_days: 5 },
    { id: 'd', can_day: 1, can_night: 1, max_consecutive_days: 5 },
  ];
  const result = generateSchedule({
    month: '2026-07',
    department: { ...dept, day_min: 1, day_max: 1, night_min: 1, night_max: 1 },
    staff,
    leaveByStaff: {},
  });
  let streak = 0;
  for (const code of Object.values(result.assignments.a)) {
    if (code === 'D' || code === 'N') streak++;
    else streak = 0;
    assert.ok(streak <= 2, 'day-only support exceeds configured work streak');
  }
});


test('exception-only night eligibility is limited to explicitly approved dates', () => {
  const staff = [
    { id: 'wayne', can_day: 1, can_night: 0, night_exception_dates: ['2026-07-01'] },
    { id: 'b', can_day: 1, can_night: 1 },
    { id: 'c', can_day: 1, can_night: 1 },
    { id: 'd', can_day: 1, can_night: 1 },
  ];
  const result = generateSchedule({
    month: '2026-07',
    department: { ...dept, day_min: 1, day_max: 1, night_min: 1, night_max: 1 },
    staff,
    leaveByStaff: {},
  });
  const nights = Object.entries(result.assignments.wayne).filter(([, code]) => code === 'N').map(([date]) => date);
  assert.ok(nights.every(date => date === '2026-07-01'));
});


test('approved Duty Ops team-cover assignment is fixed in the generated roster', () => {
  const staff = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, can_day: 1, can_night: 1 }));
  const result = generateSchedule({
    month: '2026-07',
    department: { ...dept, day_min: 2, day_max: 2, night_min: 2, night_max: 2 },
    staff,
    leaveByStaff: {},
    preassignedAssignments: { '2026-07-01': 's0' },
  });
  assert.equal(result.assignments.s0['2026-07-01'], 'D');
});

test('reference roster preserves typed leave, trainee time and Field Supervisor relief', () => {
  const staff = [
    { id: 'alpha', name: 'Alpha', can_day: 1, can_night: 1, max_consecutive_days: 5 },
    { id: 'trainee', name: 'Trainee', can_day: 1, can_night: 1, max_consecutive_days: 5 },
    { id: 'field', name: 'Clinton Juma', can_day: 1, can_night: 1, max_consecutive_days: 5, relief_only: 1 },
  ];
  const result = generateSchedule({
    month: '2026-12',
    department: { id: 'ISOC', day_code: 'D', night_code: 'N', day_min: 1, day_max: 1, night_min: 1, night_max: 1, night_rest_rule: 1 },
    staff,
    leaveByStaff: { alpha: new Map([['2026-12-04', 'PL'], ['2026-12-05', 'ML'], ['2026-12-06', 'SL']]) },
    fixedAssignments: {
      trainee: { '2026-12-04': { shift_code: 'T' } },
      field: { '2026-12-05': { shift_code: 'FSA', coverage_department_id: 'ISOC', coverage_shift_code: 'N' } },
    },
  });
  assert.equal(result.assignments.alpha['2026-12-04'], 'PL');
  assert.equal(result.assignments.alpha['2026-12-05'], 'ML');
  assert.equal(result.assignments.alpha['2026-12-06'], 'SL');
  assert.equal(result.assignments.trainee['2026-12-04'], 'T');
  assert.equal(result.assignments.field['2026-12-05'], 'FSA');
  assert.equal(result.assignmentMeta.field['2026-12-05'].coverage_shift_code, 'N');
  assert.ok(result.totals.trainee.total >= 1, 'training counts as working time');
  assert.ok(result.totals.field.relief >= 1, 'Field Supervisor duty is reported separately');
});

test('relief-only cross-qualified staff are never used for routine fallback', () => {
  const result = generateSchedule({
    month: '2026-12',
    department: { id: 'ISOC', day_code: 'D', night_code: 'N', day_min: 1, day_max: 1, night_min: 0, night_max: 0, night_rest_rule: 1 },
    staff: [
      { id: 'primary', can_day: 0, can_night: 0, relief_only: 0 },
      { id: 'borrowed', can_day: 1, can_night: 1, relief_only: 1 },
    ],
  });
  assert.equal(result.assignments.borrowed['2026-12-01'], 'O');
  assert.ok(result.warnings.some(warning => warning.includes('0/1 available')));
});

test('fixed relief allocation is explicit and prevents a second regular shift on that date', () => {
  const result = generateSchedule({
    month: '2026-12',
    department: { id: 'ISOC', day_code: 'D', night_code: 'N', day_min: 1, day_max: 1, night_min: 0, night_max: 0 },
    staff: [
      { id: 'primary', can_day: 1, can_night: 1 },
      { id: 'borrowed', can_day: 1, can_night: 1, relief_only: 1 },
    ],
    fixedAssignments: { borrowed: { '2026-12-01': { shift_code: 'D', coverage_department_id: 'ISOC', coverage_shift_code: 'D' } } },
  });
  assert.equal(result.assignments.borrowed['2026-12-01'], 'D');
  assert.equal(result.assignments.primary['2026-12-01'], 'O');
});
