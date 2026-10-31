// Every knob is a plugin option, and each also reads the environment variable AUTO_EFFORT_{OPTION} (the option in upper snake case),
// which wins over the option, which wins over the default. Defaults agree in three places: here, plugin.json's userConfig and the README table.
// A bad value is reported by key and value (a bad variable by its name), and the default applies.

import { isEffort, LEVELS, rank, type Effort } from './levels.ts';
import { normalizeModel } from './model.ts';
import { clip, quote } from './text.ts';

export const PLUGIN = 'auto-effort';
/** The plugin's name from 1.0.0 to 2.0.0: its settings, variables and state directory are migrated, never dropped. */
export const FORMER = 'auto-effort-control';

export type ModelStatus = 'allow' | 'probation' | 'deny';
export type UnknownModels = 'off' | ModelStatus;

export type Settings = {
  floor: Effort;
  ceiling: Effort;
  planLevel: Effort;
  planUpshiftPatterns: string[];
  hintPatterns: string[];
  planUpshiftChars: number;
  turnReminder: boolean;
  escalateAfterFailures: number;
  lowerOnPass: boolean;
  failurePatterns: string[];
  failureTools: string[];
  testCommandPatterns: string[];
  userEffortPins: boolean;
  models: string[];
  unknownModels: UnknownModels;
  probationSwitches: number;
  canaryThreshold: number;
  cacheTtlSeconds: number;
  statusLine: boolean;
  stateFile: string;
};

export const DEFAULTS: Settings = {
  floor: 'medium',
  ceiling: 'xhigh',
  planLevel: 'high',
  planUpshiftPatterns: [],
  hintPatterns: ['\\bdesign', '\\barchitect', '\\btrade-?offs?\\b', '\\broot[- ]?causes?\\b', '\\bspec(s|ced|ification)?\\b', '\\bthink (hard|harder|deeply|carefully|it through)\\b', '\\bultrathink\\b'],
  planUpshiftChars: 1500,
  turnReminder: true,
  escalateAfterFailures: 2,
  lowerOnPass: true,
  failurePatterns: ['--- FAIL', 'FAIL(ED)?', '(?<!\\d)[1-9]\\d* (failed|failing)', 'AssertionError', 'panic:', 'Traceback'],
  failureTools: ['Bash'],
  testCommandPatterns: [
    '\\bgo\\s+(-C\\s+\\S+\\s+)?test\\b',
    '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b',
    '\\bvitest\\b',
    '\\bjest\\b',
    '\\bpytest\\b',
    '\\bcargo\\s+(test|nextest)\\b',
    '\\bmake\\b[^;&|\\n]*?\\b(test|check|verify)\\b',
    '\\bjust\\b[^;&|\\n]*?\\b(test|check)\\b',
    '\\b(mvn|gradle|gradlew)\\b[^;&|\\n]*?\\btest\\b',
    '\\bdotnet\\s+test\\b',
    '\\bdeno\\s+test\\b',
    '\\bswift\\s+test\\b',
    '\\bmix\\s+test\\b',
    '\\b(rspec|phpunit|ctest|tox|nox)\\b',
    '\\bscripts?/test[\\w.-]*\\.sh\\b',
  ],
  userEffortPins: true,
  models: ['claude-opus-5-5=allow', 'claude-fable-5-1=allow', 'claude-sonnet-5-5=probation', 'claude-haiku-5-5=probation', 'claude-sonnet-5=deny'],
  unknownModels: 'off',
  probationSwitches: 5,
  canaryThreshold: 0.9,
  cacheTtlSeconds: 300,
  statusLine: true,
  stateFile: '~/.local/state/auto-effort/state.json',
};

export const SETTING_KEYS = Object.keys(DEFAULTS) as Array<keyof Settings>;

