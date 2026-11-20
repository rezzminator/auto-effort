// The per-agent controller: the state of one steered agent and every decision about its
// effort. Pure: events go in, `{ actions }` come out; the hooks file performs the actions.

import { judgeStep, type Sample, type Switched, type Usage as CacheUsage } from '../canary';
import { modelVariant, recheckAt, type Marks, type Unsafe } from '../gate';
import { canaryNotice } from '../text';
import type { Effort } from './effort';
import { collapse, packet as buildPacket, parseAnswer, type Tripwire } from './judge';
import { clamp, isLevel, rank, step } from './ladder';
import { returnLine, type ReturnWords } from './signals';
import { announceLine, autoText, boundText, buttonText, unsafeText, unsteeredNote, whyChild, whyDecayed, whyJudge, whyRedispatch, whyResolved, WHY_FAIL1, WHY_FAIL2, WHY_JUDGE_FAILED, WHY_LANDING, type Direction } from './text';

export type Row = Record<string, unknown>;

export type Action =
  /** A decision-log row: the hook adds `ts`, `agent` and `type`. `detail` is logged only when packets are. */
  | { kind: 'log'; row: Row; detail?: Row }
  /** A judge call to start, detached; its answer returns through `onJudgeAnswer` / `onJudgeFailure` with this epoch. */
  | { kind: 'judge'; epoch: number; tripwire: Tripwire; packet: string };

export type Outcome = { actions: Action[] };
export type RequestOutcome = Outcome & { send: Effort | undefined };

export type Setup = {
  id: string;
  type: string;
  /** The level the agent starts at: its definition's effort, else its tag, else its first request's. */
  home: Effort;
  floor: Effort;
  ceiling: Effort;
  /** Whether a tripwire asks the judge (else it raises one step mechanically). */
  judge: boolean;
  /** The judge's probability (0-100) at or above which the level rises one step; below it the level holds. */
  judgeRaiseAt: number;
  /** The armed tripwire kinds; a disarmed one is counted and remembered but raises nothing. */
  tripwires: ReadonlySet<Tripwire>;
  /** Agent types whose spawn lands the flight. */
  landing: readonly string[];
  /** Model id prefixes the agent may be steered on; `*` steers every model. */
  models: readonly string[];
  words: ReturnWords;
  announce: boolean;
  /** The requests an open struggle goes without a new tripwire before its level comes home; 0: never. */
  struggleDecay: number;
  /** The spawn prompt after the tag was stripped. */
  brief: string;
  /** The cache marks the main chat and every sub-agent share: a waiting one stops this agent's effort changes too. */
  marks: Marks;
  /** The clock, in epoch ms. */
  now: () => number;
};

type Child = { type: string; name: string | undefined; unit: string | undefined };
/** `requests` counts the struggle's raised requests; `quiet` the ones since its last tripwire. */
type Struggle = { epoch: number; pre: Effort; requests: number; quiet: number };
type Usage = { input_tokens: number; output_tokens: number };
/** A request in flight: its raw model name, the request as the cache check sees it, and the one before it when it switched effort. */
type Inflight = { name: string; request: Switched; prev: Sample | undefined };

const RING = 12;
const COMMAND_MAX = 70;
const LINE_MAX = 100;
const FAIL_TAIL_MAX = 300;
const HEAD_MAX = 300;
const LAST_WORDS_MAX = 400;

const log = (event: string, fields: Row = {}, detail?: Row): Action => ({ kind: 'log', row: { event, ...fields }, ...(detail ? { detail } : {}) });

/** Whether the `models` option steers a model: `*` names every model, any other entry a model id prefix. */
export function steers(models: readonly string[], model: string): boolean {
  return models.some((entry) => entry === '*' || model.startsWith(entry));
}

export class Controller {
  level: Effort;
  base: Effort;
  /** Set by a button press: no automatic rule moves the level until `onAuto`. */
  held = false;
  ownFails = 0;
  readonly reds = new Set<string>();

  private struggle: Struggle | undefined;
  private epochs = 0;
  private struggles = 0;
  private judgeCalls = 0;
  private judgeTokens = { input: 0, output: 0 };
  private inFlight: { epoch: number; tripwire: Tripwire; packet: string } | undefined;
  private readonly ring: string[] = [];
  private readonly children = new Map<string, Child>();
  private readonly seen = new Set<string>();
  private readonly heads = new Map<string, string>();
  private readonly requests: Record<string, number> = {};
  private lastWords = '';
  private failTail: string | undefined;
  private home: Effort;
  private model = '';
  private gated = false;
  private line: string | undefined;
  /** Whether the latest request went on a model and effort this controller steers. */
  private steeredNow = true;
  /** The effort the latest steered request went at; undefined before the first. */
  private wire: Effort | undefined;
  /** Whether a cache mark held the latest steered request's effort. */
  private holding = false;
  private last: Sample | undefined;
  private inflight: Inflight | undefined;
  /** A compaction of the agent's conversation stood since its last request: the next one's check judges nothing. */
  private compacted = false;

