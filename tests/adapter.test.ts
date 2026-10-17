import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe as suite, expect, it, vi } from 'vitest';
import { register } from '../plugins/auto-effort/hooks/auto-effort.ts';
import { Controller } from '../plugins/auto-effort/src/controller.ts';
import { KEEPER_ARGV } from '../plugins/auto-effort/src/state.ts';

// A stand-in engine: the hooks the module registers, driven the way the engine drives them, over a fake `$`.
type Hook = (...args: any[]) => any;
const TOOL = 'mcp__auto-effort__set_effort';
const OPUS = 'claude-opus-5-5';
// The state file at the default `stateFile` for session sess1: what a status line outside the plugin reads.
const STATE = '/fake-home/u/.local/state/auto-effort/state.sess1.json';
const usage = (input: number, cacheRead: number, cacheWrite: number, output = 100) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, model: OPUS });

function engine(options: Record<string, unknown> = {}, o: { configRows?: unknown[]; storeGet?: () => Promise<unknown>; storeValue?: unknown; env?: Record<string, string | undefined>; keeper?: 'fails' | 'silent' | 'noisy' } = {}) {
  const hooks: Array<{ name: string; matcher?: Record<string, unknown>; fn: Hook }> = [];
  const logs: string[] = [];
  const statuses: Array<string | undefined> = [];
  const toasts: string[] = [];
  const files = new Map<string, string>();
  const writes: Array<{ path: string; rows: number }> = [];
  const store = new Map<string, unknown>(o.storeValue === undefined ? [] : [['state', o.storeValue]]);
  const registered: any[] = [];
  const commands: any[] = [];
  const configSets: any[] = [];
  const sess = { id: 'sess1' };
  // The host's plugin state outlives a plugin reload: one value per (plugin, key, id).
  const state = new Map<string, unknown>();
  const stateKey = (ref: { plugin: string; key: string; id?: string }) => `${ref.plugin}/${ref.key}/${ref.id ?? ''}`;
  // Each child `$.process.spawn` starts: a keeper prints its pid (4242 on), then runs until `end()` or its loop is left.
  // 'noisy' writes a shell warning to stderr first and its pid in two pieces; a `gate` holds the pid back until it opens.
  const keepers: Array<{ argv: readonly string[]; pid: number; end: () => void; closed: boolean }> = [];
  const spawning = { mode: o.keeper as 'fails' | 'silent' | 'noisy' | undefined, gate: undefined as Promise<void> | undefined };
  let nextPid = 4242;
  const spawn = (request: { argv: readonly string[] }) => {
    const mode = spawning.mode;
    const gate = spawning.gate;
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => (finish = resolve));
    const keeper = { argv: request.argv, pid: mode === 'fails' ? 0 : nextPid++, end: () => finish(), closed: false };
    if (mode !== 'fails') keepers.push(keeper);
    const stream = (async function* () {
      if (mode === 'fails') throw new Error('cannot start /bin/sh');
      try {
        if (mode === 'noisy') {
          yield { stream: 'stderr' as const, text: 'sh: setlocale: LC_ALL: cannot change locale (xx_XX.UTF-8)\n' };
          yield { stream: 'stdout' as const, text: String(keeper.pid).slice(0, 2) };
          yield { stream: 'stdout' as const, text: `${String(keeper.pid).slice(2)}\n` };
        } else if (mode !== 'silent') {
          await gate;
          yield { stream: 'stdout' as const, text: `${keeper.pid}\n` };
        }
        await ended;
        return { code: 0, signal: null };
      } finally {
        keeper.closed = true;
      }
    })();
    // The host kills the child when its stream is closed: the loop then ends.
    const close = stream.return.bind(stream);
    stream.return = (value: any) => (finish(), close(value));
    return Object.assign(stream, { result: ended.then(() => ({ code: 0, signal: null })) });
  };
  const $ = {
    process: { run: async (_argv: string[], _options?: unknown) => ({ exitCode: 0, stdout: '', stderr: '' }), spawn },
    tool: { register: async (spec: any) => (registered.push(spec), { tool: `mcp__auto-effort__${spec.name}` }) },
    command: { register: async (spec: any) => (commands.push(spec), { name: spec.name }) },
    store: {
      get: o.storeGet ?? (async (key: string) => store.get(key)),
      set: async (key: string, value: unknown) => void store.set(key, JSON.parse(JSON.stringify(value))),
    },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path) ?? '',
      write: async (path: string, text: string) => {
        writes.push({ path, rows: text.split('\n').filter(Boolean).length });
        files.set(path, text);
      },
    },
    ui: { log: (line: string) => logs.push(line), status: (text?: string) => statuses.push(text), toast: (text: string) => toasts.push(text) },
    session: { id: async () => sess.id, model: async () => OPUS, cwd: async () => '/work' },
    env: { get: async (name: string) => (o.env === undefined ? (name === 'HOME' ? '/fake-home/u' : undefined) : o.env[name]) },
    config: {
      list: async () => o.configRows ?? [],
      set: async (args: unknown) => (configSets.push(args), { value: (args as { value: unknown }).value }),
    },
    clock: { now: async () => Date.now(), sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 30))) },
    state: {
      get: async (ref: { plugin: string; key: string; id?: string }) => ({ value: state.get(stateKey(ref)), version: 1 }),
      set: async (ref: { plugin: string; key: string; id?: string }, value: unknown) => (state.set(stateKey(ref), JSON.parse(JSON.stringify(value))), { isSet: true, version: 2 }),
    },
  };
  const load = (opts: Record<string, unknown>) => (register as Hook)((name: string, a: unknown, b?: unknown) => hooks.push(typeof a === 'function' ? { name, fn: a as Hook } : { name, matcher: a as Record<string, unknown>, fn: b as Hook }), opts);
  load(options);
  const find = (name: string, matcher?: Record<string, unknown>) => {
    const hook = hooks.find((h) => h.name === name && (matcher === undefined || JSON.stringify(h.matcher) === JSON.stringify(matcher)));
    if (!hook) throw new Error(`no ${name} hook`);
    return hook.fn;
  };
  const sent: any[] = [];
  const api = {
    $, sess, state, logs, statuses, toasts, files, writes, store, registered, commands, configSets, hooks, sent, keepers, spawning,
    // A plugin reload (or an option change): the module registers again and builds a new controller; the host's state stays.
    reload: (opts: Record<string, unknown> = options) => {
      hooks.length = 0;
      load(opts);
    },
    end: () => find('session.end')($, {}, async () => ({})),
    start: () => find('session.start')($, { cwd: '/work', surface: null, isInteractive: true }, async (e: any) => ({ cwd: e.cwd })),
    prompt: async (text = 'fix the parser bug', extra: Record<string, unknown> = {}) => {
      let seen: any;
      await find('prompt.submit')($, { text, wait: false, origin: { kind: 'composer' }, ...extra }, async (e: any) => ((seen = e), e));
      return seen;
    },
    // One request through turn.step; `result` is what the engine's response carries.
    async step(e: Record<string, unknown>, result: { usage?: unknown; toolUses?: unknown[] } = {}) {
      const base = { turnId: 't1', index: 0, model: OPUS, effort: 'xhigh', messageCount: 2 };
      const input = { ...base, ...e };
      const next = (x: any) => (async function* () { sent.push(x); return { answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(10, 1000, 100), ...result }; })();
      const gen = find('turn.step')($, input, next);
      let step = await gen.next();
      while (!step.done) step = await gen.next();
      return sent[sent.length - 1];
    },
    tool: (e: Record<string, unknown>, result: Record<string, unknown> = { result: 'ok', text: 'ok' }) => find('tool.call')($, { tool: 'Bash', tool_use_id: 'u1', ...e }, async () => result),
    complete: (e: Record<string, unknown> = {}) => find('turn.complete')($, { answer: '', durationMs: 3000, isAborted: false, turnId: 't1', reason: 'answer', ...e }, async (x: any) => x),
    command: (args: string) => find('command.run', { command: 'auto-effort' })($, { command: 'auto-effort', args, origin: { kind: 'composer' }, presentation: {} }, async () => ({ text: 'unhandled' })),
    logRows: () => [...files].filter(([path]) => path.endsWith('.jsonl')).flatMap(([, text]) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l))),
    settle: () => vi.waitFor(() => expect([...files.keys()].some((path) => path.endsWith('.jsonl'))).toBe(true)),
    logFiles: () => [...files.keys()].filter((path) => path.endsWith('.jsonl')),
    stateOf: (path = STATE) => {
      const text = files.get(path);
      return text === undefined ? undefined : JSON.parse(text);
    },
  };
  return api;
}

