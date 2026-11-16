// The cache canary: after an effort change, the switched request must still read the previous request's prompt from the cache.

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** The cached prefix a request left behind: what it read from the cache plus what it wrote. Its uncached input sat after the
 * last cache breakpoint, so no later request can read it. */
export function cachedPrompt(usage: Usage): number {
  return usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
}

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
  const cached = cachedPrompt(prev);
  if (cached <= 0) return { verdict: 'skip', why: 'empty-prev' };
  const ratio = cur.cache_read_input_tokens / cached;
  return { verdict: ratio >= check.threshold ? 'ok' : 'fail', ratio };
}

/** A request the cache check compares the next one with: its model and context window (`modelVariant`), the effort it went at, its usage, when it ended, how many messages it carried. */
export type Sample = { model: string; wire: unknown; usage: Usage | null; endedAt: number; messages: number };

/** A request at another effort than the one before it on the same model: its Sample, when it started, whether a compaction came between. */
export type Switched = Sample & { startedAt: number; compacted: boolean };

/** The cache check of a switched request against the one before it: the one door the main chat and the sub-agents judge through. */
export function judgeStep(prev: Sample, cur: Switched, ttlMs: number, threshold: number): Verdict {
  return judgeSwitch({ prev: prev.usage, cur: cur.usage, gapMs: cur.startedAt - prev.endedAt, ttlMs, threshold, compacted: cur.compacted, sameModel: prev.model === cur.model, prevMessages: prev.messages, curMessages: cur.messages });
}
