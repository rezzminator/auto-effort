// Every decision, as plain state and methods: the adapter feeds it the hook events and does what it returns.
// Nothing here touches the engine; a clock is passed in.

import { judgeSwitch, wholePrompt, type Usage } from './canary.ts';
import type { View } from './command.ts';
import { cleanSwitch, clearUnsafe, gateOf, markUnsafe, type Gate, type Persisted } from './gate.ts';
import { clamp, isEffort, levelsWithin, stepUp, type Effort } from './levels.ts';
import { normalizeModel } from './model.ts';
import { planFor } from './plan.ts';
import { compile, type Compiled, type Settings } from './settings.ts';
import { stateOf, type EffortState } from './state.ts';
import { deescalationLine, escalationLine, handBackText, heldLine, quote, reminderLine, setText, shortReason } from './text.ts';

export type Row = Record<string, unknown>;
/** What decided a turn's level: the planning level, the main chat's own set_effort level, a failing-test rise, the user's /effort. */
export type Source = 'plan' | 'model' | 'escalation' | 'pin';
/** The main chat's own level, set with set_effort: it holds until this turn ends or set_effort is called with auto. */
export type Override = { level: Effort; reason: string; turnId: string | null };

/** The effort a request carries: a level, a number on models that take one, absent on models without. */
type Carried = Effort | number | undefined;

export type StepInput = { turnId: string; index: number; model: string; effort: Carried; messageCount: number };

type PluginWarning = { event: 'gate-unsafe' | 'canary-failed'; msg: string; where: string };

export type StepPlan = {
  warning?: PluginWarning;
  /** The effort to rewrite the request to; undefined leaves it as it is. */
  send: Effort | undefined;
  /** The level held for this request; undefined when the plugin leaves the request alone. */
  level: Effort | undefined;
  source: Source | 'off';
  reason: string;
  newTurn: boolean;
  rows: Row[];
};

/** `persisted` and `model` come together: the marks changed for that model, to be saved. */
export type StepEnd = { warning?: PluginWarning; rows: Row[]; persisted?: Persisted; model?: string };

type Turn = {
  id: string;
  level: Effort;
  source: Source;
  reason: string;
  /** The planning level and its reason: what `auto` gives the turn back. */
  startLevel: Effort;
  planReason: string;
  steps: number;
  switches: number;
  /** Failing test runs in a row since the last rise or passing run. */
  failures: number;
  /** What the turn held before the first rise of the failing streak, for a passing run to return to; null when there is none. */
  beforeRise: { level: Effort; source: Source; reason: string } | null;
  escalations: number;
  setEffortCalls: number;
};

type Sample = { model: string; wire: Carried; usage: Usage | null; endedAt: number; messages: number };

type Inflight = {
  turnId: string;
  index: number;
  model: string;
  wire: Carried;
  source: Source | 'off';
  active: boolean;
  gate: Gate;
  switched: boolean;
  prev: Sample | undefined;
  compacted: boolean;
  startedAt: number;
  messages: number;
};

/** A harness note that the command went on in the background: its result says nothing about the tests yet. */
const BACKGROUND = /^Command running in background with ID: \S+\.[^\r\n]*$/i;

/**
 * What a tool result says about the tests. A call of a `failureTools` tool whose command matches `testCommandPatterns` is a test
 * run: it fails when its result matches `failurePatterns`, passes otherwise, and says nothing yet when it went to the background.
 * Any other result is no test run.
 */
function testRunOf(settings: Settings, compiled: Compiled, input: { tool: string; command: string | undefined; text: string }): 'fail' | 'pass' | 'background' | undefined {
  const { command, text } = input;
  if (command === undefined || !settings.failureTools.includes(input.tool)) return undefined;
  if (!compiled.testCommand.some((re) => re.test(command))) return undefined;
  if (BACKGROUND.test(text)) return 'background';
  return compiled.failure.some((re) => re.test(text)) ? 'fail' : 'pass';
}

/** What the host keeps per session so a plugin reload does not lose it. */
export type SessionState = { enabled: boolean; pin: Effort | null; override: Override | null };

/** The saved state as it was written, a value saved before `override` existed holding none; undefined for anything else. */
export function readSessionState(raw: unknown): SessionState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { enabled, pin, override } = raw as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return undefined;
  if (pin !== null && !isEffort(pin)) return undefined;
  if (override === undefined || override === null) return { enabled, pin, override: null };
  if (typeof override !== 'object' || Array.isArray(override)) return undefined;
  const { level, reason, turnId } = override as Record<string, unknown>;
  if (!isEffort(level) || typeof reason !== 'string' || (turnId !== undefined && turnId !== null && typeof turnId !== 'string')) return undefined;
  return { enabled, pin, override: { level, reason, turnId: turnId ?? null } };
}