  constructor(private readonly setup: Setup) {
    this.level = clamp(setup.home, setup.floor, setup.ceiling);
    this.base = this.level;
    this.home = setup.home;
  }

  get id(): string {
    return this.setup.id;
  }

  get type(): string {
    return this.setup.type;
  }

  get struggleOpen(): boolean {
    return this.struggle !== undefined;
  }

  /** The effort to send for one request, or undefined to pass it through untouched; `messages` is how many it carries. */
  onRequest(model: string, requested: unknown, messages = 0): RequestOutcome {
    this.model = model;
    const actions: Action[] = [];
    // A model the option leaves out, or a request with no level to steer (a model without effort, or a number), goes untouched.
    const listed = steers(this.setup.models, model);
    this.steeredNow = listed && isLevel(requested);
    if (!this.steeredNow) {
      if (!this.gated) actions.push(log('model-gated', listed ? { model, requested: requested ?? null } : { model }));
      this.gated = true;
      this.inflight = undefined;
      this.last = undefined;
      return { send: undefined, actions };
    }
    const now = this.setup.now();
    const waiting = this.setup.marks.waiting(model, now);
    // A waiting cache mark keeps the effort the agent has; its first request has no cache to lose and goes at its level.
    const sent = waiting !== undefined && this.wire !== undefined ? this.wire : this.level;
    if (waiting !== undefined && !this.holding) actions.push(log('gate', { model, status: 'unsafe', why: 'cache mark', recheckAt: new Date(recheckAt(waiting)).toISOString() }));
    this.holding = waiting !== undefined;
    const variant = modelVariant(model);
    // A request that never answered leaves nothing to compare the next one with.
    const prev = this.inflight === undefined ? this.last : undefined;
    const switched = prev !== undefined && prev.model === variant && prev.wire !== sent;
    this.inflight = { name: model, request: { model: variant, wire: sent, usage: null, endedAt: now, messages, startedAt: now, compacted: this.compacted }, prev: switched ? prev : undefined };
    this.compacted = false;
    this.wire = sent;
    this.requests[sent] = (this.requests[sent] ?? 0) + 1;
    if (this.struggle) {
      this.struggle.requests += 1;
      this.struggle.quiet += 1;
    }
    actions.push(log('step', { model, requested: requested ?? null, sent, struggle: this.struggle !== undefined }));
    if (this.struggle && this.setup.struggleDecay > 0 && this.struggle.quiet >= this.setup.struggleDecay) this.close(actions, 'decay');
    return { send: sent, actions };
  }

  /**
   * The request answered. One that went at another effort than the request before it on the same model is checked against
   * it (`judgeStep`) and the verdict kept in the shared marks: a failure stops every effort change on that model and context
   * window, here, in the other agents and in the main chat, until its recheck. A compaction in between (`onCompaction`, or
   * fewer messages) judges nothing.
   * `changed` names the model whose stored marks changed, to be saved; `warning` is a failure's notice.
   */
  onResponse(usage: CacheUsage | null, check: { ttlMs: number; threshold: number }): Outcome & { changed?: string; warning?: string } {
    const inf = this.inflight;
    this.inflight = undefined;
    if (inf === undefined) return { actions: [] };
    const cur: Switched = { ...inf.request, usage, endedAt: this.setup.now() };
    this.last = usage === null ? undefined : cur;
    if (inf.prev === undefined) return { actions: [] };
    const verdict = judgeStep(inf.prev, cur, check.ttlMs, check.threshold);
    const actions = [log('canary', { model: inf.name, from: inf.prev.wire, to: cur.wire, ...verdict })];
    const kept = this.setup.marks.keep(verdict, inf.prev, cur);
    const changed = kept.stored ? { changed: cur.model } : {};
    if (kept.lifted) actions.push(log('gate', { model: inf.name, status: 'steered', why: 'cache check passed' }));
    if (verdict.verdict !== 'fail' || kept.mark === undefined) return { actions, ...changed };
    this.holding = true;
    actions.push(log('gate', { model: inf.name, status: 'unsafe', why: 'cache canary', ratio: verdict.ratio, fails: kept.mark.fails }));
    const warning = canaryNotice({ model: inf.name, variant: cur.model, from: kept.mark.from, to: kept.mark.to, ratio: verdict.ratio, threshold: check.threshold, recheck: recheckAt(kept.mark) });
    return { actions, ...changed, warning };
  }

