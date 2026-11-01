import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../plugins/auto-effort/src/subagent/frontmatter.ts';

describe('parseFrontmatter', () => {
  it('reads top-level scalars between the fences', () => {
    expect(parseFrontmatter('---\nname: builder\neffort: High\n---\nbody: not me')).toEqual({ fields: { name: 'builder', effort: 'High' }, unterminated: false });
  });

  it('reads one level of nesting as parent.child', () => {
    const text = '---\nname: lead\neffortControl:\n  floor: medium\n  landing: lander, reviewer\n---\n';
    expect(parseFrontmatter(text).fields).toEqual({ name: 'lead', effortControl: '', 'effortControl.floor': 'medium', 'effortControl.landing': 'lander, reviewer' });
  });

  it('reads a block list under a key with no value of its own as a comma list, at the top level and nested', () => {
    const text = '---\nname: lead\ntools:\n- Read\n- "Bash"\neffortControl:\n  tripwires:\n    - fail2\n    - red # loud\n  landing:\n    - lander\n---\n';
    expect(parseFrontmatter(text).fields).toEqual({ name: 'lead', tools: 'Read, Bash', effortControl: '', 'effortControl.tripwires': 'fail2, red', 'effortControl.landing': 'lander' });
  });

  it('strips quotes and trailing comments', () => {
    expect(parseFrontmatter('---\na: "x y"\nb: z # note\n---\n').fields).toEqual({ a: 'x y', b: 'z' });
  });

  it('reads no frontmatter from a file without fences', () => {
    expect(parseFrontmatter('name: x')).toEqual({ fields: {}, unterminated: false });
  });

  it('keeps the fields of an unterminated frontmatter and says it is unterminated', () => {
    expect(parseFrontmatter('---\nname: x\neffort: high\n')).toEqual({ fields: { name: 'x', effort: 'high' }, unterminated: true });
  });

  it('survives a byte-order mark and CRLF line ends', () => {
    expect(parseFrontmatter('﻿---\r\nname: x\r\n---\r\n').fields).toEqual({ name: 'x' });
  });
});
