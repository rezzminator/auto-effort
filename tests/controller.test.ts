import { describe, expect, it } from 'vitest';
import { Controller, type Row } from '../plugins/auto-effort/src/controller.ts';
import { EMPTY_PERSISTED, markUnsafe, type Persisted } from '../plugins/auto-effort/src/gate.ts';
import { resolveSettings } from '../plugins/auto-effort/src/settings.ts';
import { escalationLine } from '../plugins/auto-effort/src/text.ts';

const OPUS = 'claude-opus-5-5';
const TOOL = 'mcp__auto-effort__set_effort';
const usage = (input: number, cacheRead: number, cacheWrite: number, output = 100) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

// A controller on a clock the test moves, and the rows every call returned.
function rig(raw: Record<string, unknown> = {}, persisted: Persisted = EMPTY_PERSISTED) {
  const clock = { t: 1_000_000 };
  const rows: Row[] = [];
  const ctl = new Controller(resolveSettings(raw).settings, persisted, () => clock.t);
  ctl.toolName = TOOL;
  const keep = <T extends { rows: Row[] }>(out: T): T => (rows.push(...out.rows), out);
  return {
    ctl,
    clock,
    rows,
    prompt: (text = 'fix the failing parser test', model = OPUS) => keep(ctl.onPrompt({ text, model, midTurn: false })),
    // One main request: begin, then end with `u` (or no usage when null).
    step(turn: string, index: number, o: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number; model?: string; n?: number; u?: ReturnType<typeof usage> | null } = {}) {
      const plan = keep(ctl.beginStep({ turnId: turn, index, model: o.model ?? OPUS, effort: 'effort' in o ? o.effort : 'xhigh', messageCount: o.n ?? 2 + index * 2 }));
      const end = keep(ctl.endStep(o.u === undefined ? usage(10, 1000 * (index + 1), 100) : o.u));
      return { plan, end };
    },
    set: (input: Record<string, unknown>, agent = false) => keep(ctl.setEffort({ input, agent })),
    tool: (tool: string, text: string) => keep(ctl.onToolResult({ tool, text })),
  };
}

// R2: the first request of a turn runs at the planning level and holds.
describe('planning level (R2)', () => {
  it('starts a turn at planLevel, names it in the status line and holds it for the turn', () => {
    const r = rig();
    r.prompt();
    const first = r.step('t1', 0).plan;
    expect(first).toMatchObject({ send: 'high', level: 'high', source: 'plan', reason: 'planning turn', newTurn: true });
    expect(first.status).toBe('effort auto: high · planning turn (plan)');
    expect(r.step('t1', 1).plan).toMatchObject({ send: 'high', level: 'high', source: 'plan', newTurn: false });
  });

  it('plans a prompt that asks for thought at xhigh, and leaves a request already at that effort untouched', () => {
    const r = rig();
    r.prompt('think about the retry design');
    expect(r.step('t1', 0, { effort: 'high' }).plan).toMatchObject({ send: 'xhigh', level: 'xhigh', source: 'plan', reason: 'planning: prompt asks for thought' });
    r.prompt();
    expect(r.step('t2', 0, { effort: 'high' }).plan).toMatchObject({ send: undefined, level: 'high', source: 'plan' });
  });

  it('plans a turn no prompt announced at the planning level', () => {
    const r = rig();
    expect(r.step('t1', 0).plan).toMatchObject({ send: 'high', source: 'plan' });
  });

  it('uses each prompt for the turn that follows it only', () => {
    const r = rig();
    r.prompt('design the cache');
    expect(r.step('t1', 0).plan.level).toBe('xhigh');
    r.prompt('now rename it');
    expect(r.step('t2', 0).plan.level).toBe('high');
  });

  it('leaves a model without an effort setting untouched', () => {
    const r = rig();
    r.prompt();
    expect(r.step('t1', 0, { effort: undefined }).plan).toMatchObject({ send: undefined, level: undefined, source: 'off', status: undefined });
    expect(r.step('t2', 0, { effort: 64 }).plan).toMatchObject({ send: undefined, source: 'off' });
    r.prompt();
    expect(r.step('t3', 0, { effort: 'xhigh' }).plan).toMatchObject({ send: 'high', source: 'plan' });
  });
});

