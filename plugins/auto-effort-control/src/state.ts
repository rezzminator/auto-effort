// The state file: one JSON line per session naming the mode the main chat's effort is in, its level, the reason and the
// keeper vouching for it, for a reader outside the plugin such as a status line. The adapter rewrites it whole when its
// text, `updatedAt` aside, changes; README § The state file is its contract.

import type { Effort } from './levels.ts';
import { shortReason } from './text.ts';

export const STATE_VERSION = 2;

/** The last argument of the keeper's argv: a reader checks a process carries it before it trusts the pid. */
export const KEEPER_MARK = 'auto-effort-control-keeper';

/**
 * The keeper, a child the adapter starts for the plugin's life: the host kills it when the plugin's hooks unload, and
 * it exits within two seconds of the process that started it. Its first output is its own pid.
 */
export const KEEPER_ARGV: readonly string[] = ['/bin/sh', '-c', 'echo $$; while kill -0 "$PPID" 2>/dev/null; do sleep 2; done', KEEPER_MARK];

/**
 * `auto`: the automatic rules (the planning level, test-failure rises); `model`: the main chat's own level, set with
 * `set_effort`; `pin`: the user's `/effort`; `off`: the plugin sends no level (switched off, or the model gate keeps
 * the model unsteered).
 */
export type Mode = 'auto' | 'model' | 'pin' | 'off';

/** `level` is null when the plugin holds none: `off`, or `auto` before the first request. */
export type EffortState = { version: typeof STATE_VERSION; mode: Mode; level: Effort | null; reason: string };

export type StateInput = {
  enabled: boolean;
  /** False when the model gate keeps the last model seen unsteered; true when it steers or no model is seen yet. */
  steered: boolean;
  pin: Effort | null;
  /** The main chat's own level, held until this turn ends or it calls `set_effort` with `auto`. */
  override: { level: Effort; reason: string } | null;
  /** The level the current turn's requests go at, and why; null before the first request. */
  turn: { level: Effort; reason: string } | null;
};

/** The session's state, highest rule first: off, not steered, the user's pin, the main chat's level, the rules. */
export function stateOf(input: StateInput): EffortState {
  if (!input.enabled) return { version: STATE_VERSION, mode: 'off', level: null, reason: 'auto-effort-control is off; /auto-effort-control on resumes' };
  if (!input.steered) return { version: STATE_VERSION, mode: 'off', level: null, reason: 'this model is not steered' };
  if (input.pin !== null) return { version: STATE_VERSION, mode: 'pin', level: input.pin, reason: 'you set /effort; /effort auto or /auto-effort-control on resumes' };
  if (input.override !== null) return { version: STATE_VERSION, mode: 'model', level: input.override.level, reason: shortReason(input.override.reason) };
  if (input.turn === null) return { version: STATE_VERSION, mode: 'auto', level: null, reason: 'the next turn starts at its planned level' };
  return { version: STATE_VERSION, mode: 'auto', level: input.turn.level, reason: shortReason(input.turn.reason) };
}

/**
 * The file's whole text: one JSON line, keys in a fixed order. `keeper` is the pid of the keeper vouching for the line,
 * 0 when none does (the session ended, the plugin left this path, or no keeper runs); `updatedAt` the time of writing.
 */
export function stateText(state: EffortState, keeper: number, now: Date): string {
  return `${JSON.stringify({ version: state.version, mode: state.mode, level: state.level, reason: state.reason, keeper, updatedAt: now.toISOString() })}\n`;
}
