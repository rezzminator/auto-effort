import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { KEEPER_ARGV, KEEPER_MARK, stateOf, stateText, type StateInput } from '../plugins/auto-effort/src/state.ts';

const base: StateInput = { enabled: true, steered: true, pin: null, override: null, turn: { level: 'medium', reason: 'a lookup over logs' } };

// The state file names the mode the main chat's effort is in, highest rule first: off, not steered, pin, the main
// chat's own level, the automatic rules.
describe('stateOf', () => {
  const rows: Array<[string, Partial<StateInput>, ReturnType<typeof stateOf>]> = [
    ['the automatic rules at the turn level', {}, { version: 2, mode: 'auto', level: 'medium', reason: 'a lookup over logs' }],
    ['no request yet', { turn: null }, { version: 2, mode: 'auto', level: null, reason: 'the next turn starts at its planned level' }],
    ['the main chat set a level', { override: { level: 'high', reason: 'a refactor across files' }, turn: { level: 'high', reason: 'a refactor across files' } }, { version: 2, mode: 'model', level: 'high', reason: 'a refactor across files' }],
    ['the main chat set a level before any request', { override: { level: 'xhigh', reason: 'hard proof' }, turn: null }, { version: 2, mode: 'model', level: 'xhigh', reason: 'hard proof' }],
    ['the user pinned /effort over the main chat', { pin: 'low', override: { level: 'high', reason: 'x' } }, { version: 2, mode: 'pin', level: 'low', reason: 'you set /effort; /auto-effort on resumes' }],
    ['the user turned it off over a pin and a level', { enabled: false, pin: 'low', override: { level: 'high', reason: 'x' } }, { version: 2, mode: 'off', level: null, reason: 'auto-effort is off; /auto-effort on resumes' }],
    ['the model gate keeps the model unsteered', { steered: false, override: { level: 'high', reason: 'x' } }, { version: 2, mode: 'off', level: null, reason: 'this model is not steered' }],
  ];
  it.each(rows)('%s', (_name, change, expected) => {
    expect(stateOf({ ...base, ...change })).toEqual(expected);
  });

  it('carries a reason as one line of at most 60 characters', () => {
    const long = `line one\n${'word '.repeat(30)}`;
    const state = stateOf({ ...base, turn: { level: 'high', reason: long } });
    expect(state.reason.length).toBe(60);
    expect(state.reason.startsWith('line one word word')).toBe(true);
    expect(state.reason).not.toContain('\n');
    expect(state.reason.endsWith('…')).toBe(true);
  });
});

// The file's text: one JSON line, its keys in this order, `keeper` the pid vouching for it (0: none), `updatedAt` the
// time of writing.
describe('stateText', () => {
  it('writes the state as one JSON line ending in a newline, with the keeper that vouches for it', () => {
    const at = new Date('2026-10-17T09:30:00.000Z');
    expect(stateText({ version: 2, mode: 'auto', level: 'medium', reason: 'a lookup over logs' }, 4242, at)).toBe(
      '{"version":2,"mode":"auto","level":"medium","reason":"a lookup over logs","keeper":4242,"updatedAt":"2026-10-17T09:30:00.000Z"}\n',
    );
    expect(stateText({ version: 2, mode: 'off', level: null, reason: 'auto-effort is off; /auto-effort on resumes' }, 0, at)).toBe(
      '{"version":2,"mode":"off","level":null,"reason":"auto-effort is off; /auto-effort on resumes","keeper":0,"updatedAt":"2026-10-17T09:30:00.000Z"}\n',
    );
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The keeper: its first output is its own pid, its argv ends in the mark a reader checks, and it exits once the
// process that started it is gone.
describe('KEEPER_ARGV', () => {
  it('prints its own pid, carries the mark, and exits within seconds of its parent', async () => {
    expect(KEEPER_ARGV.at(-1)).toBe(KEEPER_MARK);
    expect(KEEPER_MARK).toBe('auto-effort-keeper');
    // A parent that starts the keeper and exits half a second later.
    const parent = spawn('/bin/sh', ['-c', '"$@" & sleep 0.5', 'parent', ...KEEPER_ARGV], { stdio: ['ignore', 'pipe', 'inherit'] });
    const first = await new Promise<string>((resolve) => parent.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString())));
    const pid = Number(first.trim());
    expect(Number.isInteger(pid) && pid > 0 && pid !== parent.pid).toBe(true);
    expect(alive(pid)).toBe(true);
    const gone = Date.now() + 5000;
    while (alive(pid) && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(false);
  }, 10000);
});