// R3 and R6: set_effort applies from the next request, holds to the end of the turn, and is clamped.
describe('set_effort (R3, R6)', () => {
  it('applies the level from the next request on and names it in the result', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0);
    expect(r.set({ level: 'medium', reason: 'mechanical rename' }).text).toBe('Effort set to medium from your next request until this turn ends.');
    const next = r.step('t1', 1).plan;
    expect(next).toMatchObject({ send: 'medium', level: 'medium', source: 'model', reason: 'mechanical rename' });
    expect(next.status).toBe('effort auto: medium · mechanical rename (model)');
    expect(r.step('t1', 2).plan).toMatchObject({ send: 'medium', source: 'model' });
  });

  it('takes `effort` as the key too', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0);
    expect(r.set({ effort: 'xhigh', reason: 'root cause not found' }).text).toContain('Effort set to xhigh');
    expect(r.step('t1', 1, { effort: 'medium' }).plan).toMatchObject({ send: 'xhigh', source: 'model' });
  });

  it('clamps to the floor and the ceiling and says so', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0);
    const low = r.set({ level: 'low', reason: 'lookup' }).text;
    expect(low).toContain('Effort set to medium');
    expect(low).toContain('floor');
    expect(r.step('t1', 1).plan.level).toBe('medium');
    const max = r.set({ level: 'max', reason: 'hard' }).text;
    expect(max).toContain('Effort set to xhigh');
    expect(max).toContain('ceiling');
    const wide = rig({ ceiling: 'max' });
    wide.prompt();
    wide.step('t1', 0);
    expect(wide.set({ level: 'max' }).text).toContain('Effort set to max');
  });

  it('refuses a level it does not know, a missing level and a sub-agent, and changes nothing', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0);
    expect(r.set({ level: 'ultra', reason: 'x' }).text).toMatch(/^Not applied: .*medium, high, xhigh/);
    expect(r.set({ reason: 'x' }).text).toMatch(/^Not applied/);
    expect(r.set({ level: 'medium', reason: 'x' }, true).text).toBe('Not applied: set_effort applies to the main chat only.');
    expect(r.step('t1', 1).plan).toMatchObject({ level: 'high', source: 'plan' });
  });

  it('quotes a short piece of a level it refuses, never the whole value', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0);
    const out = r.set({ level: 'x'.repeat(1000), reason: 'x' });
    expect(out.text).toMatch(/^Not applied: .*got "xxxxxxxx/);
    expect(out.text.length).toBeLessThan(200);
    expect(JSON.stringify(out.rows).length).toBeLessThan(300);
  });

  it('ends with the turn: the next turn plans afresh', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0);
    r.set({ level: 'medium', reason: 'rename' });
    r.step('t1', 1);
    r.prompt();
    expect(r.step('t2', 0).plan).toMatchObject({ level: 'high', source: 'plan' });
  });

  it('refuses while the user pins the effort, the plugin is off, or the model is not enabled', () => {
    const pinned = rig();
    pinned.prompt();
    pinned.step('t1', 0, { effort: 'xhigh' });
    pinned.prompt();
    pinned.step('t2', 0, { effort: 'low' });
    expect(pinned.set({ level: 'high', reason: 'x' }).text).toMatch(/^Not applied: .*pinned.*\/auto-effort on/);
    const off = rig();
    off.ctl.setEnabled(false);
    off.prompt();
    off.step('t1', 0);
    expect(off.set({ level: 'high', reason: 'x' }).text).toMatch(/^Not applied: .*off/);
    const denied = rig();
    denied.prompt('x', 'claude-sonnet-5');
    denied.step('t1', 0, { model: 'claude-sonnet-5' });
    expect(denied.set({ level: 'high', reason: 'x' }).text).toMatch(/^Not applied: .*claude-sonnet-5/);
  });
});

