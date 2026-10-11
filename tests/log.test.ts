import { describe as suite, expect, it } from 'vitest';
import { fillSegments, sessionLogPath } from '../plugins/auto-effort/src/log.ts';

const rows = (from: number, count: number) => Array.from({ length: count }, (_, n) => `{"n":${from + n}}`);
const text = (list: string[]) => list.join('\n') + '\n';

suite('sessionLogPath', () => {
  it.each([
    ['/logs/decisions.jsonl', 'sess1', undefined, '/logs/decisions.sess1.jsonl'],
    ['/logs/decisions.jsonl', 'sess1', 1, '/logs/decisions.sess1.jsonl'],
    ['/logs/decisions.jsonl', 'sess1', 2, '/logs/decisions.sess1.2.jsonl'],
    ['/logs/decisions.jsonl', 'sess1', 13, '/logs/decisions.sess1.13.jsonl'],
    ['/logs/decisions', 'sess1', 3, '/logs/decisions.sess1.3'],
    ['decisions.jsonl', 'sess1', 2, 'decisions.sess1.2.jsonl'],
    ['/logs/.decisions', 'sess1', 2, '/logs/.decisions.sess1.2'],
    ['/logs/decisions.jsonl', 'a/b.c', 2, '/logs/decisions.a_b_c.2.jsonl'],
  ])('names %s for session %s, file %s', (logFile, session, segment, expected) => {
    expect(sessionLogPath(logFile as string, session as string, segment as number | undefined)).toBe(expected);
  });
});

suite('fillSegments', () => {
  it('adds the rows to the newest file while it has room', () => {
    expect(fillSegments(text(rows(0, 3)), 4, rows(3, 2), 5)).toEqual([{ segment: 4, text: text(rows(0, 5)), added: 2 }]);
  });

  it('starts the next file with the rows that do not fit', () => {
    expect(fillSegments(text(rows(0, 4)), 1, rows(4, 3), 5)).toEqual([
      { segment: 1, text: text(rows(0, 5)), added: 1 },
      { segment: 2, text: text(rows(5, 2)), added: 2 },
    ]);
  });

  it('spreads a batch over as many files as it needs', () => {
    expect(fillSegments('', 2, rows(0, 11), 5)).toEqual([
      { segment: 2, text: text(rows(0, 5)), added: 5 },
      { segment: 3, text: text(rows(5, 5)), added: 5 },
      { segment: 4, text: text(rows(10, 1)), added: 1 },
    ]);
  });

  it('does not open a file for rows that all fit exactly', () => {
    expect(fillSegments(text(rows(0, 2)), 1, rows(2, 3), 5)).toEqual([{ segment: 1, text: text(rows(0, 5)), added: 3 }]);
  });

  it('drops blank lines and writes nothing for no rows', () => {
    expect(fillSegments('\n' + rows(0, 1)[0] + '\n\n', 1, ['', '  '], 5)).toEqual([{ segment: 1, text: text(rows(0, 1)), added: 0 }]);
    expect(fillSegments('', 1, [], 5)).toEqual([]);
  });

  it('leaves a file at or past the cap as it is: the rows start the next file', () => {
    expect(fillSegments(text(rows(0, 7)), 1, rows(7, 1), 5)).toEqual([{ segment: 2, text: text(rows(7, 1)), added: 1 }]);
    expect(fillSegments(text(rows(0, 5)), 3, rows(5, 6), 5)).toEqual([
      { segment: 4, text: text(rows(5, 5)), added: 5 },
      { segment: 5, text: text(rows(10, 1)), added: 1 },
    ]);
  });
});
