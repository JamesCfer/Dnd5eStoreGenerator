/**
 * Lightweight ring buffer that captures console output for error reports.
 * Patches console.log/info/warn/error once; original methods are always called.
 */

const MAX_ENTRIES = 150;
const _entries = [];
let _patched = false;

function _format(args) {
  return args.map(a => {
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (a !== null && typeof a === 'object') {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }).join(' ');
}

export function initConsoleCapture() {
  if (_patched) return;
  _patched = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${_format(args)}`;
      _entries.push(line);
      if (_entries.length > MAX_ENTRIES) _entries.shift();
    };
  }
}

export function getConsoleLog() {
  return _entries.join('\n');
}