// R4: one context line at prompt.submit naming the level and the tool.
describe('turn reminder (R4)', () => {
  it('names the planning level the turn starts at and the tool, in one line', () => {
    const r = rig();
    const { reminder } = r.prompt('rename it');
    expect(reminder).toContain('high');
    expect(reminder).toContain(TOOL);
    expect(r.prompt('think about it').reminder).toContain('xhigh');
  });

  it('is left out when switched off, mid-turn, pinned, for a disabled plugin or a model it will not touch', () => {
    expect(rig().prompt().reminder).toContain(TOOL);
    expect(rig({ turnReminder: false }).prompt().reminder).toBeUndefined();
    const midTurn = rig();
    expect(midTurn.ctl.onPrompt({ text: 'also this', model: OPUS, midTurn: true }).reminder).toBeUndefined();
    const off = rig();
    off.ctl.setEnabled(false);
    expect(off.prompt().reminder).toBeUndefined();
    expect(rig().prompt('x', 'claude-sonnet-5').reminder).toBeUndefined();
    const pinned = rig();
    pinned.prompt();
    pinned.step('t1', 0, { effort: 'xhigh' });
    pinned.prompt();
    pinned.step('t2', 0, { effort: 'low' });
    expect(pinned.prompt().reminder).toBeUndefined();
  });

  it('plans the next turn from a prompt typed to wait for the running one, and gives it the reminder', () => {
    const r = rig();
    r.prompt('rename it');
    r.step('t1', 0);
    const queued = r.ctl.onPrompt({ text: 'think about the retry design', model: OPUS, midTurn: true, wait: true });
    expect(queued.reminder).toContain('xhigh');
    expect(queued.reminder).toContain(TOOL);
    expect(r.step('t1', 1).plan).toMatchObject({ level: 'high', source: 'plan', newTurn: false });
    expect(r.step('t2', 0).plan).toMatchObject({ level: 'xhigh', reason: 'planning: prompt asks for thought', newTurn: true });
  });

  it('keeps the text of a prompt delivered into the running turn for a next turn no prompt announced, with no reminder', () => {
    const r = rig();
    r.prompt('rename it');
    r.step('t1', 0);
    expect(r.ctl.onPrompt({ text: 'think about the retry design', model: OPUS, midTurn: true, wait: false }).reminder).toBeUndefined();
    expect(r.step('t2', 0).plan).toMatchObject({ level: 'xhigh', newTurn: true });
    r.prompt('rename it');
    expect(r.ctl.onPrompt({ text: 'think about it', model: OPUS, midTurn: true, wait: false }).reminder).toBeUndefined();
    expect(r.step('t3', 0).plan).toMatchObject({ level: 'high', reason: 'planning turn' });
  });
});