export class Controller {
  /** The set_effort tool's full name once the engine registered it. */
  toolName: string | undefined;
  private settingsNow: Settings;
  private compiled: Compiled;
  private store: Persisted;
  private enabled = true;
  private pin: { level: Effort } | null = null;
  private override: Override | null = null;
  /** False after a request that carried no level: a model without an effort setting. */
  private takesLevel = true;
  private lastSeen: { model: string; effort: Effort } | undefined;
  private turn: Turn | null = null;
  private turnId: string | undefined;
  private pendingText: string | undefined;
  private lastModel: string | undefined;
  private inflight: Inflight | undefined;
  private last: Sample | undefined;
  private compacted = false;
  private told = new Set<string>();

  constructor(
    settings: Settings,
    persisted: Persisted,
    private readonly now: () => number,
  ) {
    this.settingsNow = settings;
    this.compiled = compile(settings);
    this.store = persisted;
  }

  get settings(): Settings {
    return this.settingsNow;
  }

  get persisted(): Persisted {
    return this.store;
  }

  applySettings(settings: Settings): void {
    this.settingsNow = settings;
    this.compiled = compile(settings);
  }

  loadPersisted(persisted: Persisted): void {
    this.store = persisted;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.pin = null;
  }

  /** Read the user's built-in command after the host has handled it. */
  onEffortCommand(args: string): { rows: Row[] } {
    const level = args.trim().toLowerCase();
    if (level === 'auto') {
      const released = this.pin?.level ?? null;
      this.pin = null;
      this.lastSeen = undefined;
      return { rows: this.settingsNow.userEffortPins ? [{ event: 'unpin', via: 'command', level: released }] : [] };
    }
    if (!this.settingsNow.userEffortPins || !isEffort(level)) return { rows: [] };
    const previous = this.pin?.level ?? this.lastSeen?.effort ?? null;
    this.pin = { level };
    return { rows: [{ event: 'pin', via: 'command', level, previous }] };
  }

  /** What a plugin reload keeps within one session: on or off, the user's /effort pin and the main chat's own level. */
  sessionState(): SessionState {
    return { enabled: this.enabled, pin: this.pin === null ? null : this.pin.level, override: this.override === null ? null : { ...this.override } };
  }

  /** The state of a session a reload interrupted, given to a controller built afresh. */
  restoreSession(state: SessionState): void {
    this.enabled = state.enabled;
    this.pin = state.pin === null ? null : { level: state.pin };
    this.override = state.override === null ? null : { ...state.override };
  }

  /** Lifts the cache mark from one model, or every model when none is named. */
  clear(model: string | undefined): void {
    this.store = clearUnsafe(this.store, model);
    if (model === undefined) this.told.clear();
    else this.told.delete(normalizeModel(model));
  }

  /** A new session in the same process (after /clear): on again, the user pin kept, no level of the main chat's, no turn, nothing to compare with; the marks stay. */
  resetSession(): void {
    this.enabled = true;
    this.override = null;
    this.takesLevel = true;
    this.lastSeen = undefined;
    this.turn = null;
    this.turnId = undefined;
    this.pendingText = undefined;
    this.lastModel = undefined;
    this.inflight = undefined;
    this.last = undefined;
    this.compacted = false;
    this.told.clear();
  }

  noteCompaction(): void {
    this.compacted = true;
  }

  private gate(model: string): Gate {
    return gateOf(model, this.settingsNow, this.compiled, this.store);
  }

  /**
   * A prompt arrives. One typed between turns, or typed mid-turn to wait for the running turn, starts a turn: that turn is
   * planned from it. One delivered into the running turn gets no reminder; its text only plans a next turn no prompt announces.
   */
  onPrompt(input: { text: string; model: string | undefined; midTurn: boolean; wait?: boolean }): { reminder?: string; rows: Row[] } {
    if (input.midTurn && input.wait !== true) {
      this.pendingText ??= input.text;
      return { rows: [] };
    }
    this.pendingText = input.text;
    if (input.model !== undefined) this.lastModel = input.model;
    const s = this.settingsNow;
    if (!s.turnReminder || !this.enabled || this.pin !== null || this.toolName === undefined || input.model === undefined) return { rows: [] };
    if (!this.gate(input.model).active) return { rows: [] };
    const plan = planFor(s, this.compiled, input.text);
    return { reminder: reminderLine({ ...plan, tool: this.toolName, chars: input.text.length, hintLevel: clamp('xhigh', s.floor, s.ceiling) }), rows: [] };
  }

