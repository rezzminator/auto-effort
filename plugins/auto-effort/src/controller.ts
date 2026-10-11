// Every decision, as plain state and methods: the adapter feeds it the hook events and does what it returns.
// Nothing here touches the engine; a clock is passed in.

import { judgeSwitch, wholePrompt, type Usage } from './canary.ts';
import type { View } from './command.ts';
import { cleanSwitch, clearUnsafe, gateOf, markUnsafe, type Gate, type Persisted } from './gate.ts';
import { clamp, isEffort, levelsWithin, rank, stepUp, type Effort } from './levels.ts';
import { normalizeModel } from './model.ts';
import { planFor } from './plan.ts';
import { compile, type Compiled, type Settings } from './settings.ts';
import { escalationLine, reminderLine, shortReason, statusLine, type Shown } from './text.ts';

export type Row = Record<string, unknown>;
export type Source = Shown;

/** The effort a request carries: a level, a number on models that take one, absent on models without. */
type Carried = Effort | number | undefined;

export type StepInput = { turnId: string; index: number; model: string; effort: Carried; messageCount: number };

export type StepPlan = {
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

export type StepEnd = { rows: Row[]; toast?: string; persisted?: Persisted };

type Turn = {
  id: string;
  level: Effort;
  source: Source;
  reason: string;
  startLevel: Effort;
  steps: number;
  switches: number;
  failures: number;
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

  /** Lifts the cache mark from one model, or every model when none is named. */
  clear(model: string | undefined): void {
    this.store = clearUnsafe(this.store, model);
    if (model === undefined) this.told.clear();
    else this.told.delete(normalizeModel(model));
  }

  noteCompaction(): void {
    this.compacted = true;
  }

  private gate(model: string): Gate {
    return gateOf(model, this.settingsNow, this.compiled, this.store);
  }

  /** A prompt arrives; the turn it starts is planned from it. */
  onPrompt(input: { text: string; model: string | undefined; midTurn: boolean }): { reminder?: string; rows: Row[] } {
    if (input.midTurn) return { rows: [] };
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
    if (this.pin !== null) return statusLine(this.pin.level, 'you set /effort', 'pin');
    if (this.turn === null) return undefined;
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
    }
    this.lastSeen = { model: name, effort };

    if (!this.enabled) return this.inactive(input, effort, 'auto-effort is off for this session', gate, newTurn, rows);
    if (!gate.active) {
      const toast = gate.status === 'unsafe' && !this.told.has(name) ? `auto-effort is off for ${input.model}: a cache check failed on it earlier. /auto-effort clear ${name} turns it back on.` : undefined;
      if (toast !== undefined) this.told.add(name);
      return this.inactive(input, effort, `auto-effort does not change effort on ${input.model} (${gate.status})`, gate, newTurn, rows, toast);
    }
    if (this.pin !== null) {
      const plan = this.inactive(input, effort, 'you set /effort', gate, newTurn, rows, undefined, 'pin');
      return { ...plan, level: this.pin.level, status: s.statusLine ? statusLine(this.pin.level, 'you set /effort', 'pin') : undefined };
    }

    if (this.turn === null || this.turn.id !== input.turnId) {
      const plan = planFor(s, this.compiled, text ?? '');
      this.turn = { id: input.turnId, level: plan.level, source: 'plan', reason: plan.reason, startLevel: plan.level, steps: 0, switches: 0, failures: 0, escalations: 0, setEffortCalls: 0 };
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
    return { rows, ...(toast === undefined ? {} : { toast }), ...(persisted === undefined ? {} : { persisted }) };
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
    if (!isEffort(requested)) return refuse(`Not applied: level must be one of ${levelsWithin(s.floor, s.ceiling).join(', ')}; got ${JSON.stringify(requested ?? null)}.`);
    const turn = this.turn;
    if (turn === null) return refuse('Not applied: no turn is being steered yet.');
    const applied = clamp(requested, s.floor, s.ceiling);
    const reason = shortReason(input.input.reason);
    const from = turn.level;
    turn.level = applied;
    turn.source = 'model';
    turn.reason = reason;
    turn.setEffortCalls += 1;
    let text = `Effort set to ${applied} from your next request until this turn ends.`;
    if (applied !== requested) text = `Effort set to ${applied} from your next request until this turn ends (${requested} is ${rank(requested) < rank(s.floor) ? `below the floor ${s.floor}` : `above the ceiling ${s.ceiling}`}).`;
    return { text, rows: [{ event: 'set_effort', turnId: turn.id, requested, applied, from, reason }] };
  }

  /** A main-loop tool result: a failing test run counts, and enough of them raise the level one step. */
  onToolResult(input: { tool: string; text: string }): { context?: string; rows: Row[] } {
    const s = this.settingsNow;
    const turn = this.turn;
    if (turn === null || !this.enabled || this.pin !== null) return { rows: [] };
    if (this.lastModel !== undefined && !this.gate(this.lastModel).active) return { rows: [] };
    if (!s.failureTools.includes(input.tool) || !this.compiled.failure.some((re) => re.test(input.text))) return { rows: [] };
    turn.failures += 1;
    if (turn.failures < s.escalateAfterFailures) return { rows: [] };
    const failures = turn.failures;
    turn.failures = 0;
    const from = clamp(turn.level, s.floor, s.ceiling);
    const to = stepUp(from, s.ceiling);
    if (to === from) return { rows: [{ event: 'escalation', turnId: turn.id, from, to, failures, held: 'ceiling' }] };
    turn.level = to;
    turn.source = 'escalation';
    turn.reason = `${failures} failing test runs`;
    turn.escalations += 1;
    return { context: escalationLine(failures, from, to), rows: [{ event: 'escalation', turnId: turn.id, from, to, failures }] };
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
