import { DEFAULTS as MAIN_DEFAULTS, envName, resolveSettings as mainSettings } from './settings.ts';
import { DEFAULTS as SUBAGENT_DEFAULTS, resolveSettings as subagentSettings } from './subagent/settings.ts';

export type Scope = 'main' | 'subagent';
export type Values = Readonly<Record<string, unknown>>;
export type ReadValue = { ok: true; value: unknown } | { ok: false; error: string };
export const OPTION_DEFAULTS: Values = {
  ...SUBAGENT_DEFAULTS,
  ...MAIN_DEFAULTS,
  models: [...MAIN_DEFAULTS.models.map((x) => `main:${x}`), ...SUBAGENT_DEFAULTS.models.map((x) => `subagent:${x}`)],
  testCommandPatterns: [...MAIN_DEFAULTS.testCommandPatterns.map((x) => `main:${x}`), ...SUBAGENT_DEFAULTS.testCommandPatterns.map((x) => `subagent:${x}`)],
};
export const OPTION_KEYS = Object.keys(OPTION_DEFAULTS);
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const own = (x: Values, key: string): boolean => Object.prototype.hasOwnProperty.call(x, key);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const defaultsOf = (scope: Scope): Values => scope === 'main' ? MAIN_DEFAULTS : SUBAGENT_DEFAULTS;
const legacyOf = (scope: Scope): string => scope === 'main' ? 'auto-effort' : 'effort-live-control';
const legacyEnv = (scope: Scope, key: string): string => envName(key).replace('AUTO_EFFORT_CONTROL_', scope === 'main' ? 'AUTO_EFFORT_' : 'EFFORT_LIVE_CONTROL_');
const target = (key?: string): string => `pluginConfigs["auto-effort-control@…"].options${key === undefined ? '' : `.${key}`}`;

/** Project one public list without widening either scope. Empty scoped lists stay empty. */
export function projectOptions(raw: Values, scope: Scope): { options: Record<string, unknown>; errors: string[] } {
  const options: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const key of Object.keys(defaultsOf(scope))) {
    if (!own(raw, key)) continue;
    const value = raw[key];
    if (key !== 'models' && key !== 'testCommandPatterns') { options[key] = value; continue; }
    if (typeof value !== 'string' && !Array.isArray(value)) { options[key] = value; continue; }
    const items = typeof value === 'string' ? value.split('\n').map((x) => x.trim()).filter(Boolean) : value;
    if (typeof value === 'string' && items.length === 0) continue;
    if (!items.every((x): x is string => typeof x === 'string')) {
      errors.push(`auto-effort-control: ${target(key)} must be a list of strings; using the ${scope} default`);
      continue;
    }
    if (key === 'models' && items.some((x) => !/^(main|subagent):/.test(x))) {
      errors.push(`auto-effort-control: ${target(key)} requires main:model=allow|probation|deny or subagent:model-prefix; using the ${scope} default`);
      continue;
    }
    options[key] = items.filter((x) => !/^(main|subagent):/.test(x) || x.startsWith(`${scope}:`)).map((x) => x.replace(/^(main|subagent):/, ''));
  }
  return { options, errors };
}

