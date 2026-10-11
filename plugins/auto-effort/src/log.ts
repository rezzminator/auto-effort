// The decision log: one JSONL file per session, appended to on every write. Chats share the configured `logFile`,
// so each session writes its own file beside it; a resumed session appends to the rows it wrote before.

/** `~/` expanded to the home directory; a path that does not start with it is returned as it is. */
export function expandHome(path: string, home: string | undefined): string {
  if (path === '~' || path.startsWith('~/')) {
    if (home === undefined || home === '') throw new Error(`auto-effort: the log path ${path} needs the home directory, which is not set`);
    return home.replace(/\/+$/, '') + path.slice(1);
  }
  return path;
}

/** The session's own log path: the session id goes before the extension of `logFile`. */
export function sessionLogPath(logFile: string, sessionId: string): string {
  if (sessionId === '') throw new Error('auto-effort: empty session id; cannot name the log file');
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const slash = logFile.lastIndexOf('/');
  const dir = logFile.slice(0, slash + 1);
  const name = logFile.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${dir}${name}.${safe}`;
  return `${dir}${name.slice(0, dot)}.${safe}${name.slice(dot)}`;
}

/** The file's rows followed by `rows`, blank lines dropped, the newest `cap` kept. */
export function appendRows(existing: string, rows: string[], cap: number): string {
  const all = [...existing.split('\n').filter((line) => line.trim() !== ''), ...rows];
  return all.slice(-cap).join('\n') + '\n';
}
