import { describe, expect, it } from 'vitest';
import { parseCommand, statusText } from '../plugins/auto-effort/src/command.ts';
import { Controller } from '../plugins/auto-effort/src/controller.ts';
import { EMPTY_PERSISTED, markUnsafe } from '../plugins/auto-effort/src/gate.ts';
import { resolveSettings } from '../plugins/auto-effort/src/settings.ts';

// R11: `/auto-effort [on|off|status]`, plus `set <key> <value>` because a plugin can persist a setting through `$.config.set`.
describe('parseCommand', () => {
  it.each([
    ['', { kind: 'status' }],
    ['  status ', { kind: 'status' }],
    ['on', { kind: 'on' }],
    ['OFF', { kind: 'off' }],
    ['set floor low', { kind: 'set', key: 'floor', value: 'low' }],
    ['set planUpshiftChars   2000', { kind: 'set', key: 'planUpshiftChars', value: '2000' }],
    ['clear claude-opus-5-5', { kind: 'clear', model: 'claude-opus-5-5' }],
    ['clear', { kind: 'clear', model: undefined }],
  ] as const)('reads %j', (args, expected) => {
    expect(parseCommand(args)).toEqual(expected);
  });

  it.each(['set floor', 'set', 'set nothere 1', 'set failurePatterns x', 'launch'])('refuses %j with a message that teaches the forms', (args) => {
    const parsed = parseCommand(args);
    expect(parsed.kind).toBe('bad');
    expect('message' in parsed && parsed.message).toContain('/auto-effort [on|off|status]');
  });
});

describe('statusText', () => {
  const view = (raw: Record<string, unknown> = {}, persisted = EMPTY_PERSISTED) => {
    const { settings, errors } = resolveSettings(raw);
    const ctl = new Controller(settings, persisted, () => 0);
    ctl.onPrompt({ text: 'fix it', model: 'claude-opus-5-5', midTurn: false });
    ctl.beginStep({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 2 });
    return statusText({ view: ctl.view(), settings, errors, version: '0.1.0', settingsFrom: 'live' });
  };

  it('shows the level and its source, the gate state of the model and the settings in effect', () => {
    const text = view();
    expect(text).toContain('auto-effort 0.1.0 · on');
    expect(text).toContain('level: high · plan · planning turn');
    expect(text).toContain('model: claude-opus-5-5 · allow');
    expect(text).toContain('floor=medium');
    expect(text).toContain('ceiling=xhigh');
  });

  it("names the main chat's own level as held across turns until set_effort auto", () => {
    const { settings } = resolveSettings({});
    const ctl = new Controller(settings, EMPTY_PERSISTED, () => 0);
    ctl.setEffort({ input: { level: 'medium', reason: 'mechanical rename' }, agent: false });
    expect(statusText({ view: ctl.view(), settings, errors: [], version: '0.1.0', settingsFrom: 'live' })).toContain('level: medium · model, held across turns until set_effort auto · mechanical rename');
    ctl.beginStep({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 2 });
    expect(statusText({ view: ctl.view(), settings, errors: [], version: '0.1.0', settingsFrom: 'live' })).toContain('level: medium · model, held across turns until set_effort auto · mechanical rename');
  });

  it("says the main chat's own level is kept behind off and behind a pin", () => {
    const { settings } = resolveSettings({});
    const ctl = new Controller(settings, EMPTY_PERSISTED, () => 0);
    ctl.setEffort({ input: { level: 'medium', reason: 'mechanical rename' }, agent: false });
    ctl.setEnabled(false);
    const off = statusText({ view: ctl.view(), settings, errors: [], version: '0.1.0', settingsFrom: 'live' });
    expect(off).toContain("main chat's own level: medium · kept while auto-effort is off · mechanical rename");
    ctl.restoreSession({ enabled: true, pin: 'low', override: { level: 'medium', reason: 'mechanical rename' } });
    const pinned = statusText({ view: ctl.view(), settings, errors: [], version: '0.1.0', settingsFrom: 'live' });
    expect(pinned).toContain('level: low · pin');
    expect(pinned).toContain("main chat's own level: medium · kept behind your /effort pin until /auto-effort on · mechanical rename");
    ctl.restoreSession({ enabled: true, pin: null, override: null });
    expect(statusText({ view: ctl.view(), settings, errors: [], version: '0.1.0', settingsFrom: 'live' })).not.toContain("main chat's own level");
  });

  it("shows the main chat's own level as it is sent, clamped, and only as kept on a model the plugin does not steer", () => {
    const { settings } = resolveSettings({});
    const ctl = new Controller(settings, EMPTY_PERSISTED, () => 0);
    ctl.restoreSession({ enabled: true, pin: null, override: { level: 'max', reason: 'deep proof' } });
    expect(statusText({ view: ctl.view(), settings, errors: [], version: '0.1.0', settingsFrom: 'live' })).toContain('level: xhigh · model, held across turns until set_effort auto · deep proof');
    ctl.beginStep({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: undefined, messageCount: 2 });
    const unsteered = statusText({ view: ctl.view(), settings, errors: [], version: '0.1.0', settingsFrom: 'live' });
    expect(unsteered).not.toContain('· model, held across turns');
    expect(unsteered).toContain("main chat's own level: xhigh · kept while this model is not steered · deep proof");
  });

  it('names the pluginConfigs key to edit and the set command', () => {
    const text = view();
    expect(text).toContain('pluginConfigs["auto-effort@');
    expect(text).toContain('/auto-effort set <key> <value>');
  });

  it('lists the option errors and a cache mark with the way to clear it', () => {
    const marked = markUnsafe(EMPTY_PERSISTED, 'claude-opus-5-5', { at: '2026-10-11T12:00:00Z', ratio: 0.12, prevPrompt: 40000, cacheRead: 4800, from: 'high', to: 'medium' });
    const text = view({ floor: 'nope' }, marked);
    expect(text).toContain('"floor"');
    expect(text).toContain('model: claude-opus-5-5 · unsafe');
    expect(text).toContain('/auto-effort clear claude-opus-5-5');
  });
});
