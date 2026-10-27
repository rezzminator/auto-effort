// The planning level: what the first request of a turn runs at, before the model has said anything.

import { clamp, rank, type Effort } from './levels.ts';
import type { Compiled, Settings } from './settings.ts';

export type Plan = {
  level: Effort;
  /** Why the level went up: the prompt matched a pattern, or it was long. */
  upshift: 'pattern' | 'length' | null;
  reason: string;
  hints: string[];
  hintSources: string[];
};

export function planFor(settings: Settings, compiled: Compiled, text: string): Plan {
  const pattern = compiled.upshift.some((re) => re.test(text));
  const long = text.length > settings.planUpshiftChars;
  const upshift = pattern ? 'pattern' : long ? 'length' : null;
  const wanted: Effort = upshift !== null && rank(settings.planLevel) < rank('xhigh') ? 'xhigh' : settings.planLevel;
  const level = clamp(wanted, settings.floor, settings.ceiling);
  const matches: { index: number; word: string }[] = [];
  const hintSources: string[] = [];
  for (const [index, re] of compiled.hints.entries()) {
    let found = false;
    for (const match of text.matchAll(re)) {
      if (!match[0]) continue;
      found = true;
      let start = match.index;
      let end = start + match[0].length;
      while (start > 0 && /[\p{L}\p{N}_-]/u.test(text[start - 1]!)) start--;
      while (end < text.length && /[\p{L}\p{N}_-]/u.test(text[end]!)) end++;
      matches.push({ index: start, word: text.slice(start, end).toLowerCase() });
    }
    if (found) hintSources.push(settings.hintPatterns[index]!);
  }
  const hints = [...new Set(matches.sort((a, b) => a.index - b.index).map((match) => match.word))].slice(0, 3).map((word) => word.slice(0, 40));
  const reason = upshift === 'pattern' ? 'planning: prompt asks for thought' : upshift === 'length' ? `planning: long prompt (${text.length} chars)` : 'planning turn';
  return { level, upshift, reason, hints, hintSources };
}
