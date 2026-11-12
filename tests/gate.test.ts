import { describe, expect, it } from 'vitest';
import { clearUnsafe, cleanSwitch, EMPTY_PERSISTED, gateOf, marksOf, markUnsafe, mergeModels, modelVariant, normalizeModel, readPersisted } from '../plugins/auto-effort/src/gate.ts';
import { compile, DEFAULTS, resolveSettings } from '../plugins/auto-effort/src/settings.ts';

const compiled = compile(DEFAULTS);
const gate = (model: string, persisted = EMPTY_PERSISTED, settings = DEFAULTS) => gateOf(model, settings, compile(settings), persisted);
const mark = { at: '2026-10-11T12:00:00Z', ratio: 0.12, prevPrompt: 40000, cacheRead: 4800, from: 'high', to: 'medium' };

// R8: a per-model allow / probation / deny map; an unknown model follows `unknownModels`.
describe('gateOf', () => {
  it.each([
    ['claude-opus-5-5', 'allow', true],
    ['claude-fable-5-1', 'allow', true],
    ['claude-sonnet-5-5', 'probation', true],
    ['claude-haiku-5-5', 'probation', true],
    ['claude-sonnet-5', 'deny', false],
    ['claude-opus-5', 'off', false],
    ['claude-opus-5-5[1m]', 'allow', true],
    ['claude-opus-5-5-20261001', 'allow', true],
  ] as const)('%s is %s (active %s)', (model, status, active) => {
    expect(gate(model)).toMatchObject({ status, active });
  });

  it('lets `unknownModels` decide a model the map does not name', () => {
    expect(gate('claude-new-9', EMPTY_PERSISTED, resolveSettings({ unknownModels: 'allow' }).settings)).toMatchObject({ status: 'allow', active: true });
    expect(gate('claude-new-9', EMPTY_PERSISTED, resolveSettings({ unknownModels: 'probation' }).settings)).toMatchObject({ status: 'probation', active: true });
    expect(gate('claude-new-9', EMPTY_PERSISTED, resolveSettings({ unknownModels: 'deny' }).settings)).toMatchObject({ status: 'deny', active: false });
  });

  // R9: the unsafe mark persists across sessions.
  it('stops a model the cache canary marked unsafe, until the mark is cleared', () => {
    const marked = markUnsafe(EMPTY_PERSISTED, 'claude-opus-5-5-20261001', mark);
    expect(gate('claude-opus-5-5', marked)).toMatchObject({ status: 'unsafe', active: false });
    expect(gate('claude-fable-5-1', marked)).toMatchObject({ status: 'allow', active: true });
    expect(gate('claude-opus-5-5', clearUnsafe(marked, 'claude-opus-5-5'))).toMatchObject({ status: 'allow', active: true });
    expect(gate('claude-opus-5-5', clearUnsafe(marked, undefined))).toMatchObject({ status: 'allow', active: true });
  });

  // One model's context windows can carry effort differently on the wire, so a mark holds for the window it was found on.
  it('keeps a mark to the context window it was made on', () => {
    const wide = markUnsafe(EMPTY_PERSISTED, 'claude-opus-5-5[1m]', mark);
    expect(Object.keys(wide.unsafe)).toEqual(['claude-opus-5-5[1m]']);
    expect(gate('claude-opus-5-5[1m]', wide)).toMatchObject({ status: 'unsafe', active: false });
    expect(gate('claude-opus-5-5-20261001[1m]', wide)).toMatchObject({ status: 'unsafe', active: false });
    expect(gate('claude-opus-5-5', wide)).toMatchObject({ status: 'allow', active: true });
    const plain = markUnsafe(EMPTY_PERSISTED, 'claude-opus-5-5', mark);
    expect(gate('claude-opus-5-5', plain)).toMatchObject({ status: 'unsafe', active: false });
    expect(gate('claude-opus-5-5[1m]', plain)).toMatchObject({ status: 'allow', active: true });
  });

  it('clears one window by its own name, and every window of a model by the bare name', () => {
    const both = markUnsafe(markUnsafe(markUnsafe(EMPTY_PERSISTED, 'claude-opus-5-5', mark), 'claude-opus-5-5[1m]', mark), 'claude-fable-5-1[1m]', mark);
    expect(marksOf(both, 'claude-opus-5-5[1m]')).toEqual(['claude-opus-5-5[1m]']);
    expect(marksOf(both, 'claude-opus-5-5')).toEqual(['claude-opus-5-5', 'claude-opus-5-5[1m]']);
    expect(marksOf(both, 'claude-sonnet-5-5')).toEqual([]);
    expect(Object.keys(clearUnsafe(both, 'claude-opus-5-5[1m]').unsafe)).toEqual(['claude-opus-5-5', 'claude-fable-5-1[1m]']);
    expect(Object.keys(clearUnsafe(both, 'claude-opus-5-5').unsafe)).toEqual(['claude-fable-5-1[1m]']);
    expect(clearUnsafe(both, undefined).unsafe).toEqual({});
  });
});

describe('cleanSwitch', () => {
  it('graduates a probation model after `probationSwitches` clean switches', () => {
    let persisted = EMPTY_PERSISTED;
    for (let n = 1; n < 5; n++) {
      const step = cleanSwitch(persisted, 'claude-sonnet-5-5', 5);
      expect(step.graduated).toBe(false);
      expect(step.persisted.probation['claude-sonnet-5-5']).toBe(n);
      persisted = step.persisted;
    }
    const last = cleanSwitch(persisted, 'claude-sonnet-5-5', 5);
    expect(last.graduated).toBe(true);
    expect(gate('claude-sonnet-5-5', last.persisted)).toMatchObject({ status: 'allow', active: true });
    expect(gate('claude-haiku-5-5', last.persisted)).toMatchObject({ status: 'probation' });
  });
});