// F3: on/off and the user's /effort pin belong to the session, so a reload keeps them and a new session starts clean.
suite('plugin reload', () => {
  it('keeps `/auto-effort off` across a reload and an option change, and `on` after it turns the plugin back on', async () => {
    const e = engine();
    await e.start();
    await e.command('off');
    e.reload({ planLevel: 'medium' });
    await e.start();
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
    expect((await e.command('status')).text).toContain('off');
    await e.command('on');
    e.reload();
    await e.prompt();
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'high' });
  });

  it('keeps the pin of the user\'s /effort across a reload', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({ turnId: 't1', effort: 'xhigh' });
    await e.prompt();
    expect(await e.step({ turnId: 't2', effort: 'low' })).toMatchObject({ effort: 'low' });
    e.reload();
    await e.prompt();
    const kept = await e.step({ turnId: 't3', effort: 'low' });
    expect(kept).toMatchObject({ effort: 'low' });
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'pin', level: 'low' }));
  });

  it('starts a new session after /clear on and unpinned, even after a reload', async () => {
    const e = engine();
    await e.start();
    await e.command('off');
    e.reload();
    e.sess.id = 'sess2';
    await e.prompt();
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'high' });
  });

  it('holds on and unpinned when the saved state cannot be read, and says so', async () => {
    const e = engine();
    await e.start();
    await e.command('off');
    e.reload();
    e.$.state.get = async () => {
      throw new Error('no state');
    };
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    expect(e.logs.some((line) => line.includes('reading the saved on/off, the pin and the set_effort level failed: no state') && line.includes('on and unpinned, with no set_effort level'))).toBe(true);
  });

  it('holds on and unpinned when the saved state is not in the form it writes, and says so', async () => {
    const e = engine();
    await e.start();
    e.state.set('auto-effort/session/sess1', { enabled: 'no' });
    e.reload();
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    expect(e.logs.filter((line) => line.includes('not in the expected form'))).toHaveLength(1);
  });

  it('keeps going and says so when the state cannot be written', async () => {
    const e = engine();
    await e.start();
    e.$.state.set = async () => {
      throw new Error('read only');
    };
    expect((await e.command('off')).text).toContain('off');
    expect(e.logs.some((line) => line.includes('read only') && line.includes('a reload'))).toBe(true);
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
  });

  it('saves what the session does after a failed read, so a later reload does not bring back the off it could not read', async () => {
    const e = engine();
    await e.start();
    await e.command('off');
    e.reload();
    const get = e.$.state.get;
    e.$.state.get = async () => {
      throw new Error('no state');
    };
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    e.$.state.get = get;
    e.reload();
    await e.prompt();
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'high' });
  });

  it('reads the saved state once it learns the session id, when the id could not be read at start', async () => {
    const e = engine();
    await e.start();
    await e.command('off');
    e.reload();
    const id = e.$.session.id;
    let failing = true;
    e.$.session.id = async () => {
      if (failing) {
        failing = false;
        throw new Error('no id yet');
      }
      return id();
    };
    await e.prompt();
    expect(e.logs.some((line) => line.includes('no id yet'))).toBe(true);
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
  });

  it('quotes a short piece of a saved state it cannot read, never the whole value', async () => {
    const e = engine();
    await e.start();
    e.state.set('auto-effort/session/sess1', { enabled: 'x'.repeat(5000), pin: null });
    e.reload();
    await e.prompt();
    const line = e.logs.find((entry) => entry.includes('not in the expected form'));
    expect(line).toContain('{"enabled":"xxxx');
    expect(line!.length).toBeLessThan(300);
  });

  it('applies `/auto-effort off` typed after /clear to the new session, and the next prompt keeps it', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    e.sess.id = 'sess2';
    expect((await e.command('off')).text).toContain('off');
    await e.prompt();
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'xhigh' });
    expect(e.state.get('auto-effort/session/sess2')).toEqual({ enabled: false, pin: null, override: null });
    expect(e.state.get('auto-effort/session/sess1')).not.toEqual({ enabled: false, pin: null, override: null });
  });

  it('sends the request while the host is still saving the on/off and pin', async () => {
    const e = engine();
    await e.start();
    e.$.state.set = () => new Promise(() => undefined);
    await e.prompt();
    const sent = await Promise.race([e.step({}), new Promise((done) => setTimeout(() => done('held'), 200))]);
    expect(sent).toMatchObject({ effort: 'high' });
  });

  it('says once that the on/off and pin cannot be saved, not at every request', async () => {
    const e = engine();
    await e.start();
    e.$.state.set = async () => {
      throw new Error('read only');
    };
    await e.prompt();
    for (let index = 0; index < 3; index += 1) await e.step({ index });
    await vi.waitFor(() => expect(e.logs.filter((line) => line.includes('saving the on/off, the pin and the set_effort level')).length).toBeGreaterThan(0));
    await new Promise((done) => setTimeout(done, 20));
    expect(e.logs.filter((line) => line.includes('saving the on/off, the pin and the set_effort level'))).toHaveLength(1);
  });

  it('plans the turn with the reminder when the session id cannot be read at a prompt', async () => {
    const e = engine();
    await e.start();
    e.$.session.id = async () => {
      throw new Error('no id now');
    };
    const seen = await e.prompt();
    expect(seen.context).toEqual([expect.stringContaining(TOOL)]);
    expect(e.logs.some((line) => line.includes('no id now'))).toBe(true);
  });
});

suite('session start', () => {
  it('registers set_effort always loaded, with the range the clamp lets through, and the /auto-effort command', async () => {
    const e = engine();
    await e.start();
    expect(e.registered).toHaveLength(1);
    expect(e.registered[0]).toMatchObject({ name: 'set_effort', isDeferred: false });
    expect(e.registered[0].description).toContain('Call it in your first response of a user turn whose work needs another level');
    expect(e.registered[0].inputSchema.properties.level.enum).toEqual(['medium', 'high', 'xhigh', 'auto']);
    expect(e.registered[0].inputSchema.properties.effort.enum).toEqual(['medium', 'high', 'xhigh', 'auto']);
    expect(e.registered[0].inputSchema.properties.level.description).toContain('holds across turns until you call it with auto');
    expect(e.registered[0].inputSchema.required ?? []).toEqual([]);
    expect(e.commands).toEqual([expect.objectContaining({ name: 'auto-effort' })]);
  });

  // R12: an invalid option is reported by key and value, and the default applies.
  it('logs an invalid option by key and value', async () => {
    const e = engine({ floor: 'lowest' });
    await e.start();
    await e.prompt();
    expect(e.logs.filter((line) => line.includes('"floor"') && line.includes('lowest'))).toHaveLength(1);
    expect((await e.step({}))).toMatchObject({ effort: 'high' });
  });
});

