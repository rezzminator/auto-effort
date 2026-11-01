// The decision log: one JSONL file per session, appended to on every write.
// Chats share the plugin log directory, so each session writes its own file
// there; a resumed session appends to the rows it wrote before.

/** The session's sub-agent log: the id and scope go before the extension, apart from the main chat's numbered files. */
export function sessionLogPath(base: string, sessionId: string): string {
  if (sessionId === '') throw new Error('auto-effort: empty session id; cannot name the log file');
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const slash = base.lastIndexOf('/');
  const dir = base.slice(0, slash + 1);
  const name = base.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${dir}${name}.${safe}.subagent`;
  return `${dir}${name.slice(0, dot)}.${safe}.subagent${name.slice(dot)}`;
}

/** The file's rows followed by `rows`, blank lines dropped, the newest `cap` kept. */
export function appendRows(existing: string, rows: string[], cap: number): string {
  const all = [...existing.split('\n').filter((line) => line.trim() !== ''), ...rows];
  return all.slice(-cap).join('\n') + '\n';
}