/** All I/O is in the hook module; this resolver owns source presence, precedence and migration diagnostics. */
export function resolveOptions(scope: Scope, registered: Values, snapshot: ReadValue, reads: Readonly<Record<string, ReadValue>>, rows: readonly { key: string; value: unknown; explicit?: boolean }[] = [], previousEnv: Readonly<Record<string, string | undefined>> = {}) {
  const errors: string[] = [];
  const defaults = defaultsOf(scope);
  const legacy = legacyOf(scope);
  const canonical: Record<string, unknown> = {};
  const old: Record<string, unknown> = {};
  const origins: Record<string, string> = {};
  let settings: Values = {};
  if (!snapshot.ok) errors.push(`auto-effort-control: reading settings failed: ${snapshot.error}; pluginConfigs["auto-effort@…"].options -> ${target()} and pluginConfigs["effort-live-control@…"].options -> ${target()} could not be inspected; registered options still apply`);
  else if (!record(snapshot.value)) errors.push(`auto-effort-control: settings snapshot is not an object; pluginConfigs["${legacy}@…"].options -> ${target()} could not be inspected`);
  else settings = snapshot.value;
  const configs = settings.pluginConfigs;
  if (configs !== undefined && !record(configs)) errors.push(`auto-effort-control: pluginConfigs is not an object; pluginConfigs["${legacy}@…"].options -> ${target()} could not be inspected`);
  if (record(configs)) for (const id of Object.keys(configs).sort()) {
    const identity = id.split('@')[0];
    if (identity !== 'auto-effort-control' && identity !== legacy) continue;
    const entry = configs[id];
    const source = `pluginConfigs[${JSON.stringify(id)}].options`;
    if (!record(entry) || !record(entry.options)) {
      errors.push(`auto-effort-control: ${source} -> ${target()}: expected an options object; value was not applied`);
      continue;
    }
    const out = identity === legacy ? old : canonical;
    for (const [key, value] of Object.entries(entry.options)) {
      if (!OPTION_KEYS.includes(key) || (identity === legacy && !own(defaults, key))) {
        errors.push(`auto-effort-control: ${source}.${key} -> ${target(key)}: unknown option; not applied`);
        continue;
      }
      if (identity === legacy && Array.isArray(defaults[key]) && Array.isArray(value) && value.some((item) => typeof item !== 'string')) {
        errors.push(`auto-effort-control: ${source}.${key} -> ${target(key)}: list contains non-string entries; preserving the legacy string conversion`);
      }
      if (own(out, key)) {
        errors.push(`auto-effort-control: ${source}.${key} -> ${target(key)}: displaced by the first sorted entry of ${identity}; consolidate duplicate entries`);
        continue;
      }
      out[key] = value;
      if (identity === legacy) origins[key] = `${source}.${key}`;
    }
  }
  for (const [key, value] of Object.entries(registered)) {
    if (!OPTION_KEYS.includes(key)) errors.push(`auto-effort-control: registered option ${key} -> ${target(key)}: unknown option; not applied`);
    else if (!same(value, OPTION_DEFAULTS[key]) && !own(canonical, key)) canonical[key] = value;
  }
  for (const row of rows) {
    const match = /^auto-effort-control(?:@.+)?\.(\w+)$/.exec(row.key);
    if (!match) continue;
    const key = match[1]!;
    if (!OPTION_KEYS.includes(key)) errors.push(`auto-effort-control: /config ${row.key} -> ${target(key)}: unknown option; not applied`);
    // The menu includes defaults. Only raw presence, a changed value or our successful write proves an explicit setting.
    else if (row.explicit || own(canonical, key) || !same(row.value, OPTION_DEFAULTS[key])) canonical[key] = row.value;
  }
  // Validate all legacy settings even when another source displaces them.
  const validate = scope === 'main' ? mainSettings : subagentSettings;
  const legacyErrors = validate(old).errors;
  for (const line of legacyErrors) errors.push(`auto-effort-control: legacy ${legacy} -> auto-effort-control: ${line}`);
  const base = projectOptions(registered, scope);
  const explicit = projectOptions(canonical, scope);
  errors.push(...base.errors, ...explicit.errors);
  const options: Record<string, unknown> = { ...base.options, ...old, ...explicit.options };
  for (const key of Object.keys(canonical)) if (own(defaults, key) && !own(explicit.options, key)) delete options[key];
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(defaults)) {
    const name = envName(key);
    const oldName = legacyEnv(scope, key);
    const current = reads[name];
    const prior = reads[oldName];
    if (current !== undefined && !current.ok) errors.push(`auto-effort-control: reading ${name} failed: ${current.error}; ${previousEnv[key] === undefined ? 'using the option or its default' : 'keeping its last effective value'}`);
    if (prior !== undefined && !prior.ok) errors.push(`auto-effort-control: reading ${oldName} -> ${name} failed: ${prior.error}; keeping its last effective value when known`);
    const text = current?.ok && typeof current.value === 'string' && current.value.trim() !== '' ? current.value : undefined;
    const oldText = prior?.ok && typeof prior.value === 'string' && prior.value.trim() !== '' ? prior.value : undefined;
    if (origins[key] !== undefined) errors.push(`auto-effort-control: ${origins[key]} -> ${target(key)}: ${own(canonical, key) || text !== undefined || oldText !== undefined ? 'displaced by a higher-precedence value' : `honored for ${scope}`}`);
    if (oldText !== undefined) {
      errors.push(`auto-effort-control: ${oldName} -> ${name}: ${text !== undefined ? 'displaced by the canonical variable' : `honored for ${scope}`}`);
      for (const line of validate({}, { [key]: oldText }).errors) errors.push(`${oldName} -> ${name}: ${line}`);
    }
    let chosen = text ?? oldText;
    if (current !== undefined && !current.ok) chosen = previousEnv[key] ?? oldText;
    else if (text === undefined && prior !== undefined && !prior.ok) chosen = previousEnv[key];
    if (chosen === undefined) continue;
    if (text !== undefined && (key === 'models' || key === 'testCommandPatterns')) {
      try {
        const list: unknown = JSON.parse(chosen);
        if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new Error('not a JSON array of strings');
        const projected = projectOptions({ [key]: list }, scope);
        errors.push(...projected.errors.map((line) => `environment variable ${name}: ${line}`));
        // An invalid scoped value must default, not expose a lower-priority legacy value.
        env[key] = JSON.stringify(projected.options[key] ?? defaults[key]);
      } catch (error) {
        errors.push(`auto-effort-control: environment variable ${name} is ${JSON.stringify(chosen)}, invalid: ${error instanceof Error ? error.message : String(error)}; using the ${scope} default`);
        env[key] = JSON.stringify(defaults[key]);
      }
    } else env[key] = chosen;
  }
  // Historical state/log trees are read-only even when an old setting still names them.
  const effective = validate(options, env).settings;
  for (const key of ['logFile', ...(scope === 'main' ? ['stateFile'] : [])]) {
    const value = effective[key as keyof typeof effective];
    if (typeof value !== 'string') continue;
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '.' && part !== '') parts.push(part);
    }
    if (!/(^|\/)\.local\/state\/(auto-effort|effort-live-control)(\/|$)/.test(parts.join('/'))) continue;
    errors.push(`auto-effort-control: ${key} ${JSON.stringify(value)} -> ${target(key)}: retired artifacts are read-only; using the ${scope} default ${JSON.stringify(defaults[key])}`);
    options[key] = defaults[key];
    delete env[key];
  }
  // The SDK only enumerates settings.env, not the process environment. Never claim an OS-wide inventory.
  if (settings.env !== undefined && !record(settings.env)) errors.push('auto-effort-control: settings.env is not an object; legacy environment keys could not be inspected');
  if (record(settings.env)) for (const key of Object.keys(settings.env)) {
    const match = /^(AUTO_EFFORT_|EFFORT_LIVE_CONTROL_)(.*)$/.exec(key);
    if (match && !key.startsWith('AUTO_EFFORT_CONTROL_') && !Object.prototype.hasOwnProperty.call(reads, key)) errors.push(`auto-effort-control: ${key} -> AUTO_EFFORT_CONTROL_${match[2]}: unknown legacy variable; not applied`);
  }
  return { options, env, errors: [...new Set(errors)] };
}
