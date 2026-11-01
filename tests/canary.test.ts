import { describe, expect, it } from 'vitest';
import { cachedPrompt, judgeSwitch, wholePrompt } from '../plugins/auto-effort/src/canary.ts';

const usage = (input: number, cacheRead: number, cacheWrite: number) => ({ input_tokens: input, output_tokens: 50, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const base = {
  prev: usage(10, 900, 100), // cached prefix 1000
  cur: usage(20, 990, 30),
  gapMs: 20_000,
  ttlMs: 300_000,
  threshold: 0.9,
  compacted: false,
  sameModel: true,
  prevMessages: 10,
  curMessages: 12,
};

// R9: after a switch, the next main request's cache read over the previous request's cached prefix (cache read + cache write).
describe('wholePrompt', () => {
  it('sums input, cache read and cache write', () => {
    expect(wholePrompt(usage(10, 900, 90))).toBe(1000);
  });
});

describe('cachedPrompt', () => {
  it('sums cache read and cache write, never the uncached input', () => {
    expect(cachedPrompt(usage(10, 900, 90))).toBe(990);
  });
});

describe('judgeSwitch', () => {
  it('is clean at a ratio of the threshold or above', () => {
    expect(judgeSwitch(base)).toEqual({ verdict: 'ok', ratio: 0.99 });
    // a first request with 28,553 uncached input tokens: the switched request read every token it cached
    expect(judgeSwitch({ ...base, prev: usage(28_553, 0, 34_789), cur: usage(2, 34_789, 32_360) })).toEqual({ verdict: 'ok', ratio: 1 });
    expect(judgeSwitch({ ...base, cur: usage(0, 900, 0) })).toEqual({ verdict: 'ok', ratio: 0.9 });
  });

  it('fails below the threshold', () => {
    expect(judgeSwitch({ ...base, cur: usage(900, 100, 0) })).toEqual({ verdict: 'fail', ratio: 0.1 });
    expect(judgeSwitch({ ...base, cur: usage(0, 899, 0) })).toEqual({ verdict: 'fail', ratio: 0.899 });
  });

  it.each([
    ['ttl', { gapMs: 300_001 }],
    ['compaction', { compacted: true }],
    ['model', { sameModel: false }],
    ['shrunk', { curMessages: 9 }],
    ['empty-prev', { prev: usage(500, 0, 0) }],
  ] as const)('skips, with no verdict, when the check cannot hold (%s)', (why, change) => {
    expect(judgeSwitch({ ...base, ...change })).toEqual({ verdict: 'skip', why });
  });

  it('skips when a request carried no usage', () => {
    expect(judgeSwitch({ ...base, cur: null })).toEqual({ verdict: 'skip', why: 'no-usage' });
    expect(judgeSwitch({ ...base, prev: null })).toEqual({ verdict: 'skip', why: 'no-usage' });
  });
});
