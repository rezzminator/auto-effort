import { describe, expect, it } from 'vitest';
import { OPTION_DEFAULTS, resolveOptions, type Scope } from '../plugins/auto-effort-control/src/options.ts';
import { resolveSettings as mainSettings } from '../plugins/auto-effort-control/src/settings.ts';
import { resolveSettings as subagentSettings } from '../plugins/auto-effort-control/src/subagent/settings.ts';

describe('environment read recovery', () => {
  it.each([
    { scope: 'main' as Scope, key: 'models', suffix: 'MODELS', values: ['claude-custom=allow'] },
    { scope: 'subagent' as Scope, key: 'models', suffix: 'MODELS', values: ['claude-custom'] },
    { scope: 'main' as Scope, key: 'testCommandPatterns', suffix: 'TEST_COMMAND_PATTERNS', values: ['custom-test'] },
    { scope: 'subagent' as Scope, key: 'testCommandPatterns', suffix: 'TEST_COMMAND_PATTERNS', values: [] },
  ])('$scope retains its effective $key after a later canonical read fails', ({ scope, key, suffix, values }) => {
    const variable = `AUTO_EFFORT_CONTROL_${suffix}`;
    const resolve = (reads: Parameters<typeof resolveOptions>[3], previous: Record<string, string | undefined> = {}) =>
      resolveOptions(scope, OPTION_DEFAULTS, { ok: true, value: {} }, reads, [], previous);
    const first = resolve({ [variable]: { ok: true, value: JSON.stringify(values.map((value) => `${scope}:${value}`)) } });
    const later = resolve({ [variable]: { ok: false, error: 'temporary settings backend failure' } }, first.env);
    const settings = scope === 'main' ? mainSettings : subagentSettings;
    expect(settings(first.options, first.env).settings[key as 'models' | 'testCommandPatterns']).toEqual(values);
    expect(settings(later.options, later.env).settings[key as 'models' | 'testCommandPatterns']).toEqual(values);
    expect(later.errors).toContain(`auto-effort-control: reading ${variable} failed: temporary settings backend failure; keeping its last effective value`);
  });
});

describe('migration source shapes', () => {
  it.each([
    { scope: 'main' as Scope, identity: 'auto-effort', key: 'failurePatterns', raw: [7], value: ['7'] },
    { scope: 'subagent' as Scope, identity: 'effort-live-control', key: 'readOnlyCommands', raw: [42], value: ['42'] },
  ])('$scope reports non-string legacy list entries without changing their original coercion', ({ scope, identity, key, raw, value }) => {
    const source = `pluginConfigs["${identity}@old"].options.${key}`;
    const target = `pluginConfigs["auto-effort-control@…"].options.${key}`;
    const merged = resolveOptions(scope, OPTION_DEFAULTS, { ok: true, value: { pluginConfigs: { [`${identity}@old`]: { options: { [key]: raw } } } } }, {});
    const resolved = scope === 'main' ? mainSettings(merged.options, merged.env) : subagentSettings(merged.options, merged.env);
    expect(resolved.settings[key as keyof typeof resolved.settings]).toEqual(value);
    expect(merged.errors).toContain(`auto-effort-control: ${source} -> ${target}: list contains non-string entries; preserving the legacy string conversion`);
  });
});


describe('retired artifacts stay read-only', () => {
  it.each(['main', 'subagent'] as const)('%s rejects retired path destinations from every supported source', (scope) => {
    const defaults = scope === 'main' ? mainSettings({}).settings : subagentSettings({}).settings;
    for (const key of scope === 'main' ? ['stateFile', 'logFile'] : ['logFile']) {
      const suffix = key === 'stateFile' ? 'STATE_FILE' : 'LOG_FILE';
      for (const retired of ['auto-effort', 'effort-live-control']) {
        const path = `~/.local/state/safe/../${retired}/original.json`;
        for (const source of ['canonical-env', 'legacy-env', 'canonical-option', 'legacy-option']) {
          const identity = source === 'legacy-option' ? (scope === 'main' ? 'auto-effort' : 'effort-live-control') : 'auto-effort-control';
          const prefix = source === 'legacy-env' ? (scope === 'main' ? 'AUTO_EFFORT_' : 'EFFORT_LIVE_CONTROL_') : 'AUTO_EFFORT_CONTROL_';
          const snapshot = { ok: true as const, value: { pluginConfigs: { [`${identity}@old`]: { options: source.endsWith('option') ? { [key]: path } : {} } } } };
          const merged = resolveOptions(scope, OPTION_DEFAULTS, snapshot, source.endsWith('env') ? { [`${prefix}${suffix}`]: { ok: true, value: path } } : {});
          const result = scope === 'main' ? mainSettings(merged.options, merged.env) : subagentSettings(merged.options, merged.env);
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
  const result = resolveOptions('main', raw, snapshot, { AUTO_EFFORT_CONTROL_HINT_PATTERNS: { ok: true, value: '["architect"]' } });
  expect(mainSettings(result.options, result.env).settings.hintPatterns).toEqual(['architect']);
});
