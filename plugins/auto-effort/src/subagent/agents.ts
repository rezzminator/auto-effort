import { isEffort, isParentTag, LEVELS, type Effort, type ParentTag } from './effort';
import { parseFrontmatter } from './frontmatter';
import { parseTripwires, type Tripwire } from './judge';
import { rank } from './ladder';
import { PluginRoots } from './plugin-root';
import { parseDecay } from './settings';

export type AgentFs = {
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<string>;
  /** File names (no directory part) of the `.md` files in a directory. */
  listMarkdown: (dir: string) => Promise<string[]>;
};

/** What an agent's `effortControl` frontmatter resolves to; every field has its default filled in. */
export type ControlConfig = {
  floor: Effort;
  ceiling: Effort;
  /** Agent types whose spawn lands the flight: the steered agent steps one below its home level. */
  landing: string[];
  judge: boolean;
  /** The armed tripwire kinds; empty arms none. */
  tripwires: Tripwire[];
  /** The requests without a new tripwire after which an open struggle's level comes home; 0: never. */
  struggleDecay: number;
};

/** The option values a frontmatter key falls back to. */
export type ControlDefaults = { floor: Effort; ceiling: Effort; judge: boolean; tripwires: readonly Tripwire[]; parentTag: ParentTag; struggleDecay: number };

export type Definition = {
  /** The definition's `effort:` when it is a level. */
  effort: Effort | undefined;
  /** Undefined when steering is off, absent or unreadable. */
  control: ControlConfig | undefined;
  /** Whether a tag wins over this type's `effort:`: its `effortControl.parentTag`, else the option; read even when steering is off. */
  parentTag: ParentTag;
};

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** on/true/yes → true, off/false/no → false, case-insensitive; anything else undefined. */
function parseSwitch(raw: string): boolean | undefined {
  const word = raw.trim().toLowerCase();
  if (word === 'on' || word === 'true' || word === 'yes') return true;
  if (word === 'off' || word === 'false' || word === 'no') return false;
  return undefined;
}

/**
 * Resolves an agent type to its definition's effort and effortControl: `<dir>/<type>.md`
 * in each directory in order (its `name:` absent or the type), then any file whose
 * frontmatter `name:` is the type (the directories scanned once), else no definition.
 * A type `P:N` is a plugin agent: the same search for `N` in `<root>/agents` of each
 * enabled plugin `P` under `pluginConfigDir` (see `PluginRoots`); a plugin that is not
 * enabled is no definition, like an unknown type.
 * Every failure is logged and read as no definition; results are cached per type.
 */
export class Definitions {
  private readonly byType = new Map<string, Promise<Definition>>();
  private readonly indexes = new Map<string, Promise<Map<string, string>>>();
  private readonly plugins: PluginRoots | undefined;

  constructor(
    private readonly dirs: readonly string[],
    private readonly defaults: ControlDefaults,
    private readonly fs: AgentFs,
    private readonly log: (line: string) => void,
    /** The Claude Code config directory holding the plugin records; undefined: plugin agents resolve to none. */
    pluginConfigDir?: string,
  ) {
    this.plugins = pluginConfigDir ? new PluginRoots(pluginConfigDir, fs, log) : undefined;
  }

  resolve(type: string): Promise<Definition> {
    let hit = this.byType.get(type);
    if (!hit) {
      hit = this.lookup(type);
      this.byType.set(type, hit);
    }
    return hit;
  }

  private async lookup(type: string): Promise<Definition> {
    const parts = type.split(':');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return (await this.search(type, type, this.dirs)) ?? this.none();
    const [plugin, name] = parts as [string, string];
    for (const root of (await this.plugins?.roots(plugin)) ?? []) {
      const found = await this.search(type, name, [`${root}/agents`]);
      if (found) return found;
    }
    return this.none();
  }

  /** The definition of `type` in `dirs`, where a file declares itself by `name` (a plugin agent's part after the colon); undefined when none holds it. */
  private async search(type: string, name: string, dirs: readonly string[]): Promise<Definition | undefined> {
    const report = this.log;
    for (const dir of dirs) {
      const path = join(dir, `${name}.md`);
      let found = false;
      try {
        found = await this.fs.exists(path);
      } catch (error) {
        report(`auto-effort: checking ${path} failed: ${message(error)}; treating ${type} as having no definition there`);
      }
      if (!found) continue;
      const fields = await this.fields(path, type, report);
      if (fields === 'failed') return this.none();
      if (!fields.name || fields.name === name) return this.fromFields(type, path, fields, report);
    }
    const byName = (await this.index(dirs, report)).get(name);
    if (byName) {
      const fields = await this.fields(byName, type, report);
      if (fields !== 'failed') return this.fromFields(type, byName, fields, report);
    }
    return undefined;
  }

  private none(): Definition {
    return { effort: undefined, control: undefined, parentTag: this.defaults.parentTag };
  }

  private fromFields(type: string, path: string, fields: Record<string, string>, report: (line: string) => void): Definition {
    const level = (fields.effort ?? '').trim().toLowerCase();
    const effort = isEffort(level) ? level : undefined;
    if (level !== '' && effort === undefined) report(`auto-effort: ${path} effort for ${type} is invalid (not a level: ${LEVELS.join(', ')}); using none`);
    return { effort, control: this.control(type, path, fields, report), parentTag: this.parentTag(type, path, fields, report) };
  }