// R5: after `escalateAfterFailures` failing test runs within a turn the level rises one step, with one context line.
describe('escalation (R5)', () => {
  function atMedium(raw: Record<string, unknown> = {}) {
    const r = rig(raw);
    r.prompt();
    r.step('t1', 0);
    r.set({ level: 'medium', reason: 'rename' });
    r.step('t1', 1);
    return r;
  }

  it('raises one step on the second failing run, with one line, and holds the new level', () => {
    const r = atMedium();
    expect(r.tool('Bash', 'FAILED (failures=1)').context).toBeUndefined();
    const second = r.tool('Bash', '1 failed, 4 passed');
    expect(second.context).toBe(escalationLine(2, 'medium', 'high'));
    const next = r.step('t1', 2).plan;
    expect(next).toMatchObject({ send: 'high', level: 'high', source: 'escalation' });
    expect(next.status).toMatch(/^effort auto: high · .*\(escalation\)$/);
    expect(r.step('t1', 3).plan.level).toBe('high');
  });

  it('counts afresh after a rise and stops at the ceiling', () => {
    const r = atMedium();
    r.tool('Bash', 'Traceback (most recent call last)');
    r.tool('Bash', 'AssertionError: 1 != 2');
    expect(r.tool('Bash', 'panic: nil map').context).toBeUndefined();
    expect(r.tool('Bash', '--- FAIL: TestX').context).toBe(escalationLine(2, 'high', 'xhigh'));
    expect(r.step('t1', 2).plan.level).toBe('xhigh');
    r.tool('Bash', 'FAIL');
    expect(r.tool('Bash', 'FAILED').context).toBeUndefined();
    expect(r.step('t1', 3).plan.level).toBe('xhigh');
  });

  it('respects a lower ceiling and a custom threshold', () => {
    const low = atMedium({ ceiling: 'high', escalateAfterFailures: 1 });
    expect(low.tool('Bash', 'FAILED').context).toBe(escalationLine(1, 'medium', 'high'));
    expect(low.tool('Bash', 'FAILED').context).toBeUndefined();
    expect(low.step('t1', 2).plan.level).toBe('high');
  });

  it('counts only matching results of the tools in `failureTools`, and only within one turn', () => {
    const r = atMedium();
    expect(r.tool('Bash', 'all 12 tests passed').context).toBeUndefined();
    expect(r.tool('Read', 'AssertionError panic: Traceback FAILED').context).toBeUndefined();
    expect(r.tool('Bash', 'FAILED').context).toBeUndefined();
    r.prompt();
    r.step('t2', 0);
    expect(r.tool('Bash', 'FAILED').context).toBeUndefined();
    expect(r.step('t2', 1).plan).toMatchObject({ level: 'high', source: 'plan' });
  });

  it('does nothing while the plugin is off', () => {
    const on = atMedium();
    on.tool('Bash', 'FAILED');
    expect(on.tool('Bash', 'FAILED').context).toBe(escalationLine(2, 'medium', 'high'));
    const off = atMedium();
    off.ctl.setEnabled(false);
    expect(off.tool('Bash', 'FAILED').context).toBeUndefined();
    expect(off.tool('Bash', 'FAILED').context).toBeUndefined();
  });
});

// R7: a change of the session effort between turns is the user's pin.
describe('user pin (R7)', () => {
  function pinned(raw: Record<string, unknown> = {}) {
    const r = rig(raw);
    r.prompt();
    r.step('t1', 0, { effort: 'xhigh' });
    r.prompt();
    r.step('t2', 0, { effort: 'xhigh' });
    r.prompt();
    return r;
  }

  it('steps aside when the session effort changed between turns, and shows the pin', () => {
    const r = pinned();
    const plan = r.step('t3', 0, { effort: 'medium' }).plan;
    expect(plan).toMatchObject({ send: undefined, level: 'medium', source: 'pin', newTurn: true });
    expect(plan.status).toBe('effort auto: medium · you set /effort (pin)');
    expect(r.step('t3', 1, { effort: 'medium' }).plan).toMatchObject({ send: undefined, source: 'pin' });
    r.prompt();
    expect(r.step('t4', 0, { effort: 'medium' }).plan).toMatchObject({ send: undefined, source: 'pin' });
  });

  it('resumes on `/auto-effort on`', () => {
    const r = pinned();
    r.step('t3', 0, { effort: 'medium' });
    r.ctl.setEnabled(true);
    r.prompt();
    expect(r.step('t4', 0, { effort: 'medium' }).plan).toMatchObject({ send: 'high', source: 'plan' });
  });

  it('pins afresh when the user changes the effort again after resuming', () => {
    const r = pinned();
    r.step('t3', 0, { effort: 'medium' });
    r.ctl.setEnabled(true);
    r.prompt();
    r.step('t4', 0, { effort: 'medium' });
    r.prompt();
    expect(r.step('t5', 0, { effort: 'low' }).plan).toMatchObject({ source: 'pin', send: undefined });
  });

  it('is off when `userEffortPins` is false, and a model change is not a pin', () => {
    const off = pinned({ userEffortPins: false });
    expect(off.step('t3', 0, { effort: 'medium' }).plan).toMatchObject({ source: 'plan', send: 'high' });
    const swapped = pinned();
    expect(swapped.step('t3', 0, { effort: 'medium', model: 'claude-fable-5-1' }).plan).toMatchObject({ source: 'plan', send: 'high' });
  });

  it('does not count its own rewrites as a change by the user', () => {
    const r = rig();
    for (const turn of ['t1', 't2', 't3']) {
      r.prompt();
      expect(r.step(turn, 0, { effort: 'xhigh' }).plan.source).toBe('plan');
      r.set({ level: 'medium', reason: 'rename' });
      expect(r.step(turn, 1, { effort: 'xhigh' }).plan.source).toBe('model');
    }
  });
});

