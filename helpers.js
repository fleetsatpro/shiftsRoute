import { daysInMonth, dateStr } from './solver.js';

export function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function csvCell(value) {
  let text = String(value ?? '');
  // Spreadsheet applications may execute cells beginning with formula
  // markers. Prefix dangerous user-controlled values before CSV quoting.
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(assignments, month) {
  const dayCount = daysInMonth(month);
  const byStaff = Object.create(null);
  for (const row of assignments) {
    if (!byStaff[row.staff_id]) {
      byStaff[row.staff_id] = {
        name: row.staff_name,
        department_id: row.roster_department_id || row.department_id,
        home_department_id: row.home_department_id || row.department_id,
        days: {},
      };
    }
    byStaff[row.staff_id].days[row.date] = row.shift_code === 'FSA'
      && row.coverage_department_id && row.coverage_shift_code
      ? 'FSA:' + row.coverage_department_id + '/' + row.coverage_shift_code
      : row.shift_code;
  }

  const header = ['Department', 'Staff', 'Home Team', ...Array.from({ length: dayCount }, (_, i) => dateStr(month, i + 1))];
  const lines = [header.map(csvCell).join(',')];
  for (const staffId of Object.keys(byStaff)) {
    const { name, department_id, home_department_id, days } = byStaff[staffId];
    const row = [department_id, name, home_department_id];
    for (let d = 1; d <= dayCount; d++) row.push(days[dateStr(month, d)] || '');
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n');
}
