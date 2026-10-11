import type { ConfigRow, EngineInterface, Register } from 'claude-code';
import type { Usage } from '../src/canary.ts';
import { parseCommand, statusText, USAGE } from '../src/command.ts';
import { Controller, type Row, type StepPlan } from '../src/controller.ts';
import { EMPTY_PERSISTED, readPersisted } from '../src/gate.ts';
import { levelsWithin } from '../src/levels.ts';
import { appendRows, expandHome, sessionLogPath } from '../src/log.ts';
import { PLUGIN, resolveSettings, SETTING_KEYS } from '../src/settings.ts';
import { toolDescription } from '../src/text.ts';
import { VERSION } from '../src/version.ts';

// Thin adapter: every decision lives in src/controller.ts. A failure is logged with its context and the request,
// the prompt or the tool result goes through as it was.

const TOOL_NAME = 'set_effort';
const STORE_KEY = 'state';
/** The newest rows one session's log file keeps; a read over 4 MiB is refused, so the file stays well below it. */
const LOG_ROWS = 8000;
const ROW_KEY = new RegExp(`^${PLUGIN}(?:@[^.]*)?\\.(\\w+)$`);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type State = {
  ctl: Controller;
  /** The options the plugin registered with: what applies where /config has no row. */
  options: Record<string, unknown>;
  errors: string[];
  /** The option errors last reported, so a new prompt does not report them again. */
  errorKey: string;
  settingsFrom: string;
  starting: Promise<void> | undefined;
  /** The floor and ceiling the tool is registered for. */
  toolKey: string | undefined;
  sessionId: string | undefined;
  pending: string[];
  writing: Promise<void>;
};

function note($: EngineInterface, what: string, error: unknown, then: string): void {
  $.ui.log(`auto-effort: ${what} failed: ${message(error)}; ${then}`);
}

function toUsage(raw: unknown): Usage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.input_tokens !== 'number') return null;
  const count = (key: string): number => (typeof u[key] === 'number' ? u[key] : 0);
  return {
    input_tokens: u.input_tokens,
    output_tokens: count('output_tokens'),
    cache_read_input_tokens: count('cache_read_input_tokens'),
    cache_creation_input_tokens: count('cache_creation_input_tokens'),
  };
}

// The decision log: rows are queued and written one batch at a time, never on the request's path.
async function flush($: EngineInterface, st: State): Promise<void> {
  const lines = st.pending.splice(0);
  if (lines.length === 0) return;
  try {
    const file = st.ctl.settings.logFile;
    if (file === '') return;
    st.sessionId ??= await $.session.id();
    const home = await $.env.get('HOME');
    const path = sessionLogPath(expandHome(file, home), st.sessionId);
    const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    await $.fs.write(path, appendRows(existing, lines, LOG_ROWS));
  } catch (error) {
    note($, 'writing the decision log', error, `${lines.length} rows were not kept`);
  }
}

function record($: EngineInterface, st: State, rows: readonly Row[]): void {
  if (rows.length === 0 || st.ctl.settings.logFile === '') return;
  const ts = new Date().toISOString();
  st.pending.push(...rows.map((row) => JSON.stringify({ ts, ...row })));
  st.writing = st.writing.then(() => flush($, st));
}

function present($: EngineInterface, status: string | undefined, toast?: string): void {
  try {
    $.ui.status(status);
  } catch (error) {
    note($, 'showing the status line', error, 'the request goes on');
  }
  if (toast === undefined) return;
  try {
    $.ui.toast(toast);
  } catch (error) {
    note($, 'showing a notice', error, `the notice was: ${toast}`);
  }
}

function reportErrors($: EngineInterface, st: State, errors: string[]): void {
  st.errors = errors;
  const key = errors.join('\n');
  if (key === st.errorKey) return;
  st.errorKey = key;
  for (const line of errors) $.ui.log(line);
  record($, st, errors.map((line) => ({ event: 'option-error', message: line })));
}

// The tool is registered for the levels the clamp lets through, so a changed floor or ceiling registers it again.
async function ensureTool($: EngineInterface, st: State): Promise<void> {
  const { floor, ceiling } = st.ctl.settings;
  const key = `${floor}|${ceiling}`;
  if (key === st.toolKey) return;
  const levels = levelsWithin(floor, ceiling);
  const { tool } = await $.tool.register({
    name: TOOL_NAME,
    description: toolDescription(floor, ceiling),
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: levels, description: 'The reasoning effort to hold from the next request until the turn ends.' },
        effort: { type: 'string', enum: levels, description: 'The same as level.' },
        reason: { type: 'string', description: 'A few words on why this level fits the work ahead.' },
      },
    },
    isDeferred: false,
  });
  st.ctl.toolName = tool;
  st.toolKey = key;
}

