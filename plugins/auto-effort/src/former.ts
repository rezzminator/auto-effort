// The directories under the plugin's former name move to its name once: a directory moves only while its new place is
// free, so no decision log, plugin log or state line is lost and nothing already under the new name is overwritten.

import { pluginLogDir } from './plugin-log.ts';
import { FORMER, PLUGIN } from './settings.ts';

/** Each directory FORMER wrote and its place under PLUGIN: the state directory, then the PLUGIN_LOG_DIR one; no directory twice. */
export function formerDirs(configured: string | undefined, home: string | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (home) {
    const state = `${home.replace(/\/+$/, '')}/.local/state`;
    pairs.push([`${state}/${FORMER}`, `${state}/${PLUGIN}`]);
  }
  const from = pluginLogDir(configured, undefined, FORMER);
  const to = pluginLogDir(configured, undefined, PLUGIN);
  if (from !== undefined && to !== undefined && !pairs.some(([seen]) => seen === from)) pairs.push([from, to]);
  return pairs;
}

/**
 * Moves each argument pair `from to` while `to` is free, printing `moved {from} -> {to}`, or `kept {from}: {to} exists`
 * when it is not. A move that fails while `from` is still there exits 1; one another chat finished first is no failure.
 */
export const MOVE_SCRIPT = 'while [ "$#" -ge 2 ]; do if [ -e "$1" ] && [ ! -e "$2" ]; then if mv -- "$1" "$2"; then echo "moved $1 -> $2"; elif [ -e "$1" ]; then exit 1; fi; elif [ -e "$1" ]; then echo "kept $1: $2 exists"; fi; shift 2; done';
