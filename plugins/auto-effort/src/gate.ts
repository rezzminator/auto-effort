// The model gate (allow / probation / deny, `unknownModels` for the rest), the marks that persist across sessions and their recheck.

import { modelVariant, normalizeModel } from './model.ts';
import type { Compiled, Settings } from './settings.ts';

export { modelVariant, normalizeModel };

/** The cache canary's finding: the model's cache did not survive an effort change. */
/** `ratio` is null when a stored mark no longer holds it: the mark gates by its presence, the ratio is only shown. */
/** `fails` counts the failed checks in a row, 1 for a first one and for a mark stored before the count was kept. */
export type Unsafe = { at: string; ratio: number | null; prevPrompt: number; cacheRead: number; from: string; to: string; fails: number };

/**
 * A chat's own cache checks on one model and context window, held while its process lives: the mark its last failed
 * check left, and whether a check has passed since. A failed check can come from the chat alone (its process, its
 * conversation), so what a chat saw itself outranks what another chat stored.
 */
export type Checks = { failed: Unsafe | undefined; passed: boolean };

export const NO_CHECKS: Checks = { failed: undefined, passed: false };

export type Persisted = {
  /** The marks, per model and context window (`modelVariant`): a mark on `claude-x[1m]` leaves `claude-x` steered. */
  unsafe: Record<string, Unsafe>;
  /** Clean switches counted so far, per probation model. */
  probation: Record<string, number>;
  /** Probation models that earned `allow`. */
  graduated: string[];
};

export const EMPTY_PERSISTED: Persisted = { unsafe: {}, probation: {}, graduated: [] };

/** `unsafe` while a mark waits, `recheck` once its wait is over: the model is steered again and its next switch is judged. */
export type GateStatus = 'allow' | 'probation' | 'deny' | 'off' | 'unsafe' | 'recheck';
export type Gate = { model: string; status: GateStatus; active: boolean };

const RECHECK_FIRST_MS = 3_600_000;
const RECHECK_LONGEST_MS = 86_400_000;

/**
 * When a mark is rechecked, in epoch ms: an hour after a first failed check, twice as long after each further one in a
 * row, a day at most. A mark whose time cannot be read is due at once: nothing says how long it has waited.
 */
export function recheckAt(mark: Unsafe): number {
  const at = Date.parse(mark.at);
  return Number.isNaN(at) ? 0 : at + Math.min(RECHECK_LONGEST_MS, RECHECK_FIRST_MS * 2 ** (mark.fails - 1));
}

/** The mark that binds a chat: the one its own failed check left; else the stored one, unless a check of its own has passed. */
export function bindingMark(persisted: Persisted, model: string, checks: Checks): Unsafe | undefined {
  return checks.failed ?? (checks.passed ? undefined : persisted.unsafe[modelVariant(model)]);
}

/** The failed checks in a row one more failure makes: one past the longer of the chat's own run and the stored one. */
export function nextFails(persisted: Persisted, model: string, checks: Checks): number {
  return Math.max(checks.failed?.fails ?? 0, persisted.unsafe[modelVariant(model)]?.fails ?? 0) + 1;
}

export function gateOf(model: string, settings: Settings, compiled: Compiled, persisted: Persisted, checks: Checks, now: number): Gate {
  const name = normalizeModel(model);
  const configured = compiled.models[name] ?? settings.unknownModels;
  if (configured === 'deny') return { model: name, status: 'deny', active: false };
  if (configured === 'off') return { model: name, status: 'off', active: false };
  const mark = bindingMark(persisted, model, checks);
  if (mark !== undefined) return now >= recheckAt(mark) ? { model: name, status: 'recheck', active: true } : { model: name, status: 'unsafe', active: false };
  if (configured === 'probation' && persisted.graduated.includes(name)) return { model: name, status: 'allow', active: true };
  return { model: name, status: configured, active: true };
}

/** One clean switch on a probation model; the last one it needs graduates it. */
export function cleanSwitch(persisted: Persisted, model: string, needed: number): { persisted: Persisted; graduated: boolean } {
  const name = normalizeModel(model);
  const count = (persisted.probation[name] ?? 0) + 1;
  if (count >= needed) {
    const { [name]: _done, ...rest } = persisted.probation;
    return { persisted: { ...persisted, probation: rest, graduated: [...new Set([...persisted.graduated, name])] }, graduated: true };
  }
  return { persisted: { ...persisted, probation: { ...persisted.probation, [name]: count } }, graduated: false };
}