// R8: the model gate.
describe('model gate (R8)', () => {
  it.each([
    ['claude-sonnet-5', 'deny'],
    ['claude-opus-5', 'off'],
  ])('leaves %s (%s) alone', (model) => {
    const r = rig();
    r.prompt('x', model);
    const plan = r.step('t1', 0, { model }).plan;
    expect(plan).toMatchObject({ send: undefined, level: undefined, source: 'off', status: undefined });
    expect(plan.reason).toContain(model);
  });

  it('acts on a model on probation and on an unknown one when `unknownModels` allows it', () => {
    const probation = rig();
    probation.prompt('x', 'claude-sonnet-5-5');
    expect(probation.step('t1', 0, { model: 'claude-sonnet-5-5' }).plan).toMatchObject({ send: 'high', source: 'plan' });
    const unknown = rig({ unknownModels: 'allow' });
    unknown.prompt('x', 'claude-new-9');
    expect(unknown.step('t1', 0, { model: 'claude-new-9' }).plan).toMatchObject({ send: 'high', source: 'plan' });
  });

  it('is off for the session on `/auto-effort off`', () => {
    const r = rig();
    r.ctl.setEnabled(false);
    r.prompt();
    expect(r.step('t1', 0).plan).toMatchObject({ send: undefined, source: 'off', status: undefined });
    r.ctl.setEnabled(true);
    r.prompt();
    expect(r.step('t2', 0).plan).toMatchObject({ send: 'high', source: 'plan' });
  });
});

