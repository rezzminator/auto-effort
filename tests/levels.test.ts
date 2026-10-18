import { describe, expect, it } from 'vitest';
import { clamp, isEffort, levelsWithin, stepUp } from '../plugins/auto-effort-control/src/levels.ts';

// R6: every level is clamped to [floor, ceiling]; `max` only when the ceiling is `max`.
describe('clamp', () => {
  it.each([
    ['low', 'medium', 'xhigh', 'medium'],
    ['medium', 'medium', 'xhigh', 'medium'],
    ['high', 'medium', 'xhigh', 'high'],
    ['xhigh', 'medium', 'xhigh', 'xhigh'],
    ['max', 'medium', 'xhigh', 'xhigh'],
    ['max', 'medium', 'max', 'max'],
    ['xhigh', 'low', 'high', 'high'],
  ] as const)('%s within [%s, %s] is %s', (level, floor, ceiling, expected) => {
    expect(clamp(level, floor, ceiling)).toBe(expected);
  });
});

// R5: an escalation raises the level one step, up to the ceiling.
describe('stepUp', () => {
  it.each([
    ['medium', 'xhigh', 'high'],
    ['high', 'xhigh', 'xhigh'],
    ['xhigh', 'xhigh', 'xhigh'],
    ['xhigh', 'max', 'max'],
    ['max', 'max', 'max'],
    ['low', 'high', 'medium'],
  ] as const)('%s under ceiling %s steps to %s', (level, ceiling, expected) => {
    expect(stepUp(level, ceiling)).toBe(expected);
  });
});

describe('levelsWithin', () => {
  it('lists the levels from the floor to the ceiling', () => {
    expect(levelsWithin('medium', 'xhigh')).toEqual(['medium', 'high', 'xhigh']);
    expect(levelsWithin('low', 'max')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('isEffort', () => {
  it('accepts the five levels only', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].every(isEffort)).toBe(true);
    expect([isEffort('HIGH'), isEffort('mid'), isEffort(3), isEffort(undefined)]).toEqual([false, false, false, false]);
  });
});