// R1: main loop only.
suite('turn.step', () => {
  it('rewrites the effort of a main request to the planning level and leaves a sub-agent request untouched', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    expect(await e.step({ agentId: 'agent-7', effort: 'xhigh' })).toMatchObject({ agentId: 'agent-7', effort: 'xhigh' });
    expect(await e.step({})).toMatchObject({ effort: 'high' });
  });

  it('rewrites a request only when the level differs from the effort it carries', async () => {
    const e = engine({ planLevel: 'xhigh' });
    await e.start();
    await e.prompt();
    expect(await e.step({ effort: 'medium' })).toMatchObject({ effort: 'xhigh' });
    const same = engine({ planLevel: 'xhigh' });
    await same.start();
    await same.prompt();
    const input = { turnId: 't1', index: 0, model: OPUS, effort: 'xhigh', messageCount: 2 };
    expect(await same.step(input)).toEqual(input);
  });

  // R13
  it('sends the effort it already had, and logs with context, when the decision fails', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    const spy = vi.spyOn(Controller.prototype, 'beginStep').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
    } finally {
      spy.mockRestore();
    }
    expect(e.logs.some((line) => line.includes('boom') && line.includes('auto-effort'))).toBe(true);
    expect(await e.step({ index: 1 })).toMatchObject({ effort: 'high' });
  });

  it('keeps going when the notice, the state file or the log cannot be written', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    e.$.ui.toast = () => {
      throw new Error('no toast');
    };
    e.$.fs.write = async () => {
      throw new Error('disk full');
    };
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    await vi.waitFor(() => expect(e.logs.some((line) => line.includes('writing the decision log failed: disk full'))).toBe(true));
    await vi.waitFor(() => expect(e.logs.some((line) => line.includes('writing the state file failed: disk full'))).toBe(true));
    expect(e.logs.some((line) => line.includes('showing a notice failed: no toast'))).toBe(true);
  });

  it('clears a status line left by an older version once at the start, and pins none', async () => {
    const e = engine();
    await e.start();
    expect(e.statuses).toEqual([undefined]);
    await e.prompt();
    await e.step({});
    await e.tool({ tool: TOOL, level: 'medium', reason: 'mechanical rename' });
    await e.step({ index: 1 });
    await e.command('off');
    await e.command('on');
    expect(e.statuses).toEqual([undefined]);
  });

  // R9 through the adapter: the toast and the mark in the store. statusLine off keeps the reason notices out, so only the gate's counts.
  it('toasts once and stores the unsafe mark when the cache breaks after a switch', async () => {
    const e = engine({ statusLine: false });
    await e.start();
    await e.prompt();
    await e.step({}, { usage: usage(10, 0, 5000) });
    await e.tool({ tool: TOOL, level: 'medium', reason: 'rename' });
    await e.step({ index: 1 }, { usage: usage(4000, 100, 900) });
    expect(e.toasts).toHaveLength(1);
    expect(e.toasts[0]).toContain(OPUS);
    expect((e.store.get('state') as any).unsafe[OPUS]).toMatchObject({ from: 'high', to: 'medium' });
    expect(await e.step({ index: 2 })).toMatchObject({ effort: 'xhigh' });
    expect(e.toasts).toHaveLength(1);
  });

  it('starts off on a model the store marked unsafe, with one toast', async () => {
    const e = engine({}, { storeValue: { unsafe: { [OPUS]: { at: 'x', ratio: 0.1, prevPrompt: 1, cacheRead: 0, from: 'high', to: 'medium' } }, probation: {}, graduated: [] } });
    await e.start();
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
    await e.step({ index: 1 });
    expect(e.toasts).toHaveLength(1);
  });

  it('keeps a cache mark it could not save when the next prompt reads the store again, and saves it once the store takes it', async () => {
    const e = engine({ statusLine: false });
    await e.start();
    await e.prompt();
    expect(await e.step({}, { usage: usage(10, 0, 5000) })).toMatchObject({ effort: 'high' });
    await e.tool({ tool: TOOL, level: 'medium', reason: 'rename' });
    const set = e.$.store.set;
    e.$.store.set = async () => {
      throw new Error('store full');
    };
    await e.step({ index: 1 }, { usage: usage(4000, 100, 900) });
    expect(e.toasts).toHaveLength(1);
    expect(e.logs.some((line) => line.includes('store full'))).toBe(true);
    await e.prompt();
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'xhigh' });
    e.$.store.set = set;
    await e.prompt();
    expect((e.store.get('state') as any).unsafe[OPUS]).toMatchObject({ from: 'high', to: 'medium' });
    expect(await e.step({ turnId: 't3' })).toMatchObject({ effort: 'xhigh' });
  });

  it('keeps the marks another chat saved meanwhile when it saves its own', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({}, { usage: usage(10, 0, 5000) });
    const other = { at: 'y', ratio: 0.2, prevPrompt: 9, cacheRead: 1, from: 'high', to: 'xhigh' };
    e.store.set('state', { unsafe: { 'claude-fable-5-1': other }, probation: { 'claude-haiku-5-5': 3 }, graduated: [] });
    await e.tool({ tool: TOOL, level: 'medium', reason: 'rename' });
    await e.step({ index: 1 }, { usage: usage(4000, 100, 900) });
    const saved = e.store.get('state') as any;
    expect(saved.unsafe[OPUS]).toMatchObject({ from: 'high', to: 'medium' });
    expect(saved.unsafe['claude-fable-5-1']).toEqual(other);
    expect(saved.probation).toEqual({ 'claude-haiku-5-5': 3 });
  });

  it('keeps a cache mark made while an earlier save is still in flight, and saves it', async () => {
    const FABLE = 'claude-fable-5-1';
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({}, { usage: usage(10, 0, 5000) });
    await e.tool({ tool: TOOL, level: 'medium', reason: 'rename' });
    const { get, set } = e.$.store;
    e.$.store.set = async () => {
      throw new Error('store full');
    };
    await e.step({ index: 1 }, { usage: usage(4000, 100, 900) });
    await e.step({ index: 2, model: FABLE }, { usage: usage(10, 0, 5000) });
    await e.tool({ tool: TOOL, level: 'xhigh', reason: 'hard part' });
    let releaseSet: (() => void) | undefined;
    e.$.store.set = (key: string, value: unknown) => new Promise((done) => (releaseSet = () => done(set(key, value))));
    const first = e.prompt('also this', { turnId: 't1' });
    await vi.waitFor(() => expect(releaseSet).toBeDefined());
    let releaseGet: (() => void) | undefined;
    e.$.store.get = (key: string) => new Promise((done) => (releaseGet = () => done(get(key))));
    const second = e.step({ index: 3, model: FABLE }, { usage: usage(4000, 100, 900) });
    await vi.waitFor(() => expect(releaseGet).toBeDefined());
    releaseSet!();
    await first;
    e.$.store.set = set;
    e.$.store.get = get;
    releaseGet!();
    await second;
    await e.prompt();
    expect(Object.keys((e.store.get('state') as any).unsafe).sort()).toEqual([FABLE, OPUS]);
  });

  it('starts again on the next prompt when its first start failed', async () => {
    const e = engine({ floor: 'lowest' });
    const log = e.$.ui.log;
    let broken = true;
    e.$.ui.log = (line: string) => {
      if (broken) {
        broken = false;
        throw new Error('log closed');
      }
      return log(line);
    };
    await e.start().catch(() => undefined);
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    expect(e.registered).toHaveLength(1);
  });
});

