// @ts-nocheck
function quoteArg(value) {
  const text = String(value ?? '');
  if (!text) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

export function formatCommand(command, args = []) {
  return [quoteArg(command), ...args.map((arg) => quoteArg(arg))].join(' ');
}

export function logCommandStart({ source, command, args = [], cwd = '' }) {
  const line = `[cmd][${source}] start ${formatCommand(command, args)}${cwd ? ` (cwd=${cwd})` : ''}`;
  console.log(line);
}

export function logCommandEnd({ source, command, args = [], cwd = '', code, durationMs, error = '' }) {
  const normalizedCode = code === undefined || code === null ? 'unknown' : String(code);
  const status = error
    ? 'error'
    : (normalizedCode === '0' ? 'ok' : 'fail');
  const line = `[cmd][${source}] ${status} code=${normalizedCode} duration=${Math.max(0, Number(durationMs) || 0)}ms ${formatCommand(command, args)}${cwd ? ` (cwd=${cwd})` : ''}${error ? ` error=${error}` : ''}`;
  console.log(line);
}
