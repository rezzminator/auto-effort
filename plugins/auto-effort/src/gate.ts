// The model gate (allow / probation / deny, `unknownModels` for the rest) and the marks that persist across sessions.

import { normalizeModel } from './model.ts';
import type { Compiled, Settings } from './settings.ts';

export { normalizeModel };

/** The cache canary's finding: the model's cache did not survive an effort change. */
export type Unsafe = { at: string; ratio: number; prevPrompt: number; cacheRead: number; from: string; to: string };

export type Persisted = {
  unsafe: Record<string, Unsafe>;
  /** Clean switches counted so far, per probation model. */
  probation: Record<string, number>;
  /** Probation models that earned `allow`. */
  graduated: string[];
};

export const EMPTY_PERSISTED: Persisted = { unsafe: {}, probation: {}, graduated: [] };

export type GateStatus = 'allow' | 'probation' | 'deny' | 'off' | 'unsafe';
export type Gate = { model: string; status: GateStatus; active: boolean };

export function gateOf(model: string, settings: Settings, compiled: Compiled, persisted: Persisted): Gate {
  const name = normalizeModel(model);
  const configured = compiled.models[name] ?? settings.unknownModels;
  if (configured === 'deny') return { model: name, status: 'deny', active: false };
  if (configured === 'off') return { model: name, status: 'off', active: false };
  if (persisted.unsafe[name] !== undefined) return { model: name, status: 'unsafe', active: false };
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
  return { ...persisted, unsafe: { ...persisted.unsafe, [normalizeModel(model)]: mark } };
}

/** Lifts the mark from one model, or from every model when none is named. */
export function clearUnsafe(persisted: Persisted, model: string | undefined): Persisted {
  if (model === undefined) return { ...persisted, unsafe: {} };
  const { [normalizeModel(model)]: _gone, ...rest } = persisted.unsafe;
  return { ...persisted, unsafe: rest };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stored value, tolerant of anything a hand edit or an older version left behind. */
export function readPersisted(raw: unknown): Persisted {
  if (!isRecord(raw)) return { unsafe: {}, probation: {}, graduated: [] };
  const unsafe: Record<string, Unsafe> = {};
  if (isRecord(raw.unsafe)) {
    for (const [model, mark] of Object.entries(raw.unsafe)) {
      if (isRecord(mark) && typeof mark.ratio === 'number') {
        unsafe[model] = {
          at: String(mark.at ?? ''),
          ratio: mark.ratio,
          prevPrompt: Number(mark.prevPrompt ?? 0),
          cacheRead: Number(mark.cacheRead ?? 0),
          from: String(mark.from ?? ''),
          to: String(mark.to ?? ''),
        };
      }
    }
  }
  const probation: Record<string, number> = {};
  if (isRecord(raw.probation)) {
    for (const [model, count] of Object.entries(raw.probation)) if (typeof count === 'number' && count >= 0) probation[model] = count;
  }
  const graduated = Array.isArray(raw.graduated) ? raw.graduated.filter((model): model is string => typeof model === 'string') : [];
  return { unsafe, probation, graduated };
}