async function start($: EngineInterface, st: State): Promise<void> {
  try {
    st.ctl.loadPersisted(readPersisted(await $.store.get(STORE_KEY)));
  } catch (error) {
    note($, 'reading the saved model marks', error, 'starting with none');
    st.ctl.loadPersisted(EMPTY_PERSISTED);
  }
  reportErrors($, st, st.errors);
  try {
    await ensureTool($, st);
  } catch (error) {
    note($, 'registering the set_effort tool', error, 'the turn reminder and the planning level still apply; the next prompt tries again');
  }
  try {
    await $.command.register({ name: PLUGIN, description: 'Show or change automatic reasoning effort: status, on, off, set <key> <value>, clear [model]' });
  } catch (error) {
    note($, `registering the /${PLUGIN} command`, error, 'automatic effort works without it');
  }
}

function ensureStarted($: EngineInterface, st: State): Promise<void> {
  st.starting ??= start($, st);
  return st.starting;
}

// The options as /config holds them now, over the options the plugin registered with.
async function refresh($: EngineInterface, st: State): Promise<void> {
  try {
    const rows: readonly ConfigRow[] = await $.config.list();
    const fromRows: Record<string, unknown> = {};
    for (const row of rows) {
      const field = ROW_KEY.exec(row.key)?.[1];
      if (field !== undefined && (SETTING_KEYS as readonly string[]).includes(field)) fromRows[field] = row.value;
    }
    st.settingsFrom = Object.keys(fromRows).length > 0 ? '/config' : 'plugin options';
    const { settings, errors } = resolveSettings({ ...st.options, ...fromRows });
    reportErrors($, st, errors);
    st.ctl.applySettings(settings);
    st.ctl.loadPersisted(readPersisted(await $.store.get(STORE_KEY)));
    await ensureTool($, st);
  } catch (error) {
    note($, 'reading the plugin options', error, 'the settings of the last prompt stay');
  }
}

async function saveMarks($: EngineInterface, st: State): Promise<void> {
  try {
    await $.store.set(STORE_KEY, st.ctl.persisted);
  } catch (error) {
    note($, 'saving the model marks', error, 'they hold for this session only');
  }
}

async function finishStep($: EngineInterface, st: State, raw: unknown): Promise<void> {
  try {
    const end = st.ctl.endStep(toUsage(raw));
    record($, st, end.rows);
    if (end.toast !== undefined) present($, st.ctl.statusNow(), end.toast);
    if (end.persisted !== undefined) await saveMarks($, st);
  } catch (error) {
    st.ctl.failStep();
    note($, 'judging the request', error, 'the next request is not compared with it');
  }
}

function answerSetEffort($: EngineInterface, st: State, e: Record<string, unknown>): { result: string } {
  try {
    const answer = st.ctl.setEffort({ input: { level: e.level, effort: e.effort, reason: e.reason }, agent: e.agentId !== undefined });
    record($, st, answer.rows);
    return { result: answer.text };
  } catch (error) {
    note($, 'applying set_effort', error, 'the effort stays as it was');
    return { result: 'Not applied: the effort stays as it was.' };
  }
}

async function runCommand($: EngineInterface, st: State, args: string): Promise<string> {
  const command = parseCommand(args);
  switch (command.kind) {
    case 'bad':
      return command.message;
    case 'on':
    case 'off':
      st.ctl.setEnabled(command.kind === 'on');
      present($, st.ctl.statusNow());
      return `auto-effort is ${command.kind} for this session.`;
    case 'clear': {
      const had = Object.keys(st.ctl.persisted.unsafe);
      st.ctl.loadPersisted(readPersisted(await $.store.get(STORE_KEY)));
      st.ctl.clear(command.model);
      await saveMarks($, st);
      const text = command.model === undefined ? 'every model' : command.model;
      return had.length === 0 && Object.keys(st.ctl.persisted.unsafe).length === 0 ? 'Nothing to clear: no model has a cache mark.' : `Cache mark cleared for ${text}; automatic effort applies to it again.`;
    }
    case 'set': {
      const next = resolveSettings({ ...st.ctl.settings, [command.key]: command.value });
      if (next.errors.length > 0) return `Not changed: ${next.errors.map((line) => line.replace(/; using the defaults?\b.*$/, '')).join('\n')}`;
      const typed = next.settings[command.key];
      const rows = await $.config.list();
      const key = rows.find((row) => ROW_KEY.exec(row.key)?.[1] === command.key)?.key ?? `${PLUGIN}.${command.key}`;
      const saved = await $.config.set({ key, value: typed });
      if ('deny' in saved && saved.deny !== undefined) return `Not changed: the settings refused "${command.key}": ${saved.deny}`;
      st.options[command.key] = typed;
      st.ctl.applySettings(next.settings);
      await ensureTool($, st);
      present($, st.ctl.statusNow());
      return `${command.key} is now ${JSON.stringify(typed)}.`;
    }
    case 'status': {
      await refresh($, st);
      return statusText({ view: st.ctl.view(), settings: st.ctl.settings, errors: st.errors, version: VERSION, settingsFrom: st.settingsFrom });
    }
  }
}