  /** A compaction of the agent's conversation stood: it rewrote the prompt, so the next request's cache check judges nothing. */
  onCompaction(): void {
    this.compacted = true;
  }

  /** The agent's reply text of one request; a non-empty one becomes its last words. */
  onAnswer(answer: string): void {
    const words = collapse(answer);
    if (words !== '') this.lastWords = words.slice(-LAST_WORDS_MAX);
  }

  onTestRun(run: { command: string; failed: boolean; text: string }): Outcome {
    const actions: Action[] = [];
    const command = collapse(run.command).slice(0, COMMAND_MAX);
    this.event(`test ${run.failed ? 'FAIL' : 'PASS'}: ${command}`);
    if (run.failed) {
      this.ownFails += 1;
      this.failTail = collapse(run.text).slice(-FAIL_TAIL_MAX);
      if (this.ownFails === 1) this.tripwire('fail1', WHY_FAIL1, actions);
      else if (this.ownFails % 2 === 0) this.tripwire('fail2', WHY_FAIL2, actions);
    } else {
      this.ownFails = 0;
      this.resolve(actions);
    }
    return { actions };
  }

  /** The agent spawned a child (`childId` is absent when the spawn started none). */
  onSpawn(spawn: { childId?: string; type: string; name?: string }): Outcome {
    const actions: Action[] = [];
    this.event(`spawn ${spawn.type}`);
    this.seen.clear();
    if (this.setup.landing.includes(spawn.type)) {
      const base = step(this.home, -1, this.setup.floor, this.setup.ceiling);
      const from = this.level;
      this.base = base;
      if (this.struggle) this.struggle.pre = base;
      else this.setLevel(base, WHY_LANDING);
      actions.push(log('landing', { from, to: this.level, ...this.heldMark() }));
    }
    const redType = [...this.children.values()].find((child) => child.type === spawn.type && this.isRed(child));
    if (redType) this.tripwire('redispatch', whyRedispatch(redType.type), actions, this.headOf(redType));
    if (spawn.childId !== undefined) this.children.set(spawn.childId, { type: spawn.type, name: spawn.name, unit: undefined });
    return { actions };
  }

  /** A child's final answer on its own turn.complete. */
  onChildReturn(childId: string, answer: string): Outcome {
    const found = returnLine(answer, 'complete', this.setup.words);
    if (!found) return { actions: [] };
    const child = this.children.get(childId);
    return this.take(found, child?.type ?? '?', found.unit ?? child?.type ?? '?', child, answer);
  }

  /** A result the agent read: a `Read`, or a Bash call that only runs read-only programs such as a cat of a return file. */
  onRead(text: string): Outcome {
    const found = returnLine(text, 'read', this.setup.words);
    if (!found) return { actions: [] };
    const child = [...this.children.values()].find((candidate) => found.unit !== undefined && (candidate.name === found.unit || candidate.type === found.unit));
    return this.take(found, child?.type ?? found.unit ?? '?', found.unit ?? '?', child, text);
  }

  /** The agent sent a message to `to` (a child's id or name). */
  onSendMessage(to: string): Outcome {
    const actions: Action[] = [];
    const child = this.children.get(to) ?? [...this.children.values()].find((candidate) => candidate.name === to);
    this.event(`sendmessage → ${child?.type ?? to}`);
    this.seen.clear();
    if (child && this.isRed(child)) this.tripwire('redispatch', whyRedispatch(child.type), actions, this.headOf(child));
    return { actions };
  }

  onJudgeAnswer(epoch: number, text: string, ms: number, usage: Usage): Outcome {
    const call = this.inFlight;
    this.inFlight = undefined;
    this.addUsage(usage);
    const actions: Action[] = [];
    const detail = { packet: call?.packet ?? null, answer: text };
    const tripwire = call?.tripwire ?? 'unknown';
    if (!this.current(epoch)) {
      actions.push(log('judge-stale', { tripwire, epoch }, detail));
      return { actions };
    }
    const parsed = parseAnswer(text);
    if (!parsed) {
      this.failed(epoch, tripwire, 'unparseable answer', actions, detail);
      return { actions };
    }
    const from = this.level;
    if (parsed.p >= this.setup.judgeRaiseAt) this.setLevel(step(this.level, +1, this.setup.floor, this.setup.ceiling), whyJudge(parsed.reason));
    actions.push(log('judge', { tripwire, p: parsed.p, from, to: this.level, reason: parsed.reason, ms, usage, ...this.heldMark() }, detail));
    return { actions };
  }