  /** The mode the main chat's effort is in now, its level and why: what the state file carries. */
  stateNow(): EffortState {
    const { floor, ceiling } = this.settingsNow;
    return stateOf({
      enabled: this.enabled,
      steered: this.steered(),
      pin: this.pin === null ? null : this.pin.level,
      override: this.override === null ? null : { level: clamp(this.override.level, floor, ceiling), reason: this.override.reason },
      turn: this.turn === null ? null : { level: clamp(this.turn.level, floor, ceiling), reason: this.turn.reason },
    });
  }

  /** False when the last main request carried no level, or the model gate keeps its model unsteered; true before any. */
  private steered(): boolean {
    return this.takesLevel && (this.lastModel === undefined || this.gate(this.lastModel).active);
  }

  private inactive(input: StepInput, wire: Carried, reason: string, gate: Gate, newTurn: boolean, rows: Row[], source: Source | 'off' = 'off'): StepPlan {
    this.turn = null;
    this.inflight = { turnId: input.turnId, index: input.index, model: input.model, wire, source, active: false, gate, switched: false, prev: this.last, compacted: this.takeCompacted(), startedAt: this.now(), messages: input.messageCount };
    if (newTurn) rows.push({ event: 'decision', turnId: input.turnId, model: input.model, level: source === 'pin' ? wire ?? null : null, source, reason, hints: null, sessionEffort: wire ?? null });
    return { send: undefined, level: undefined, source, reason, newTurn, rows };
  }

  private takeCompacted(): boolean {
    const was = this.compacted;
    this.compacted = false;
    return was;
  }

  /** A main-loop request is about to go out. */
  beginStep(input: StepInput): StepPlan {
    const s = this.settingsNow;
    const rows: Row[] = [];
    const name = normalizeModel(input.model);
    const newTurn = this.turnId !== input.turnId;
    if (newTurn && this.override?.turnId !== input.turnId) this.override = null;
    this.turnId = input.turnId;
    this.lastModel = input.model;
    const text = newTurn ? this.pendingText : undefined;
    if (newTurn) this.pendingText = undefined;
    const gate = this.gate(input.model);
    const effort = input.effort;

    // A level outside the five is none this plugin can steer or show: the model is left as one that takes no level.
    if (effort === undefined || typeof effort === 'number' || !isEffort(effort)) {
      this.takesLevel = false;
      const why = typeof effort === 'string' ? `${input.model} carries effort ${quote(effort)}, no level auto-effort sets` : `${input.model} takes no effort level`;
      return this.inactive(input, effort, why, gate, newTurn, rows);
    }
    this.takesLevel = true;

    // The user's own /effort between turns is a pin: the session effort moved while the model stood still.
    if (newTurn && s.userEffortPins && this.pin === null && this.lastSeen !== undefined && this.lastSeen.model === name && this.lastSeen.effort !== effort) {
      this.pin = { level: effort };
      rows.push({ event: 'pin', via: 'carried', turnId: input.turnId, model: input.model, level: effort, previous: this.lastSeen.effort });
    } else if (newTurn && this.pin !== null) {
      // A pinned session's requests go at the effort they carry: the pin shows that level, after another /effort too.
      this.pin = { level: effort };
    }
    this.lastSeen = { model: name, effort };

    if (!this.enabled) return this.inactive(input, effort, 'auto-effort is off for this session', gate, newTurn, rows);
    if (!gate.active) {
      const notice = gate.status === 'unsafe' && !this.told.has(name) ? `auto-effort is off for ${input.model}: a cache check failed on it earlier. /auto-effort clear ${name} turns it back on.` : undefined;
      if (notice !== undefined) this.told.add(name);
      const inactive = this.inactive(input, effort, `auto-effort does not change effort on ${input.model} (${gate.status})`, gate, newTurn, rows);
      return { ...inactive, ...(notice === undefined ? {} : { warning: { event: 'gate-unsafe', msg: notice, where: 'src/controller.ts#beginStep' } as PluginWarning }) };
    }
    if (this.pin !== null) {
      const plan = this.inactive(input, effort, 'you set /effort', gate, newTurn, rows, 'pin');
      return { ...plan, level: this.pin.level };
    }

    if (this.turn === null || this.turn.id !== input.turnId) {
      const plan = planFor(s, this.compiled, text ?? '');
      // The main chat's own level outranks the plan: the turn is still planned and logged, and runs at the level it set.
      const held = this.override;
      this.turn = {
        id: input.turnId,
        level: held?.level ?? plan.level,
        source: held === null ? 'plan' : 'model',
        reason: held?.reason ?? plan.reason,
        startLevel: plan.level,
        planReason: plan.reason,
        steps: 0,
        switches: 0,
        failures: 0,
        beforeRise: null,
        escalations: 0,
        setEffortCalls: 0,
      };
      rows.push({ event: 'decision', turnId: input.turnId, model: input.model, level: plan.level, source: 'plan', reason: plan.reason, upshift: plan.upshift, hints: plan.hintSources.length ? plan.hintSources : null, sessionEffort: effort, override: held?.level ?? null });
    }
    const turn = this.turn;
    turn.steps += 1;
    const level = clamp(turn.level, s.floor, s.ceiling);
    const send = level === effort ? undefined : level;
    const prev = this.last;
    const switched = prev !== undefined && prev.model === name && prev.wire !== level;
    if (switched && prev !== undefined) {
      turn.switches += 1;
      rows.push({ event: 'switch', turnId: input.turnId, index: input.index, model: input.model, from: prev.wire ?? null, to: level, source: turn.source, reason: turn.reason });
    }
    this.inflight = { turnId: input.turnId, index: input.index, model: input.model, wire: level, source: turn.source, active: true, gate, switched, prev, compacted: this.takeCompacted(), startedAt: this.now(), messages: input.messageCount };
    return { send, level, source: turn.source, reason: turn.reason, newTurn, rows };
  }

