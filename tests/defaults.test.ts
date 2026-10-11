import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, SETTING_KEYS } from '../plugins/auto-effort/src/settings.ts';

// R12: every knob is a plugin option. Defaults agree in three places: src/settings.ts, plugin.json's userConfig and the README table.
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('plugins/auto-effort/.claude-plugin/plugin.json', root), 'utf8'));
const readme = readFileSync(new URL('README.md', root), 'utf8');

describe('plugin options', () => {
  it('declares exactly the settings, each with its default', () => {
    expect(SETTING_KEYS).toEqual(
      expect.arrayContaining(['floor', 'ceiling', 'planLevel', 'planUpshiftPatterns', 'planUpshiftChars', 'turnReminder', 'escalateAfterFailures', 'failurePatterns', 'userEffortPins', 'models', 'unknownModels', 'probationSwitches', 'canaryThreshold', 'statusLine', 'logFile']),
    );
    expect(SETTING_KEYS).toHaveLength(17);
    expect(Object.keys(manifest.userConfig).sort()).toEqual([...SETTING_KEYS].sort());
    for (const key of SETTING_KEYS) {
      const field = manifest.userConfig[key];
      expect(field.default, key).toEqual(DEFAULTS[key]);
      expect(typeof field.title, key).toBe('string');
      expect(typeof field.description, key).toBe('string');
      expect(field.type, key).toBe(typeof DEFAULTS[key] === 'object' ? 'string' : typeof DEFAULTS[key]);
      expect(Boolean(field.multiple), key).toBe(Array.isArray(DEFAULTS[key]));
    }
  });

  it('lists every option in the README table', () => {
    for (const key of SETTING_KEYS) expect(readme, key).toContain(`| \`${key}\` |`);
  });
});
