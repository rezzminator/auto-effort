import { describe, expect, it } from 'vitest';
import { deescalationLine, escalationLine, handBackText, heldLine, reminderLine, setText, shortReason, toolDescription } from '../plugins/auto-effort/src/text.ts';

// R3: the description is the model's only guide; it lists the levels the clamp lets through.
describe('toolDescription', () => {
  it('guides the model across the default range and mentions no level below the floor', () => {
    const text = toolDescription('medium', 'xhigh');
    expect(text).toContain('Call it in your first response of a user turn whose work needs another level than the one in effect, alongside your first tool calls.');
    for (const level of ['xhigh:', 'high:', 'medium:']) expect(text).toContain(`- ${level}`);
    expect(text).not.toContain('- low:');
    expect(text).not.toContain('- max:');
    expect(text).toContain('If the answer itself needs deep thought and there is no tool work, call this first and answer after its result.');
  });

  // Pilot (first round): a sub-agent saw the always-loaded schema and called the tool; the plugin refused it.
  it('tells a sub-agent, which sees the same schema, not to call it', () => {
    expect(toolDescription('medium', 'xhigh')).toContain('Main chat only: a sub-agent never calls it.');
  });

  // The main chat's own level wins over the automatic rules until it hands it back.
  it('says a level holds until the turn ends over automatic rules, and auto hands it back', () => {
    const text = toolDescription('medium', 'xhigh');
    expect(text.split('\n')[0]).toBe('set_effort: set your reasoning effort for the requests after this call. A level you set holds until this turn ends, over the automatic rules; the next turn starts at its planned level again.');
    expect(text).toContain('auto hands the effort back to the automatic rules for the rest of this turn: its planned level, and failing test runs raise it.');
  });

  it('follows the floor and the ceiling', () => {
    expect(toolDescription('low', 'xhigh')).toContain('- low:');
    expect(toolDescription('medium', 'high')).not.toContain('- xhigh:');
    expect(toolDescription('medium', 'max')).toContain('- max:');
  });
});

describe('reminderLine', () => {
  for (const upshift of [null, 'length', 'pattern'] as const) {
    for (const hints of [[], ['design'], ['design', 'architecture'], ['design', 'architecture', 'spec']]) {
      it(`explains ${upshift} with ${hints.length} hints in one line`, () => {
        const why = upshift === 'length' ? ' because the prompt is long (1600 characters)' : upshift === 'pattern' ? ' because the prompt matches planUpshiftPatterns' : '';
        const words = hints.length === 1 ? '"design"' : hints.length === 2 ? '"design" and "architecture"' : '"design", "architecture" and "spec"';
        const hint = hints.length ? ` This prompt names ${words}: the set_effort guide places that kind of work at xhigh; whether this turn is that work is your call.` : '';
        const line = reminderLine({ level: 'high', tool: 'set_effort', upshift, chars: 1600, hints, hintLevel: 'xhigh' });
        expect(line).toBe(`Your reasoning effort starts this turn at high${why}, and this first response runs at high. Call set_effort first, with the level the work ahead needs; a level you set lasts until this turn ends. With no call, the turn stays at high.${hint}`);
        expect(line.split('\n')).toHaveLength(1);
      });
    }
  }
});

describe('heldLine', () => {
  it('says the failing runs leave the level the main chat set, and how to raise it, in one line', () => {
    expect(heldLine(2, 'medium', 'mcp__auto-effort__set_effort')).toBe(
      'auto-effort: 2 failing test runs this turn; your reasoning effort stays at medium, the level you set. Call mcp__auto-effort__set_effort with a higher level if the work needs more, or with auto to let failing tests raise it.',
    );
  });
});

describe('setText', () => {
  it('names the level applied and that it holds until the turn ends or auto', () => {
    expect(setText('medium', 'medium', 'medium', 'xhigh')).toBe('Effort set to medium from your next request; it holds until this turn ends, or until you call set_effort with auto.');
  });

  it('says why a clamped level differs from the one asked', () => {
    expect(setText('medium', 'low', 'medium', 'xhigh')).toBe('Effort set to medium from your next request (low is below the floor medium); it holds until this turn ends, or until you call set_effort with auto.');
    expect(setText('xhigh', 'max', 'medium', 'xhigh')).toBe('Effort set to xhigh from your next request (max is above the ceiling xhigh); it holds until this turn ends, or until you call set_effort with auto.');
  });
});

describe('handBackText', () => {
  it.each([
    [{ held: true, level: 'xhigh' }, 'Effort handed back to the automatic rules: this turn runs at xhigh again from your next request, and each turn starts at its planned level.'],
    [{ held: true, level: null }, 'Effort handed back to the automatic rules: each turn starts at its planned level.'],
    [{ held: false, level: 'high' }, 'Nothing to hand back: your reasoning effort already follows the automatic rules.'],
    [{ held: true, level: null, outranked: 'your /effort pin at low still applies until /auto-effort on' }, 'Effort handed back to the automatic rules; your /effort pin at low still applies until /auto-effort on.'],
  ] as const)('answers %j', (input, text) => {
    expect(handBackText(input)).toBe(text);
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