// R9: the cache canary.
describe('cache canary (R9)', () => {
  // Request 1 at high, then a switch to medium at request 2 whose cache read is `read`.
  function switched(read: number, o: { r?: ReturnType<typeof rig>; gapMs?: number; compact?: boolean; model?: string } = {}) {
    const r = o.r ?? rig();
    const model = o.model ?? OPUS;
    r.prompt('x', model);
    r.step('t1', 0, { model, u: usage(10, 0, 5000) });
    r.set({ level: 'medium', reason: 'rename' });
    r.clock.t += o.gapMs ?? 20_000;
    if (o.compact) r.ctl.noteCompaction();
    const out = r.step('t1', 1, { model, effort: 'xhigh', u: usage(20, read, 100) });
    return { r, out };
  }

  it('is clean at a ratio of 0.9 or more, logs it and marks nothing', () => {
    const { r, out } = switched(4990);
    expect(out.end.persisted).toBeUndefined();
    expect(out.end.toast).toBeUndefined();
    expect(r.rows.find((row) => row.event === 'canary')).toMatchObject({ verdict: 'ok', from: 'high', to: 'medium' });
    expect(r.rows.find((row) => row.event === 'canary')?.ratio).toBeCloseTo(4990 / 5010, 4);
  });

  it('marks the model unsafe below the threshold, toasts once and stops switching on that model', () => {
    const { r, out } = switched(200);
    expect(out.end.persisted?.unsafe[OPUS]).toMatchObject({ from: 'high', to: 'medium' });
    expect(out.end.toast).toContain(OPUS);
    expect(out.end.toast).toContain('/auto-effort clear');
    expect(r.rows.find((row) => row.event === 'canary')).toMatchObject({ verdict: 'fail' });
    const after = r.step('t1', 2, { effort: 'xhigh' });
    expect(after.plan).toMatchObject({ send: undefined, source: 'off' });
    expect(after.end.toast).toBeUndefined();
    expect(r.ctl.persisted.unsafe[OPUS]).toBeDefined();
  });

  it('keeps the mark across sessions: a new controller on the stored value stays off, until it is cleared', () => {
    const { out } = switched(200);
    const later = rig({}, out.end.persisted);
    later.prompt();
    const first = later.step('t9', 0);
    expect(first.plan).toMatchObject({ send: undefined, source: 'off' });
    expect(first.plan.toast).toContain(OPUS);
    expect(later.step('t9', 1).plan.toast).toBeUndefined();
    later.ctl.clear(OPUS);
    later.prompt();
    expect(later.step('t10', 0).plan).toMatchObject({ send: 'high', source: 'plan' });
  });

  it.each([
    ['past the cache TTL', { gapMs: 301_000 }, 'ttl'],
    ['across a compaction', { compact: true }, 'compaction'],
  ])('does not judge a switch %s', (_name, o, why) => {
    const { r, out } = switched(200, o);
    expect(out.end.persisted).toBeUndefined();
    expect(r.rows.find((row) => row.event === 'canary')).toMatchObject({ verdict: 'skip', why });
  });

  it('runs no check on the first request, on a request that kept the effort or on a model change', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0, { u: usage(10, 0, 5000) });
    r.step('t1', 2, { u: usage(20, 5100, 100) });
    expect(r.rows.filter((row) => row.event === 'canary')).toEqual([]);
    r.prompt('x', 'claude-fable-5-1');
    r.step('t2', 0, { model: 'claude-fable-5-1', u: usage(10, 100, 100) });
    expect(r.rows.filter((row) => row.event === 'canary')).toEqual([]);
    r.set({ level: 'medium', reason: 'x' });
    r.step('t2', 1, { model: 'claude-fable-5-1', u: usage(10, 200, 100) });
    expect(r.rows.filter((row) => row.event === 'canary')).toHaveLength(1);
  });

  it('graduates a probation model after `probationSwitches` clean switches', () => {
    const r = rig({ probationSwitches: 2 });
    const model = 'claude-sonnet-5-5';
    r.prompt('x', model);
    let whole = 1000;
    r.step('t1', 0, { model, u: usage(10, 0, whole) });
    let persisted: Persisted | undefined;
    const levels = ['medium', 'high', 'medium'] as const;
    levels.forEach((level, i) => {
      r.set({ level, reason: 'x' });
      r.clock.t += 1000;
      const out = r.step('t1', i + 1, { model, u: usage(10, whole, 10) });
      whole += 20;
      persisted = out.end.persisted ?? persisted;
    });
    expect(persisted?.graduated).toContain(model);
    expect(r.rows.find((row) => row.event === 'gate' && row.model === model)).toMatchObject({ status: 'allow', why: 'graduated' });
  });

  it('judges a switch the plugin made after a pin ended', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0, { effort: 'xhigh', u: usage(10, 0, 5000) });
    r.prompt();
    r.step('t2', 0, { effort: 'low', u: usage(10, 4900, 200) });
    r.ctl.setEnabled(true);
    r.prompt();
    r.clock.t += 5_000;
    r.step('t3', 0, { effort: 'low', u: usage(10, 5000, 300) });
    expect(r.rows.filter((row) => row.event === 'canary')).toHaveLength(1);
  });
});

