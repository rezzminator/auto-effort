import { describe, expect, it } from 'vitest';
import { OPTION_DEFAULTS, resolveOptions, type Scope } from '../plugins/auto-effort/src/options.ts';
import { resolveSettings as mainSettings } from '../plugins/auto-effort/src/settings.ts';
import { resolveSettings as subagentSettings } from '../plugins/auto-effort/src/subagent/settings.ts';

describe('environment read recovery', () => {
  it.each([
    { scope: 'main' as Scope, key: 'models', suffix: 'MODELS', values: ['claude-custom=allow'] },
    { scope: 'subagent' as Scope, key: 'models', suffix: 'MODELS', values: ['claude-custom'] },
    { scope: 'main' as Scope, key: 'testCommandPatterns', suffix: 'TEST_COMMAND_PATTERNS', values: ['custom-test'] },
    { scope: 'subagent' as Scope, key: 'testCommandPatterns', suffix: 'TEST_COMMAND_PATTERNS', values: [] },
  ])('$scope retains its effective $key after a later canonical read fails', ({ scope, key, suffix, values }) => {
    const variable = `AUTO_EFFORT_${suffix}`;
    const resolve = (reads: Parameters<typeof resolveOptions>[3], previous: Record<string, string | undefined> = {}) =>
      resolveOptions(scope, OPTION_DEFAULTS, { ok: true, value: {} }, reads, [], previous);
    const first = resolve({ [variable]: { ok: true, value: JSON.stringify(values.map((value) => `${scope}:${value}`)) } });
    const later = resolve({ [variable]: { ok: false, error: 'temporary settings backend failure' } }, first.env);
    const settings = scope === 'main' ? mainSettings : subagentSettings;
    expect(settings(first.options, first.env).settings[key as 'models' | 'testCommandPatterns']).toEqual(values);
    expect(settings(later.options, later.env).settings[key as 'models' | 'testCommandPatterns']).toEqual(values);
    expect(later.errors).toContain(`auto-effort: reading ${variable} failed: temporary settings backend failure; keeping its last effective value`);
  });
});

describe('migration source shapes', () => {
  it.each([
    { scope: 'subagent' as Scope, identity: 'effort-live-control', key: 'readOnlyCommands', raw: [42], value: ['42'] },
  ])('$scope reports non-string legacy list entries without changing their original coercion', ({ scope, identity, key, raw, value }) => {
    const source = `pluginConfigs["${identity}@old"].options.${key}`;
    const target = `pluginConfigs["auto-effort@…"].options.${key}`;
    const merged = resolveOptions(scope, OPTION_DEFAULTS, { ok: true, value: { pluginConfigs: { [`${identity}@old`]: { options: { [key]: raw } } } } }, {});
    const resolved = scope === 'main' ? mainSettings(merged.options, merged.env) : subagentSettings(merged.options, merged.env);
    expect(resolved.settings[key as keyof typeof resolved.settings]).toEqual(value);
    expect(merged.errors).toContain(`auto-effort: ${source} -> ${target}: list contains non-string entries; preserving the legacy string conversion`);
  });
});