  onJudgeFailure(epoch: number, reason: string, usage?: Usage): Outcome {
    const call = this.inFlight;
    this.inFlight = undefined;
    if (usage) this.addUsage(usage);
    const actions: Action[] = [];
    this.failed(epoch, call?.tripwire ?? 'unknown', reason, actions, { packet: call?.packet ?? null, answer: null });
    return { actions };
  }

  /** A press of effort_up or effort_down: one step within the range, and the level holds, a press at a bound included. */
  onButton(direction: Direction): Outcome & { text: string } {
    const waiting = this.waiting();
    if (waiting !== undefined) return this.unsafe(direction, waiting);
    const { floor, ceiling } = this.setup;
    const to = step(this.level, direction === 'up' ? 1 : -1, floor, ceiling);
    const from = this.level;
    this.held = true;
    // The press answers for itself: a line an automatic rule left undelivered would name a level the agent no longer has.
    this.line = undefined;
    const actions = [log('button', { direction, from, to })];
    if (to === from) return { text: boundText(direction, from) + this.unsteered(), actions };
    this.level = to;
    if (!this.struggle) this.base = to;
    return { text: buttonText(direction, to, floor, ceiling) + this.unsteered(), actions };
  }

  /** effort_auto: the hold ends, the level and the resting level go home, and an open struggle resolves to home. */
  onAuto(): Outcome & { text: string } {
    const waiting = this.waiting();
    if (waiting !== undefined) return this.unsafe('auto', waiting);
    const { floor, ceiling } = this.setup;
    const to = clamp(this.home, floor, ceiling);
    const from = this.level;
    const held = this.held;
    this.held = false;
    this.line = undefined;
    this.level = to;
    this.base = to;
    if (this.struggle) this.struggle.pre = to;
    return { text: autoText(to, from, floor, ceiling) + this.unsteered(), actions: [log('auto', { from, to, held })] };
  }

  /** A press refused while a cache mark holds the agent's model: nothing changes, a hold included. */
  private unsafe(direction: Direction | 'auto', mark: Unsafe): Outcome & { text: string } {
    return { text: unsafeText(this.model, this.wire ?? this.level, recheckAt(mark)), actions: [log('button-refused', { direction, model: this.model, status: 'unsafe' })] };
  }

  /** The cache mark that holds this agent's effort while it waits; undefined when none does. */
  private waiting(): Unsafe | undefined {
    return this.model === '' || !this.steeredNow ? undefined : this.setup.marks.waiting(this.model, this.setup.now());
  }

  /**
   * A press's note while the last request went untouched (a model outside `models`, or no level): the level waits for a request it can go on.
   */
  private unsteered(): string {
    return this.model === '' || this.steeredNow ? '' : unsteeredNote(this.model);
  }

  /** The line owed to the agent's next tool result, handed over once. */
  takeAnnouncement(): string | undefined {
    const line = this.line;
    this.line = undefined;
    return line;
  }

  end(): Row {
    return { event: 'end', requests: { ...this.requests }, struggles: this.struggles, judgeCalls: this.judgeCalls, judgeTokens: { ...this.judgeTokens } };
  }

  private take(found: { token: string; red: boolean; line: string }, childType: string, unit: string, child: Child | undefined, text: string): Outcome {
    const actions: Action[] = [];
    if (this.seen.has(found.line)) return { actions };
    this.seen.add(found.line);
    this.event(`return ${childType} ${found.token}: ${found.line.slice(0, LINE_MAX)}`);
    if (child) child.unit = unit;
    if (found.red) {
      this.reds.add(unit);
      this.heads.set(unit, collapse(text).slice(0, HEAD_MAX));
      this.tripwire('red', whyChild(childType, found.token), actions, this.heads.get(unit));
    } else {
      // A green return that names no open red closes the only one its own agent type holds.
      if (!this.reds.has(unit) && child) {
        const open = new Set([...this.children.values()].filter((other) => other.type === child.type && this.isRed(other)).map((other) => other.unit as string));
        if (open.size === 1) {
          const [only] = open;
          this.reds.delete(only as string);
          this.heads.delete(only as string);
        }
      }
      this.reds.delete(unit);
      this.resolve(actions);
    }
    return { actions };
  }

