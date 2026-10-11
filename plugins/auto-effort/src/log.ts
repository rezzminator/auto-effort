// The decision log: JSONL, one file per session, a new numbered file after every SEGMENT_ROWS rows. Chats share the
// configured `logFile`, so each session writes its own files beside it; a resumed session appends to its newest file.

/** `~/` expanded to the home directory; a path that does not start with it is returned as it is. */
export function expandHome(path: string, home: string | undefined): string {
  if (path === '~' || path.startsWith('~/')) {
    if (home === undefined || home === '') throw new Error(`auto-effort: the log path ${path} needs the home directory, which is not set`);
    return home.replace(/\/+$/, '') + path.slice(1);
  }
  return path;
}

/**
 * File `segment` (1, 2, ...) of the session's own log: the session id goes before the extension of `logFile`, and from
 * the second file on a number follows it (`decisions.<session>.2.jsonl`).
 */
export function sessionLogPath(logFile: string, sessionId: string, segment = 1): string {
  if (sessionId === '') throw new Error('auto-effort: empty session id; cannot name the log file');
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const part = segment > 1 ? `${safe}.${segment}` : safe;
  const slash = logFile.lastIndexOf('/');
  const dir = logFile.slice(0, slash + 1);
  const name = logFile.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${dir}${name}.${part}`;
  return `${dir}${name.slice(0, dot)}.${part}${name.slice(dot)}`;
}

/** Rows one log file holds before the next file starts. */
export const SEGMENT_ROWS = 1000;

/**
 * The files to write after `rows` join the newest file `segment` (its text is `existing`): that file filled to `cap`
 * rows, then as many new files as the rest needs. `$.fs` has no append, so a write rewrites its whole file; the cap
 * bounds that. Blank lines are dropped.
 */
export function fillSegments(existing: string, segment: number, rows: string[], cap: number): Array<{ segment: number; text: string }> {
  const all = [...existing.split('\n'), ...rows].filter((line) => line.trim() !== '');
  const out: Array<{ segment: number; text: string }> = [];
  for (let at = 0; at < all.length; at += cap) out.push({ segment: segment + out.length, text: all.slice(at, at + cap).join('\n') + '\n' });
  return out;
}
