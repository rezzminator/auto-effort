// `/auto-effort`: parsing the arguments and the status text.

import type { Gate, Unsafe } from './gate.ts';
import { DEFAULTS, PLUGIN, SETTING_KEYS, type Settings } from './settings.ts';

export const USAGE = '/auto-effort [on|off|status] | /auto-effort set <key> <value> | /auto-effort clear [model]';

export type Command =
  | { kind: 'status' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'set'; key: keyof Settings; value: string }
  | { kind: 'clear'; model: string | undefined }
  | { kind: 'bad'; message: string };

/** The settings `set` takes: the single-valued ones; a list is edited in /config or settings.json. */
export const SETTABLE = SETTING_KEYS.filter((key) => !Array.isArray(DEFAULTS[key]));

export function parseCommand(args: string): Command {
  const words = args.trim().split(/\s+/).filter((word) => word !== '');
  const verb = (words[0] ?? 'status').toLowerCase();
  if (verb === 'status' && words.length <= 1) return { kind: 'status' };
  if (verb === 'on' && words.length === 1) return { kind: 'on' };
  if (verb === 'off' && words.length === 1) return { kind: 'off' };
  if (verb === 'clear' && words.length <= 2) return { kind: 'clear', model: words[1] };
  if (verb === 'set') {
    const key = SETTABLE.find((name) => name === words[1]);
    const value = args.trim().replace(/^\S+\s+\S+\s*/, '');
    if (key !== undefined && value !== '') return { kind: 'set', key, value };
    const why = key === undefined ? `"${words[1] ?? ''}" is not a single-valued setting (${SETTABLE.join(', ')}; a list is edited in /config)` : `"${key}" needs a value`;
    return { kind: 'bad', message: `${why}\n${USAGE}` };
  }
  return { kind: 'bad', message: `Unknown arguments "${args.trim()}".\n${USAGE}` };
}

export type View = {
  enabled: boolean;
  pin: { level: string } | null;
  model: string | undefined;
  gate: Gate | undefined;
  turn: { level: string; source: string; reason: string } | null;
  /** Clean switches counted for a probation model. */
  probation: number | undefined;
  unsafe: Unsafe | undefined;
};

function show(value: unknown): string {
  return Array.isArray(value) ? `[${value.join(' | ')}]` : String(value);
}

export function statusText(input: { view: View; settings: Settings; errors: readonly string[]; version: string; settingsFrom: string }): string {
  const { view, settings, errors, version, settingsFrom } = input;
  const lines = [`auto-effort ${version} · ${view.enabled ? 'on' : 'off'} (this session)`];
  if (view.pin !== null) lines.push(`level: ${view.pin.level} · pin · you set /effort; /auto-effort on resumes automatic effort`);
  else if (view.turn !== null) lines.push(`level: ${view.turn.level} · ${view.turn.source} · ${view.turn.reason}`);
  else lines.push('level: none yet · the first request of the next turn runs at the planning level');
  if (view.model !== undefined && view.gate !== undefined) {
    let gate = `model: ${view.model} · ${view.gate.status}`;
    if (view.gate.status === 'probation') gate += ` (${view.probation ?? 0} of ${settings.probationSwitches} clean switches)`;
    if (view.unsafe !== undefined) gate += ` · cache read ${(view.unsafe.ratio * 100).toFixed(1)}% of the previous prompt at ${view.unsafe.at}; /auto-effort clear ${view.model} turns it back on`;
    lines.push(gate);
  }
  if (errors.length > 0) lines.push('option errors:', ...errors.map((line) => `  ${line}`));
  lines.push(`settings (${settingsFrom}): ${SETTING_KEYS.map((key) => `${key}=${show(settings[key])}`).join(' ')}`);
  lines.push(`change one: /auto-effort set <key> <value>, /config, or pluginConfigs["${PLUGIN}@<marketplace>"].options in settings.json (key "${PLUGIN}@inline" when loaded with --plugin-dir)`);
  return lines.join('\n');
}
