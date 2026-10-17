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
      lowerOnPass: true,
      userEffortPins: true,
      unknownModels: 'off',
      probationSwitches: 5,
      canaryThreshold: 0.9,
      statusLine: true,
    });
    expect(DEFAULTS.planUpshiftPatterns).toEqual(['\\bthink', '\\bdesign']);
    expect(DEFAULTS.failurePatterns).toEqual(['--- FAIL', 'FAIL(ED)?', '(?<!\\d)[1-9]\\d* (failed|failing)', 'AssertionError', 'panic:', 'Traceback']);
    expect(DEFAULTS.testCommandPatterns).toHaveLength(15);
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
    ['lowerOnPass', 'sometimes', true],
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

  it('reports a test command pattern that is not a regular expression, and uses none of that list', () => {
    const taken = resolveSettings({ testCommandPatterns: ['\\bmytest\\b'] });
    expect(taken.errors).toEqual([]);
    expect(taken.settings.testCommandPatterns).toEqual(['\\bmytest\\b']);
    const { settings, errors } = resolveSettings({ testCommandPatterns: ['\\bmytest\\b', '(unclosed'] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"testCommandPatterns"');
    expect(errors[0]).toContain('(unclosed');
    expect(settings.testCommandPatterns).toEqual(DEFAULTS.testCommandPatterns);
    expect(compile(settings).testCommand.map((re) => re.source)).not.toContain('(unclosed');
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

// The environment layer: AUTO_EFFORT_{OPTION} over the option, over the default. A bad value is reported by its variable name and the option's default applies.
describe('resolveSettings with environment variables', () => {
  const NAMES = {
    floor: 'AUTO_EFFORT_FLOOR',
    ceiling: 'AUTO_EFFORT_CEILING',
    planLevel: 'AUTO_EFFORT_PLAN_LEVEL',
    planUpshiftPatterns: 'AUTO_EFFORT_PLAN_UPSHIFT_PATTERNS',
    planUpshiftChars: 'AUTO_EFFORT_PLAN_UPSHIFT_CHARS',
    turnReminder: 'AUTO_EFFORT_TURN_REMINDER',
    escalateAfterFailures: 'AUTO_EFFORT_ESCALATE_AFTER_FAILURES',
    failurePatterns: 'AUTO_EFFORT_FAILURE_PATTERNS',
    failureTools: 'AUTO_EFFORT_FAILURE_TOOLS',
    userEffortPins: 'AUTO_EFFORT_USER_EFFORT_PINS',
    models: 'AUTO_EFFORT_MODELS',
    unknownModels: 'AUTO_EFFORT_UNKNOWN_MODELS',
    probationSwitches: 'AUTO_EFFORT_PROBATION_SWITCHES',
    canaryThreshold: 'AUTO_EFFORT_CANARY_THRESHOLD',
    cacheTtlSeconds: 'AUTO_EFFORT_CACHE_TTL_SECONDS',
    statusLine: 'AUTO_EFFORT_STATUS_LINE',
    logFile: 'AUTO_EFFORT_LOG_FILE',
    stateFile: 'AUTO_EFFORT_STATE_FILE',
    lowerOnPass: 'AUTO_EFFORT_LOWER_ON_PASS',
    testCommandPatterns: 'AUTO_EFFORT_TEST_COMMAND_PATTERNS',
  } as const;

  it('names one variable per option', () => {
    expect(Object.keys(NAMES).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  // [option, env text, an option-layer value that env must beat, the value env gives]
  it.each([
    ['floor', 'low', 'high', 'low'],
    ['ceiling', ' max ', 'high', 'max'],
    ['planLevel', 'medium', 'low', 'medium'],
    ['planUpshiftPatterns', '["\\\\bplan"]', ['\\bother'], ['\\bplan']],
    ['planUpshiftChars', ' 2000 ', 100, 2000],
    ['turnReminder', 'FALSE', true, false],
    ['turnReminder', '0', true, false],
    ['userEffortPins', ' True ', false, true],
    ['statusLine', '1', false, true],
    ['escalateAfterFailures', '3', 9, 3],
    ['failurePatterns', '["boom", "bang"]', ['x'], ['boom', 'bang']],
    ['failurePatterns', '[]', ['x'], []],
    ['failureTools', '["Bash","PowerShell"]', ['Edit'], ['Bash', 'PowerShell']],
    ['models', '["claude-x=deny"]', ['claude-y=allow'], ['claude-x=deny']],
    ['unknownModels', 'probation', 'allow', 'probation'],
    ['probationSwitches', '8', 2, 8],
    ['canaryThreshold', '0.5', 0.8, 0.5],
    ['cacheTtlSeconds', '3600', 60, 3600],
    ['logFile', '/var/log/effort.jsonl', '/other.jsonl', '/var/log/effort.jsonl'],
    ['stateFile', '/run/effort.json', '/other.json', '/run/effort.json'],
    ['lowerOnPass', ' False ', true, false],
    ['lowerOnPass', '1', false, true],
    ['testCommandPatterns', '["\\\\bmytest\\\\b"]', ['\\bother\\b'], ['\\bmytest\\b']],
    ['testCommandPatterns', '[]', ['\\bother\\b'], []],
  ] as const)('%s: the variable %j beats the option and the default', (key, text, option, value) => {
    const { settings, errors } = resolveSettings({ [key]: option }, { [key]: text });
    expect(errors).toEqual([]);
    expect(settings[key]).toEqual(value);
    expect(resolveSettings({}, { [key]: text }).settings[key]).toEqual(value);
  });

  // [option, a bad env text, a valid option-layer value that the default must still beat]
  it.each([
    ['floor', 'lowest', 'high'],
    ['ceiling', 'Max', 'high'],
    ['planUpshiftPatterns', '["(unclosed"]', ['\\bother']],
    ['planUpshiftPatterns', '\\bplan', ['\\bother']],
    ['planUpshiftChars', '0', 100],
    ['planUpshiftChars', '12x', 100],
    ['turnReminder', 'yes', false],
    ['userEffortPins', 'maybe', false],
    ['statusLine', '2', false],
    ['escalateAfterFailures', '2.5', 9],
    ['failurePatterns', 'a\nb', ['x']],
    ['failureTools', '[1, 2]', ['Edit']],
    ['failureTools', '{"Bash":true}', ['Edit']],
    ['models', '["claude-y"]', ['claude-z=allow']],
    ['unknownModels', 'sometimes', 'allow'],
    ['probationSwitches', 'many', 2],
    ['canaryThreshold', '1.5', 0.8],
    ['cacheTtlSeconds', '-3', 60],
    ['lowerOnPass', 'sometimes', false],
    ['testCommandPatterns', '["(unclosed"]', ['\\bother\\b']],
    ['testCommandPatterns', '\\bmytest\\b', ['\\bother\\b']],
  ] as const)('%s: a bad variable %j is reported by name and the default applies, not the option %j', (key, text, option) => {
    const { settings, errors } = resolveSettings({ [key]: option }, { [key]: text });
    expect(settings[key]).toEqual(DEFAULTS[key]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(NAMES[key]);
    expect(errors[0]).toContain(`"${key}"`);
    expect(errors[0]).toContain(`using the default ${JSON.stringify(DEFAULTS[key])}`);
  });

  it('treats an unset, empty or blank variable as absent, so the option or the default decides', () => {
    for (const blank of [undefined, '', '   ', '\n\t']) {
      const withOption = resolveSettings({ floor: 'high', failureTools: ['Edit'] }, { floor: blank, failureTools: blank, logFile: blank });
      expect(withOption.errors).toEqual([]);
      expect(withOption.settings).toMatchObject({ floor: 'high', failureTools: ['Edit'], logFile: DEFAULTS.logFile });
    }
    expect(resolveSettings({}, {}).settings).toEqual(DEFAULTS);
  });

  it('checks the floor against the ceiling after both layers', () => {
    const { settings, errors } = resolveSettings({ ceiling: 'low' }, { floor: 'high' });
    expect([settings.floor, settings.ceiling]).toEqual(['medium', 'xhigh']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"floor"');
    expect(errors[0]).toContain('"floor" ("high", from AUTO_EFFORT_FLOOR)');
    expect(errors[0]).toContain('"ceiling" ("low")');
  });

  it('lists the options whose variable applies: not a bad one, not a floor or ceiling the conflict reset', () => {
    expect(resolveSettings({}, { floor: 'low', planUpshiftChars: '9', turnReminder: 'maybe', logFile: '  ' }).fromEnv).toEqual(['floor', 'planUpshiftChars']);
    expect(resolveSettings({ ceiling: 'low' }, { floor: 'high', planUpshiftChars: '9' }).fromEnv).toEqual(['planUpshiftChars']);
    expect(resolveSettings({}, {}).fromEnv).toEqual([]);
  });

  it('quotes a short piece of a rejected variable, never the whole value', () => {
    const { errors } = resolveSettings({}, { planLevel: 'x'.repeat(5000) });
    expect(errors[0]).toContain('AUTO_EFFORT_PLAN_LEVEL');
    expect(errors[0]!.length).toBeLessThan(400);
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

  it('knows the common test runners by their command, and no command that only reads output', () => {
    const testCommand = compile(DEFAULTS).testCommand;
    const isTest = (command: string) => testCommand.some((re) => re.test(command));
    for (const command of [
      'go test ./...',
      'go -C engine test -run TestX ./internal/...',
      'npm test',
      'npm run test -- --watch=false',
      'pnpm test',
      'yarn test',
      'bun test',
      'npx vitest run tests/a.test.ts',
      'jest --ci',
      'python -m pytest -q',
      'cargo test',
      'cargo nextest run',
      'make -C engine test',
      'make check',
      'make verify',
      'just test',
      'mvn -q test',
      './gradlew test',
      'dotnet test',
      'deno test',
      'swift test',
      'mix test',
      'bundle exec rspec',
      'vendor/bin/phpunit',
      'ctest --output-on-failure',
      'tox -e py312',
      'nox -s tests',
      'bash scripts/test-unit.sh',
      'cd app && ./script/test.sh',
    ]) expect(isTest(command), command).toBe(true);
    for (const command of ['cat build.log', 'grep -rn FAIL .', 'sed -n 1,40p out.txt', 'ls tests/', 'npm install', 'make build; echo test', 'git log --grep latest', 'echo contest']) {
      expect(isTest(command), command).toBe(false);
    }
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
