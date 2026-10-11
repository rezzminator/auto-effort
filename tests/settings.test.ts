import { describe, expect, it } from 'vitest';
import { compile, DEFAULTS, resolveSettings } from '../plugins/auto-effort/src/settings.ts';

// R12: every knob of R2-R10 is an option, validated at load; an invalid value is reported by key and value, and the default applies.
describe('resolveSettings', () => {
  it('uses the defaults of the requirements for no options', () => {
    const { settings, errors } = resolveSettings({});
    expect(errors).toEqual([]);
    expect(settings).toEqual(DEFAULTS);
    expect(DEFAULTS).toMatchObject({
      floor: 'medium',
      ceiling: 'xhigh',
      planLevel: 'high',
      planUpshiftChars: 1500,
      turnReminder: true,
      escalateAfterFailures: 2,
      userEffortPins: true,
      unknownModels: 'off',
      probationSwitches: 5,
      canaryThreshold: 0.9,
      statusLine: true,
    });
    expect(DEFAULTS.planUpshiftPatterns).toEqual(['\\bthink', '\\bdesign']);
    expect(DEFAULTS.failurePatterns).toEqual(['--- FAIL', 'FAIL(ED)?', '(?<!\\d)[1-9]\\d* (failed|failing)', 'AssertionError', 'panic:', 'Traceback']);
    expect(DEFAULTS.models).toEqual([
      'claude-opus-5-5=allow',
      'claude-fable-5-1=allow',
      'claude-sonnet-5-5=probation',
      'claude-haiku-5-5=probation',
      'claude-sonnet-5=deny',
    ]);
  });

  it('takes valid values, a number or a boolean given as text included', () => {
    const { settings, errors } = resolveSettings({ floor: 'low', ceiling: 'max', planLevel: 'medium', planUpshiftChars: '2000', turnReminder: 'false', canaryThreshold: '0.95', logFile: '' });
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ floor: 'low', ceiling: 'max', planLevel: 'medium', planUpshiftChars: 2000, turnReminder: false, canaryThreshold: 0.95, logFile: '' });
  });

  it.each([
    ['floor', 'lowest', 'medium'],
    ['ceiling', 7, 'xhigh'],
    ['planLevel', 'HIGH!', 'high'],
    ['planUpshiftChars', -1, 1500],
    ['escalateAfterFailures', 0, 2],
    ['escalateAfterFailures', 2.5, 2],
    ['probationSwitches', 'many', 5],
    ['canaryThreshold', 1.5, 0.9],
    ['turnReminder', 'maybe', true],
    ['unknownModels', 'sometimes', 'off'],
    ['cacheTtlSeconds', 0, 300],
  ] as const)('reports %s = %j and applies the default %j', (key, value, fallback) => {
    const { settings, errors } = resolveSettings({ [key]: value });
    expect(settings[key]).toEqual(fallback);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`"${key}"`);
    expect(errors[0]).toContain(String(value));
  });

  it('reports a pattern that is not a regular expression and keeps the default list', () => {
    const { settings, errors } = resolveSettings({ failurePatterns: ['ok', '(unclosed'] });
    expect(settings.failurePatterns).toEqual(DEFAULTS.failurePatterns);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"failurePatterns"');
    expect(errors[0]).toContain('(unclosed');
  });

  it('reads a list given as lines of text', () => {
    expect(resolveSettings({ failureTools: 'Bash\nPowerShell' }).settings.failureTools).toEqual(['Bash', 'PowerShell']);
    expect(resolveSettings({ planUpshiftPatterns: ['\\bplan'] }).settings.planUpshiftPatterns).toEqual(['\\bplan']);
  });

  it('puts a floor above the ceiling back to both defaults and names both keys', () => {
    const { settings, errors } = resolveSettings({ floor: 'xhigh', ceiling: 'medium' });
    expect([settings.floor, settings.ceiling]).toEqual(['medium', 'xhigh']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"floor"');
    expect(errors[0]).toContain('"ceiling"');
  });

  it('quotes a short piece of a rejected value, never the whole value', () => {
    const level = resolveSettings({ planLevel: 'x'.repeat(5000) }).errors;
    expect(level[0]).toMatch(/"planLevel" is "xxxxxxxx/);
    expect(level[0]!.length).toBeLessThan(300);
    const pattern = resolveSettings({ failurePatterns: ['(' + 'a'.repeat(5000)] }).errors;
    expect(pattern[0]).toContain('"failurePatterns"');
    expect(pattern[0]).toContain('(aaaa');
    expect(pattern[0]!.length).toBeLessThan(400);
  });

  it('rejects a model entry without a valid state', () => {
    const { settings, errors } = resolveSettings({ models: ['claude-x=allow', 'claude-y'] });
    expect(settings.models).toEqual(DEFAULTS.models);
    expect(errors[0]).toContain('"models"');
    expect(errors[0]).toContain('claude-y');
    expect(resolveSettings({ models: ['claude-x=sometimes'] }).errors[0]).toContain('claude-x=sometimes');
  });
});

describe('compile', () => {
  it('turns the lists into regular expressions and the model entries into a map', () => {
    const compiled = compile(DEFAULTS);
    expect(compiled.models).toEqual({
      'claude-opus-5-5': 'allow',
      'claude-fable-5-1': 'allow',
      'claude-sonnet-5-5': 'probation',
      'claude-haiku-5-5': 'probation',
      'claude-sonnet-5': 'deny',
    });
    expect(compiled.upshift.some((re) => re.test('Please THINK about it'))).toBe(true);
    expect(compiled.failure.some((re) => re.test('--- FAIL: TestX (0.00s)'))).toBe(true);
    expect(compiled.failure.some((re) => re.test('3 failed, 2 passed'))).toBe(true);
    expect(compiled.failure.some((re) => re.test('all tests passed, 0 failures'))).toBe(false);
  });

  it('counts a run with failures, never a green run that reports 0 failed, in time linear in the result', () => {
    const failure = compile(DEFAULTS).failure;
    const hits = (text: string) => failure.some((re) => re.test(text));
    expect(hits('test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out')).toBe(false);
    expect(hits('ok | 3 passed | 0 failed (12ms)')).toBe(false);
    expect(hits('=== 10 failed, 2 passed in 0.31s ===')).toBe(true);
    expect(hits('test result: ok. 11 passed; 1 failed; 0 ignored')).toBe(true);
    expect(hits('Tests  2 failing')).toBe(true);
    const digits = '7'.repeat(100_000);
    const started = performance.now();
    expect(hits(digits)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