// R10: the decision log has one row per decision, switch and canary result, and no message text.
describe('decision rows (R10)', () => {
  it('records the decision, the switch, the set_effort call, the escalation, the request and the turn', () => {
    const r = rig();
    r.prompt('SECRET-PROMPT-TEXT think');
    r.step('t1', 0, { u: usage(10, 0, 5000) });
    r.set({ level: 'medium', reason: 'mechanical rename' });
    r.step('t1', 1, { u: usage(10, 4990, 100) });
    r.tool('Bash', 'FAILED SECRET-TOOL-OUTPUT');
    r.tool('Bash', 'FAILED SECRET-TOOL-OUTPUT');
    r.step('t1', 2, { u: usage(10, 5090, 100) });
    r.rows.push(...r.ctl.completeTurn({ turnId: 't1', durationMs: 4000, usage: usage(30, 9000, 200, 450) }));
    const events = r.rows.map((row) => row.event);
    expect(events).toEqual(expect.arrayContaining(['decision', 'step', 'switch', 'set_effort', 'canary', 'escalation', 'turn']));
    expect(r.rows.find((row) => row.event === 'decision')).toMatchObject({ turnId: 't1', level: 'xhigh', source: 'plan', model: OPUS });
    expect(r.rows.find((row) => row.event === 'switch')).toMatchObject({ from: 'xhigh', to: 'medium', source: 'model' });
    expect(r.rows.find((row) => row.event === 'set_effort')).toMatchObject({ requested: 'medium', applied: 'medium', reason: 'mechanical rename' });
    expect(r.rows.find((row) => row.event === 'escalation')).toMatchObject({ from: 'medium', to: 'high', failures: 2 });
    expect(r.rows.find((row) => row.event === 'step' && row.index === 1)).toMatchObject({ sent: 'medium', source: 'model', cacheRead: 4990, output: 100 });
    expect(r.rows.find((row) => row.event === 'turn')).toMatchObject({ turnId: 't1', startLevel: 'xhigh', endLevel: 'high', steps: 3, setEffortCalls: 1, escalations: 1, durationMs: 4000, output: 450 });
    const text = JSON.stringify(r.rows);
    expect(text).not.toContain('SECRET-PROMPT-TEXT');
    expect(text).not.toContain('SECRET-TOOL-OUTPUT');
  });

  it('shows no status line when `statusLine` is off', () => {
    const shown = rig();
    shown.prompt();
    expect(shown.step('t1', 0).plan.status).toBe('effort auto: high · planning turn (plan)');
    const r = rig({ statusLine: false });
    r.prompt();
    expect(r.step('t1', 0).plan).toMatchObject({ status: undefined, level: 'high' });
  });
});

describe('controller upkeep', () => {
  it('forgets a request that failed, so the next one is not compared with it', () => {
    const r = rig();
    r.prompt();
    r.step('t1', 0, { u: usage(10, 0, 5000) });
    r.set({ level: 'medium', reason: 'x' });
    r.ctl.beginStep({ turnId: 't1', index: 1, model: OPUS, effort: 'xhigh', messageCount: 4 });
    r.ctl.failStep();
    r.set({ level: 'medium', reason: 'x' });
    r.step('t1', 2, { u: usage(10, 100, 100) });
    expect(r.rows.filter((row) => row.event === 'canary')).toEqual([]);
    r.set({ level: 'high', reason: 'x' });
    r.clock.t += 1000;
    r.step('t1', 3, { u: usage(10, 90, 10) });
    expect(r.rows.filter((row) => row.event === 'canary')).toHaveLength(1);
  });

  it('starts a new session afresh: on, no pin, no turn, nothing to compare with, the notice told again', () => {
    const r = rig();
    r.ctl.loadPersisted(markUnsafe(EMPTY_PERSISTED, 'claude-fable-5-1', { at: 'x', ratio: 0.1, prevPrompt: 10, cacheRead: 1, from: 'high', to: 'medium' }));
    r.prompt();
    r.step('t1', 0, { effort: 'xhigh' });
    r.prompt();
    expect(r.step('t2', 0, { effort: 'low' }).plan).toMatchObject({ source: 'pin' });
    expect(r.step('t3', 0, { model: 'claude-fable-5-1' }).plan.toast).toContain('claude-fable-5-1');
    expect(r.step('t4', 0, { model: 'claude-fable-5-1' }).plan.toast).toBeUndefined();
    r.ctl.setEnabled(false);
    r.ctl.resetSession();
    expect(r.ctl.view()).toMatchObject({ enabled: true, pin: null, turn: null, model: undefined });
    r.prompt();
    expect(r.step('t5', 0, { effort: 'low' }).plan).toMatchObject({ send: 'high', source: 'plan', newTurn: true });
    expect(r.rows.filter((row) => row.event === 'switch' || row.event === 'pin').map((row) => row.turnId)).toEqual(['t2']);
    expect(r.step('t6', 0, { model: 'claude-fable-5-1' }).plan.toast).toContain('claude-fable-5-1');
  });

  it('takes settings changed in place', () => {
    const r = rig();
    r.ctl.applySettings(resolveSettings({ planLevel: 'medium' }).settings);
    r.prompt();
    expect(r.step('t1', 0).plan).toMatchObject({ level: 'medium', send: 'medium' });
  });
});
