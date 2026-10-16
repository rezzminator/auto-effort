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
    'set_effort: set your reasoning effort for the requests after this call, until this turn ends.',
    'Main chat only: a sub-agent never calls it.',
    'Call it in your first response of every user turn, alongside your first tool calls.',
    ...lines,
    'Raise it the moment the work turns harder than planned: a test fails for a reason you cannot name, or a fix you were sure of did not hold. Lower it once only mechanical steps remain.',
    'If the answer itself needs deep thought and there is no tool work, call this first and answer after its result.',
  ].join('\n');
}

/** The one line added to each prompt: the level the turn starts at, and the tool. */
export function reminderLine(level: Effort, tool: string): string {
  return `Your reasoning effort starts this turn at ${level}, and this first response runs at ${level}. Call ${tool} first, with the level the work ahead needs; it holds until the turn ends. With no call, the turn stays at ${level}.`;
}

/** The one line a rise adds to the tool result that caused it. */
export function escalationLine(failures: number, from: Effort, to: Effort): string {
  return `auto-effort: ${failures} failing test runs this turn, so your reasoning effort rises from ${from} to ${to} for the requests that follow.`;
}

/** The one line a passing test run adds when it undoes the rises of the failing streak before it. */
export function deescalationLine(from: Effort, to: Effort): string {
  return `auto-effort: the tests pass again, so your reasoning effort is back to ${to} from ${from} for the requests that follow.`;
}

export type Shown = 'plan' | 'model' | 'escalation' | 'pin';

/** The pinned status line: `effort auto: {level} · {short reason} ({source})`. */
export function statusLine(level: Effort, reason: string, source: Shown): string {
  return `effort auto: ${level} · ${reason} (${source})`;
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

/** A reason as the status line and the log carry it: one line, at most 60 characters. */
export function shortReason(reason: unknown): string {
  if (typeof reason !== 'string') return 'no reason given';
  const text = reason.replace(/\s+/g, ' ').trim();
  if (text === '') return 'no reason given';
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}
