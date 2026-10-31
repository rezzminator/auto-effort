// Every sentence the model or the user reads. The tool description and the turn reminder are what the pilot tunes.

import { LEVELS, rank, type Effort } from './levels.ts';

const GUIDE: Record<Effort, string> = {
  low: 'lookups, status reports, formatting, one-line edits',
  medium: 'edits whose every line the plan already fixes (a rename, a move, a known fix), running and reading tests',
  high: 'debugging a known symptom, writing non-trivial code from scratch, explaining unfamiliar code',
  xhigh: 'a decision others will build on (architecture, design trade-offs, a spec, a review verdict), or a root cause one attempt did not find',
  max: 'what xhigh already failed to settle',
};

/** The tool's description for the levels the clamp lets through: the floor's line also covers the lighter work, the ceiling's the heavier. */
export function toolDescription(floor: Effort, ceiling: Effort): string {
  const lines = [...LEVELS]
    .reverse()
    .filter((level) => rank(level) >= rank(floor) && rank(level) <= rank(ceiling))
    .map((level) => {
      let text = GUIDE[level];
      if (level === floor && rank(floor) > 0) text += `; and anything lighter (${LEVELS.filter((l) => rank(l) < rank(floor)).map((l) => GUIDE[l]).join('; ')})`;
      if (level === ceiling && rank(ceiling) < rank('max')) text += `; and anything heavier, which this setup caps at ${ceiling}`;
      return `- ${level}: ${text}.`;
    });
  return [
    'set_effort: set your reasoning effort for the requests after this call. A level you set holds until this turn ends, over the automatic rules; the next turn starts at its planned level again.',
    'auto hands the effort back to the automatic rules for the rest of this turn: its planned level, and failing test runs raise it.',
    'Main chat only: a sub-agent never calls it.',
    'Call it in your first response of a user turn whose work needs another level than the one in effect, alongside your first tool calls.',
    ...lines,
    'Raise it the moment the work turns harder than planned: a test fails for a reason you cannot name, or a fix you were sure of did not hold. Lower it once only mechanical steps remain.',
    'If the answer itself needs deep thought and there is no tool work, call this first and answer after its result.',
  ].join('\n');
}

/** The one line added to each prompt while the automatic rules hold: the level the turn starts at, and the tool. */
export function reminderLine({ level, tool, upshift, chars, hints, hintLevel }: { level: Effort; tool: string; upshift: 'length' | 'pattern' | null; chars: number; hints: string[]; hintLevel: Effort }): string {
  const why = upshift === 'length' ? ` because the prompt is long (${chars} characters)` : upshift === 'pattern' ? ' because the prompt matches planUpshiftPatterns' : '';
  const words = hints.map((word) => JSON.stringify(word));
  const named = words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  const hint = hints.length ? ` This prompt names ${named}: the ${tool} guide places that kind of work at ${hintLevel}; whether this turn is that work is your call.` : '';
  return `Your reasoning effort starts this turn at ${level}${why}, and this first response runs at ${level}. Call ${tool} first, with the level the work ahead needs; a level you set lasts until this turn ends. With no call, the turn stays at ${level}.${hint}`;
}

/** The answer to a level set with set_effort, with why a clamped level differs from the one asked. */
export function setText(applied: Effort, requested: Effort, floor: Effort, ceiling: Effort): string {
  const clamped = applied === requested ? '' : ` (${requested} is ${rank(requested) < rank(floor) ? `below the floor ${floor}` : `above the ceiling ${ceiling}`})`;
  return `Effort set to ${applied} from your next request${clamped}; it holds until this turn ends, or until you call set_effort with auto.`;
}

/**
 * The answer to set_effort with auto. `held`: a level of the main chat's was held; `level`: what the current turn runs at
 * again, null with no turn steered; `outranked`: what still decides the effort instead (a pin, off, the model gate).
 */
export function handBackText(input: { held: boolean; level: Effort | null; outranked?: string }): string {
  if (input.outranked !== undefined) return `Effort handed back to the automatic rules; ${input.outranked}.`;
  if (!input.held) return 'Nothing to hand back: your reasoning effort already follows the automatic rules.';
  if (input.level === null) return 'Effort handed back to the automatic rules: each turn starts at its planned level.';
  return `Effort handed back to the automatic rules: this turn runs at ${input.level} again from your next request, and each turn starts at its planned level.`;
}

/** The one line a rise adds to the tool result that caused it. */
export function escalationLine(failures: number, from: Effort, to: Effort): string {
  return `auto-effort: ${failures} failing test runs this turn, so your reasoning effort rises from ${from} to ${to} for the requests that follow.`;
}

/** The one line the rise's threshold adds while the main chat's own level holds: no rise, and the way up. */
export function heldLine(failures: number, level: Effort, tool: string): string {
  return `auto-effort: ${failures} failing test runs this turn; your reasoning effort stays at ${level}, the level you set. Call ${tool} with a higher level if the work needs more, or with auto to let failing tests raise it.`;
}

/** The one line a passing test run adds when it undoes the rises of the failing streak before it. */
export function deescalationLine(from: Effort, to: Effort): string {
  return `auto-effort: the tests pass again, so your reasoning effort is back to ${to} from ${from} for the requests that follow.`;
}

const REASON_MAX = 60;

/** Text a message carries from outside (a raw value, an error): at most `max` characters. */
export function clip(text: string, max = REASON_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A raw value as a message quotes it: its JSON, at most 60 characters. */
export function quote(value: unknown): string {
  return clip(JSON.stringify(value) ?? String(value));
}

/** A reason as the state file and the log carry it: one line, at most 60 characters. */
export function shortReason(reason: unknown): string {
  if (typeof reason !== 'string') return 'no reason given';
  const text = reason.replace(/\s+/g, ' ').trim();
  if (text === '') return 'no reason given';
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}
