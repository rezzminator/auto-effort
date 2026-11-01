import { OPTION_DEFAULTS as DEFAULTS, OPTION_KEYS as SETTING_KEYS } from '../../plugins/auto-effort/src/options.ts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Every knob is a plugin option. Defaults agree in three places: src/settings.ts, plugin.json's userConfig and the README table. The README table also names each option's environment variable.
const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('plugins/auto-effort/.claude-plugin/plugin.json', root), 'utf8'));
const readmes = ['README.md', 'plugins/auto-effort/README.md'].map((path) => [path, readFileSync(new URL(path, root), 'utf8')] as const);

describe('plugin options', () => {
  it('judge is false and judgeRaiseAt is 25 in the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.judge).toBe(false);
    expect(DEFAULTS.judgeRaiseAt).toBe(25);
    expect(manifest.userConfig.judge.default).toBe(false);
    expect(manifest.userConfig.judgeRaiseAt).toMatchObject({ type: 'number', default: 25, min: 0, max: 100 });
    for (const [path, readme] of readmes) {
      const row = (key: string) => readme.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
      expect(row('judge'), path).toContain('| `false` |');
      expect(row('judgeRaiseAt'), path).toContain('| `25` |');
    }
  });

  it('tripwires: the default is fail1,fail2,red,redispatch in the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.tripwires).toBe('fail1,fail2,red,redispatch');
    expect(manifest.userConfig.tripwires).toMatchObject({ type: 'string', default: 'fail1,fail2,red,redispatch' });
    expect(manifest.userConfig.tripwires.multiple).toBeUndefined();
    for (const [path, readme] of readmes) {
      const row = readme.split('\n').find((line) => line.startsWith('| `tripwires` |'));
      expect(row, path).toContain('| `fail1,fail2,red,redispatch` |');
      expect(readme, path).toContain('`effortControl.tripwires`');
    }
  });

  it('parentTag: the default is honor in the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.parentTag).toBe('honor');
    expect(manifest.userConfig.parentTag).toMatchObject({ type: 'string', default: 'honor' });
    expect(manifest.userConfig.parentTag.multiple).toBeUndefined();
    expect(manifest.userConfig.parentTag.description).toContain('ignore');
    for (const [path, readme] of readmes) {
      const row = readme.split('\n').find((line) => line.startsWith('| `parentTag` |'));
      expect(row, path).toContain('| `honor` |');
      expect(row, path).toContain('`ignore`');
      expect(readme, path).toContain('`effortControl.parentTag`');
    }
  });

  it('defaults: struggleDecay agrees across code, manifest and both READMEs', () => {
    expect(DEFAULTS.struggleDecay).toBe(20);
    expect(manifest.userConfig.struggleDecay).toMatchObject({ type: 'number', default: 20, min: 0 });
    expect(manifest.userConfig.struggleDecay.multiple).toBeUndefined();
    expect(manifest.userConfig.struggleDecay.title.startsWith('struggleDecay: ')).toBe(true);
    for (const [path, readme] of readmes) {
      const row = readme.split('\n').find((line) => line.startsWith('| `struggleDecay` |'));
      expect(row, path).toContain('| `20` |');
      expect(row, path).toContain('`effortControl.struggleDecay`');
      expect(row, path).toContain('`0`');
      expect(readme, path).toContain('`struggleDecay`');
    }
    const [root] = readmes;
    expect(root![1]).toContain('| `effortControl.struggleDecay` |');
  });

  it('readOnlyCommands: agrees across the code, the manifest and both READMEs', () => {
    expect(DEFAULTS.readOnlyCommands).toContain('grep');
    expect(DEFAULTS.readOnlyCommands).not.toContain('source');
    expect(manifest.userConfig.readOnlyCommands).toMatchObject({ type: 'string', multiple: true, default: DEFAULTS.readOnlyCommands });
    expect(manifest.userConfig.readOnlyCommands.title.startsWith('readOnlyCommands: ')).toBe(true);
    for (const [path, readme] of readmes) {
      const row = readme.split('\n').find((line) => line.startsWith('| `readOnlyCommands` |'));
      expect(row, path).toBeDefined();
      for (const name of DEFAULTS.readOnlyCommands as readonly string[]) expect(row, `${path} ${name}`).toContain(`\`${name}\``);
    }
  });

  it('keeps the two READMEs\' option tables identical', () => {
    const table = (text: string) => text.split('\n').filter((line) => SETTING_KEYS.some((key) => line.startsWith(`| \`${key}\` |`)));
    expect(table(readmes[1]![1])).toEqual(table(readmes[0]![1]));
  });
});