  /** The request answered (or carried no usage). */
  endStep(usage: Usage | null): StepEnd {
    const inf = this.inflight;
    this.inflight = undefined;
    if (inf === undefined) return { rows: [] };
    const s = this.settingsNow;
    const endedAt = this.now();
    const rows: Row[] = [
      {
        event: 'step',
        turnId: inf.turnId,
        index: inf.index,
        model: inf.model,
        sent: inf.wire ?? null,
        source: inf.source,
        active: inf.active,
        input: usage?.input_tokens ?? null,
        output: usage?.output_tokens ?? null,
        cacheRead: usage?.cache_read_input_tokens ?? null,
        cacheWrite: usage?.cache_creation_input_tokens ?? null,
        ms: endedAt - inf.startedAt,
      },
    ];
    let notice: string | undefined;
    let persisted: Persisted | undefined;
    const model = normalizeModel(inf.model);
    if (inf.switched && inf.active && inf.prev !== undefined) {
      const prev = inf.prev;
      const verdict = judgeSwitch({
        prev: prev.usage,
        cur: usage,
        gapMs: inf.startedAt - prev.endedAt,
        ttlMs: s.cacheTtlSeconds * 1000,
        threshold: s.canaryThreshold,
        compacted: inf.compacted,
        sameModel: prev.model === normalizeModel(inf.model),
        prevMessages: prev.messages,
        curMessages: inf.messages,
      });
      rows.push({ event: 'canary', turnId: inf.turnId, index: inf.index, model: inf.model, from: prev.wire ?? null, to: inf.wire ?? null, ...verdict });
      if (verdict.verdict === 'ok' && inf.gate.status === 'probation') {
        const counted = cleanSwitch(this.store, inf.model, s.probationSwitches);
        this.store = counted.persisted;
        persisted = this.store;
        if (counted.graduated) rows.push({ event: 'gate', model: inf.model, status: 'allow', why: 'graduated' });
      }
      if (verdict.verdict === 'fail' && usage !== null && prev.usage !== null) {
        this.store = markUnsafe(this.store, inf.model, {
          at: new Date(endedAt).toISOString(),
          ratio: verdict.ratio,
          prevPrompt: wholePrompt(prev.usage),
          cacheRead: usage.cache_read_input_tokens,
          from: String(prev.wire),
          to: String(inf.wire),
        });
        persisted = this.store;
        this.told.add(normalizeModel(inf.model));
        rows.push({ event: 'gate', model: inf.model, status: 'unsafe', why: 'cache canary', ratio: verdict.ratio });
        notice = `auto-effort stopped changing effort on ${inf.model}: after the change from ${String(prev.wire)} to ${String(inf.wire)} the cache read was ${(verdict.ratio * 100).toFixed(1)}% of the previous prompt (the check wants ${(s.canaryThreshold * 100).toFixed(0)}%). /auto-effort clear ${normalizeModel(inf.model)} turns it back on.`;
      }
    }
    this.last = usage === null ? undefined : { model: normalizeModel(inf.model), wire: inf.wire, usage, endedAt, messages: inf.messages };
    return { rows, ...(notice === undefined ? {} : { warning: { event: 'canary-failed', msg: notice, where: 'src/controller.ts#endStep' } as PluginWarning }), ...(persisted === undefined ? {} : { persisted, model }) };
  }

