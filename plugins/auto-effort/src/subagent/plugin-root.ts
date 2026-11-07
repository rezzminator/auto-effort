import type { AgentFs } from './agents.ts';

type Json = Record<string, unknown>;
/** A record that exists but could not be read or parsed (already logged): "could not look", never "found nothing". */
const UNREADABLE = Symbol('unreadable');
type RecordRead = Json | undefined | typeof UNREADABLE;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Where the files of a Claude Code plugin live, from the host's records under the config
 * directory: `settings.json` says which `P@M` are enabled, `plugins/known_marketplaces.json`
 * and the marketplace's own `.claude-plugin/marketplace.json` say where a directory
 * marketplace keeps `P`, `plugins/installed_plugins.json` says where an installed copy is.
 * An absent record reads as nothing found; a record that exists but cannot be read or parsed
 * is logged with its path and error and ends the lookup of that `P@M` with no root, never
 * falling through to the next source as if the record said nothing. Records and roots are
 * cached per instance.
 */
export class PluginRoots {
  private readonly records = new Map<string, Promise<RecordRead>>();
  private readonly byPlugin = new Map<string, Promise<string[]>>();

  constructor(
    private readonly configDir: string,
    private readonly fs: AgentFs,
    private readonly log: (line: string) => void,
  ) {}

  /** The root of every enabled `plugin@marketplace`, in key order; empty when the plugin is not enabled or has no root. */
  roots(plugin: string): Promise<string[]> {
    let hit = this.byPlugin.get(plugin);
    if (!hit) {
      hit = this.find(plugin);
      this.byPlugin.set(plugin, hit);
    }
    return hit;
  }

  private async find(plugin: string): Promise<string[]> {
    const settings = await this.record(`${this.configDir}/settings.json`, plugin);
    if (settings === UNREADABLE) return [];
    const enabled = settings?.enabledPlugins;
    if (!isObject(enabled)) return [];
    const keys = Object.keys(enabled)
      .filter((key) => enabled[key] === true && key.indexOf('@') > 0 && key.slice(0, key.indexOf('@')) === plugin)
      .sort();
    const roots: string[] = [];
    for (const key of keys) {
      const directory = await this.directoryRoot(plugin, key.slice(key.indexOf('@') + 1));
      const root = directory === undefined ? await this.installedRoot(plugin, key) : directory;
      if (typeof root === 'string') roots.push(root);
    }
    return roots;
  }

  /** The `source` path the marketplace gives `plugin`, under the marketplace's install location; only for a directory marketplace; UNREADABLE when a record could not be read. */
  private async directoryRoot(plugin: string, marketplace: string): Promise<string | undefined | typeof UNREADABLE> {
    const known = await this.record(`${this.configDir}/plugins/known_marketplaces.json`, plugin);
    if (known === UNREADABLE) return UNREADABLE;
    const entry = known?.[marketplace];
    if (!isObject(entry) || !isObject(entry.source) || entry.source.source !== 'directory') return undefined;
    const location = entry.installLocation;
    if (typeof location !== 'string' || location === '') return undefined;
    const listing = await this.record(`${location}/.claude-plugin/marketplace.json`, plugin);
    if (listing === UNREADABLE) return UNREADABLE;
    const plugins = listing?.plugins;
    if (!Array.isArray(plugins)) return undefined;
    const listed = plugins.find((candidate) => isObject(candidate) && candidate.name === plugin);
    const source = isObject(listed) ? listed.source : undefined;
    if (typeof source !== 'string' || source === '') return undefined;
    return source.startsWith('/') ? source : `${location.replace(/\/$/, '')}/${source.replace(/^\.\//, '')}`;
  }

  private async installedRoot(plugin: string, key: string): Promise<string | undefined> {
    const installed = await this.record(`${this.configDir}/plugins/installed_plugins.json`, plugin);
    if (installed === UNREADABLE) return undefined;
    const plugins = installed?.plugins;
    const installs = isObject(plugins) ? plugins[key] : undefined;
    const first: unknown = Array.isArray(installs) ? installs[0] : undefined;
    const path = isObject(first) ? first.installPath : undefined;
    return typeof path === 'string' && path !== '' ? path : undefined;
  }

  private record(path: string, plugin: string): Promise<RecordRead> {
    let hit = this.records.get(path);
    if (!hit) {
      hit = this.read(path, plugin);
      this.records.set(path, hit);
    }
    return hit;
  }

  private async read(path: string, plugin: string): Promise<RecordRead> {
    try {
      if (!(await this.fs.exists(path))) return undefined;
      const parsed: unknown = JSON.parse(await this.fs.read(path));
      if (!isObject(parsed)) throw new Error('not a JSON object');
      return parsed;
    } catch (error) {
      this.log(`auto-effort: reading plugin record ${path} failed: ${message(error)}; the agents of plugin ${plugin} could not be looked up through it`);
      return UNREADABLE;
    }
  }
}