describe('the former name auto-effort-control', () => {
  it.each(['main', 'subagent'] as const)('%s takes its options in this plugin\'s shape, scoped lists projected, below this name\'s own', (scope) => {
    const configs = {
      'auto-effort-control@professor': { options: { models: ['main:claude-x=deny', 'subagent:claude-y'], floor: 'low', ceiling: 'high' } },
      'auto-effort@professor': { options: { ceiling: 'max' } },
    };
    const merged = resolveOptions(scope, OPTION_DEFAULTS, { ok: true, value: { pluginConfigs: configs } }, {});
    expect(merged.options.models).toEqual(scope === 'main' ? ['claude-x=deny'] : ['claude-y']);
    expect(merged.options.floor).toBe('low');
    expect(merged.options.ceiling).toBe('max');
    const from = (key: string) => `auto-effort: pluginConfigs["auto-effort-control@professor"].options.${key} -> pluginConfigs["auto-effort@…"].options.${key}`;
    expect(merged.errors).toContain(`${from('floor')}: honored for ${scope}`);
    expect(merged.errors).toContain(`${from('ceiling')}: displaced by the auto-effort value`);
  });

  it.each(['main', 'subagent'] as const)('%s reads AUTO_EFFORT_CONTROL_* as AUTO_EFFORT_*, below it', (scope) => {
    const ok = (value: string) => ({ ok: true as const, value });
    const alone = resolveOptions(scope, OPTION_DEFAULTS, { ok: true, value: {} }, { AUTO_EFFORT_CONTROL_MODELS: ok('["main:claude-x=deny","subagent:claude-y"]'), AUTO_EFFORT_CONTROL_FLOOR: ok('low') });
    expect(alone.env.models).toBe(JSON.stringify(scope === 'main' ? ['claude-x=deny'] : ['claude-y']));
    expect(alone.env.floor).toBe('low');
    expect(alone.errors).toContain(`auto-effort: AUTO_EFFORT_CONTROL_FLOOR -> AUTO_EFFORT_FLOOR: honored for ${scope}`);
    const both = resolveOptions(scope, OPTION_DEFAULTS, { ok: true, value: {} }, { AUTO_EFFORT_CONTROL_FLOOR: ok('low'), AUTO_EFFORT_FLOOR: ok('high') });
    expect(both.env.floor).toBe('high');
    expect(both.errors).toContain('auto-effort: AUTO_EFFORT_CONTROL_FLOOR -> AUTO_EFFORT_FLOOR: displaced by AUTO_EFFORT_FLOOR');
  });
});

describe('retired artifacts stay read-only', () => {
  it.each(['main'] as const)('%s rejects retired path destinations from every supported source', (scope) => {
    const defaults = mainSettings({}).settings;
    for (const key of ['stateFile']) {
      const suffix = 'STATE_FILE';
      for (const retired of ['auto-effort-control', 'effort-live-control']) {
        const path = `~/.local/state/safe/../${retired}/original.json`;
        for (const source of ['canonical-env', 'legacy-env', 'canonical-option', 'legacy-option']) {
          const identity = source === 'legacy-option' ? (scope === 'main' ? 'auto-effort-control' : 'effort-live-control') : 'auto-effort';
          const prefix = source === 'legacy-env' ? (scope === 'main' ? 'AUTO_EFFORT_CONTROL_' : 'EFFORT_LIVE_CONTROL_') : 'AUTO_EFFORT_';
          const snapshot = { ok: true as const, value: { pluginConfigs: { [`${identity}@old`]: { options: source.endsWith('option') ? { [key]: path } : {} } } } };
          const merged = resolveOptions(scope, OPTION_DEFAULTS, snapshot, source.endsWith('env') ? { [`${prefix}${suffix}`]: { ok: true, value: path } } : {});
          const result = mainSettings(merged.options, merged.env);
          expect(result.settings[key as keyof typeof result.settings], `${scope} ${key} ${source} ${retired}`).toBe(defaults[key as keyof typeof defaults]);
          expect(merged.errors.join('\n')).toContain(path);
          expect(merged.errors.join('\n')).toContain('retired artifacts are read-only');
        }
      }
    }
  });
});

it('projects hintPatterns only into main and reads its environment override', () => {
  const raw = { hintPatterns: ['design'] };
  const snapshot = { ok: true as const, value: {} };
  expect(resolveOptions('main', raw, snapshot, {}).options.hintPatterns).toEqual(['design']);
  expect(resolveOptions('subagent', raw, snapshot, {}).options.hintPatterns).toBeUndefined();
  const result = resolveOptions('main', raw, snapshot, { AUTO_EFFORT_HINT_PATTERNS: { ok: true, value: '["architect"]' } });
  expect(mainSettings(result.options, result.env).settings.hintPatterns).toEqual(['architect']);
});
