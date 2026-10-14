/// <reference types="vite/client" />
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

// An absent new capability fails an assertion, not module resolution, on the untouched tree.
const modules = import.meta.glob('../plugins/auto-effort/src/plugin-log.ts', { eager: true });
const api = Object.values(modules)[0] as any;
function writer() {
  return api;
}
const exec = promisify(execFile);
const dirs: string[] = [];
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'auto-effort-plugin-log-')); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const now = 1791991231123;
const fields = { plugin: 'auto-effort', level: 'error', event: 'set-effort-failed', msg: 'applying set_effort failed: unknown level; the model was told Not applied', where: 'hooks/auto-effort.ts#applyEffort', session: '5f0c2a', detail: { error: 'unknown level' } };
const rows = (s: string) => s.trim().split('\n').map((l) => JSON.parse(l));
const run = async (argv: string[]) => { const r = await exec('/bin/sh', argv.slice(1)); return { exitCode: 0, ...r }; };

it.each([
  { name: 'session known', f: fields, keys: ['ts', 'plugin', 'level', 'event', 'msg', 'where', 'session', 'detail'] },
  { name: 'session unknown', f: { ...fields, session: undefined }, keys: ['ts', 'plugin', 'level', 'event', 'msg', 'where', 'detail'] },
])('levelRow contract: $name', ({ f, keys }) => {
  const { levelRow } = writer();
  const text = levelRow(f, now);
  expect(text).toBe(JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...f }) + '\n');
  expect(Object.keys(JSON.parse(text))).toEqual(keys);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
});

it.each(['x'.repeat(10000), 'é😀\\"\n'.repeat(5000)])('caps oversized UTF-8 and JSON escaping', (msg) => {
  const { levelRow } = writer();
  const full = JSON.stringify({ ts: '2026-10-14T15:20:31.123Z', ...fields, msg }) + '\n';
  const text = levelRow({ ...fields, msg }, now);
  const row = JSON.parse(text);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
  expect(row.detail).toEqual({ truncated: true, bytes: Buffer.byteLength(full) });
  expect(msg.startsWith(row.msg)).toBe(true);
  expect(row.msg.length).toBeGreaterThan(0);
});

it('caps huge envelopes too, and replaces oversized detail before touching a short message', () => {
  const { levelRow } = writer();
  const text = levelRow({ ...fields, plugin: 'p'.repeat(5000), event: 'e'.repeat(5000), where: 'w'.repeat(5000), session: 's'.repeat(5000) }, now);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
  expect(JSON.parse(text).detail.truncated).toBe(true);
  const detail = levelRow({ ...fields, detail: { error: 'e'.repeat(9000) } }, now);
  expect(JSON.parse(detail).msg).toBe(fields.msg);
  expect(JSON.parse(detail).detail.truncated).toBe(true);
});

it.each([
  ['/x/logs', '/h/u', '/x/logs/auto-effort'],
  [undefined, '/h/u', '/h/u/.local/state/auto-effort/logs'],
  [undefined, undefined, undefined],
  ['', '', undefined],
  ['/x/logs/', '/h/u', '/x/logs/auto-effort'],
])('pluginLogDir(%s, %s)', (env, home, expected) => {
  expect(writer().pluginLogDir(env, home, 'auto-effort')).toBe(expected);
});

it('appends three level files, with private modes and positional shell data', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = join(await temp(), 'space " $(not-a-command)');
  const input = ['error', 'warning', 'info'].map((level) => levelRow({ ...fields, level, msg: 'literal $(touch bad); "\\\n' }, now));
  for (const argv of appendArgv(dir, 'auto-effort', input)) await run(argv);
  for (const [i, file] of ['errors', 'warnings', 'info'].entries()) {
    expect(await readFile(join(dir, `${file}.jsonl`), 'utf8')).toBe(input[i]);
    expect((await stat(join(dir, `${file}.jsonl`))).mode & 0o777).toBe(0o600);
  }
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

it('renames past 20971520 bytes to .1 and emits a contract log-capped warning', async () => {
  const { levelRow, appendArgv, PLUGIN_LOG_CAP_BYTES } = writer();
  expect(PLUGIN_LOG_CAP_BYTES).toBe(20971520);
  const dir = await temp();
  const old = 'x'.repeat(20971521);
  await writeFile(join(dir, 'errors.jsonl'), old);
  const row = levelRow(fields, now);
  for (const argv of appendArgv(dir, 'auto-effort', [row])) await run(argv);
  expect(await readFile(join(dir, 'errors.jsonl.1'), 'utf8')).toBe(old);
  expect(await readFile(join(dir, 'errors.jsonl'), 'utf8')).toBe(row);
  const cap = rows(await readFile(join(dir, 'warnings.jsonl'), 'utf8'));
  expect(cap).toEqual([expect.objectContaining({ plugin: 'auto-effort', level: 'warning', event: 'log-capped', where: 'src/plugin-log.ts#append', detail: { file: 'errors.jsonl', cap_bytes: 20971520 } })]);
});

it('caps the warnings file without recursively capping its cap notice', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  await writeFile(join(dir, 'warnings.jsonl'), 'x'.repeat(20971521));
  for (const argv of appendArgv(dir, 'auto-effort', [levelRow({ ...fields, level: 'warning' }, now)])) await run(argv);
  expect(rows(await readFile(join(dir, 'warnings.jsonl'), 'utf8')).map((r) => r.event)).toEqual(['log-capped', 'set-effort-failed']);
});