export function markUnsafe(persisted: Persisted, model: string, mark: Unsafe): Persisted {
  return { ...persisted, unsafe: { ...persisted.unsafe, [modelVariant(model)]: mark } };
}

/**
 * The stored marks with this session's entries laid over them for the models it changed, an absent entry included; every
 * other model keeps what is stored. A cache mark is laid over the context window named, a probation count and a graduation
 * over the model whatever its window.
 */
export function mergeModels(stored: Persisted, mine: Persisted, models: readonly string[]): Persisted {
  const unsafe = { ...stored.unsafe };
  const probation = { ...stored.probation };
  const graduated = new Set(stored.graduated);
  for (const variant of new Set(models.map(modelVariant))) {
    const mark = mine.unsafe[variant];
    if (mark === undefined) delete unsafe[variant];
    else unsafe[variant] = mark;
  }
  for (const name of new Set(models.map(normalizeModel))) {
    const count = mine.probation[name];
    if (count === undefined) delete probation[name];
    else probation[name] = count;
    if (mine.graduated.includes(name)) graduated.add(name);
    else graduated.delete(name);
  }
  return { unsafe, probation, graduated: [...graduated] };
}

/** Lifts the mark of one model and context window: the one a clean switch on it disproved. */
export function liftMark(persisted: Persisted, model: string): Persisted {
  const { [modelVariant(model)]: _lifted, ...unsafe } = persisted.unsafe;
  return { ...persisted, unsafe };
}

/** Whether a model name covers a marked one: that context window alone when it names one (`claude-x[1m]`), else every window of the model. */
export function coversMark(model: string, marked: string): boolean {
  const variant = modelVariant(model);
  const name = normalizeModel(model);
  return variant === name ? normalizeModel(marked) === name : marked === variant;
}

/** The marked names a model name covers (`coversMark`). */
export function marksOf(persisted: Persisted, model: string): string[] {
  return Object.keys(persisted.unsafe).filter((marked) => coversMark(model, marked));
}

/** Lifts the marks a model name covers (`marksOf`), or every mark when none is named. */
export function clearUnsafe(persisted: Persisted, model: string | undefined): Persisted {
  if (model === undefined) return { ...persisted, unsafe: {} };
  const gone = new Set(marksOf(persisted, model));
  return { ...persisted, unsafe: Object.fromEntries(Object.entries(persisted.unsafe).filter(([marked]) => !gone.has(marked))) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The stored value, tolerant of anything a hand edit or an older version left behind. A model's unsafe mark is kept
 * whatever its fields hold; a probation count or graduated name it cannot read is named in `unreadable` and starts over.
 */
export function readPersisted(raw: unknown, unreadable: string[] = []): Persisted {
  if (!isRecord(raw)) return { unsafe: {}, probation: {}, graduated: [] };
  const unsafe: Record<string, Unsafe> = {};
  if (isRecord(raw.unsafe)) {
    for (const [model, stored] of Object.entries(raw.unsafe)) {
      const mark = isRecord(stored) ? stored : {};
      unsafe[model] = {
        at: String(mark.at ?? ''),
        ratio: typeof mark.ratio === 'number' ? mark.ratio : null,
        prevPrompt: Number(mark.prevPrompt ?? 0),
        cacheRead: Number(mark.cacheRead ?? 0),
        from: String(mark.from ?? ''),
        to: String(mark.to ?? ''),
        fails: typeof mark.fails === 'number' && mark.fails >= 1 ? Math.floor(mark.fails) : 1,
      };
    }
  } else if (raw.unsafe !== undefined) unreadable.push('unsafe');
  const probation: Record<string, number> = {};
  if (isRecord(raw.probation)) {
    for (const [model, count] of Object.entries(raw.probation)) {
      if (typeof count === 'number' && count >= 0) probation[model] = count;
      else unreadable.push(`probation.${model}`);
    }
  } else if (raw.probation !== undefined) unreadable.push('probation');
  const graduated: string[] = [];
  if (Array.isArray(raw.graduated)) {
    raw.graduated.forEach((model: unknown, at) => {
      if (typeof model === 'string') graduated.push(model);
      else unreadable.push(`graduated[${at}]`);
    });
  } else if (raw.graduated !== undefined) unreadable.push('graduated');
  return { unsafe, probation, graduated };
}