suite('prompt.submit', () => {
  it('adds the turn reminder as one context line naming the tool as registered', async () => {
    const e = engine();
    await e.start();
    const seen = await e.prompt('rename it', { context: ['earlier'] });
    expect(seen.context).toHaveLength(2);
    expect(seen.context[0]).toBe('earlier');
    expect(seen.context[1]).toContain(TOOL);
    expect(seen.context[1]).toContain('high');
  });

  it('plans the next turn from a prompt typed to wait for the running one, with the reminder', async () => {
    const e = engine();
    await e.start();
    const waiting = await e.prompt('think about the retry design', { turnId: 't1', wait: true });
    expect(waiting.context).toEqual([expect.stringContaining(TOOL)]);
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'xhigh' });
    const delivered = await e.prompt('also this', { turnId: 't2', wait: false });
    expect(delivered.context).toBeUndefined();
  });

  it('starts a new session after /clear: its rows go to its own file and `/auto-effort off` of the last one ends', async () => {
    const e = engine({ logFile: '/logs/decisions.jsonl' });
    await e.start();
    await e.command('off');
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
    await vi.waitFor(() => expect(e.files.has('/logs/decisions.sess1.jsonl')).toBe(true));
    e.sess.id = 'sess2';
    await e.prompt();
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'high' });
    await vi.waitFor(() => expect(e.files.has('/logs/decisions.sess2.jsonl')).toBe(true));
    expect(e.logRows().filter((row) => row.turnId === 't2').length).toBeGreaterThan(0);
    expect(e.files.get('/logs/decisions.sess1.jsonl')).not.toContain('"t2"');
  });

  it('passes the prompt through when the settings cannot be read', async () => {
    const e = engine();
    await e.start();
    e.$.config.list = async () => {
      throw new Error('no config');
    };
    const seen = await e.prompt('rename it');
    expect(seen.text).toBe('rename it');
    expect(e.logs.some((line) => line.includes('no config'))).toBe(true);
  });

  // R12: a change takes effect without restarting the chat.
  it('takes a setting changed in /config at the next prompt', async () => {
    const e = engine();
    await e.start();
    e.$.config.list = async () => [
      { key: 'auto-effort@my.market.planLevel', value: 'medium', kind: 'text' },
      { key: 'auto-effort.floor', value: 'low', kind: 'text' },
      { key: 'other.planLevel', value: 'xhigh', kind: 'text' },
    ];
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'medium' });
    expect(e.registered.at(-1).description).toContain('- low:');
  });
});

// The environment layer: AUTO_EFFORT_{OPTION} read through $.env.get at the start and at each prompt, over /config and the options.
suite('environment options', () => {
  const HOME = { HOME: '/fake-home/u' };
  const envEngine = (env: Record<string, string>, options: Record<string, unknown> = {}) => engine(options, { env: { ...HOME, ...env } });
  const ALL: Record<string, string> = {
    AUTO_EFFORT_FLOOR: 'low',
    AUTO_EFFORT_CEILING: 'max',
    AUTO_EFFORT_PLAN_LEVEL: 'medium',
    AUTO_EFFORT_PLAN_UPSHIFT_PATTERNS: '["\\\\bplan"]',
    AUTO_EFFORT_PLAN_UPSHIFT_CHARS: '2000',
    AUTO_EFFORT_TURN_REMINDER: 'false',
    AUTO_EFFORT_ESCALATE_AFTER_FAILURES: '3',
    AUTO_EFFORT_FAILURE_PATTERNS: '["boom"]',
    AUTO_EFFORT_FAILURE_TOOLS: '["PowerShell"]',
    AUTO_EFFORT_USER_EFFORT_PINS: 'false',
    AUTO_EFFORT_MODELS: '["claude-x=deny"]',
    AUTO_EFFORT_UNKNOWN_MODELS: 'allow',
    AUTO_EFFORT_PROBATION_SWITCHES: '8',
    AUTO_EFFORT_CANARY_THRESHOLD: '0.5',
    AUTO_EFFORT_CACHE_TTL_SECONDS: '3600',
    AUTO_EFFORT_STATUS_LINE: '0',
    AUTO_EFFORT_LOG_FILE: '/var/log/effort.jsonl',
    AUTO_EFFORT_STATE_FILE: '/run/effort.json',
    AUTO_EFFORT_LOWER_ON_PASS: 'false',
    AUTO_EFFORT_TEST_COMMAND_PATTERNS: '["\\\\bmytest\\\\b"]',
  };

  it('reads every option from its own variable', async () => {
    const e = envEngine(ALL);
    await e.start();
    await e.prompt();
    const text = (await e.command('status')).text;
    expect(text).toContain('settings (plugin options; environment overrides: AUTO_EFFORT_FLOOR, AUTO_EFFORT_CEILING');
    for (const shown of ['floor=low', 'ceiling=max', 'planLevel=medium', 'planUpshiftPatterns=[\\bplan]', 'planUpshiftChars=2000', 'turnReminder=false', 'escalateAfterFailures=3', 'failurePatterns=[boom]', 'failureTools=[PowerShell]', 'userEffortPins=false', 'models=[claude-x=deny]', 'unknownModels=allow', 'probationSwitches=8', 'canaryThreshold=0.5', 'cacheTtlSeconds=3600', 'statusLine=false', 'logFile=/var/log/effort.jsonl', 'stateFile=/run/effort.json', 'lowerOnPass=false', 'testCommandPatterns=[\\bmytest\\b]']) {
      expect(text, shown).toContain(shown);
    }
    expect(e.logs.filter((line) => line.includes('option'))).toEqual([]);
  });

  it('spells each variable as a string literal in the hooks file', () => {
    const source = readFileSync(new URL('../plugins/auto-effort/hooks/auto-effort.ts', import.meta.url), 'utf8');
    const calls = [...source.matchAll(/\$\.env\.get\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    const named = calls.filter((arg) => arg.startsWith("'AUTO_EFFORT_")).map((arg) => arg.slice(1, -1));
    expect(named.sort()).toEqual(Object.keys(ALL).sort());
    expect(calls.every((arg) => /^'[A-Z_]+'$/.test(arg))).toBe(true);
  });

  it('registers set_effort for the floor and ceiling the variables give, before any prompt', async () => {
    const e = envEngine({ AUTO_EFFORT_FLOOR: 'high', AUTO_EFFORT_CEILING: 'xhigh' }, { floor: 'low', ceiling: 'max' });
    await e.start();
    expect(e.registered).toHaveLength(1);
    expect(e.registered[0].inputSchema.properties.level.enum).toEqual(['high', 'xhigh', 'auto']);
  });

  it('lets a variable beat /config and the registered options at the next prompt', async () => {
    const e = envEngine({ AUTO_EFFORT_PLAN_LEVEL: 'medium' }, { planLevel: 'xhigh' });
    await e.start();
    e.$.config.list = async () => [{ key: 'auto-effort.planLevel', value: 'xhigh', kind: 'text' }];
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'medium' });
  });

  it('reports a bad variable by name, in the log and in status, and uses the default', async () => {
    const e = envEngine({ AUTO_EFFORT_PLAN_LEVEL: 'bogus' }, { planLevel: 'xhigh' });
    await e.start();
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    expect(e.logs.filter((line) => line.includes('AUTO_EFFORT_PLAN_LEVEL'))).toHaveLength(1);
    expect((await e.command('status')).text).toContain('option errors:\n  auto-effort: option "planLevel" (environment variable AUTO_EFFORT_PLAN_LEVEL) is "bogus"');
  });

  it('applies an unset variable as absent: the option decides', async () => {
    const e = envEngine({ AUTO_EFFORT_PLAN_LEVEL: '  ' }, { planLevel: 'xhigh' });
    await e.start();
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
    expect((await e.command('status')).text).toContain('settings (plugin options)');
  });

  it('says so when `set` saves an option a variable still overrides', async () => {
    const e = envEngine({ AUTO_EFFORT_PLAN_LEVEL: 'medium' });
    await e.start();
    const reply = (await e.command('set planLevel low')).text;
    expect(e.configSets).toEqual([{ key: 'auto-effort.planLevel', value: 'low' }]);
    expect(reply).toBe('planLevel is saved as "low", but AUTO_EFFORT_PLAN_LEVEL is set and still applies: planLevel stays "medium".');
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'medium' });
  });

  // A read that fails (a host refusal) is said once per read, and the variables of the last good read stay.
  const failEnv = (e: ReturnType<typeof engine>) => {
    const read = e.$.env.get;
    e.$.env.get = async (name: string) => {
      if (name.startsWith('AUTO_EFFORT_')) throw new Error('env unavailable');
      return read(name);
    };
  };

  it('keeps the variables of the last read, still applies /config, and names the environment when a read fails', async () => {
    const e = envEngine({ AUTO_EFFORT_FLOOR: 'high' });
    await e.start();
    failEnv(e);
    e.$.config.list = async () => [{ key: 'auto-effort.planLevel', value: 'xhigh', kind: 'text' }];
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
    expect((await e.command('status')).text).toContain('floor=high');
    expect(e.logs.some((line) => line.includes('reading the option environment variables failed: env unavailable'))).toBe(true);
    expect(e.logs.some((line) => line.includes('reading the plugin options'))).toBe(false);
  });

  it('starts, registers the tool and says why when the environment cannot be read at the start', async () => {
    const e = envEngine({});
    failEnv(e);
    await e.start();
    expect(e.registered).toHaveLength(1);
    expect(e.logs.some((line) => line.includes('reading the option environment variables failed: env unavailable'))).toBe(true);
  });

  it('reads the variables in one parallel round per prompt', async () => {
    const e = envEngine({});
    await e.start();
    const read = e.$.env.get;
    const seen = { calls: 0, inFlight: 0, peak: 0 };
    e.$.env.get = async (name: string) => {
      if (!name.startsWith('AUTO_EFFORT_')) return read(name);
      seen.calls += 1;
      seen.inFlight += 1;
      seen.peak = Math.max(seen.peak, seen.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      seen.inFlight -= 1;
      return read(name);
    };
    await e.prompt();
    expect(seen).toEqual({ calls: 20, inFlight: 0, peak: 20 });
  });

  it('answers `set` as a success when the environment cannot be read', async () => {
    const e = envEngine({});
    await e.start();
    failEnv(e);
    const reply = (await e.command('set planLevel low')).text;
    expect(reply).toBe('planLevel is now "low".');
    expect(e.configSets).toEqual([{ key: 'auto-effort.planLevel', value: 'low' }]);
  });

  it('applies on `set` what the next prompt computes, and says so when a floor/ceiling conflict resets it', async () => {
    const e = envEngine({ AUTO_EFFORT_FLOOR: 'high' }, { ceiling: 'medium' });
    await e.start();
    await e.prompt();
    const conflict = 'floor=medium ceiling=xhigh';
    expect((await e.command('status')).text).toContain(conflict);
    const reply = (await e.command('set ceiling medium')).text;
    expect(reply).toBe('ceiling is saved as "medium", but "xhigh" is in effect: see the option errors in /auto-effort status.');
    expect((await e.command('status')).text).toContain(conflict);
    await e.command('set planLevel xhigh');
    expect((await e.command('status')).text).toContain(conflict);
    expect(e.registered.at(-1).inputSchema.properties.level.enum).toEqual(['medium', 'high', 'xhigh', 'auto']);
  });

  it('names the variable behind a floor/ceiling conflict', async () => {
    const e = envEngine({ AUTO_EFFORT_CEILING: 'low' }, { floor: 'high' });
    await e.start();
    expect(e.logs.some((line) => line.includes('option "ceiling" ("low", from AUTO_EFFORT_CEILING)'))).toBe(true);
  });

  it('counts only a variable that applies as in effect, in status and in the `set` reply', async () => {
    const e = envEngine({ AUTO_EFFORT_PLAN_LEVEL: 'bogus', AUTO_EFFORT_STATUS_LINE: '0' });
    await e.start();
    await e.prompt();
    const status = (await e.command('status')).text;
    expect(status).toContain('settings (plugin options; environment overrides: AUTO_EFFORT_STATUS_LINE):');
    const reply = (await e.command('set planLevel low')).text;
    expect(reply).toBe('planLevel is saved as "low", but "high" is in effect: see the option errors in /auto-effort status.');
  });
});