  /** The request failed before it answered: nothing to compare the next one with. */
  failStep(): void {
    this.inflight = undefined;
    this.last = undefined;
  }

  /**
   * The model's set_effort call. A level is the main chat's own: it holds within its turn over the plan and the failing-test
   * rise until a call with `auto` hands the effort back to them. Off, the user's pin and the model gate outrank it: a level
   * is refused there, while `auto` is always taken.
   */
  setEffort(input: { input: Record<string, unknown>; agent: boolean }): { text: string; rows: Row[] } {
    const s = this.settingsNow;
    const refuse = (text: string): { text: string; rows: Row[] } => ({ text, rows: [{ event: 'set_effort', turnId: this.turn?.id ?? null, refused: text }] });
    if (input.agent) return refuse('Not applied: set_effort applies to the main chat only.');
    const requested = input.input.level ?? input.input.effort;
    if (requested === 'auto') return this.handBack(shortReason(input.input.reason));
    if (!this.enabled) return refuse('Not applied: auto-effort is off for this session; /auto-effort on turns it back on.');
    if (this.pin !== null) return refuse(`Not applied: the effort is pinned at ${this.pin.level} by your /effort command; /effort auto or /auto-effort on resumes automatic effort.`);
    const gate = this.lastModel === undefined ? undefined : this.gate(this.lastModel);
    if (gate !== undefined && !gate.active) return refuse(`Not applied: auto-effort does not change effort on ${this.lastModel} (${gate.status}).`);
    if (!this.takesLevel) return refuse(`Not applied: ${this.lastModel ?? 'this model'} takes no effort level.`);
    if (!isEffort(requested)) return refuse(`Not applied: level must be auto or one of ${levelsWithin(s.floor, s.ceiling).join(', ')}; got ${quote(requested ?? null)}.`);
    const applied = clamp(requested, s.floor, s.ceiling);
    const reason = shortReason(input.input.reason);
    const turn = this.turn;
    const from = turn === null ? null : turn.level;
    this.override = { level: applied, reason, turnId: this.turn?.id ?? this.turnId ?? null };
    if (turn !== null) {
      turn.level = applied;
      turn.source = 'model';
      turn.reason = reason;
      turn.setEffortCalls += 1;
      // The model's level stands: a passing test run no longer undoes a rise it chose over.
      turn.beforeRise = null;
    }
    return { text: setText(applied, requested, s.floor, s.ceiling), rows: [{ event: 'set_effort', turnId: turn?.id ?? null, requested, applied, from, reason }] };
  }

  /** set_effort with `auto`: the main chat's level is dropped, and the turn runs at its planning level again. */
  private handBack(reason: string): { text: string; rows: Row[] } {
    const s = this.settingsNow;
    const held = this.override;
    this.override = null;
    const turn = this.turn;
    if (turn !== null) {
      turn.setEffortCalls += 1;
      if (held !== null) {
        turn.level = turn.startLevel;
        turn.source = 'plan';
        turn.reason = turn.planReason;
        turn.beforeRise = null;
      }
    }
    const text = handBackText({ held: held !== null, level: turn === null ? null : clamp(turn.level, s.floor, s.ceiling), ...this.outranked() });
    return { text, rows: [{ event: 'set_effort', turnId: turn?.id ?? null, requested: 'auto', applied: 'auto', from: held?.level ?? null, reason }] };
  }

  /** What decides the effort over the automatic rules: off, the user's pin, the model gate, a model taking no level; none while the rules apply. */
  private outranked(): { outranked?: string } {
    if (!this.enabled) return { outranked: 'auto-effort is off for this session until /auto-effort on' };
    if (this.pin !== null) return { outranked: `your /effort pin at ${this.pin.level} still applies until /auto-effort on` };
    const gate = this.lastModel === undefined ? undefined : this.gate(this.lastModel);
    if (gate !== undefined && !gate.active) return { outranked: `auto-effort does not change effort on ${this.lastModel} (${gate.status})` };
    if (!this.takesLevel) return { outranked: `${this.lastModel ?? 'this model'} takes no effort level, so none is steered` };
    return {};
  }

