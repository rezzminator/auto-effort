// Every knob is a plugin option. Defaults agree in three places: here, plugin.json's userConfig and the README table.
// A bad value is reported by key and value, and the default applies.

import { isEffort, LEVELS, rank, type Effort } from './levels.ts';
import { normalizeModel } from './model.ts';

export const PLUGIN = 'auto-effort';

export type ModelStatus = 'allow' | 'probation' | 'deny';
export type UnknownModels = 'off' | ModelStatus;

export type Settings = {
  floor: Effort;
  ceiling: Effort;
  planLevel: Effort;
  planUpshiftPatterns: string[];
  planUpshiftChars: number;
  turnReminder: boolean;
  escalateAfterFailures: number;
  failurePatterns: string[];
  failureTools: string[];
  userEffortPins: boolean;
  models: string[];
  unknownModels: UnknownModels;
  probationSwitches: number;
  canaryThreshold: number;
  cacheTtlSeconds: number;
  statusLine: boolean;
  logFile: string;
};

export const DEFAULTS: Settings = {
  floor: 'medium',
  ceiling: 'xhigh',
  planLevel: 'high',
  planUpshiftPatterns: ['\\bthink', '\\bdesign'],
  planUpshiftChars: 1500,
  turnReminder: true,
  escalateAfterFailures: 2,
  failurePatterns: ['--- FAIL', 'FAIL(ED)?', '\\d+ (failed|failing)', 'AssertionError', 'panic:', 'Traceback'],
  failureTools: ['Bash'],
  userEffortPins: true,
  models: ['claude-opus-5-5=allow', 'claude-fable-5-1=allow', 'claude-sonnet-5-5=probation', 'claude-haiku-5-5=probation', 'claude-sonnet-5=deny'],
  unknownModels: 'off',
  probationSwitches: 5,
  canaryThreshold: 0.9,
  cacheTtlSeconds: 300,
  statusLine: true,
  logFile: '~/.local/state/auto-effort/decisions.jsonl',
};

export const SETTING_KEYS = Object.keys(DEFAULTS) as Array<keyof Settings>;

type Parsed<T> = { ok: true; value: T } | { ok: false; why: string };
const good = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (why: string): Parsed<never> => ({ ok: false, why });

const parseLevel = (raw: unknown): Parsed<Effort> => (isEffort(raw) ? good(raw) : bad(`not a level (${LEVELS.join(', ')})`));

function parseBool(raw: unknown): Parsed<boolean> {
  if (typeof raw === 'boolean') return good(raw);
  if (raw === 'true') return good(true);
  if (raw === 'false') return good(false);
  return bad('not true or false');
}

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
}

const parseInt1 = (raw: unknown): Parsed<number> => {
  const n = toNumber(raw);
  return Number.isInteger(n) && n >= 1 ? good(n) : bad('not a whole number of at least 1');
};

const parseRatio = (raw: unknown): Parsed<number> => {
  const n = toNumber(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? good(n) : bad('not a number above 0 and at most 1');
};

function parseUnknownModels(raw: unknown): Parsed<UnknownModels> {
  return raw === 'off' || raw === 'allow' || raw === 'probation' || raw === 'deny' ? good(raw) : bad('not one of off, allow, probation, deny');
}

const parseText = (raw: unknown): Parsed<string> => (typeof raw === 'string' ? good(raw) : bad('not text'));

/** A list option: an array of strings, or text with one entry per line. Empty text means the default. */
function listOf(check: (item: string) => string | undefined): (raw: unknown) => Parsed<string[] | 'default'> {
  return (raw) => {
    let items: string[];
    if (Array.isArray(raw)) items = raw.map(String);
    else if (typeof raw === 'string') items = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    else return bad('not a list');
    if (typeof raw === 'string' && items.length === 0) return good('default');
    for (const item of items) {
      const problem = check(item);
      if (problem !== undefined) return bad(problem);
    }
    return good(items);
  };
}

const regexItem = (item: string): string | undefined => {
  try {
    new RegExp(item);
    return undefined;
  } catch (error) {
    return `"${item}" is not a regular expression (${error instanceof Error ? error.message : String(error)})`;
  }
};

const MODEL_ENTRY = /^([^=\s]+)=(allow|probation|deny)$/;
const modelItem = (item: string): string | undefined => (MODEL_ENTRY.test(item) ? undefined : `"${item}" is not model=allow, model=probation or model=deny`);
const nameItem = (item: string): string | undefined => (/^\S+$/.test(item) ? undefined : `"${item}" is not a tool name`);

const PARSERS: { [K in keyof Settings]: (raw: unknown) => Parsed<Settings[K] | 'default'> } = {
  floor: parseLevel,
  ceiling: parseLevel,
  planLevel: parseLevel,
  planUpshiftPatterns: listOf(regexItem),
  planUpshiftChars: parseInt1,
  turnReminder: parseBool,
  escalateAfterFailures: parseInt1,
  failurePatterns: listOf(regexItem),
  failureTools: listOf(nameItem),
  userEffortPins: parseBool,
  models: listOf(modelItem),
  unknownModels: parseUnknownModels,
  probationSwitches: parseInt1,
  canaryThreshold: parseRatio,
  cacheTtlSeconds: parseInt1,
  statusLine: parseBool,
  logFile: parseText,
};

function errorLine(key: string, raw: unknown, why: string): string {
  return `auto-effort: option "${key}" is ${JSON.stringify(raw)}, ${why}; using the default ${JSON.stringify(DEFAULTS[key as keyof Settings])}`;
}

/** Every option read, validated and defaulted; `errors` holds one line per rejected option. */
export function resolveSettings(raw: Readonly<Record<string, unknown>>): { settings: Settings; errors: string[] } {
  const settings: Record<string, unknown> = { ...DEFAULTS };
  const errors: string[] = [];
  for (const key of SETTING_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    const parsed = (PARSERS[key] as (raw: unknown) => Parsed<unknown>)(value);
    if (!parsed.ok) errors.push(errorLine(key, value, parsed.why));
    else if (parsed.value !== 'default') settings[key] = parsed.value;
  }
  const out = settings as Settings;
  if (rank(out.floor) > rank(out.ceiling)) {
    errors.push(`auto-effort: option "floor" (${JSON.stringify(out.floor)}) is above option "ceiling" (${JSON.stringify(out.ceiling)}); using the defaults ${JSON.stringify(DEFAULTS.floor)} and ${JSON.stringify(DEFAULTS.ceiling)}`);
    out.floor = DEFAULTS.floor;
    out.ceiling = DEFAULTS.ceiling;
  }
  return { settings: out, errors };
}

export type Compiled = {
  upshift: RegExp[];
  failure: RegExp[];
  models: Record<string, ModelStatus>;
};

/** The lists as regular expressions (a prompt pattern ignores case, a failure pattern does not) and the model entries as a map. */
export function compile(settings: Settings): Compiled {
  const models: Record<string, ModelStatus> = {};
  for (const entry of settings.models) {
    const match = MODEL_ENTRY.exec(entry);
    if (match?.[1] !== undefined && match[2] !== undefined) models[normalizeModel(match[1])] = match[2] as ModelStatus;
  }
  return {
    upshift: settings.planUpshiftPatterns.map((source) => new RegExp(source, 'i')),
    failure: settings.failurePatterns.map((source) => new RegExp(source)),
    models,
  };
}