it('reports a non-directory write failure with the path', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = join(await temp(), 'file');
  await writeFile(dir, 'not a directory');
  await expect(run(appendArgv(dir, 'auto-effort', [levelRow(fields, now)])[0])).rejects.toMatchObject({ stderr: expect.stringContaining(dir) });
});

it.skipIf(process.getuid?.() === 0)('skip-because:superuser — unwritable directory reports its path', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  await chmod(dir, 0o500);
  try {
    await expect(run(appendArgv(dir, 'auto-effort', [levelRow(fields, now)])[0])).rejects.toMatchObject({ stderr: expect.stringContaining(dir) });
    expect((await stat(dir)).mode & 0o777).toBe(0o500);
  } finally { await chmod(dir, 0o700); }
});

it('batches at 64 pairs and two concurrent appenders lose/interleave no rows', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  const batch = Array.from({ length: 130 }, (_, n) => levelRow({ ...fields, detail: { n } }, now));
  const args = appendArgv(dir, 'auto-effort', batch);
  expect(args.map((a: string[]) => (a.length - 6) / 2)).toEqual([64, 64, 2]);
  await Promise.all([0, 1].map(async () => { for (const argv of args) await run(argv); }));
  const seen = rows(await readFile(join(dir, 'errors.jsonl'), 'utf8'));
  expect(seen).toHaveLength(260);
  for (let n = 0; n < 130; n += 1) expect(seen.filter((r) => r.detail.n === n)).toHaveLength(2);
});

describe('PluginLogQueue', () => {
  it('does no work for empty input and serializes concurrent flushes', async () => {
    const { PluginLogQueue, levelRow } = writer();
    const queue = new PluginLogQueue('/logs/auto-effort', 'auto-effort', () => undefined);
    const calls: string[][] = [];
    let release!: () => void;
    const run = async (a: string[]) => { calls.push(a); if (calls.length === 1) await new Promise<void>((done) => { release = done; }); return { exitCode: 0, stdout: '', stderr: '' }; };
    await queue.flush(run);
    expect(calls).toHaveLength(0);
    queue.add(levelRow(fields, now));
    const first = queue.flush(run);
    await Promise.resolve(); await Promise.resolve();
    queue.add(levelRow({ ...fields, event: 'second' }, now));
    const second = queue.flush(run);
    expect(calls).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]![7]!)).toMatchObject({ event: 'second' });
  });

  it('contains rejections, nonzero and missing runners, reports once per streak then re-arms', async () => {
    const { PluginLogQueue, levelRow } = writer();
    const notices: string[] = [];
    const q = new PluginLogQueue('/logs/auto-effort', 'auto-effort', (s: string) => notices.push(s));
    const attempt = async (run?: any) => { q.add(levelRow(fields, now)); return q.flush(run); };
    const fail = async () => { throw new Error('cannot start'); };
    expect(await attempt(fail)).toMatchObject({ dropped: 1 });
    await attempt(async () => ({ exitCode: 2, stderr: 'disk full\ncontext', stdout: '' }));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('/logs/auto-effort');
    expect(notices[0]).toContain('cannot start');
    await attempt(async () => ({ exitCode: 0, stderr: '', stdout: '' }));
    await attempt();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('process.run');
    const q2 = new PluginLogQueue('/logs/p', 'auto-effort', (s: string) => notices.push(s));
    q2.add(levelRow(fields, now));
    await q2.flush(async () => ({ exitCode: 9, stderr: 'disk full\nsecond line', stdout: '' }));
    expect(notices.at(-1)).toContain('disk full');
    expect(notices.at(-1)).toContain('1 rows dropped');
  });

  it('names the off state and cannot throw even if the fallback screen fails', async () => {
    const { PluginLogQueue, levelRow } = writer();
    const notices: string[] = [];
    const q = new PluginLogQueue(undefined, 'auto-effort', (s: string) => notices.push(s));
    q.add(levelRow(fields, now)); await q.flush();
    q.add(levelRow(fields, now)); await q.flush();
    expect(notices).toEqual(['plugin log off: no PLUGIN_LOG_DIR and no HOME; 1 rows dropped']);
    const broken = new PluginLogQueue(undefined, 'auto-effort', () => { throw new Error('screen closed'); });
    broken.add(levelRow(fields, now));
    await expect(broken.flush()).resolves.toMatchObject({ dropped: 1 });
  });
});


