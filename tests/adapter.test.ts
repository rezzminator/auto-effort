import { readFileSync } from 'node:fs';
import { describe as suite, expect, it, vi } from 'vitest';
import { register } from '../plugins/auto-effort/hooks/auto-effort.ts';
import { Controller } from '../plugins/auto-effort/src/controller.ts';

// A stand-in engine: the hooks the module registers, driven the way the engine drives them, over a fake `$`.
type Hook = (...args: any[]) => any;
const TOOL = 'mcp__auto-effort__set_effort';
const OPUS = 'claude-opus-5-5';
const usage = (input: number, cacheRead: number, cacheWrite: number, output = 100) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, model: OPUS });

function engine(options: Record<string, unknown> = {}, o: { configRows?: unknown[]; storeGet?: () => Promise<unknown>; storeValue?: unknown } = {}) {
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
  const $ = {
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
    env: { get: async (name: string) => (name === 'HOME' ? '/fake-home/u' : undefined) },
    config: {
      list: async () => o.configRows ?? [],
      set: async (args: unknown) => (configSets.push(args), { value: (args as { value: unknown }).value }),
    },
    clock: { now: async () => Date.now() },
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
    $, sess, state, logs, statuses, toasts, files, writes, store, registered, commands, configSets, hooks, sent,
    // A plugin reload (or an option change): the module registers again and builds a new controller; the host's state stays.
    reload: (opts: Record<string, unknown> = options) => {
      hooks.length = 0;
      load(opts);
    },
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
    settle: () => vi.waitFor(() => expect(files.size).toBeGreaterThan(0)),
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
    expect(e.statuses.at(-1)).toContain('you set /effort');
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
    expect(e.logs.some((line) => line.includes('no state') && line.includes('on and unpinned'))).toBe(true);
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
    expect(e.state.get('auto-effort/session/sess2')).toEqual({ enabled: false, pin: null });
    expect(e.state.get('auto-effort/session/sess1')).not.toEqual({ enabled: false, pin: null });
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
    await vi.waitFor(() => expect(e.logs.filter((line) => line.includes('saving the on/off and pin')).length).toBeGreaterThan(0));
    await new Promise((done) => setTimeout(done, 20));
    expect(e.logs.filter((line) => line.includes('saving the on/off and pin'))).toHaveLength(1);
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
    expect(e.registered[0].description).toContain('Call it in your first response of every user turn');
    expect(e.registered[0].inputSchema.properties.level.enum).toEqual(['medium', 'high', 'xhigh']);
    expect(e.registered[0].inputSchema.properties.effort.enum).toEqual(['medium', 'high', 'xhigh']);
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
    expect(e.statuses.at(-1)).toBe('effort auto: high · planning turn (plan)');
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

  it('keeps going when the status line or the log cannot be written', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    e.$.ui.status = () => {
      throw new Error('no status');
    };
    e.$.fs.write = async () => {
      throw new Error('disk full');
    };
    expect(await e.step({})).toMatchObject({ effort: 'high' });
    await vi.waitFor(() => expect(e.logs.some((line) => line.includes('disk full'))).toBe(true));
  });

  // R9 through the adapter: the toast and the mark in the store.
  it('toasts once and stores the unsafe mark when the cache breaks after a switch', async () => {
    const e = engine();
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
    const e = engine();
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

suite('set_effort and escalation', () => {
  it('serves set_effort and applies the level from the next request', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    const answered = await e.tool({ tool: TOOL, level: 'medium', reason: 'mechanical rename' });
    expect(answered).toEqual({ result: 'Effort set to medium from your next request until this turn ends.' });
    expect(await e.step({ index: 1 })).toMatchObject({ effort: 'medium' });
    expect(e.statuses.at(-1)).toBe('effort auto: medium · mechanical rename (model)');
  });

  it('refuses set_effort from a sub-agent', async () => {
    const e = engine();
    await e.start();
    expect(await e.tool({ tool: TOOL, level: 'medium', agentId: 'agent-7' })).toEqual({ result: 'Not applied: set_effort applies to the main chat only.' });
  });

  it('adds the escalation line to the second failing test run of the main chat only, and the lowering line to the passing one', async () => {
    const e = engine();
    await e.start();
    await e.prompt();
    await e.step({});
    await e.tool({ tool: TOOL, level: 'medium', reason: 'rename' });
    await e.step({ index: 1 });
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
    expect([...e.files.keys()]).toEqual(['/logs/decisions.sess1.jsonl']);
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
    expect(off.files.size).toBe(0);
    const home = engine();
    await home.start();
    await home.prompt();
    await home.step({});
    await home.settle();
    expect([...home.files.keys()]).toEqual(['/fake-home/u/.local/state/auto-effort/decisions.sess1.jsonl']);
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
    expect(e.writes.every((write) => write.path === '/logs/decisions.sess1.3.jsonl')).toBe(true);
    expect([...e.files.keys()]).toHaveLength(3);
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

suite('session.compact', () => {
  it('lets the compaction through and keeps the canary from judging a switch across it', async () => {
    const e = engine({ logFile: '/logs/decisions.jsonl' });
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
    expect(text).toContain('auto-effort 0.1.0 · on');
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
    expect(e.statuses.at(-1)).toBeUndefined();
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
