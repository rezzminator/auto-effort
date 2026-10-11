// The planning level: what the first request of a turn runs at, before the model has said anything.

import { clamp, rank, type Effort } from './levels.ts';
import type { Compiled, Settings } from './settings.ts';

export type Plan = {
  level: Effort;
  /** Why the level went up: the prompt matched a pattern, or it was long. */
  upshift: 'pattern' | 'length' | null;
  reason: string;
};

export function planFor(settings: Settings, compiled: Compiled, text: string): Plan {
  const pattern = compiled.upshift.some((re) => re.test(text));
  const long = text.length > settings.planUpshiftChars;
  const upshift = pattern ? 'pattern' : long ? 'length' : null;
  const wanted: Effort = upshift !== null && rank(settings.planLevel) < rank('xhigh') ? 'xhigh' : settings.planLevel;
  const level = clamp(wanted, settings.floor, settings.ceiling);
  if (upshift === 'pattern') return { level, upshift, reason: 'planning: prompt asks for thought' };
  if (upshift === 'length') return { level, upshift, reason: `planning: long prompt (${text.length} chars)` };
  return { level, upshift, reason: 'planning turn' };
}