  /**
   * A main-loop tool result. Failing test runs in a row raise the level one step at `escalateAfterFailures`; a passing run resets
   * the count and, with `lowerOnPass`, returns a raised level to what the failing streak found. While the main chat's own level
   * holds, the threshold raises nothing and says so. Any other result changes nothing.
   */
  onToolResult(input: { tool: string; command: string | undefined; text: string }): { context?: string; rows: Row[] } {
    const s = this.settingsNow;
    const turn = this.turn;
    if (turn === null || !this.enabled || this.pin !== null) return { rows: [] };
    if (this.lastModel !== undefined && !this.gate(this.lastModel).active) return { rows: [] };
    const run = testRunOf(s, this.compiled, input);
    if (run === undefined || run === 'background') return { rows: [] };
    if (run === 'pass') return this.testsPass(turn);
    turn.failures += 1;
    if (turn.failures < s.escalateAfterFailures) return { rows: [] };
    const failures = turn.failures;
    turn.failures = 0;
    const from = clamp(turn.level, s.floor, s.ceiling);
    if (this.override !== null) {
      return { context: heldLine(failures, from, this.toolName ?? 'set_effort'), rows: [{ event: 'escalation', turnId: turn.id, from, to: from, failures, held: 'override' }] };
    }
    const to = stepUp(from, s.ceiling);
    if (to === from) return { rows: [{ event: 'escalation', turnId: turn.id, from, to, failures, held: 'ceiling' }] };
    turn.beforeRise ??= { level: from, source: turn.source, reason: turn.reason };
    turn.level = to;
    turn.source = 'escalation';
    turn.reason = `${failures} failing test runs`;
    turn.escalations += 1;
    return { context: escalationLine(failures, from, to), rows: [{ event: 'escalation', turnId: turn.id, from, to, failures }] };
  }

  /** A passing test run ends the failing streak; with `lowerOnPass` the turn gets back what it held before the streak's first rise. */
  private testsPass(turn: Turn): { context?: string; rows: Row[] } {
    const s = this.settingsNow;
    const before = turn.beforeRise;
    turn.failures = 0;
    turn.beforeRise = null;
    if (before === null || !s.lowerOnPass) return { rows: [] };
    const from = clamp(turn.level, s.floor, s.ceiling);
    const to = clamp(before.level, s.floor, s.ceiling);
    turn.level = to;
    turn.source = before.source;
    turn.reason = before.reason;
    if (to === from) return { rows: [] };
    return { context: deescalationLine(from, to), rows: [{ event: 'deescalation', turnId: turn.id, from, to }] };
  }

  /** The turn ended: its summary row. */
  completeTurn(input: { turnId: string; durationMs: number; usage: Usage | undefined }): Row[] {
    const turn = this.turn;
    if (turn === null || turn.id !== input.turnId) return [];
    // The model's set_effort level lasts until its turn ends: drop it here so the state file stops naming it.
    if (this.override?.turnId === turn.id) this.override = null;
    return [
      {
        event: 'turn',
        turnId: turn.id,
        startLevel: turn.startLevel,
        endLevel: clamp(turn.level, this.settingsNow.floor, this.settingsNow.ceiling),
        steps: turn.steps,
        switches: turn.switches,
        setEffortCalls: turn.setEffortCalls,
        escalations: turn.escalations,
        durationMs: input.durationMs,
        input: input.usage?.input_tokens ?? null,
        output: input.usage?.output_tokens ?? null,
        cacheRead: input.usage?.cache_read_input_tokens ?? null,
        cacheWrite: input.usage?.cache_creation_input_tokens ?? null,
      },
    ];
  }

  /** What `/auto-effort status` shows. */
  view(): View {
    const model = this.lastModel;
    const gate = model === undefined ? undefined : this.gate(model);
    const name = model === undefined ? undefined : normalizeModel(model);
    return {
      enabled: this.enabled,
      pin: this.pin,
      override: this.override === null ? null : { level: clamp(this.override.level, this.settingsNow.floor, this.settingsNow.ceiling), reason: this.override.reason },
      steered: this.steered(),
      model,
      gate,
      turn: this.turn === null ? null : { level: this.turn.level, source: this.turn.source, reason: this.turn.reason },
      probation: name === undefined ? undefined : this.store.probation[name],
      unsafe: name === undefined ? undefined : this.store.unsafe[name],
    };
  }
}