suite('set_effort and escalation', () => {
  it('serves set_effort and applies the level from the next request', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    const answered = await e.tool({ tool: TOOL, level: 'medium', reason: 'mechanical rename' });
    expect(answered).toEqual({ result: 'Effort set to medium from your next request; it holds across turns until you call set_effort with auto.' });
    expect(await e.step({ index: 1 })).toMatchObject({ effort: 'medium' });
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'model', level: 'medium', reason: 'mechanical rename' }));
  });

  it('holds the main chat\'s level across turns and a reload, until set_effort with auto hands it back', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    await e.tool({ tool: TOOL, level: 'medium', reason: 'mechanical rename' });
    e.reload();
    const next = await e.prompt();
    expect(next.context.at(-1)).toContain(`the level you set with ${TOOL}; it holds across turns`);
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'medium' });
    expect((await e.tool({ tool: TOOL, level: 'auto' })).result).toMatch(/^Effort handed back to the automatic rules: this turn runs at high again/);
    expect(await e.step({ turnId: 't2', index: 1 })).toMatchObject({ effort: 'high' });
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', level: 'high', reason: 'planning turn' }));
  });

  it('refuses set_effort from a sub-agent', async () => {
    const e = engine();
    await e.start();
    expect(await e.tool({ tool: TOOL, level: 'medium', agentId: 'agent-7' })).toEqual({ result: 'Not applied: set_effort applies to the main chat only.' });
  });

  it('adds the escalation line to the second failing test run of the main chat only, and the lowering line to the passing one', async () => {
    const e = engine({ planLevel: 'medium' });
    await e.start();
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'medium' });
    const run = { command: 'npm test' };
    const failing = { result: 'x', text: '2 failed, 1 passed', context: ['from another hook'] };
    expect((await e.tool(run, failing)).context).toEqual(['from another hook']);
    expect((await e.tool({ ...run, agentId: 'agent-7' }, failing)).context).toEqual(['from another hook']);
    expect((await e.tool({ command: 'cat test.log' }, failing)).context).toEqual(['from another hook']);
    const second = await e.tool(run, failing);
    expect(second.context).toHaveLength(2);
    expect(second.context[0]).toBe('from another hook');
    expect(second.context[1]).toContain('medium');
    expect(second.context[1]).toContain('high');
    expect(await e.step({ index: 2 })).toMatchObject({ effort: 'high' });
    const passing = await e.tool(run, { result: 'x', text: '3 passed', context: ['from another hook'] });
    expect(passing.context).toHaveLength(2);
    expect(passing.context[1]).toContain('back to medium from high');
    expect(await e.step({ index: 3 })).toMatchObject({ effort: 'medium' });
  });

  it('hands the controller the call\'s command beside the result text, and nothing for a call without one', async () => {
    const e = engine();
    await e.start();
    const spy = vi.spyOn(Controller.prototype, 'onToolResult');
    try {
      await e.tool({ command: 'go test ./...' }, { result: 'x', text: 'FAILED' });
      await e.tool({ tool: 'Read', file_path: 'a.txt' }, { result: 'x', text: 'body' });
      await e.tool({ command: 42 }, { result: 'x', text: 'ok' });
      expect(spy.mock.calls.map((call) => call[0])).toEqual([
        { tool: 'Bash', command: 'go test ./...', text: 'FAILED' },
        { tool: 'Read', command: undefined, text: 'body' },
        { tool: 'Bash', command: undefined, text: 'ok' },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes a tool result through untouched when the decision fails', async () => {
    const e = engine();
    await e.start();
    const spy = vi.spyOn(Controller.prototype, 'onToolResult').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const result = { result: 'x', text: 'FAILED' };
      expect(await e.tool({}, result)).toEqual(result);
    } finally {
      spy.mockRestore();
    }
    expect(e.logs.some((line) => line.includes('boom'))).toBe(true);
  });
});

