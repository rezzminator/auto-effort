import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, envName, SETTING_KEYS } from '../plugins/auto-effort/src/settings.ts';

// R12: every knob is a plugin option. Defaults agree in three places: src/settings.ts, plugin.json's userConfig and the README table,
// which also names the environment variable each option reads.
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('plugins/auto-effort/.claude-plugin/plugin.json', root), 'utf8'));
const readme = readFileSync(new URL('README.md', root), 'utf8');

describe('plugin options', () => {
  it('declares exactly the settings, each with its default', () => {
    expect(SETTING_KEYS).toEqual(
      expect.arrayContaining(['floor', 'ceiling', 'planLevel', 'planUpshiftPatterns', 'planUpshiftChars', 'turnReminder', 'escalateAfterFailures', 'lowerOnPass', 'failurePatterns', 'failureTools', 'testCommandPatterns', 'userEffortPins', 'models', 'unknownModels', 'probationSwitches', 'canaryThreshold', 'statusLine', 'logFile']),
    );
    expect(SETTING_KEYS).toHaveLength(19);
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

  it('shows every option in the README table with its environment variable and the default the code holds', () => {
    const lines = readme.split('\n');
    for (const key of SETTING_KEYS) {
      const row = lines.find((line) => line.startsWith(`| \`${key}\` |`));
      expect(row, key).toBeDefined();
      // A GFM cell ends at every `|` not escaped as `\|`, inside code spans too.
      const cells = row!.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
      expect(cells, key).toHaveLength(4);
      expect(cells[1], key).toBe(`\`${envName(key)}\``);
      const shown = cells[2]!.split('<br>').map((entry) => entry.replace(/^`|`$/g, '').replace(/\\\|/g, '|'));
      const value = DEFAULTS[key];
      expect(shown, key).toEqual(Array.isArray(value) ? value : [String(value)]);
    }
  });
});