export const register: Register = (on, options) => {
  const { settings, errors } = resolveSettings(options);
  const st: State = {
    ctl: new Controller(settings, EMPTY_PERSISTED, () => Date.now()),
    options: { ...options },
    errors,
    errorKey: '',
    settingsFrom: 'plugin options',
    starting: undefined,
    toolKey: undefined,
    sessionId: undefined,
    pending: [],
    writing: Promise.resolve(),
  };

  on('session.start', async ($, e, next) => {
    await ensureStarted($, st);
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    let context = e.context;
    try {
      await ensureStarted($, st);
      await refresh($, st);
      const out = st.ctl.onPrompt({ text: e.text, model: await $.session.model(), midTurn: e.turnId !== undefined });
      record($, st, out.rows);
      if (out.reminder !== undefined) context = [...(e.context ?? []), out.reminder];
    } catch (error) {
      note($, 'planning the turn', error, 'the prompt goes through unchanged');
    }
    return next(context === e.context ? e : { ...e, context });
  });

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e);
    let request = e;
    let plan: StepPlan | undefined;
    try {
      await ensureStarted($, st);
      plan = st.ctl.beginStep({ turnId: e.turnId, index: e.index, model: e.model, effort: e.effort, messageCount: e.messageCount });
    } catch (error) {
      st.ctl.failStep();
      note($, `choosing the effort of request ${e.index}`, error, `it goes at ${String(e.effort)}`);
    }
    if (plan !== undefined) {
      record($, st, plan.rows);
      present($, plan.status, plan.toast);
      if (plan.send !== undefined) request = { ...e, effort: plan.send };
    }
    let result;
    try {
      result = yield* next(request);
    } catch (error) {
      if (plan !== undefined) st.ctl.failStep();
      throw error;
    }
    if (plan !== undefined) await finishStep($, st, result.usage);
    return result;
  });

  on('tool.call', async ($, e, next) => {
    const name = st.ctl.toolName;
    if (name !== undefined && e.tool === name) return answerSetEffort($, st, e as Record<string, unknown>);
    const result = await next(e);
    if (e.agentId !== undefined || result.deny !== undefined) return result;
    try {
      const text = result.text ?? (typeof result.result === 'string' ? result.result : '');
      const seen = st.ctl.onToolResult({ tool: e.tool, text });
      record($, st, seen.rows);
      if (seen.context !== undefined) return { ...result, context: [...(result.context ?? []), seen.context] };
    } catch (error) {
      note($, `reading the ${e.tool} result`, error, 'the result goes through unchanged');
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    try {
      record($, st, st.ctl.completeTurn({ turnId: e.turnId, durationMs: e.durationMs, usage: toUsage(e.usage) ?? undefined }));
    } catch (error) {
      note($, 'recording the turn', error, 'the turn ended as it would have');
    }
    return result;
  });

  // A compaction rewrites the prompt, so the switch right after it is not judged by the cache canary.
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && e.trigger !== 'precompute' && typeof (result as { skip?: unknown }).skip !== 'string') st.ctl.noteCompaction();
    return result;
  });

  on('command.run', { command: PLUGIN }, async ($, e) => {
    try {
      await ensureStarted($, st);
      return { text: await runCommand($, st, e.args) };
    } catch (error) {
      note($, `/${PLUGIN} ${e.args}`, error, 'nothing was changed');
      return { text: `/${PLUGIN} failed: ${message(error)}\n${USAGE}` };
    }
  });
};
