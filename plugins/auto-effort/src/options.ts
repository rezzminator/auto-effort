import { DEFAULTS as MAIN_DEFAULTS, envName, FORMER, PLUGIN, resolveSettings as mainSettings } from './settings.ts';
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
// FORMER's options and variables have this plugin's shape and scopes; a scope's legacy plugin had only that scope's.
const legacyOf = (scope: Scope): string | undefined => scope === 'main' ? undefined : 'effort-live-control';
const formerEnv = (key: string): string => envName(key).replace(/^AUTO_EFFORT_/, 'AUTO_EFFORT_CONTROL_');
const legacyEnv = (scope: Scope, key: string): string | undefined => scope === 'main' ? undefined : envName(key).replace(/^AUTO_EFFORT_/, 'EFFORT_LIVE_CONTROL_');
const retiredConfigs = (scope: Scope): string => [FORMER, legacyOf(scope)].filter((id) => id !== undefined).map((id) => `pluginConfigs["${id}@…"].options -> ${target()}`).join(' and ');
const target = (key?: string): string => `pluginConfigs["auto-effort@…"].options${key === undefined ? '' : `.${key}`}`;

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
      errors.push(`auto-effort: ${target(key)} must be a list of strings; using the ${scope} default`);
      continue;
    }
    if (key === 'models' && items.some((x) => !/^(main|subagent):/.test(x))) {
      errors.push(`auto-effort: ${target(key)} requires main:model=allow|probation|deny or subagent:model-prefix; using the ${scope} default`);
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
  const former: Record<string, unknown> = {};
  const formerOrigins: Record<string, string> = {};
  let settings: Values = {};
  if (!snapshot.ok) errors.push(`auto-effort: reading settings failed: ${snapshot.error}; ${retiredConfigs(scope)} could not be inspected; registered options still apply`);
  else if (!record(snapshot.value)) errors.push(`auto-effort: settings snapshot is not an object; ${retiredConfigs(scope)} could not be inspected`);
  else settings = snapshot.value;
  const configs = settings.pluginConfigs;
  if (configs !== undefined && !record(configs)) errors.push(`auto-effort: pluginConfigs is not an object; ${retiredConfigs(scope)} could not be inspected`);
  if (record(configs)) for (const id of Object.keys(configs).sort()) {
    const identity = id.split('@')[0];
    if (identity !== PLUGIN && identity !== FORMER && identity !== legacy) continue;
    const entry = configs[id];
    const source = `pluginConfigs[${JSON.stringify(id)}].options`;
    if (!record(entry) || !record(entry.options)) {
      errors.push(`auto-effort: ${source} -> ${target()}: expected an options object; value was not applied`);
      continue;
    }
    const out = identity === legacy ? old : identity === FORMER ? former : canonical;
    for (const [key, value] of Object.entries(entry.options)) {
      if (!OPTION_KEYS.includes(key) || (identity === legacy && !own(defaults, key))) {
        errors.push(`auto-effort: ${source}.${key} -> ${target(key)}: unknown option; not applied`);
        continue;
      }
      if (identity === legacy && Array.isArray(defaults[key]) && Array.isArray(value) && value.some((item) => typeof item !== 'string')) {
        errors.push(`auto-effort: ${source}.${key} -> ${target(key)}: list contains non-string entries; preserving the legacy string conversion`);
      }
      if (own(out, key)) {
        errors.push(`auto-effort: ${source}.${key} -> ${target(key)}: displaced by the first sorted entry of ${identity}; consolidate duplicate entries`);
        continue;
      }
      out[key] = value;
      if (identity === legacy) origins[key] = `${source}.${key}`;
      if (identity === FORMER) formerOrigins[key] = `${source}.${key}`;
    }
  }
  for (const [key, value] of Object.entries(registered)) {
    if (!OPTION_KEYS.includes(key)) errors.push(`auto-effort: registered option ${key} -> ${target(key)}: unknown option; not applied`);
    else if (!same(value, OPTION_DEFAULTS[key]) && !own(canonical, key)) canonical[key] = value;
  }
  for (const row of rows) {
    const match = new RegExp(`^${PLUGIN}(?:@.+)?\\.(\\w+)$`).exec(row.key);
    if (!match) continue;
    const key = match[1]!;
    if (!OPTION_KEYS.includes(key)) errors.push(`auto-effort: /config ${row.key} -> ${target(key)}: unknown option; not applied`);
    // The menu includes defaults. Only raw presence, a changed value or our successful write proves an explicit setting.
    else if (row.explicit || own(canonical, key) || !same(row.value, OPTION_DEFAULTS[key])) canonical[key] = row.value;
  }
  // FORMER's options stand in for this name's own, below every source under this name.
  for (const [key, value] of Object.entries(former)) {
    if (own(defaults, key)) errors.push(`auto-effort: ${formerOrigins[key]} -> ${target(key)}: ${own(canonical, key) ? `displaced by the ${PLUGIN} value` : `honored for ${scope}`}`);
    if (!own(canonical, key)) canonical[key] = value;
  }
  // Validate all legacy settings even when another source displaces them.
  const validate = scope === 'main' ? mainSettings : subagentSettings;
  const legacyErrors = validate(old).errors;
  for (const line of legacyErrors) errors.push(`auto-effort: legacy ${legacy} -> auto-effort: ${line}`);
  const base = projectOptions(registered, scope);
  const explicit = projectOptions(canonical, scope);
  errors.push(...base.errors, ...explicit.errors);
  const options: Record<string, unknown> = { ...base.options, ...old, ...explicit.options };
  for (const key of Object.keys(canonical)) if (own(defaults, key) && !own(explicit.options, key)) delete options[key];
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(defaults)) {
    const name = envName(key);
    const formerName = formerEnv(key);
    const oldName = legacyEnv(scope, key);
    let current = reads[name];
    const renamed = reads[formerName];
    const prior = oldName === undefined ? undefined : reads[oldName];
    const filled = (read: ReadValue | undefined): boolean => read?.ok === true && typeof read.value === 'string' && read.value.trim() !== '';
    // FORMER's variable stands in for this name's own, read and projected as it.
    if (renamed !== undefined && !renamed.ok) errors.push(`auto-effort: reading ${formerName} -> ${name} failed: ${renamed.error}; using the option or its default`);
    if (filled(renamed)) {
      errors.push(`auto-effort: ${formerName} -> ${name}: ${filled(current) ? `displaced by ${name}` : `honored for ${scope}`}`);
      if (!filled(current) && current?.ok !== false) current = renamed;
    }
    if (current !== undefined && !current.ok) errors.push(`auto-effort: reading ${name} failed: ${current.error}; ${previousEnv[key] === undefined ? 'using the option or its default' : 'keeping its last effective value'}`);
    if (prior !== undefined && !prior.ok) errors.push(`auto-effort: reading ${oldName} -> ${name} failed: ${prior.error}; keeping its last effective value when known`);
    const text = current?.ok && typeof current.value === 'string' && current.value.trim() !== '' ? current.value : undefined;
    const oldText = prior?.ok && typeof prior.value === 'string' && prior.value.trim() !== '' ? prior.value : undefined;
    if (origins[key] !== undefined) errors.push(`auto-effort: ${origins[key]} -> ${target(key)}: ${own(canonical, key) || text !== undefined || oldText !== undefined ? 'displaced by a higher-precedence value' : `honored for ${scope}`}`);
    if (oldText !== undefined) {
      errors.push(`auto-effort: ${oldName} -> ${name}: ${text !== undefined ? 'displaced by the canonical variable' : `honored for ${scope}`}`);
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
        errors.push(`auto-effort: environment variable ${name} is ${JSON.stringify(chosen)}, invalid: ${error instanceof Error ? error.message : String(error)}; using the ${scope} default`);
        env[key] = JSON.stringify(defaults[key]);
      }
    } else env[key] = chosen;
  }
  // Historical state/log trees are read-only even when an old setting still names them.
  const effective = validate(options, env).settings;
  for (const key of scope === 'main' ? ['stateFile'] : []) {
    const value = effective[key as keyof typeof effective];
    if (typeof value !== 'string') continue;
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '.' && part !== '') parts.push(part);
    }
    if (!new RegExp(`(^|/)\\.local/state/(${FORMER}|effort-live-control)(/|$)`).test(parts.join('/'))) continue;
    errors.push(`auto-effort: ${key} ${JSON.stringify(value)} -> ${target(key)}: retired artifacts are read-only; using the ${scope} default ${JSON.stringify(defaults[key])}`);
    options[key] = defaults[key];
    delete env[key];
  }
  // The SDK only enumerates settings.env, not the process environment. Never claim an OS-wide inventory.
  if (settings.env !== undefined && !record(settings.env)) errors.push('auto-effort: settings.env is not an object; legacy environment keys could not be inspected');
  if (record(settings.env)) for (const key of Object.keys(settings.env)) {
    const match = /^(AUTO_EFFORT_CONTROL_|EFFORT_LIVE_CONTROL_)(.*)$/.exec(key);
    if (match && !Object.prototype.hasOwnProperty.call(reads, key)) errors.push(`auto-effort: ${key} -> AUTO_EFFORT_${match[2]}: unknown legacy variable; not applied`);
  }
  return { options, env, errors: [...new Set(errors)] };
}
