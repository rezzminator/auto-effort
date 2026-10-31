import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formerDirs, MOVE_SCRIPT } from '../plugins/auto-effort/src/former.ts';

describe('formerDirs', () => {
  it('pairs the state directory and the PLUGIN_LOG_DIR one, each under the former and the new name', () => {
    expect(formerDirs('/logs/', '/home/u/')).toEqual([
      ['/home/u/.local/state/auto-effort-control', '/home/u/.local/state/auto-effort'],
      ['/logs/auto-effort-control', '/logs/auto-effort'],
    ]);
  });

  it('names a directory once when PLUGIN_LOG_DIR is the state root', () => {
    expect(formerDirs('/home/u/.local/state', '/home/u')).toEqual([['/home/u/.local/state/auto-effort-control', '/home/u/.local/state/auto-effort']]);
  });

  it('pairs only what it can resolve', () => {
    expect(formerDirs(undefined, '/home/u')).toEqual([['/home/u/.local/state/auto-effort-control', '/home/u/.local/state/auto-effort']]);
    expect(formerDirs('/logs', undefined)).toEqual([['/logs/auto-effort-control', '/logs/auto-effort']]);
    expect(formerDirs(undefined, undefined)).toEqual([]);
  });
});

describe('MOVE_SCRIPT', () => {
  let root = '';
  afterEach(() => { if (root !== '') rmSync(root, { recursive: true, force: true }); });
  const run = (...args: string[]): string => execFileSync('/bin/sh', ['-c', MOVE_SCRIPT, 'move-former-dirs', ...args], { encoding: 'utf8' });

  it('moves a directory whose new place is free, its files with it', () => {
    root = mkdtempSync(join(tmpdir(), 'former-'));
    mkdirSync(join(root, 'old'));
    writeFileSync(join(root, 'old', 'decisions.s1.jsonl'), '{"event":"x"}\n');
    expect(run(join(root, 'old'), join(root, 'new'))).toBe(`moved ${join(root, 'old')} -> ${join(root, 'new')}\n`);
    expect(existsSync(join(root, 'old'))).toBe(false);
    expect(readFileSync(join(root, 'new', 'decisions.s1.jsonl'), 'utf8')).toBe('{"event":"x"}\n');
  });

  it('keeps both when the new place is taken, and overwrites nothing', () => {
    root = mkdtempSync(join(tmpdir(), 'former-'));
    mkdirSync(join(root, 'old'));
    mkdirSync(join(root, 'new'));
    writeFileSync(join(root, 'old', 'state.json'), 'old');
    writeFileSync(join(root, 'new', 'state.json'), 'new');
    expect(run(join(root, 'old'), join(root, 'new'))).toBe(`kept ${join(root, 'old')}: ${join(root, 'new')} exists\n`);
    expect(readFileSync(join(root, 'old', 'state.json'), 'utf8')).toBe('old');
    expect(readFileSync(join(root, 'new', 'state.json'), 'utf8')).toBe('new');
    expect(existsSync(join(root, 'new', 'old'))).toBe(false);
  });

  it('says nothing when there is nothing to move, and handles every pair', () => {
    root = mkdtempSync(join(tmpdir(), 'former-'));
    mkdirSync(join(root, 'b'));
    expect(run(join(root, 'a'), join(root, 'a2'), join(root, 'b'), join(root, 'b2'))).toBe(`moved ${join(root, 'b')} -> ${join(root, 'b2')}\n`);
  });
});
