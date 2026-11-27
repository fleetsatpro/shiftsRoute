export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeShiftCode(value) {
  return ['D', 'N', 'DC', 'NC', 'O', 'L', 'PL', 'ML', 'SL', 'T', 'FSA', 'X'].includes(value) ? value : 'UNKNOWN';
}

export function safeStatus(value) {
  return ['draft', 'published', 'pending', 'approved', 'rejected'].includes(value) ? value : 'unknown';
}
