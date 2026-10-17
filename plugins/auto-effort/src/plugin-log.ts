// Standalone contract rows and a serial append queue. The adapter supplies I/O and the screen fallback.
export const PLUGIN_LOG_CAP_BYTES = 20971520;
export const ROW_MAX_BYTES = 4096;
export type PluginLogLevel = 'error' | 'warning' | 'info';
export type PluginLogFields = { plugin: string; level: PluginLogLevel; event: string; msg: string; where: string; session?: string; detail?: Record<string, unknown> };
export type PluginLogRun = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type FlushResult = { written: number; dropped: number };
const FILES = { error: 'errors.jsonl', warning: 'warnings.jsonl', info: 'info.jsonl' } as const;

/** Errors show immediately; other diagnostics show only when their log could not keep them. */
export function diagnosticOnScreen(level: PluginLogLevel, logged: boolean): boolean {
  return level === 'error' || !logged;
}

function bytes(text: string): number {
  let n = 0;
  for (const c of text) { const p = c.codePointAt(0)!; n += p <= 0x7f ? 1 : p <= 0x7ff ? 2 : p <= 0xffff ? 3 : 4; }
  return n;
}
function clipped(text: string, fits: (s: string) => boolean): string {
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(chars.slice(0, mid).join(''))) lo = mid; else hi = mid - 1; }
  return chars.slice(0, lo).join('');
}

export function levelRow(fields: PluginLogFields, nowMs: number): string {
  const row = { ts: new Date(nowMs).toISOString(), plugin: fields.plugin, level: fields.level, event: fields.event, msg: fields.msg, where: fields.where, ...(fields.session === undefined ? {} : { session: fields.session }), ...(fields.detail === undefined ? {} : { detail: fields.detail }) };
  const render = () => JSON.stringify(row) + '\n';
  let text: string;
  try { text = render(); }
  catch (error) { row.detail = { error: `plugin log detail serialization failed: ${error instanceof Error ? error.message : String(error)}` }; text = render(); }
  const original = bytes(text);
  if (original <= ROW_MAX_BYTES) return text;
  row.detail = { truncated: true, bytes: original };
  // Only malformed/oversized caller identifiers need this; real component names remain intact.
  for (const key of ['plugin', 'event', 'where', 'session'] as const) {
    if (row[key] !== undefined) row[key] = clipped(row[key]!, (s) => bytes(JSON.stringify(s)) <= 512);
  }
  row.msg = clipped(row.msg, (s) => { const old = row.msg; row.msg = s; const size = bytes(render()); row.msg = old; return size <= ROW_MAX_BYTES; });
  return render();
}

export function pluginLogDir(env: string | undefined, home: string | undefined, plugin: string): string | undefined {
  const root = env || (home ? `${home.replace(/\/+$/, '')}/.local/state` : undefined);
  if (root === undefined) return undefined;
  return env ? `${root.replace(/\/+$/, '')}/${plugin}` : `${root}/${plugin}/logs`;
}

// Cap notices reuse the canonical row's encoded timestamp/session as printf data, never shell source.
export const APPEND_SCRIPT = `set -eu
umask 077
dir=$1
case "$dir" in -*) dir=./$dir ;; esac
plugin=$2
shift 2
refuse() { printf 'plugin log %s: %s\\n' "$1" "$2" >&2; exit 1; }
cap_file() {
  cap_path=$dir/$1
  [ -f "$cap_path" ] || return 1
  size=$(wc -c < "$cap_path") || refuse "$cap_path" 'size failed'
  [ "$size" -gt ${PLUGIN_LOG_CAP_BYTES} ] || return 1
  mv -f "$cap_path" "$cap_path.1" || refuse "$cap_path" 'cap rename failed'
}
cap_notice() {
  notice_file=$1
  printf '{"ts":%s,"plugin":"%s","level":"warning","event":"log-capped","msg":"level file exceeded the cap; moved to .1","where":"src/plugin-log.ts#append"%s,"detail":{"file":"%s","cap_bytes":${PLUGIN_LOG_CAP_BYTES}}}\\n' "$ts" "$plugin" "$session" "$notice_file" >> "$dir/warnings.jsonl" || refuse "$dir/warnings.jsonl" 'cap notice failed'
}
case "$plugin" in ''|*[!a-zA-Z0-9_-]*) printf 'invalid plugin slug: %s\\n' "$plugin" >&2; exit 2;; esac
mkdir -p "$dir" || refuse "$dir" 'mkdir failed'
while [ "$#" -gt 0 ]; do
  file=$1
  row=$2
  shift 2
  case "$file" in errors.jsonl|warnings.jsonl|info.jsonl) ;; *) printf 'invalid level file: %s\\n' "$file" >&2; exit 2;; esac
  # Remove the canonical newline and outer closing brace, then exclude detail entirely.
  body=\${row%?}
  body=\${body%?}
  head=\${body%%',"detail":'*}
  ts=\${head#'{"ts":'}
  ts=\${ts%%',"plugin":'*}
  session=''
  case "$head" in *',"session":'*) value=\${head##*',"session":'}; session=',"session":'"$value";; esac
  # A cap notice must never be appended to an already oversized warnings file.
  if cap_file warnings.jsonl; then cap_notice warnings.jsonl; fi
  if [ "$file" != warnings.jsonl ] && cap_file "$file"; then cap_notice "$file"; fi
  path=$dir/$file
  printf '%s' "$row" >> "$path" || refuse "$path" 'append failed'
done`;

export function appendArgv(dir: string, plugin: string, rows: readonly string[]): string[][] {
  const commands: string[][] = [];
  for (let n = 0; n < rows.length; n += 64) {
    const argv = ['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log', dir, plugin];
    for (const row of rows.slice(n, n + 64)) {
      const level = (JSON.parse(row) as PluginLogFields).level;
      const file = FILES[level];
      if (file === undefined) throw new Error(`invalid plugin log level: ${String(level)}`);
      argv.push(file, row);
    }
    commands.push(argv);
  }
  return commands;
}

export class PluginLogQueue {
  private rows: string[] = [];
  private chain: Promise<FlushResult> = Promise.resolve({ written: 0, dropped: 0 });
  private failing = false;
  constructor(private readonly dir: string | undefined, private readonly plugin: string, private readonly fallback: (notice: string) => void) {}
  add(row: string): void { this.rows.push(row); }
  flush(run?: PluginLogRun): Promise<FlushResult> {
    const batch = this.rows.splice(0);
    this.chain = this.chain.then(async () => {
      let written = 0;
      if (batch.length === 0) return { written, dropped: 0 };
      try {
        if (this.dir === undefined) throw new Error('plugin log off: no PLUGIN_LOG_DIR and no HOME');
        if (run === undefined) throw new Error('process.run unavailable');
        for (const argv of appendArgv(this.dir, this.plugin, batch)) {
          const result = await run(argv);
          if (result.exitCode !== 0) throw new Error(result.stderr.split('\n')[0] || `process.run exit ${result.exitCode}`);
          written += (argv.length - 6) / 2;
          this.failing = false;
        }
        return { written, dropped: 0 };
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        const dropped = batch.length - written;
        if (!this.failing) {
          this.failing = true;
          const notice = `${this.dir === undefined ? cause : `plugin log ${this.dir}: ${cause}`}; ${dropped} rows dropped`;
          try { this.fallback(notice); }
          catch (screenError) { // The fallback screen is gone too; never change the hook's work result.
            void screenError;
          }
        }
        return { written, dropped };
      }
    });
    return this.chain;
  }
}
