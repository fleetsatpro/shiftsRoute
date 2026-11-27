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
