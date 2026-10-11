import { describe, expect, it } from 'vitest';
import { escalationLine, reminderLine, shortReason, statusLine, toolDescription } from '../plugins/auto-effort/src/text.ts';

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