it('tightens existing owned level modes, leaving parent and legacy paths unchanged', async () => {
  const { levelRow, appendArgv } = writer();
  const parent = await temp();
  const dir = join(parent, 'auto-effort');
  // First create the scoped level directory through the actual writer.
  for (const argv of appendArgv(dir, 'auto-effort', [levelRow(fields, now)])) await run(argv);
  await chmod(parent, 0o755); await chmod(dir, 0o755);
  const names = ['errors.jsonl', 'warnings.jsonl', 'info.jsonl'];
  for (const file of names) {
    await writeFile(join(dir, file), levelRow({ ...fields, level: file === 'errors.jsonl' ? 'error' : file === 'warnings.jsonl' ? 'warning' : 'info' }, now));
    await chmod(join(dir, file), 0o644);
    await writeFile(join(dir, file + '.1'), 'archive'); await chmod(join(dir, file + '.1'), 0o644);
  }
  const legacy = join(dir, 'decisions.jsonl');
  await writeFile(legacy, 'legacy'); await chmod(legacy, 0o644);
  for (const argv of appendArgv(dir, 'auto-effort', [levelRow(fields, now)])) await run(argv);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  for (const file of names) {
    expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, file + '.1'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, file + '.1'), 'utf8')).toBe('archive');
  }
  expect((await stat(parent)).mode & 0o777).toBe(0o755);
  expect((await stat(legacy)).mode & 0o777).toBe(0o644);
  expect(await readFile(legacy, 'utf8')).toBe('legacy');
});

it.each([
  { name: 'known', session: '5f0c2a' },
  { name: 'escaped', session: 'quote" backslash\\ newline\n unicode😀' },
  { name: 'empty known', session: '' },
  { name: 'unknown', session: undefined },
])('cap notice preserves canonical $name session, not detail fakes', async ({ session }) => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  await writeFile(join(dir, 'errors.jsonl'), 'x'.repeat(20971521));
  const row = levelRow({ ...fields, session, msg: 'fake ,"session":"message-fake"', detail: { session: 'detail-fake', nested: { session: 'nested-fake' } } }, now);
  for (const argv of appendArgv(dir, 'auto-effort', [row])) await run(argv);
  const capped = rows(await readFile(join(dir, 'warnings.jsonl'), 'utf8'));
  expect(capped).toHaveLength(1);
  if (session === undefined) expect(Object.keys(capped[0])).toEqual(['ts', 'plugin', 'level', 'event', 'msg', 'where', 'detail']);
  else expect(capped[0].session).toBe(session);
  expect(capped[0]).toMatchObject({ ts: '2026-10-14T15:20:31.123Z', plugin: 'auto-effort', level: 'warning', event: 'log-capped' });
  expect(capped[0].detail).toEqual({ file: 'errors.jsonl', cap_bytes: 20971520 });
});

it('caps existing oversized warnings before adding an errors cap notice', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  const oldErrors = 'e'.repeat(20971521), oldWarnings = 'w'.repeat(20971521);
  await writeFile(join(dir, 'errors.jsonl'), oldErrors);
  await writeFile(join(dir, 'warnings.jsonl'), oldWarnings);
  const row = levelRow(fields, now);
  for (const argv of appendArgv(dir, 'auto-effort', [row])) await run(argv);
  expect(await readFile(join(dir, 'errors.jsonl.1'), 'utf8')).toBe(oldErrors);
  const warningArchive = await readFile(join(dir, 'warnings.jsonl.1'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  expect(warningArchive).toBe(oldWarnings);
  expect(await readFile(join(dir, 'errors.jsonl'), 'utf8')).toBe(row);
  const capped = rows(await readFile(join(dir, 'warnings.jsonl'), 'utf8'));
  expect(capped.map((r) => r.detail.file)).toEqual(['warnings.jsonl', 'errors.jsonl']);
  expect(capped.every((r) => r.level === 'warning' && r.event === 'log-capped' && r.session === fields.session)).toBe(true);
  expect((await stat(join(dir, 'warnings.jsonl'))).size).toBeLessThan(20971520);
});

it.skipIf(process.getuid?.() === 0)('skip-because:superuser — EPERM ownership probe cannot tighten a foreign archive target', async () => {
  const { levelRow, appendArgv } = writer();
  const dir = await temp();
  const archive = join(dir, 'errors.jsonl.1');
  // The fence's root-owned /dev/null is a positive EPERM control; this non-root attempt cannot mutate it.
  const original = (await stat('/dev/null')).mode;
  await expect(exec('/bin/chmod', ['600', '/dev/null'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Operation not permitted|Permission denied/) });
  await symlink('/dev/null', archive);
  await expect(run(appendArgv(dir, 'auto-effort', [levelRow(fields, now)])[0])).rejects.toMatchObject({ stderr: expect.stringContaining(archive) });
  expect((await stat('/dev/null')).mode).toBe(original);
});