// R10: the JSONL decision log.
suite('decision log', () => {
  it('appends one file per session beside `logFile`, with rows for the decision, the request and the turn', async () => {
    const e = engine({ logFile: '/logs/decisions.jsonl' });
    await e.start();
    await e.prompt('SECRET-PROMPT-TEXT');
    await e.step({});
    await e.complete({ usage: usage(10, 1000, 100, 77) });
    await e.complete({ agentId: 'agent-7' });
    await e.settle();
    await vi.waitFor(() => expect(e.logRows().map((row) => row.event)).toContain('turn'));
    expect(e.logFiles()).toEqual(['/logs/decisions.sess1.jsonl']);
    const rows = e.logRows();
    expect(rows.map((row) => row.event)).toEqual(expect.arrayContaining(['decision', 'step', 'turn']));
    expect(rows.filter((row) => row.event === 'turn')).toHaveLength(1);
    expect(rows.every((row) => typeof row.ts === 'string')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('expands ~ in the default path and writes nothing for an empty `logFile`', async () => {
    const off = engine({ logFile: '' });
    await off.start();
    await off.prompt();
    await off.step({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(off.logFiles()).toEqual([]);
    const home = engine();
    await home.start();
    await home.prompt();
    await home.step({});
    await home.settle();
    expect(home.logFiles()).toEqual(['/fake-home/u/.local/state/auto-effort/decisions.sess1.jsonl']);
  });

  // F5: `$.fs` has no append, so every write rewrites a whole file; a file holds at most 1000 rows, then the next starts.
  const seeded = (count: number) => Array.from({ length: count }, (_, n) => JSON.stringify({ ts: 't', event: 'seed', n })).join('\n') + '\n';
  const rowsIn = (e: ReturnType<typeof engine>, path: string) => (e.files.get(path) ?? '').split('\n').filter(Boolean).length;
  const drive = async (e: ReturnType<typeof engine>, steps: number) => {
    await e.start();
    await e.prompt();
    for (let n = 0; n < steps; n += 1) await e.step({ index: n });
  };

  it('starts `<session>.2` when a file is full, drops no row and never writes more than 1000 rows at once', async () => {
    const e = engine({ logFile: '/logs/decisions.jsonl' });
    e.files.set('/logs/decisions.sess1.jsonl', seeded(998));
    await drive(e, 6);
    await vi.waitFor(() => expect(e.logRows().filter((row) => row.event !== 'seed').length).toBeGreaterThanOrEqual(5));
    await vi.waitFor(() => expect(e.files.has('/logs/decisions.sess1.2.jsonl')).toBe(true));
    expect(rowsIn(e, '/logs/decisions.sess1.jsonl')).toBe(1000);
    expect(e.logRows().filter((row) => row.event === 'seed')).toHaveLength(998);
    const fresh = e.logRows().filter((row) => row.event !== 'seed').length;
    expect(rowsIn(e, '/logs/decisions.sess1.2.jsonl')).toBe(fresh - 2);
    expect(Math.max(...e.writes.map((write) => write.rows))).toBeLessThanOrEqual(1000);
  });

  it('resumes in the newest file of the session and leaves the full ones as they are', async () => {
    const e = engine({ logFile: '/logs/decisions.jsonl' });
    const full = seeded(1000);
    e.files.set('/logs/decisions.sess1.jsonl', full);
    e.files.set('/logs/decisions.sess1.2.jsonl', full);
    e.files.set('/logs/decisions.sess1.3.jsonl', seeded(5));
    await drive(e, 2);
    await vi.waitFor(() => expect(rowsIn(e, '/logs/decisions.sess1.3.jsonl')).toBeGreaterThan(5));
    expect(e.files.get('/logs/decisions.sess1.jsonl')).toBe(full);
    expect(e.files.get('/logs/decisions.sess1.2.jsonl')).toBe(full);
    expect(e.writes.filter((write) => write.path.endsWith('.jsonl')).every((write) => write.path === '/logs/decisions.sess1.3.jsonl')).toBe(true);
    expect(e.logFiles()).toHaveLength(3);
  });

  it('never writes over a later file of the session when an earlier one is missing', async () => {
    const e = engine({ logFile: '/logs/decisions.jsonl' });
    e.files.set('/logs/decisions.sess1.jsonl', seeded(999));
    const later = seeded(5);
    e.files.set('/logs/decisions.sess1.3.jsonl', later);
    await drive(e, 1100);
    await vi.waitFor(() => expect(rowsIn(e, '/logs/decisions.sess1.2.jsonl')).toBe(1000));
    await vi.waitFor(() => expect(e.files.has('/logs/decisions.sess1.4.jsonl')).toBe(true));
    expect(e.files.get('/logs/decisions.sess1.3.jsonl')).toBe(later);
  });

  it('counts only the rows it could not write when a later file of the batch fails', async () => {
    // Three option errors are one batch: two fill the first file, the third goes to `.2`, whose write fails.
    const e = engine({ logFile: '/logs/decisions.jsonl', floor: 'lowest', ceiling: 'nope', planLevel: 'bogus' });
    e.files.set('/logs/decisions.sess1.jsonl', seeded(998));
    const write = e.$.fs.write;
    e.$.fs.write = async (path: string, text: string) => {
      if (path.endsWith('.2.jsonl')) throw new Error('disk full');
      return write(path, text);
    };
    await e.start();
    await vi.waitFor(() => expect(e.logs.some((line) => line.includes('disk full'))).toBe(true));
    expect(e.logRows().filter((row) => row.event === 'option-error')).toHaveLength(2);
    expect(e.logs.find((line) => line.includes('disk full'))).toContain('1 rows were not kept');
  });
});

// D: the state file a status line reads, and the reason as a notice; the band line is gone.
suite('state file and notice', () => {
  const idle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('writes the session\'s state at the default path, once per change of its mode, level or reason', async () => {
    const e = engine();
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ version: 2, mode: 'auto', level: null }));
    await e.prompt();
    await e.step({});
    await vi.waitFor(() => expect(e.stateOf()).toEqual({ version: 2, mode: 'auto', level: 'high', reason: 'planning turn', keeper: expect.any(Number), updatedAt: expect.any(String) }));
    expect(e.files.get(STATE)!.endsWith('}\n')).toBe(true);
    const writes = () => e.writes.filter((write) => write.path === STATE).length;
    const before = writes();
    await e.step({ index: 1 });
    await e.prompt();
    await e.step({ turnId: 't2' });
    await idle();
    expect(writes()).toBe(before);
    await e.command('off');
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'off', level: null }));
    expect(writes()).toBe(before + 1);
  });

  it('names the session in a `stateFile` it is given, and writes none for an empty one', async () => {
    const set = engine({ stateFile: '/run/effort.json' });
    await set.start();
    await set.prompt();
    await set.step({});
    await vi.waitFor(() => expect(set.stateOf('/run/effort.sess1.json')).toMatchObject({ mode: 'auto', level: 'high' }));
    const none = engine({ stateFile: '' });
    await none.start();
    await none.prompt();
    await none.step({});
    await none.settle();
    await idle();
    expect([...none.files.keys()].filter((path) => !path.endsWith('.jsonl'))).toEqual([]);
  });

  // D7: a line names the keeper that vouches for it, or 0 once nothing does; a status line trusts only a live keeper.
  it('vouches for the line with the pid of a keeper it starts, whose argv carries the mark', async () => {
    const e = engine();
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', keeper: 4242 }));
    expect(e.keepers).toHaveLength(1);
    expect(e.keepers[0]!.argv).toEqual(KEEPER_ARGV);
    await e.prompt();
    await e.step({});
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', level: 'high', keeper: 4242 }));
    expect(e.keepers).toHaveLength(1);
  });

  it('says once that the keeper ended, and vouches with a new one from the next prompt', async () => {
    const e = engine();
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ keeper: 4242 }));
    e.keepers[0]!.end();
    await vi.waitFor(() => expect(e.logs.filter((line) => line.includes('the state file keeper ended'))).toHaveLength(1));
    await e.prompt();
    await e.step({});
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', level: 'high', keeper: 4243 }));
    expect(e.keepers.map((keeper) => keeper.closed)).toEqual([true, false]);
    expect(e.logs.filter((line) => line.includes('the state file keeper ended'))).toHaveLength(1);
  });

  it('writes keeper 0 as soon as its keeper ends, and says so again when a later keeper ends', async () => {
    const e = engine();
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ keeper: 4242 }));
    const ended = () => e.logs.filter((line) => line.includes('the state file keeper ended'));
    e.keepers[0]!.end();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', keeper: 0 }));
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ keeper: 4243 }));
    e.keepers[1]!.end();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ keeper: 0 }));
    expect(ended()).toHaveLength(2);
  });

  it('takes the keeper\'s pid from its stdout alone, whatever the shell writes to stderr first', async () => {
    const e = engine({}, { keeper: 'noisy' });
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', keeper: 4242 }));
    expect(e.keepers.map((keeper) => keeper.closed)).toEqual([false]);
    expect(e.logs.filter((line) => line.includes('keeper'))).toEqual([]);
  });

  it('never vouches again for a line retired at session end, by a keeper that came up after it', async () => {
    const e = engine();
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ keeper: 4242 }));
    e.keepers[0]!.end();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ keeper: 0 }));
    let open!: () => void;
    e.spawning.gate = new Promise<void>((resolve) => (open = resolve));
    e.$.clock.sleep = () => new Promise<void>(() => undefined);
    await e.prompt();
    await e.end();
    open();
    await vi.waitFor(() => expect(e.keepers[1]?.pid).toBe(4243));
    await idle();
    expect(e.stateOf()).toMatchObject({ mode: 'auto', keeper: 0 });
    e.sess.id = 'sess2';
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf('/fake-home/u/.local/state/auto-effort/state.sess2.json')).toMatchObject({ keeper: 4243 }));
  });

  it('retires a line again at the next publish when its retire at session end did not land, and says so once', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ level: 'high', keeper: 4242 }));
    const write = e.$.fs.write;
    let broken = true;
    e.$.fs.write = async (path: string, text: string) => {
      if (broken && path === STATE) throw new Error('aborted');
      return write(path, text);
    };
    await e.end();
    expect(e.stateOf()).toMatchObject({ keeper: 4242 });
    const failed = () => e.logs.filter((line) => line.includes('retiring the state file'));
    expect(failed()).toHaveLength(1);
    e.sess.id = 'sess2';
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf('/fake-home/u/.local/state/auto-effort/state.sess2.json')).toMatchObject({ keeper: 4242 }));
    expect(e.stateOf()).toMatchObject({ keeper: 4242 });
    expect(failed()).toHaveLength(1);
    broken = false;
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ level: 'high', keeper: 0 }));
  });

  it('registers /auto-effort although the screen fails while it says no keeper can start', async () => {
    const e = engine({}, { keeper: 'fails' });
    e.$.ui.log = () => {
      throw new Error('no screen');
    };
    await e.start();
    expect(e.commands.map((command) => command.name)).toEqual(['auto-effort']);
  });

  it('writes keeper 0 while no keeper can start, says so once, and vouches once one does', async () => {
    const e = engine({}, { keeper: 'fails' });
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', keeper: 0 }));
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ level: 'high', keeper: 0 }));
    const failed = () => e.logs.filter((line) => line.includes('starting the state file keeper failed: cannot start /bin/sh'));
    expect(failed()).toHaveLength(1);
    e.spawning.mode = undefined;
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ level: 'high', keeper: 4242 }));
    expect(failed()).toHaveLength(1);
  });

  it('writes keeper 0 when a keeper prints no pid within two seconds, and closes it', async () => {
    const e = engine({}, { keeper: 'silent' });
    await e.start();
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', keeper: 0 }));
    await vi.waitFor(() => expect(e.keepers[0]!.closed).toBe(true));
  });

  it('retires the line at session end: the same state, vouched by none', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'auto', level: 'high', keeper: 4242 }));
    await e.end();
    expect(e.stateOf()).toEqual({ version: 2, mode: 'auto', level: 'high', reason: 'planning turn', keeper: 0, updatedAt: expect.any(String) });
  });

  it('retires the line it leaves when `stateFile` moves or empties, and the session\'s line after /clear', async () => {
    const rows: unknown[] = [];
    const e = engine({}, { configRows: rows });
    await e.start();
    await e.prompt();
    await e.step({});
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ level: 'high', keeper: 4242 }));
    await e.command('set stateFile /run/x.json');
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf('/run/x.sess1.json')).toMatchObject({ mode: 'auto', level: 'high', keeper: 4242 }));
    expect(e.stateOf()).toMatchObject({ mode: 'auto', level: 'high', keeper: 0 });
    e.sess.id = 'sess2';
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf('/run/x.sess2.json')).toMatchObject({ keeper: 4242 }));
    expect(e.stateOf('/run/x.sess1.json')).toMatchObject({ mode: 'auto', level: 'high', keeper: 0 });
    rows.push({ key: 'auto-effort.stateFile', value: '', kind: 'text' });
    await e.prompt();
    await vi.waitFor(() => expect(e.stateOf('/run/x.sess2.json')).toMatchObject({ keeper: 0 }));
  });

  it('says once per failing state that the state file cannot be written, sends the request, and writes it once it can', async () => {
    const e = engine();
    const write = e.$.fs.write;
    let broken = true;
    e.$.fs.write = async (path: string, text: string) => {
      if (broken && path === STATE) throw new Error('read-only');
      return write(path, text);
    };
    await e.start();
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    await e.step({ index: 1 });
    await idle();
    const failed = () => e.logs.filter((line) => line.includes('writing the state file failed: read-only'));
    expect(failed()).toHaveLength(2);
    await e.tool({ tool: TOOL, level: 'medium', reason: 'mechanical rename' });
    await idle();
    expect(failed()).toHaveLength(3);
    broken = false;
    await e.step({ index: 2 });
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'model', level: 'medium' }));
  });

  it('keeps writing the state file after the failure notice itself could not be shown', async () => {
    const e = engine();
    const write = e.$.fs.write;
    const log = e.$.ui.log;
    let broken = true;
    e.$.fs.write = async (path: string, text: string) => {
      if (broken && path === STATE) throw new Error('read-only');
      return write(path, text);
    };
    e.$.ui.log = (...args: Parameters<typeof log>) => {
      if (broken) throw new Error('screen gone');
      return log(...args);
    };
    await e.start();
    await e.prompt();
    await e.step({});
    await idle();
    broken = false;
    await e.tool({ tool: TOOL, level: 'medium', reason: 'mechanical rename' });
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'model', level: 'medium' }));
  });

  it('shows the reason alone as a notice when the mode, level or reason changes, and none with statusLine off', async () => {
    const drive = async (e: ReturnType<typeof engine>) => {
      await e.start();
      await e.prompt();
      await e.step({});
      await e.step({ index: 1 });
      await e.tool({ tool: TOOL, level: 'medium', reason: 'mechanical rename' });
      await e.step({ index: 2 });
      await e.prompt();
      await e.step({ turnId: 't2' });
    };
    const on = engine();
    await drive(on);
    expect(on.toasts).toEqual(['planning turn', 'mechanical rename']);
    const off = engine({ statusLine: false });
    await drive(off);
    expect(off.toasts).toEqual([]);
    await vi.waitFor(() => expect(off.stateOf()).toMatchObject({ mode: 'model', level: 'medium' }));
  });
});

