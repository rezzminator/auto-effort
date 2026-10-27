import { describe, expect, it } from 'vitest';
import { sessionLogPath } from '../../plugins/auto-effort-control/src/subagent/log.ts';
import { sessionLogPath as mainLogPath } from '../../plugins/auto-effort-control/src/log.ts';

describe('sub-agent decision log', () => {
  it.each([
    ['/logs/decisions.jsonl', 'sess1', '/logs/decisions.sess1.subagent.jsonl'],
    ['/logs/decisions', 'sess1', '/logs/decisions.sess1.subagent'],
    ['decisions.jsonl', 'a/b.c', 'decisions.a_b_c.subagent.jsonl'],
  ])('keeps %s for %s separate from every main-chat segment', (file, id, expected) => {
    expect(sessionLogPath(file, id)).toBe(expected);
    expect([mainLogPath(file, id), mainLogPath(file, id, 2)]).toEqual([expected.replace('.subagent', ''), expected.replace('.subagent', '.2')]);
  });
});
