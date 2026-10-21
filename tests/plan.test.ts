import { describe, expect, it } from 'vitest';
import { planFor } from '../plugins/auto-effort-control/src/plan.ts';
import { compile, resolveSettings } from '../plugins/auto-effort-control/src/settings.ts';

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
    expect(plan(text, { planUpshiftPatterns: ['\\bthink', '\\bdesign'] })).toMatchObject(expected);
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
    expect(plan('think about it', { planUpshiftPatterns: ['think'] }).reason).toBe('planning: prompt asks for thought');
    expect(plan('x'.repeat(2000)).reason).toBe('planning: long prompt (2000 chars)');
  });
});


describe('prompt hints', () => {
  it('hints without moving the default level and excludes casual thought', () => {
    expect(plan('I think we are thinking about DESIGN')).toMatchObject({ level: 'high', upshift: null, hints: ['design'], hintSources: ['\\bdesign'] });
  });
  it('widens, deduplicates and orders the first three words across patterns', () => {
    expect(plan('Architectural designs DESIGN trade-offs root cause')).toMatchObject({ hints: ['architectural', 'designs', 'design'], hintSources: ['\\bdesign', '\\barchitect', '\\btrade-?offs?\\b', '\\broot[- ]?causes?\\b'] });
    expect(plan('design DESIGN architect tradeoffs spec').hints).toEqual(['design', 'architect', 'tradeoffs']);
  });
  it('widens phrases and clips words to forty characters, ignoring empty matches', () => {
    expect(plan('root causes; THINK carefully; specification').hints).toEqual(['root causes', 'think carefully', 'specification']);
    expect(plan('x'.repeat(60), { hintPatterns: ['x', ''] }).hints).toEqual(['x'.repeat(40)]);
    expect(plan('text', { hintPatterns: [''] })).toMatchObject({ hints: [], hintSources: [] });
  });
});

it('keeps the configured hint sources verbatim rather than regex serialization', () => {
  expect(plan('a/b', { hintPatterns: ['a/b'] }).hintSources).toEqual(['a/b']);
});