describe('readPersisted', () => {
  it('reads a stored value and survives garbage', () => {
    const stored = markUnsafe(cleanSwitch(EMPTY_PERSISTED, 'claude-haiku-5-5', 5).persisted, 'claude-opus-5-5', mark);
    expect(readPersisted(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    for (const junk of [undefined, null, 7, 'x', [], { unsafe: 3, probation: 'x', graduated: 9 }]) expect(readPersisted(junk)).toEqual(EMPTY_PERSISTED);
  });

  it('keeps an unsafe mark whatever its fields hold, its ratio unknown when it is no number', () => {
    const stored = readPersisted({ unsafe: { 'claude-opus-5-5': { at: 'x', ratio: 'low', from: 'high', to: 'medium' }, 'claude-fable-5-1': true } });
    expect(stored.unsafe).toEqual({
      'claude-opus-5-5': { at: 'x', ratio: null, prevPrompt: 0, cacheRead: 0, from: 'high', to: 'medium' },
      'claude-fable-5-1': { at: '', ratio: null, prevPrompt: 0, cacheRead: 0, from: '', to: '' },
    });
    expect(gate('claude-opus-5-5', stored)).toMatchObject({ status: 'unsafe', active: false });
    expect(gate('claude-fable-5-1', stored)).toMatchObject({ status: 'unsafe', active: false });
  });

  it('names each stored entry it cannot read, and keeps the readable ones', () => {
    const unreadable: string[] = [];
    expect(readPersisted({ probation: { 'claude-haiku-5-5': 2, 'claude-sonnet-5-5': 'three', b: -1 }, graduated: ['claude-haiku-5-5', 7] }, unreadable)).toEqual({ unsafe: {}, probation: { 'claude-haiku-5-5': 2 }, graduated: ['claude-haiku-5-5'] });
    expect(unreadable).toEqual(['probation.claude-sonnet-5-5', 'probation.b', 'graduated[1]']);
    const whole: string[] = [];
    readPersisted({ unsafe: 3, probation: 'x', graduated: 9 }, whole);
    expect(whole).toEqual(['unsafe', 'probation', 'graduated']);
  });
});

// R9 across sessions: a save keeps what another session stored for the models this one did not change.
describe('mergeModels', () => {
  it("lays this session's entries for the models it changed over the stored ones, and keeps the rest", () => {
    const stored = markUnsafe({ unsafe: {}, probation: { 'claude-haiku-5-5': 3, 'claude-sonnet-5-5': 1 }, graduated: ['claude-new-9'] }, 'claude-fable-5-1', mark);
    const mine = markUnsafe({ unsafe: {}, probation: { 'claude-sonnet-5-5': 2 }, graduated: [] }, 'claude-opus-5-5', mark);
    expect(mergeModels(stored, mine, ['claude-opus-5-5', 'claude-sonnet-5-5'])).toEqual({
      unsafe: { 'claude-fable-5-1': mark, 'claude-opus-5-5': mark },
      probation: { 'claude-haiku-5-5': 3, 'claude-sonnet-5-5': 2 },
      graduated: ['claude-new-9'],
    });
    expect(mergeModels(stored, mine, [])).toEqual(stored);
  });

  it('carries a graduation and a cleared mark, absence included, for the models named', () => {
    const stored = markUnsafe({ unsafe: {}, probation: { 'claude-haiku-5-5': 4 }, graduated: [] }, 'claude-opus-5-5', mark);
    const mine = { unsafe: {}, probation: {}, graduated: ['claude-haiku-5-5'] };
    expect(mergeModels(stored, mine, ['claude-haiku-5-5', 'claude-opus-5-5'])).toEqual({ unsafe: {}, probation: {}, graduated: ['claude-haiku-5-5'] });
    expect(mergeModels(stored, mine, ['claude-haiku-5-5'])).toEqual({ unsafe: { 'claude-opus-5-5': mark }, probation: {}, graduated: ['claude-haiku-5-5'] });
  });

  it('lays a mark over its own context window only, and a probation count over the model whatever the window', () => {
    const other = { ...mark, at: '2026-10-12T08:00:00Z' };
    const stored = markUnsafe({ unsafe: {}, probation: { 'claude-sonnet-5-5': 1 }, graduated: [] }, 'claude-sonnet-5-5', other);
    const mine = markUnsafe({ unsafe: {}, probation: { 'claude-sonnet-5-5': 2 }, graduated: [] }, 'claude-sonnet-5-5[1m]', mark);
    expect(mergeModels(stored, mine, ['claude-sonnet-5-5[1m]'])).toEqual({
      unsafe: { 'claude-sonnet-5-5': other, 'claude-sonnet-5-5[1m]': mark },
      probation: { 'claude-sonnet-5-5': 2 },
      graduated: [],
    });
  });
});

describe('normalizeModel', () => {
  it('drops a context-window suffix and a date stamp', () => {
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(normalizeModel('claude-sonnet-5-5-20261001')).toBe('claude-sonnet-5-5');
    expect(normalizeModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(compiled.models['claude-sonnet-5']).toBe('deny');
  });
});

describe('modelVariant', () => {
  it.each([
    ['claude-opus-5-5[1m]', 'claude-opus-5-5[1m]'],
    ['claude-opus-5-5-20261001[1m]', 'claude-opus-5-5[1m]'],
    ['claude-sonnet-5-5-20261001', 'claude-sonnet-5-5'],
    [' claude-sonnet-5 ', 'claude-sonnet-5'],
  ])('%j is %j: the date stamp dropped, the context window kept', (model, variant) => {
    expect(modelVariant(model)).toBe(variant);
  });
});
