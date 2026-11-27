// solver.js — reference-driven, deterministic monthly roster engine.
const OFF = 'O';
const LEAVE_CODES = new Set(['L', 'PL', 'ML', 'SL']);
const WORK_CODES = new Set(['D', 'N', 'DC', 'NC', 'T', 'FSA']);
const DAY_CODES = new Set(['D', 'DC']);
const NIGHT_CODES = new Set(['N', 'NC']);

export function daysInMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
export function dateStr(yyyymm, day) {
  const [y, m] = yyyymm.split('-').map(Number);
  return y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
export function isWeekend(yyyymm, day) {
  const [y, m] = yyyymm.split('-').map(Number);
  const dow = new Date(y, m - 1, day).getDay();
  return dow === 0 || dow === 6;
}

function leaveCodeFor(value, date) {
  if (value instanceof Set) return value.has(date) ? 'L' : null;
  if (value instanceof Map) {
    const code = value.get(date);
    return code ? (LEAVE_CODES.has(code) ? code : 'L') : null;
  }
  if (Array.isArray(value)) {
    const item = value.find(entry => typeof entry === 'string' ? entry === date : entry?.date === date);
    if (!item) return null;
    const code = typeof item === 'string' ? 'L' : item.leave_type || item.shift_code || 'L';
    return LEAVE_CODES.has(code) ? code : 'L';
  }
  if (value && typeof value === 'object' && value[date]) {
    const code = value[date];
    return LEAVE_CODES.has(code) ? code : 'L';
  }
  return null;
}
function isWorkCode(code) { return WORK_CODES.has(code); }
function isDayCode(code) { return DAY_CODES.has(code); }
function isNightCode(code) { return NIGHT_CODES.has(code); }
function shiftType(code) {
  if (isNightCode(code)) return 'night';
  if (isDayCode(code)) return 'day';
  return null;
}
function fixedValue(value) {
  if (typeof value === 'string') return { shift_code: value };
  return value && typeof value === 'object' ? value : null;
}
function seededRandom(seedText) {
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return function random() {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * fixedAssignments: { [staffId]: { [YYYY-MM-DD]: {
 *   shift_code, coverage_department_id?, coverage_shift_code?
 * } } }. These are locked operational facts (training, approved relief,
 * Field Supervisor deployment), not suggestions for the optimizer.
 *
 * leaveByStaff accepts legacy Sets (L) and date=>leave-code maps (L/PL/ML/SL).
 */
export function generateSchedule({
  month, department, staff, leaveByStaff = {}, priorFinalState,
  preassignedAssignments = {}, fixedAssignments = {},
}) {
  const nDays = daysInMonth(month);
  const dayCode = department.day_code;
  const nightCode = department.night_code;
  const warnings = [];
  const state = Object.create(null);
  const assignmentMeta = Object.create(null);
  const totals = Object.create(null);
  const lockedAssignments = new Set();
  const staffById = new Map(staff.map(person => [person.id, person]));

  for (const person of staff) {
    state[person.id] = new Array(nDays + 1).fill(null);
    assignmentMeta[person.id] = Object.create(null);
    for (let day = 1; day <= nDays; day++) {
      const date = dateStr(month, day);
      const leaveCode = leaveCodeFor(leaveByStaff[person.id], date);
      if (leaveCode) state[person.id][day] = leaveCode;
    }
    const leaveCount = state[person.id].filter(code => code && LEAVE_CODES.has(code)).length;
    totals[person.id] = { total: 0, night: 0, weekend: 0, leave: leaveCount, training: 0, relief: 0 };
  }

  function actualShiftCode(staffId, day) {
    const date = dateStr(month, day);
    return assignmentMeta[staffId][date]?.coverage_shift_code || state[staffId][day];
  }
  function lastWorkInfo(staffId, day) {
    if (day === 1) {
      const prior = priorFinalState?.[staffId];
      return { prevType: prior?.lastShift || null, consecutiveWork: prior?.consecutiveWork ?? 0 };
    }
    let consecutiveWork = 0;
    for (let current = day - 1; current >= 1; current--) {
      const code = state[staffId][current];
      if (isWorkCode(code)) consecutiveWork++;
      else break;
    }
    return { prevType: shiftType(actualShiftCode(staffId, day - 1)), consecutiveWork };
  }
  const nightRestRule = (department.night_rest_rule ?? 1) === 1;

  function canPlaceFixed(person, day, value, date) {
    const code = value.shift_code || value.code;
    if (typeof code !== 'string' || !['D','N','DC','NC','T','FSA'].includes(code)) return false;
    const coverageCode = value.coverage_shift_code || code;
    const type = shiftType(coverageCode);
    if (type === 'day' && person.can_day === 0) return false;
    if (type === 'night') {
      const exception = Array.isArray(person.night_exception_dates) && person.night_exception_dates.includes(date);
      if (person.can_night === 0 && !exception) return false;
    }
    if (state[person.id][day] !== null) return false;
    const { prevType, consecutiveWork } = lastWorkInfo(person.id, day);
    if (nightRestRule && type === 'day' && prevType === 'night') return false;
    if (consecutiveWork >= (person.max_consecutive_days ?? 5)) return false;
    return true;
  }

  function applyFixed(person, date, value, sourceLabel) {
    const day = Number(date.slice(-2));
    if (!Number.isInteger(day) || day < 1 || day > nDays || date.slice(0, 7) !== month) return;
    const fixed = fixedValue(value);
    if (!fixed) return;
    if (!canPlaceFixed(person, day, fixed, date)) {
      warnings.push(department.id + ' ' + date + ': fixed ' + (fixed.shift_code || 'assignment') +
        ' for ' + (person.name || person.id) + ' conflicts with leave, another assignment, qualification or rest policy (' + sourceLabel + ')');
      return;
    }
    const code = fixed.shift_code || fixed.code;
    state[person.id][day] = code;
    assignmentMeta[person.id][date] = {
      coverage_department_id: fixed.coverage_department_id || null,
      coverage_shift_code: fixed.coverage_shift_code || null,
    };
    lockedAssignments.add(person.id + ':' + date);
    const countsAsWork = fixed.counts_as_work !== false && isWorkCode(code);
    if (countsAsWork) {
      totals[person.id].total++;
      if (isWeekend(month, day)) totals[person.id].weekend++;
      const coveredCode = fixed.coverage_shift_code || code;
      if (isNightCode(coveredCode)) totals[person.id].night++;
      if (code === 'T') totals[person.id].training++;
      if (code === 'FSA') totals[person.id].relief++;
    }
  }

  // First apply fixed date markers and approved relief deployments.
  for (const person of staff) {
    const byDate = fixedAssignments?.[person.id] || {};
    for (const [date, value] of Object.entries(byDate)) applyFixed(person, date, value, 'approved fixed assignment');
  }

  // Backward-compatible Duty Ops day cover. It is also a locked assignment.
  for (const [date, assigned] of Object.entries(preassignedAssignments || {})) {
    const day = Number(date.slice(-2));
    const personId = typeof assigned === 'string' ? assigned : assigned?.staff_id;
    const person = staffById.get(personId);
    if (!person || !Number.isInteger(day) || day < 1 || day > nDays) continue;
    if (state[personId][day] !== null) {
      warnings.push(department.id + ' ' + date + ': Duty Ops preassignment for ' + (person.name || personId) + ' conflicts with another fixed assignment');
      continue;
    }
    applyFixed(person, date, { shift_code: dayCode }, 'Duty Ops preassignment');
  }

  function coverageCount(day, shiftCode) {
    const date = dateStr(month, day);
    return staff.reduce((count, person) => {
      const code = state[person.id][day];
      const coveredCode = assignmentMeta[person.id][date]?.coverage_shift_code || code;
      return count + (coveredCode === shiftCode && (code === shiftCode || code === 'FSA') ? 1 : 0);
    }, 0);
  }
  function fairnessScore(staffId, shiftCode, day) {
    const tally = totals[staffId];
    const weekendPenalty = isWeekend(month, day) ? tally.weekend * 0.5 : 0;
    const nightPenalty = shiftCode === nightCode ? tally.night * 2 : 0;
    return tally.total - tally.leave * 0.15 + nightPenalty + weekendPenalty;
  }

  // Primary staff are allocated first. Relief-only qualifications are never
  // used as an automatic staffing fallback; approved fixed allocations only.
  for (let day = 1; day <= nDays; day++) {
    const date = dateStr(month, day);
    for (const shiftCode of [nightCode, dayCode]) {
      const isNight = shiftCode === nightCode;
      const min = isNight ? department.night_min : department.day_min;
      const max = isNight ? (department.night_max ?? min) : (department.day_max ?? min);
      const candidates = staff.filter(person => {
        if (person.relief_only === 1 || person.relief_only === true) return false;
        const qualified = isNight
          ? (person.can_night !== 0 || person.night_exception_dates?.includes(date))
          : person.can_day !== 0;
        return qualified && state[person.id][day] === null;
      }).sort((a, b) => fairnessScore(a.id, shiftCode, day) - fairnessScore(b.id, shiftCode, day) || a.id.localeCompare(b.id));

      const alreadyAssigned = coverageCount(day, shiftCode);
      if (alreadyAssigned + candidates.length < min) {
        warnings.push(department.id + ' ' + date + ': only ' + (alreadyAssigned + candidates.length) + '/' + min +
          ' available for ' + shiftCode + ' (approved relief, qualification, leave or rest constraints)');
      }
      const needed = Math.min(Math.max(0, max - alreadyAssigned), candidates.length);
      for (let i = 0; i < needed; i++) {
        const person = candidates[i];
        const { prevType, consecutiveWork } = lastWorkInfo(person.id, day);
        if (nightRestRule && shiftCode === dayCode && prevType === 'night') {
          warnings.push(department.id + ' ' + date + ': skipped ' + person.name + ' for day shift after night duty');
          continue;
        }
        if (consecutiveWork >= (person.max_consecutive_days ?? 5)) {
          warnings.push(department.id + ' ' + date + ': skipped ' + person.name + ' after maximum consecutive work days');
          continue;
        }
        state[person.id][day] = shiftCode;
        totals[person.id].total++;
        if (isNight) totals[person.id].night++;
        if (isWeekend(month, day)) totals[person.id].weekend++;
      }
    }
    for (const person of staff) {
      if (state[person.id][day] === null) state[person.id][day] = OFF;
    }
  }

  improveBalance({
    state, staff, totals, month, nDays, department, dayCode, nightCode,
    priorFinalState, lockedAssignments, assignmentMeta,
  });

  const assignments = Object.create(null);
  for (const person of staff) {
    assignments[person.id] = Object.create(null);
    for (let day = 1; day <= nDays; day++) {
      assignments[person.id][dateStr(month, day)] = state[person.id][day];
    }
  }
  return { assignments, assignmentMeta, warnings, totals };
}

function variance(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function improveBalance({
  state, staff, totals, month, nDays, department, dayCode, nightCode,
  priorFinalState, lockedAssignments = new Set(), assignmentMeta,
}) {
  const iterations = 600;
  const allIds = staff.map(person => person.id);
  const ids = staff.filter(person => !(person.relief_only === 1 || person.relief_only === true)).map(person => person.id);
  const people = new Map(staff.map(person => [person.id, person]));
  const random = seededRandom(month + '|' + department.id + '|' + ids.slice().sort().join('|'));

  function workRunValid(staffId, day) {
    const person = people.get(staffId);
    const low = Math.max(1, day - 5);
    const high = Math.min(nDays, day + 1);
    for (let current = low; current <= high; current++) {
      const code = state[staffId][current];
      if (LEAVE_CODES.has(code) || !isWorkCode(code)) continue;
      const currentDate = dateStr(month, current);
      const currentCoverage = assignmentMeta[staffId]?.[currentDate]?.coverage_shift_code || code;
      if (shiftType(currentCoverage) === 'day') {
        let previousType = null;
        if (current === 1) previousType = priorFinalState?.[staffId]?.lastShift || null;
        else {
          const previousDate = dateStr(month, current - 1);
          previousType = shiftType(assignmentMeta[staffId]?.[previousDate]?.coverage_shift_code || state[staffId][current - 1]);
        }
        if ((department.night_rest_rule ?? 1) === 1 && previousType === 'night') return false;
      }
      let run = 0;
      for (let cursor = current; cursor >= 1; cursor--) {
        if (!isWorkCode(state[staffId][cursor])) break;
        run++;
      }
      if (current === run && (priorFinalState?.[staffId]?.lastShift === 'day' || priorFinalState?.[staffId]?.lastShift === 'night')) {
        run += priorFinalState[staffId].consecutiveWork ?? 0;
      }
      if (run > (person?.max_consecutive_days ?? 5)) return false;
    }
    return true;
  }

  function coverageOk(day, code, removeId, addId) {
    let count = 0;
    const date = dateStr(month, day);
    for (const id of allIds) {
      let current = state[id][day];
      let covered = assignmentMeta[id]?.[date]?.coverage_shift_code || current;
      if (id === removeId) { current = OFF; covered = OFF; }
      if (id === addId) { current = code; covered = code; }
      if (covered === code && (current === code || current === 'FSA')) count++;
    }
    const minimum = code === dayCode ? department.day_min : department.night_min;
    return count >= minimum;
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    const baseVariance = variance(ids.map(id => totals[id].total))
      + variance(ids.map(id => totals[id].night)) * 1.5
      + variance(ids.map(id => totals[id].weekend)) * 0.5;
    if (baseVariance < 0.01) break;

    const day = 1 + Math.floor(random() * nDays);
    const scored = ids.map(id => ({
      id,
      score: totals[id].total + totals[id].night * 0.5 + totals[id].weekend * 0.25,
    })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (scored.length < 2) break;
    const busy = scored[0].id;
    const free = scored[scored.length - 1].id;
    if (busy === free) continue;

    const busyCode = state[busy][day];
    const freeCode = state[free][day];
    const date = dateStr(month, day);
    if (lockedAssignments.has(busy + ':' + date) || lockedAssignments.has(free + ':' + date)) continue;
    if ((busyCode !== dayCode && busyCode !== nightCode) || freeCode !== OFF) continue;

    const freePerson = people.get(free);
    if (freePerson?.relief_only === 1 || freePerson?.relief_only === true) continue;
    if (busyCode === dayCode && freePerson?.can_day === 0) continue;
    if (busyCode === nightCode && freePerson?.can_night === 0 && !freePerson?.night_exception_dates?.includes(date)) continue;

    state[busy][day] = OFF;
    state[free][day] = busyCode;
    if (!workRunValid(busy, day) || !workRunValid(free, day) || !coverageOk(day, busyCode, busy, free)) {
      state[busy][day] = busyCode;
      state[free][day] = freeCode;
      continue;
    }

    totals[busy].total--;
    totals[free].total++;
    const isNight = busyCode === nightCode;
    const isWeekendDay = isWeekend(month, day);
    if (isNight) { totals[busy].night--; totals[free].night++; }
    if (isWeekendDay) { totals[busy].weekend--; totals[free].weekend++; }

    const nextVariance = variance(ids.map(id => totals[id].total))
      + variance(ids.map(id => totals[id].night)) * 1.5
      + variance(ids.map(id => totals[id].weekend)) * 0.5;
    if (nextVariance >= baseVariance) {
      state[busy][day] = busyCode;
      state[free][day] = freeCode;
      totals[busy].total++;
      totals[free].total--;
      if (isNight) { totals[busy].night++; totals[free].night--; }
      if (isWeekendDay) { totals[busy].weekend++; totals[free].weekend--; }
    }
  }
}
