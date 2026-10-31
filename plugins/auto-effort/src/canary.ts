// The cache canary: after an effort change, the switched request must still read the previous request's prompt from the cache.

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** The whole prompt a request carried: uncached input, cache read and cache write. */
export function wholePrompt(usage: Usage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
}

export type SwitchCheck = {
  prev: Usage | null;
  cur: Usage | null;
  /** From the previous request's end to this one's start. */
  gapMs: number;
  ttlMs: number;
  threshold: number;
  compacted: boolean;
  sameModel: boolean;
  prevMessages: number;
  curMessages: number;
};

export type Verdict =
  | { verdict: 'ok'; ratio: number }
  | { verdict: 'fail'; ratio: number }
  | { verdict: 'skip'; why: 'no-usage' | 'model' | 'compaction' | 'shrunk' | 'ttl' | 'empty-prev' };

/** A check that cannot hold (a lapsed TTL, a compaction, another model) judges nothing: it is no pass and no fail. */
export function judgeSwitch(check: SwitchCheck): Verdict {
  const { prev, cur } = check;
  if (prev === null || cur === null) return { verdict: 'skip', why: 'no-usage' };
  if (!check.sameModel) return { verdict: 'skip', why: 'model' };
  if (check.compacted) return { verdict: 'skip', why: 'compaction' };
  if (check.curMessages < check.prevMessages) return { verdict: 'skip', why: 'shrunk' };
  if (check.gapMs > check.ttlMs) return { verdict: 'skip', why: 'ttl' };
  const whole = wholePrompt(prev);
  if (whole <= 0) return { verdict: 'skip', why: 'empty-prev' };
  const ratio = cur.cache_read_input_tokens / whole;
  return { verdict: ratio >= check.threshold ? 'ok' : 'fail', ratio };
}
