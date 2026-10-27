// `/auto-effort-control`: parsing the arguments and the status text.

import type { Gate, Unsafe } from './gate.ts';
import { DEFAULTS, PLUGIN, SETTING_KEYS, type Settings } from './settings.ts';

export const USAGE = '/auto-effort-control [on|off|status] | /auto-effort-control set <key> <value> | /auto-effort-control clear [model]';

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
  /** The main chat's own level as it is sent (clamped), set with set_effort and held until this turn ends or set_effort auto. */
  override: { level: string; reason: string } | null;
  /** False when the last main request carried no level or the model gate keeps its model unsteered. */
  steered: boolean;
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
  const lines = [`auto-effort-control ${version} · ${view.enabled ? 'on' : 'off'} (this session)`];
  const held = view.override;
  if (view.pin !== null) lines.push(`level: ${view.pin.level} · pin · you set /effort; /effort auto or /auto-effort-control on resumes automatic effort`);
  else if (held !== null && view.enabled && view.steered) lines.push(`level: ${held.level} · model, held until this turn ends or set_effort auto · ${held.reason}`);
  else if (view.turn !== null) lines.push(`level: ${view.turn.level} · ${view.turn.source} · ${view.turn.reason}`);
  else lines.push('level: none yet · the first request of the next turn runs at the planning level');
  if (held !== null && !view.enabled) lines.push(`main chat's own level: ${held.level} · kept while auto-effort-control is off until this turn ends · ${held.reason}`);
  else if (held !== null && view.pin !== null) lines.push(`main chat's own level: ${held.level} · kept behind your /effort pin until this turn ends · ${held.reason}`);
  else if (held !== null && !view.steered) lines.push(`main chat's own level: ${held.level} · kept while this model is not steered until this turn ends · ${held.reason}`);
  if (view.model !== undefined && view.gate !== undefined) {
    let gate = `model: ${view.model} · ${view.gate.status}`;
    if (view.gate.status === 'probation') gate += ` (${view.probation ?? 0} of ${settings.probationSwitches} clean switches)`;
    if (view.unsafe !== undefined) gate += ` · cache read ${(view.unsafe.ratio * 100).toFixed(1)}% of the previous prompt at ${view.unsafe.at}; /auto-effort-control clear ${view.model} turns it back on`;
    lines.push(gate);
  }
  if (errors.length > 0) lines.push('option errors:', ...errors.map((line) => `  ${line}`));
  lines.push(`settings (${settingsFrom}): ${SETTING_KEYS.map((key) => `${key}=${show(settings[key])}`).join(' ')}`);
  lines.push(`change one: /auto-effort-control set <key> <value>, /config, or pluginConfigs["${PLUGIN}@<marketplace>"].options in settings.json (key "${PLUGIN}@inline" when loaded with --plugin-dir)`);
  lines.push('environment migration: checks known legacy names and settings.env only; this engine cannot enumerate other OS variables (AUTO_EFFORT_* / EFFORT_LIVE_CONTROL_* -> AUTO_EFFORT_CONTROL_*).');
  return lines.join('\n');
}