  private isRed(child: Child): boolean {
    return child.unit !== undefined && this.reds.has(child.unit);
  }

  private headOf(child: Child): string | undefined {
    return child.unit === undefined ? undefined : this.heads.get(child.unit);
  }

  private event(token: string): void {
    this.ring.push(collapse(token));
    if (this.ring.length > RING) this.ring.shift();
  }

  private current(epoch: number): boolean {
    return this.struggle !== undefined && this.struggle.epoch === epoch;
  }

  private addUsage(usage: Usage): void {
    this.judgeTokens.input += usage.input_tokens;
    this.judgeTokens.output += usage.output_tokens;
  }

  /** The marks a row of an automatic rule carries while a press or a cache mark holds the level. */
  private heldMark(): Row {
    return { ...(this.held ? { held: true } : {}), ...(this.waiting() !== undefined ? { unsafe: true } : {}) };
  }

  // Every automatic rule moves the level here, so a held level stays put. While a cache mark waits the requests keep their
  // effort (`onRequest`): the level moves unannounced and goes out once the wait is over, as the switch its recheck judges.
  private setLevel(to: Effort, why: string): void {
    if (this.held || to === this.level) return;
    this.level = to;
    if (this.setup.announce && this.waiting() === undefined) this.line = announceLine(to, why);
  }

  private tripwire(kind: Tripwire, why: string, actions: Action[], returnHead?: string): void {
    if (!this.setup.tripwires.has(kind)) return;
    if (!this.struggle) {
      this.struggle = { epoch: ++this.epochs, pre: this.base, requests: 0, quiet: 0 };
      this.struggles += 1;
    }
    this.struggle.quiet = 0;
    if (this.held || this.waiting() !== undefined) {
      actions.push(log('tripwire', { tripwire: kind, level: this.level, ...this.heldMark() }));
      return;
    }
    if (!this.setup.judge) {
      const from = this.level;
      this.setLevel(step(this.level, +1, this.setup.floor, this.setup.ceiling), why);
      actions.push(log('mechanical', { tripwire: kind, from, to: this.level }));
      return;
    }
    if (this.inFlight) {
      if (this.inFlight.epoch === this.struggle.epoch) {
        actions.push(log('judge-busy', { tripwire: kind }));
        return;
      }
      // The call in flight belongs to a struggle that is over: its answer will be dropped, so this one raises on its own.
      const from = this.level;
      this.setLevel(step(this.level, +1, this.setup.floor, this.setup.ceiling), why);
      actions.push(log('mechanical', { tripwire: kind, from, to: this.level, busy: true }));
      return;
    }
    const text = buildPacket({
      type: this.setup.type,
      model: this.model,
      level: this.level,
      home: this.home,
      floor: this.setup.floor,
      ceiling: this.setup.ceiling,
      tripwire: kind,
      brief: this.setup.brief,
      events: this.ring,
      failTail: this.failTail,
      returnHead,
      lastWords: this.lastWords,
    });
    this.inFlight = { epoch: this.struggle.epoch, tripwire: kind, packet: text };
    this.judgeCalls += 1;
    actions.push({ kind: 'judge', epoch: this.struggle.epoch, tripwire: kind, packet: text });
  }

  // The judge gave no level: one step up, if the struggle it was asked about is still the open one.
  private failed(epoch: number, tripwire: Tripwire | 'unknown', reason: string, actions: Action[], detail: Row): void {
    const from = this.level;
    if (this.current(epoch)) this.setLevel(step(this.level, +1, this.setup.floor, this.setup.ceiling), WHY_JUDGE_FAILED);
    actions.push(log('judge-failed', { tripwire, reason, from, to: this.level, ...this.heldMark() }, detail));
  }

  private resolve(actions: Action[]): void {
    if (!this.struggle || this.ownFails !== 0 || this.reds.size !== 0) return;
    this.close(actions, 'resolved');
  }

  // The open struggle ends and the level goes back to its pre level. A decay also clears what held it open: the
  // failure streak and the open child reds.
  private close(actions: Action[], why: 'resolved' | 'decay'): void {
    if (!this.struggle) return;
    const { pre, requests } = this.struggle;
    const from = this.level;
    this.struggle = undefined;
    if (why === 'decay') {
      this.ownFails = 0;
      this.reds.clear();
      this.heads.clear();
    }
    this.base = pre;
    this.setLevel(pre, why === 'decay' ? whyDecayed(pre, this.setup.struggleDecay) : whyResolved(pre));
    actions.push(log('resolved', { from, to: this.level, requests, why, ...this.heldMark() }));
  }
}