  /** `effortControl.parentTag` over the option; read whether or not the type is steered. */
  private parentTag(type: string, path: string, fields: Record<string, string>, report: (line: string) => void): ParentTag {
    const fallback = this.defaults.parentTag;
    const raw = fields['effortControl.parentTag'];
    if (raw === undefined) return fallback;
    const value = raw.trim().toLowerCase();
    if (isParentTag(value)) return value;
    report(`auto-effort: ${path} effortControl.parentTag for ${type} is invalid (not honor or ignore); using ${fallback}`);
    return fallback;
  }

  private control(type: string, path: string, fields: Record<string, string>, report: (line: string) => void): ControlConfig | undefined {
    const invalid = (key: string, why: string, fallback: string) =>
      report(`auto-effort: ${path} ${key} for ${type} is invalid (${why}); using ${fallback}`);
    const { floor: defaultFloor, ceiling: defaultCeiling, judge: defaultJudge, tripwires: defaultTripwires, struggleDecay: defaultDecay } = this.defaults;
    const bare = fields.effortControl;
    if (bare !== undefined && bare.trim() !== '') {
      const on = parseSwitch(bare);
      if (on === undefined) {
        invalid('effortControl', 'not on, off, true, false, yes or no', 'off');
        return undefined;
      }
      return on ? { floor: defaultFloor, ceiling: defaultCeiling, landing: [], judge: defaultJudge, tripwires: [...defaultTripwires], struggleDecay: defaultDecay } : undefined;
    }
    // `parentTag` steers nothing: alone it pins a type without turning steering on.
    if (!Object.keys(fields).some((key) => key.startsWith('effortControl.') && key !== 'effortControl.parentTag')) return undefined;

    const level = (key: 'floor' | 'ceiling', fallback: Effort): Effort => {
      const raw = fields[`effortControl.${key}`];
      if (raw === undefined) return fallback;
      const value = raw.trim().toLowerCase();
      if (isEffort(value)) return value;
      invalid(`effortControl.${key}`, `not a level: ${LEVELS.join(', ')}`, fallback);
      return fallback;
    };
    const flag = (key: 'enabled' | 'judge', fallback: boolean): boolean => {
      const raw = fields[`effortControl.${key}`];
      if (raw === undefined) return fallback;
      const value = parseSwitch(raw);
      if (value !== undefined) return value;
      invalid(`effortControl.${key}`, 'not on, off, true, false, yes or no', fallback ? 'on' : 'off');
      return fallback;
    };

    if (!flag('enabled', true)) return undefined;
    let floor = level('floor', defaultFloor);
    let ceiling = level('ceiling', defaultCeiling);
    if (rank(floor) > rank(ceiling)) {
      invalid('effortControl.floor', `above effortControl.ceiling ${ceiling}`, `${defaultFloor}..${defaultCeiling}`);
      floor = defaultFloor;
      ceiling = defaultCeiling;
    }
    const landing = (fields['effortControl.landing'] ?? '').split(/[\s,]+/).filter((name) => name !== '');
    let tripwires = [...defaultTripwires];
    const rawTripwires = fields['effortControl.tripwires'];
    if (rawTripwires !== undefined) {
      const found = parseTripwires(rawTripwires);
      if (found.ok) tripwires = found.value;
      else invalid('effortControl.tripwires', found.why, tripwires.join(','));
    }
    let struggleDecay = defaultDecay;
    const rawDecay = fields['effortControl.struggleDecay'];
    if (rawDecay !== undefined) {
      const found = parseDecay(rawDecay);
      if (found.ok) struggleDecay = found.value;
      else invalid('effortControl.struggleDecay', `${JSON.stringify(rawDecay)} is ${found.why}`, String(defaultDecay));
    }
    return { floor, ceiling, landing, judge: flag('judge', defaultJudge), tripwires, struggleDecay };
  }

  private async fields(path: string, type: string, report: (line: string) => void): Promise<Record<string, string> | 'failed'> {
    try {
      const { fields, unterminated } = parseFrontmatter(await this.fs.read(path));
      if (unterminated) report(`auto-effort: ${path} frontmatter has no closing ---; reading ${type} from the fields up to the end of the file`);
      return fields;
    } catch (error) {
      report(`auto-effort: reading ${path} failed: ${message(error)}; treating ${type} as having no definition`);
      return 'failed';
    }
  }

  private index(dirs: readonly string[], report: (line: string) => void): Promise<Map<string, string>> {
    const key = dirs.join('\n');
    let hit = this.indexes.get(key);
    if (!hit) {
      hit = this.buildIndex(dirs, report);
      this.indexes.set(key, hit);
    }
    return hit;
  }

  private async buildIndex(dirs: readonly string[], report: (line: string) => void): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const dir of dirs) {
      let files: string[] = [];
      try {
        if (!(await this.fs.exists(dir))) continue;
        files = await this.fs.listMarkdown(dir);
      } catch (error) {
        report(`auto-effort: listing ${dir} failed: ${message(error)}; its agents are found by file name only`);
        continue;
      }
      for (const file of files) {
        const path = join(dir, file);
        let name: string | undefined;
        try {
          name = parseFrontmatter(await this.fs.read(path)).fields.name;
        } catch (error) {
          report(`auto-effort: reading ${path} failed: ${message(error)}; skipping it in the name index`);
        }
        if (name && !names.has(name)) names.set(name, path);
      }
    }
    return names;
  }
}
