import { describe, expect, it } from 'vitest';
import { deescalationLine, escalationLine, reminderLine, shortReason, statusLine, toolDescription } from '../plugins/auto-effort/src/text.ts';

// R3: the description is the model's only guide; it lists the levels the clamp lets through.
describe('toolDescription', () => {
  it('guides the model across the default range and mentions no level below the floor', () => {
    const text = toolDescription('medium', 'xhigh');
    expect(text).toContain('Call it in your first response of every user turn, alongside your first tool calls.');
    for (const level of ['xhigh:', 'high:', 'medium:']) expect(text).toContain(`- ${level}`);
    expect(text).not.toContain('- low:');
    expect(text).not.toContain('- max:');
    expect(text).toContain('If the answer itself needs deep thought and there is no tool work, call this first and answer after its result.');
  });

  // Pilot (first round): a sub-agent saw the always-loaded schema and called the tool; the plugin refused it.
  it('tells a sub-agent, which sees the same schema, not to call it', () => {
    expect(toolDescription('medium', 'xhigh')).toContain('Main chat only: a sub-agent never calls it.');
  });

  it('follows the floor and the ceiling', () => {
    expect(toolDescription('low', 'xhigh')).toContain('- low:');
    expect(toolDescription('medium', 'high')).not.toContain('- xhigh:');
    expect(toolDescription('medium', 'max')).toContain('- max:');
  });
});

describe('reminderLine', () => {
  it('names the level and the tool', () => {
    const line = reminderLine('xhigh', 'mcp__auto-effort__set_effort');
    expect(line).toContain('xhigh');
    expect(line).toContain('mcp__auto-effort__set_effort');
    expect(line.split('\n')).toHaveLength(1);
  });

  // Pilot (first round): every turn's first request runs at the planning level before the call can apply, so the reminder says so.
  it('says the first response still runs at the starting level and asks for the call first', () => {
    const line = reminderLine('high', 'mcp__auto-effort__set_effort');
    expect(line).toContain('this first response runs at high');
    expect(line).toContain('Call mcp__auto-effort__set_effort first');
    expect(line).toContain('With no call, the turn stays at high.');
  });
});

describe('escalationLine', () => {
  it('names the failures and both levels in one line', () => {
    const line = escalationLine(2, 'medium', 'high');
    expect(line).toContain('2');
    expect(line).toContain('medium');
    expect(line).toContain('high');
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('deescalationLine', () => {
  it('says the tests pass again and names both levels in one line', () => {
    const line = deescalationLine('xhigh', 'medium');
    expect(line).toMatch(/tests pass again/);
    expect(line).toMatch(/back to medium from xhigh/);
    expect(line.split('\n')).toHaveLength(1);
  });
});

// R10: `effort auto: {level} · {short reason} ({source})`.
describe('statusLine', () => {
  it('formats the line of the requirements', () => {
    expect(statusLine('medium', 'mechanical rename', 'model')).toBe('effort auto: medium · mechanical rename (model)');
  });
});

describe('shortReason', () => {
  it('collapses whitespace, caps the length and fills a missing reason', () => {
    expect(shortReason('  a\n  b  ')).toBe('a b');
    expect(shortReason('x'.repeat(100))).toHaveLength(60);
    expect(shortReason('x'.repeat(100)).endsWith('…')).toBe(true);
    expect(shortReason(undefined)).toBe('no reason given');
    expect(shortReason('   ')).toBe('no reason given');
    expect(shortReason(42)).toBe('no reason given');
  });
});
