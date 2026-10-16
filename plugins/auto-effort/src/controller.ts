// Every decision, as plain state and methods: the adapter feeds it the hook events and does what it returns.
// Nothing here touches the engine; a clock is passed in.

import { judgeSwitch, wholePrompt, type Usage } from './canary.ts';
import type { View } from './command.ts';
import { cleanSwitch, clearUnsafe, gateOf, markUnsafe, type Gate, type Persisted } from './gate.ts';
import { clamp, isEffort, levelsWithin, rank, stepUp, type Effort } from './levels.ts';
import { normalizeModel } from './model.ts';
import { planFor } from './plan.ts';
import { compile, type Compiled, type Settings } from './settings.ts';
import { deescalationLine, escalationLine, quote, reminderLine, shortReason, statusLine, type Shown } from './text.ts';

export type Row = Record<string, unknown>;
export type Source = Shown;

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
  /** The status line to pin; undefined clears it. */
  status: string | undefined;
  rows: Row[];
  toast?: string;
};

/** `persisted` and `model` come together: the marks changed for that model, to be saved. */
export type StepEnd = { warning?: PluginWarning; rows: Row[]; toast?: string; persisted?: Persisted; model?: string };

type Turn = {
  id: string;
  level: Effort;
  source: Source;
  reason: string;
  startLevel: Effort;
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
export type SessionState = { enabled: boolean; pin: Effort | null };

/** The saved state as it was written; undefined for anything else. */
export function readSessionState(raw: unknown): SessionState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { enabled, pin } = raw as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return undefined;
  if (pin === null) return { enabled, pin: null };
  return isEffort(pin) ? { enabled, pin } : undefined;
}

export class Controller {
  /** The set_effort tool's full name once the engine registered it. */
  toolName: string | undefined;
  private settingsNow: Settings;
  private compiled: Compiled;
  private store: Persisted;
  private enabled = true;
  private pin: { level: Effort } | null = null;
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

  /** What a plugin reload keeps within one session: on or off, and the user's /effort pin. */
  sessionState(): SessionState {
    return { enabled: this.enabled, pin: this.pin === null ? null : this.pin.level };
  }

  /** The state of a session a reload interrupted, given to a controller built afresh. */
  restoreSession(state: SessionState): void {
    this.enabled = state.enabled;
    this.pin = state.pin === null ? null : { level: state.pin };
  }

  /** Lifts the cache mark from one model, or every model when none is named. */
  clear(model: string | undefined): void {
    this.store = clearUnsafe(this.store, model);
    if (model === undefined) this.told.clear();
    else this.told.delete(normalizeModel(model));
  }

  /** A new session in the same process (after /clear): on again, no pin, no turn, nothing to compare with; the marks stay. */
  resetSession(): void {
    this.enabled = true;
    this.pin = null;
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
    return { reminder: reminderLine(planFor(s, this.compiled, input.text).level, this.toolName), rows: [] };
  }

  /** The status line for the level held now; undefined when the plugin is not steering. */
  statusNow(): string | undefined {
    if (!this.settingsNow.statusLine || !this.enabled) return undefined;
    if (this.lastModel !== undefined && !this.gate(this.lastModel).active) return undefined;
    // The user's own /effort is no news to them: a pinned session shows nothing; the pin row stays in the decision log.
    if (this.pin !== null || this.turn === null) return undefined;
    return statusLine(this.turn.level, this.turn.reason, this.turn.source);
  }

