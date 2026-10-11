import { describe, expect, it } from 'vitest';
import { planFor } from '../plugins/auto-effort/src/plan.ts';
import { compile, resolveSettings } from '../plugins/auto-effort/src/settings.ts';

const plan = (text: string, raw: Record<string, unknown> = {}) => {
  const { settings } = resolveSettings(raw);
  return planFor(settings, compile(settings), text);
};

// R2: the first request of a turn runs at `planLevel`; `xhigh` when the prompt matches `planUpshiftPatterns` or is longer than `planUpshiftChars`.
describe('planFor', () => {
  it('plans an ordinary prompt at the planning level', () => {
    expect(plan('rename the helper in utils')).toMatchObject({ level: 'high', upshift: null });
    expect(plan('')).toMatchObject({ level: 'high', upshift: null });
  });

  it.each(['think about the cache', 'THINK', 'Please design a retry policy', 'we are thinking of a design', 'rethinking is not a match'])('upshifts %j on a pattern, case-insensitive', (text) => {
    const expected = text.startsWith('rethinking') ? { level: 'high', upshift: null } : { level: 'xhigh', upshift: 'pattern' };
    expect(plan(text)).toMatchObject(expected);
  });

  it('upshifts a prompt longer than `planUpshiftChars`, not one of exactly that length', () => {
    expect(plan('x'.repeat(1501))).toMatchObject({ level: 'xhigh', upshift: 'length' });
    expect(plan('x'.repeat(1500))).toMatchObject({ level: 'high', upshift: null });
    expect(plan('x'.repeat(30), { planUpshiftChars: 20 })).toMatchObject({ level: 'xhigh', upshift: 'length' });
  });

  it('follows custom patterns and clamps to the floor and the ceiling', () => {
    expect(plan('refactor it', { planUpshiftPatterns: ['refactor'] })).toMatchObject({ level: 'xhigh', upshift: 'pattern' });
    expect(plan('think hard', { planUpshiftPatterns: ['refactor'] })).toMatchObject({ level: 'high', upshift: null });
    expect(plan('think hard', { ceiling: 'high' })).toMatchObject({ level: 'high' });
    expect(plan('plain', { planLevel: 'low' })).toMatchObject({ level: 'medium' });
  });

  it('says in its reason why the level was chosen', () => {
    expect(plan('plain').reason).toBe('planning turn');
    expect(plan('think about it').reason).toBe('planning: prompt asks for thought');
    expect(plan('x'.repeat(2000)).reason).toBe('planning: long prompt (2000 chars)');
  });
});