suite('session.compact', () => {
  it('lets the compaction through and keeps the canary from judging a switch across it', async () => {
    const e = engine({ logFile: '/logs/decisions.jsonl', statusLine: false });
    await e.start();
    await e.prompt();
    await e.step({}, { usage: usage(10, 0, 5000) });
    await e.tool({ tool: TOOL, level: 'medium', reason: 'rename' });
    const compact = vi.fn(async () => ({ skip: undefined }));
    expect(await e.hooks.find((h) => h.name === 'session.compact')!.fn(e.$, { trigger: 'auto', messages: [] }, compact)).toEqual({ skip: undefined });
    expect(compact).toHaveBeenCalledOnce();
    await e.step({ index: 1 }, { usage: usage(4000, 100, 900) });
    await vi.waitFor(() => expect(e.logRows().map((row) => row.event)).toContain('canary'));
    expect(e.logRows().find((row) => row.event === 'canary')).toMatchObject({ verdict: 'skip', why: 'compaction' });
    expect(e.toasts).toEqual([]);
  });
});

// R11
suite('/auto-effort', () => {
  it('answers status with the version, the level and the settings', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    const { text } = await e.command('');
    expect(text).toContain('auto-effort 0.2.3 · on');
    expect(text).toContain('level: high');
    expect(text).toContain('floor=medium');
    expect((await e.command('status')).text).toBe(text);
  });

  it('turns the plugin off and on for the session', async () => {
    const e = engine();
    await e.start();
    expect((await e.command('off')).text).toContain('off');
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'xhigh' });
    await vi.waitFor(() => expect(e.stateOf()).toMatchObject({ mode: 'off', level: null }));
    expect((await e.command('on')).text).toContain('on');
    await e.prompt();
    expect(await e.step({ turnId: 't2' })).toMatchObject({ effort: 'high' });
  });

  it('persists a setting through $.config.set, validated first, and refuses a bad value', async () => {
    const e = engine();
    await e.start();
    expect((await e.command('set planLevel medium')).text).toContain('planLevel');
    expect(e.configSets).toEqual([{ key: 'auto-effort.planLevel', value: 'medium' }]);
    await e.prompt();
    expect(await e.step({})).toMatchObject({ effort: 'medium' });
    expect((await e.command('set planUpshiftChars 2000')).text).toContain('2000');
    expect(e.configSets.at(-1)).toEqual({ key: 'auto-effort.planUpshiftChars', value: 2000 });
    const bad = await e.command('set floor nope');
    expect(bad.text).toContain('"floor"');
    expect(e.configSets).toHaveLength(2);
    expect((await e.command('launch')).text).toContain('/auto-effort [on|off|status]');
  });

  it('clears a cache mark', async () => {
    const e = engine({}, { storeValue: { unsafe: { [OPUS]: { at: 'x', ratio: 0.1, prevPrompt: 1, cacheRead: 0, from: 'high', to: 'medium' } }, probation: {}, graduated: [] } });
    await e.start();
    expect((await e.command('clear claude-fable-5-1')).text).toBe('Nothing to clear: claude-fable-5-1 has no cache mark.');
    expect((e.store.get('state') as any).unsafe[OPUS]).toBeDefined();
    expect((await e.command('clear claude-opus-5-5')).text).toContain('cleared');
    expect((e.store.get('state') as any).unsafe).toEqual({});
  });
});