  private inactive(input: StepInput, wire: Carried, reason: string, gate: Gate, newTurn: boolean, rows: Row[], toast?: string, source: Source | 'off' = 'off'): StepPlan {
    this.turn = null;
    this.inflight = { turnId: input.turnId, index: input.index, model: input.model, wire, source, active: false, gate, switched: false, prev: this.last, compacted: this.takeCompacted(), startedAt: this.now(), messages: input.messageCount };
    if (newTurn) rows.push({ event: 'decision', turnId: input.turnId, model: input.model, level: source === 'pin' ? wire ?? null : null, source, reason, sessionEffort: wire ?? null });
    return { send: undefined, level: undefined, source, reason, newTurn, status: undefined, rows, ...(toast === undefined ? {} : { toast }) };
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
    this.turnId = input.turnId;
    this.lastModel = input.model;
    const text = newTurn ? this.pendingText : undefined;
    if (newTurn) this.pendingText = undefined;
    const gate = this.gate(input.model);
    const effort = input.effort;

    if (effort === undefined || typeof effort === 'number') {
      return this.inactive(input, effort, `${input.model} takes no effort level`, gate, newTurn, rows);
    }

    // The user's own /effort between turns is a pin: the session effort moved while the model stood still.
    if (newTurn && s.userEffortPins && this.pin === null && this.lastSeen !== undefined && this.lastSeen.model === name && this.lastSeen.effort !== effort) {
      this.pin = { level: effort };
      rows.push({ event: 'pin', turnId: input.turnId, model: input.model, level: effort, previous: this.lastSeen.effort });
    } else if (newTurn && this.pin !== null) {
      // A pinned session's requests go at the effort they carry: the pin shows that level, after another /effort too.
      this.pin = { level: effort };
    }
    this.lastSeen = { model: name, effort };

    if (!this.enabled) return this.inactive(input, effort, 'auto-effort is off for this session', gate, newTurn, rows);
    if (!gate.active) {
      const toast = gate.status === 'unsafe' && !this.told.has(name) ? `auto-effort is off for ${input.model}: a cache check failed on it earlier. /auto-effort clear ${name} turns it back on.` : undefined;
      if (toast !== undefined) this.told.add(name);
      const inactive = this.inactive(input, effort, `auto-effort does not change effort on ${input.model} (${gate.status})`, gate, newTurn, rows, toast);
      return { ...inactive, ...(toast === undefined ? {} : { warning: { event: 'gate-unsafe', msg: toast, where: 'src/controller.ts#beginStep' } as PluginWarning }) };
    }
    if (this.pin !== null) {
      const plan = this.inactive(input, effort, 'you set /effort', gate, newTurn, rows, undefined, 'pin');
      return { ...plan, level: this.pin.level };
    }

    if (this.turn === null || this.turn.id !== input.turnId) {
      const plan = planFor(s, this.compiled, text ?? '');
      this.turn = { id: input.turnId, level: plan.level, source: 'plan', reason: plan.reason, startLevel: plan.level, steps: 0, switches: 0, failures: 0, beforeRise: null, escalations: 0, setEffortCalls: 0 };
      rows.push({ event: 'decision', turnId: input.turnId, model: input.model, level: plan.level, source: 'plan', reason: plan.reason, upshift: plan.upshift, sessionEffort: effort });
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
    return { send, level, source: turn.source, reason: turn.reason, newTurn, status: s.statusLine ? statusLine(level, turn.reason, turn.source) : undefined, rows };
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
    let toast: string | undefined;
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
        toast = `auto-effort stopped changing effort on ${inf.model}: after the change from ${String(prev.wire)} to ${String(inf.wire)} the cache read was ${(verdict.ratio * 100).toFixed(1)}% of the previous prompt (the check wants ${(s.canaryThreshold * 100).toFixed(0)}%). /auto-effort clear ${normalizeModel(inf.model)} turns it back on.`;
      }
    }
    this.last = usage === null ? undefined : { model: normalizeModel(inf.model), wire: inf.wire, usage, endedAt, messages: inf.messages };
    return { rows, ...(toast === undefined ? {} : { toast, warning: { event: 'canary-failed', msg: toast, where: 'src/controller.ts#endStep' } as PluginWarning }), ...(persisted === undefined ? {} : { persisted, model }) };
  }

  /** The request failed before it answered: nothing to compare the next one with. */
  failStep(): void {
    this.inflight = undefined;
    this.last = undefined;
  }

  /** The model's set_effort call. */
  setEffort(input: { input: Record<string, unknown>; agent: boolean }): { text: string; rows: Row[] } {
    const s = this.settingsNow;
    const refuse = (text: string): { text: string; rows: Row[] } => ({ text, rows: [{ event: 'set_effort', turnId: this.turn?.id ?? null, refused: text }] });
    if (input.agent) return refuse('Not applied: set_effort applies to the main chat only.');
    if (!this.enabled) return refuse('Not applied: auto-effort is off for this session; /auto-effort on turns it back on.');
    if (this.pin !== null) return refuse(`Not applied: the effort is pinned at ${this.pin.level} by your /effort command; /auto-effort on resumes automatic effort.`);
    const gate = this.lastModel === undefined ? undefined : this.gate(this.lastModel);
    if (gate !== undefined && !gate.active) return refuse(`Not applied: auto-effort does not change effort on ${this.lastModel} (${gate.status}).`);
    const requested = input.input.level ?? input.input.effort;
    if (!isEffort(requested)) return refuse(`Not applied: level must be one of ${levelsWithin(s.floor, s.ceiling).join(', ')}; got ${quote(requested ?? null)}.`);
    const turn = this.turn;
    if (turn === null) return refuse('Not applied: no turn is being steered yet.');
    const applied = clamp(requested, s.floor, s.ceiling);
    const reason = shortReason(input.input.reason);
    const from = turn.level;
    turn.level = applied;
    turn.source = 'model';
    turn.reason = reason;
    turn.setEffortCalls += 1;
    // The model's level stands: a passing test run no longer undoes a rise it chose over.
    turn.beforeRise = null;
    let text = `Effort set to ${applied} from your next request until this turn ends.`;
    if (applied !== requested) text = `Effort set to ${applied} from your next request until this turn ends (${requested} is ${rank(requested) < rank(s.floor) ? `below the floor ${s.floor}` : `above the ceiling ${s.ceiling}`}).`;
    return { text, rows: [{ event: 'set_effort', turnId: turn.id, requested, applied, from, reason }] };
  }

  /**
   * A main-loop tool result. Failing test runs in a row raise the level one step at `escalateAfterFailures`; a passing run resets
   * the count and, with `lowerOnPass`, returns a raised level to what the failing streak found. Any other result changes nothing.
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
      model,
      gate,
      turn: this.turn === null ? null : { level: this.turn.level, source: this.turn.source, reason: this.turn.reason },
      probation: name === undefined ? undefined : this.store.probation[name],
      unsafe: name === undefined ? undefined : this.store.unsafe[name],
    };
  }
}