/** The variable an option reads: AUTO_EFFORT_ and the option in upper snake case (`planLevel` is AUTO_EFFORT_PLAN_LEVEL). */
export const envName = (key: string): string => `AUTO_EFFORT_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;

/** The text of each option's variable, as the environment holds it; undefined where it is unset. */
export type EnvValues = Readonly<Partial<Record<keyof Settings, string | undefined>>>;

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
    return `${quote(item)} is not a regular expression (${clip(error instanceof Error ? error.message : String(error), 72)})`;
  }
};

const MODEL_ENTRY = /^([^=\s]+)=(allow|probation|deny)$/;
const modelItem = (item: string): string | undefined => (MODEL_ENTRY.test(item) ? undefined : `${quote(item)} is not model=allow, model=probation or model=deny`);
const nameItem = (item: string): string | undefined => (/^\S+$/.test(item) ? undefined : `${quote(item)} is not a tool name`);

const PARSERS: { [K in keyof Settings]: (raw: unknown) => Parsed<Settings[K] | 'default'> } = {
  floor: parseLevel,
  ceiling: parseLevel,
  planLevel: parseLevel,
  planUpshiftPatterns: listOf(regexItem),
  hintPatterns: listOf(regexItem),
  planUpshiftChars: parseInt1,
  turnReminder: parseBool,
  escalateAfterFailures: parseInt1,
  lowerOnPass: parseBool,
  failurePatterns: listOf(regexItem),
  failureTools: listOf(nameItem),
  testCommandPatterns: listOf(regexItem),
  userEffortPins: parseBool,
  models: listOf(modelItem),
  unknownModels: parseUnknownModels,
  probationSwitches: parseInt1,
  canaryThreshold: parseRatio,
  cacheTtlSeconds: parseInt1,
  statusLine: parseBool,
  stateFile: parseText,
};

function errorLine(key: string, raw: unknown, why: string, from?: string): string {
  return `auto-effort: option "${key}"${from === undefined ? '' : ` (${from})`} is ${quote(raw)}, ${why}; using the default ${JSON.stringify(DEFAULTS[key as keyof Settings])}`;
}

/** A variable's text as the option's own parser reads it: 1|0|true|false for a boolean, a JSON array of strings for a list. */
function parseEnv(key: keyof Settings, text: string): Parsed<unknown> {
  const parser = PARSERS[key] as (raw: unknown) => Parsed<unknown>;
  if (typeof DEFAULTS[key] === 'boolean') {
    const word = text.toLowerCase();
    if (word === '1' || word === 'true') return good(true);
    if (word === '0' || word === 'false') return good(false);
    return bad('not 1, 0, true or false');
  }
  if (Array.isArray(DEFAULTS[key])) {
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      return bad('not a JSON array of strings');
    }
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) return bad('not a JSON array of strings');
    return parser(list);
  }
  return parser(text);
}

/** Every option read, validated and defaulted: its variable (`env`), else the option (`raw`), else the default. `errors` holds one line per rejected value. */
export function resolveSettings(raw: Readonly<Record<string, unknown>>, env: EnvValues = {}): { settings: Settings; errors: string[]; fromEnv: Array<keyof Settings> } {
  const settings: Record<string, unknown> = { ...DEFAULTS };
  const errors: string[] = [];
  /** The options a valid variable decided: the ones a bad variable or a floor/ceiling reset gave back to the default are not among them. */
  let fromEnv: Array<keyof Settings> = [];
  for (const key of SETTING_KEYS) {
    const text = env[key]?.trim() ?? '';
    if (text !== '') {
      const parsed = parseEnv(key, text);
      if (parsed.ok) {
        settings[key] = parsed.value;
        fromEnv.push(key);
      } else errors.push(errorLine(key, text, parsed.why, `environment variable ${envName(key)}`));
      continue;
    }
    const value = raw[key];
    if (value === undefined) continue;
    const parsed = (PARSERS[key] as (raw: unknown) => Parsed<unknown>)(value);
    if (!parsed.ok) errors.push(errorLine(key, value, parsed.why));
    else if (parsed.value !== 'default') settings[key] = parsed.value;
  }
  const out = settings as Settings;
  if (rank(out.floor) > rank(out.ceiling)) {
    const origin = (key: 'floor' | 'ceiling'): string => (fromEnv.includes(key) ? `, from ${envName(key)}` : '');
    errors.push(`auto-effort: option "floor" (${JSON.stringify(out.floor)}${origin('floor')}) is above option "ceiling" (${JSON.stringify(out.ceiling)}${origin('ceiling')}); using the defaults ${JSON.stringify(DEFAULTS.floor)} and ${JSON.stringify(DEFAULTS.ceiling)}`);
    out.floor = DEFAULTS.floor;
    out.ceiling = DEFAULTS.ceiling;
    fromEnv = fromEnv.filter((key) => key !== 'floor' && key !== 'ceiling');
  }
  return { settings: out, errors, fromEnv };
}

export type Compiled = {
  upshift: RegExp[];
  hints: RegExp[];
  failure: RegExp[];
  testCommand: RegExp[];
  models: Record<string, ModelStatus>;
};

/** The lists as regular expressions (a prompt pattern ignores case, a failure or test command pattern does not) and the model entries as a map. */
export function compile(settings: Settings): Compiled {
  const models: Record<string, ModelStatus> = {};
  for (const entry of settings.models) {
    const match = MODEL_ENTRY.exec(entry);
    if (match?.[1] !== undefined && match[2] !== undefined) models[normalizeModel(match[1])] = match[2] as ModelStatus;
  }
  return {
    upshift: settings.planUpshiftPatterns.map((source) => new RegExp(source, 'i')),
    hints: settings.hintPatterns.map((source) => new RegExp(source, 'gi')),
    failure: settings.failurePatterns.map((source) => new RegExp(source)),
    testCommand: settings.testCommandPatterns.map((source) => new RegExp(source)),
    models,
  };
}