suite('manifest', () => {
  const root = new URL('../', import.meta.url);
  const json = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
  it('keeps the version in every place and the hooks module listed', () => {
    const plugin = json('plugins/auto-effort/.claude-plugin/plugin.json');
    expect(json('package.json').version).toBe(plugin.version);
    expect(json('.claude-plugin/marketplace.json').plugins[0].version).toBe(plugin.version);
    expect(json('plugins/auto-effort/hooks/hooks.json')).toEqual({ modules: ['./auto-effort.ts'] });
  });
});


suite('plugin log adapter', () => {
  it.each([true, false])('writes error, warning and applied effort with PLUGIN_LOG_DIR set=%s', async (set) => {
    const home = await mkdtemp(join(tmpdir(), 'auto-effort-adapter-'));
    const root = join(home, 'logs');
    const dir = set ? join(root, 'auto-effort') : join(home, '.local/state/auto-effort/logs');
    const e = engine({ floor: 'lowest', logFile: '' }, { env: { HOME: home, PLUGIN_LOG_DIR: set ? root : undefined } });
    e.$.process.run = async (argv) => { const r = await promisify(execFile)('/bin/sh', argv.slice(1)); return { exitCode: 0, ...r }; };
    await e.start(); await e.start();
    await e.prompt(); await e.step({}); await e.step({ index: 1, effort: 'high' });
    const spy = vi.spyOn(Controller.prototype, 'setEffort').mockImplementation(() => { throw new Error('unknown level'); });
    try {
      expect(await e.tool({ tool: TOOL, level: 'medium' })).toEqual({ result: 'Not applied: the effort stays as it was.' });
      expect(e.logs).toContain('auto-effort: applying set_effort failed: unknown level; the effort stays as it was');
      // The unfixed tree has no end hook; observe missing rows as assertions, not a helper exception.
      const end = e.hooks.find((h) => h.name === 'session.end');
      if (end) await e.end();
      const read = async (file: string) => { try { return (await readFile(join(dir, file), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
      expect(await read('errors.jsonl')).toEqual([expect.objectContaining({ level: 'error', event: 'set-effort-failed', where: 'hooks/auto-effort.ts#answerSetEffort', session: 'sess1', detail: { error: 'unknown level' } })]);
      expect(await read('warnings.jsonl')).toEqual([expect.objectContaining({ level: 'warning', event: 'option-error', where: 'hooks/auto-effort.ts#reportErrors' })]);
      expect(await read('info.jsonl')).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'info', event: 'effort-applied', session: 'sess1', detail: { level: 'high', source: 'plan' } })]));
    } finally { spy.mockRestore(); await rm(home, { recursive: true, force: true }); }
  });

  it('keeps work results and reports one contextual process failure until recovery', async () => {
    const e = engine({ floor: 'lowest', logFile: '' }, { env: { HOME: '/isolated/home', PLUGIN_LOG_DIR: '/isolated/logs' } });
    e.$.process.run = async () => { throw new Error('cannot spawn'); };
    await e.start();
    await e.prompt();
    const end = e.hooks.find((h) => h.name === 'session.end');
    if (end) await e.end();
    const notices = () => e.logs.filter((s) => s.includes('plugin log '));
    expect(notices()).toEqual([expect.stringContaining('/isolated/logs/auto-effort: cannot spawn')]);
    e.$.config.list = async () => { throw new Error('bad config'); };
    expect((await e.prompt('unchanged')).text).toBe('unchanged');
    await e.end();
    expect(notices()).toHaveLength(1);
    e.$.process.run = async () => ({ exitCode: 0, stdout: '', stderr: '' });
    await e.prompt(); await e.end();
    e.$.process.run = async () => { throw new Error('second outage'); };
    await e.prompt(); await e.end();
    expect(notices()).toHaveLength(2);
    expect(notices()[1]).toContain('second outage');
  });

  it('names missing env/home without throwing or blocking a prompt', async () => {
    const e = engine({ floor: 'lowest', logFile: '' }, { env: {} });
    await e.start();
    expect((await e.prompt('unchanged')).text).toBe('unchanged');
    const end = e.hooks.find((h) => h.name === 'session.end');
    if (end) await e.end();
    expect(e.logs.filter((s) => s.includes('plugin log off:'))).toEqual([expect.stringContaining('plugin log off: no PLUGIN_LOG_DIR and no HOME')]);
  });

  it('logs applied rewrites only, and preserves a next-hook rethrow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auto-effort-changes-'));
    const e = engine({ logFile: '' }, { env: { HOME: home, PLUGIN_LOG_DIR: home } });
    e.$.process.run = async (argv) => { const r = await promisify(execFile)('/bin/sh', argv.slice(1)); return { exitCode: 0, ...r }; };
    try {
      await e.start(); await e.prompt(); await e.step({});
      await e.step({ index: 1, effort: 'high' });
      const error = new Error('upstream failed');
      const hook = e.hooks.find((h) => h.name === 'turn.step')!.fn;
      const gen = hook(e.$, { turnId: 't1', index: 2, model: OPUS, effort: 'high', messageCount: 3 }, () => (async function* () { throw error; })());
      await expect(gen.next()).rejects.toBe(error);
      const end = e.hooks.find((h) => h.name === 'session.end');
      if (end) await e.end();
      const read = async (level: string) => { try { return (await readFile(join(home, 'auto-effort', level + '.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; } };
      expect((await read('info')).filter((r) => r.event === 'effort-applied')).toEqual([expect.objectContaining({ detail: { level: 'high', source: 'plan' } })]);
      expect(await read('errors')).toEqual([expect.objectContaining({ event: 'hook-threw', where: 'hooks/auto-effort.ts#turn.step', detail: { error: 'upstream failed' } })]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
