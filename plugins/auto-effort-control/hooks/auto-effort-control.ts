import { projectOptions, resolveOptions, type Scope, type ReadValue } from '../src/options.ts';
import type { ConfigRow, EngineInterface, Register, ModelCompleteRequest, ModelCompleteResult, On, PluginOptions } from 'claude-code';
import type { Usage } from '../src/canary.ts';
import { parseCommand, statusText, USAGE } from '../src/command.ts';
import { Controller, readSessionState, type Row, type StepPlan } from '../src/controller.ts';
import { EMPTY_PERSISTED, mergeModels, readPersisted } from '../src/gate.ts';
import { levelsWithin } from '../src/levels.ts';
import { expandHome, fillSegments, SEGMENT_ROWS, sessionLogPath } from '../src/log.ts';
import { normalizeModel } from '../src/model.ts';
import { envName, PLUGIN, resolveSettings, SETTING_KEYS, type EnvValues } from '../src/settings.ts';
import { KEEPER_ARGV, stateText, type EffortState } from '../src/state.ts';
import { quote, toolDescription } from '../src/text.ts';
import { diagnosticOnScreen, levelRow, pluginLogDir, PluginLogQueue, type PluginLogLevel } from '../src/plugin-log.ts';
import { VERSION } from '../src/version.ts';

// Thin adapter: every decision lives in src/controller.ts. A failure is logged with its context and the request,
// the prompt or the tool result goes through as it was.

const TOOL_NAME = 'set_effort';
const STORE_KEY = 'state';
/** `<plugin>.<field>`, or `<plugin>@<marketplace>.<field>` where the marketplace name may hold dots. */
const ROW_KEY = new RegExp(`^${PLUGIN}(?:@.+)?\\.(\\w+)$`);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type State = {
  ctl: Controller;
  /** The options the plugin registered with: what applies where /config has no row. */
  options: Record<string, unknown>;
  errors: string[];
  /** The option variables as the last successful read held them: what a failed read falls back to. */
  env: EnvValues;
  mergedOptions: Record<string, unknown>;
  migrationErrors: string[];
  /** The option errors last reported, so a new prompt does not report them again. */
  errorKey: string;
  settingsFrom: string;
  starting: Promise<void> | undefined;
  /** The floor and ceiling the tool is registered for. */
  toolKey: string | undefined;
  /** The session the rows go to; a new id at a prompt (after /clear) starts a new session. */
  sessionId: string | undefined;
  /** The on/off and pin the host holds for the session, as text: a save is skipped when nothing changed. */
  savedSession: string;
  /** The session whose saved on/off and pin were read; another id at a prompt reads its own. */
  restored: string | undefined;
  /** The on/off and pin, as text, whose save failed and was reported: a retry that fails again says nothing. */
  saveFailed: string;
  /** Rows waiting for the log, each with the session it was recorded in. */
  pending: Array<{ session: string | undefined; line: string }>;
  /** Models whose marks changed in this session and are not saved yet. */
  unsaved: Set<string>;
  /** Each session log's newest file and its text, so a flush rewrites at most SEGMENT_ROWS rows and reads nothing. */
  segments: Map<string, { segment: number; text: string }>;
  writing: Promise<void>;
  pluginLog?: PluginLogQueue;
  pluginWriting: Promise<void>;
  pluginFailure: boolean;
  /** The mode, level and reason last seen, so the reason shows as a notice only when one of them changes. */
  shown: string;
  /** The state file's path, state and keeper last written, so an unchanged line is not written again. */
  stateWritten: string;
  /** The path whose line names a live keeper, and the state it holds: retired (keeper 0) when the plugin leaves it. */
  statePath: string;
  stateLast: EffortState | undefined;
  /** The pid of the keeper vouching for the state file's line; 0 while none runs. */
  keeper: number;
  keeperStarting: Promise<void> | undefined;
  /** A keeper start failed and was said: the next failure says nothing until one starts. */
  keeperFailed: boolean;
  /** This keeper's end was said: a later end says nothing until another keeper starts. */
  keeperEnded: boolean;
  /** The session whose line was retired at its end: no publish vouches for it again until a hook follows a session. */
  stateRetired: string | undefined;
  /** Lines whose retire failed, by path, with the state each holds: tried again at every write; a failure said once per path. */
  stateUnretired: Map<string, { last: EffortState; said: boolean }>;
  /** The path and state whose write failed last, so a failure is said once per failing path and state; '' after a success. */
  stateFailed: string;
  stateWriting: Promise<void>;
};

function pluginFallback($: EngineInterface, notice: string): void {
  $.ui.log(`auto-effort-control: ${notice}`);
}

function runPluginLog($: EngineInterface, argv: string[]) {
  return $.process.run(argv, { timeoutMs: 5000 });
}

function plog($: EngineInterface, st: State, level: PluginLogLevel, event: string, msg: string, where: string, detail?: Record<string, unknown>): void {
  const session = st.sessionId;
  const shown = diagnosticOnScreen(level, true);
  if (shown) {
    try { $.ui.log(msg); }
    catch (screenError) { // A broken screen must not prevent the log write or the request.
      void screenError;
    }
  }
  st.pluginWriting = st.pluginWriting.then(async () => {
    let logged = false;
    try {
      if (st.pluginLog === undefined) {
        const env = await $.env.get('PLUGIN_LOG_DIR');
        const home = await $.env.get('HOME');
        st.pluginLog = new PluginLogQueue(pluginLogDir(env, home, PLUGIN), PLUGIN, (notice) => pluginFallback($, notice));
      }
      const row = levelRow({ plugin: PLUGIN, level, event, msg, where, session, detail }, await $.clock.now());
      st.pluginLog.add(row);
      const result = await st.pluginLog.flush((argv) => runPluginLog($, argv));
      logged = result.dropped === 0;
      st.pluginFailure = false;
    } catch (error) {
      if (!st.pluginFailure) {
        st.pluginFailure = true;
        try { pluginFallback($, `plugin log initialization failed: ${message(error)}; 1 rows dropped`); }
        catch (screenError) { // With both outputs gone, contain the failure so the request still goes through.
          void screenError;
        }
      }
    }
    if (!shown && diagnosticOnScreen(level, logged)) {
      try { $.ui.log(msg); }
      catch (screenError) { // Both outputs are gone; the request must still go through.
        void screenError;
      }
    }
  });
}

function note($: EngineInterface, st: State, level: PluginLogLevel, event: string, where: string, what: string, error: unknown, then: string): void {
  const text = `auto-effort-control: ${what} failed: ${message(error)}; ${then}`;
  plog($, st, level, event, text, where, { error: message(error) });
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

// The session log's newest file, found once per session: the highest segment that exists, with its rows.
async function newestSegment($: EngineInterface, st: State, logFile: string, id: string): Promise<{ segment: number; text: string }> {
  const key = sessionLogPath(logFile, id);
  const known = st.segments.get(key);
  if (known !== undefined) return known;
  let segment = 1;
  while (await $.fs.exists(sessionLogPath(logFile, id, segment + 1))) segment += 1;
  const file = sessionLogPath(logFile, id, segment);
  const found = { segment, text: (await $.fs.exists(file)) ? await $.fs.read(file) : '' };
  st.segments.set(key, found);
  return found;
}

// The decision log: rows are queued and written one batch at a time, never on the request's path.
async function flush($: EngineInterface, st: State): Promise<void> {
  const batch = st.pending.splice(0);
  if (batch.length === 0) return;
  const bySession = new Map<string | undefined, string[]>();
  for (const { session, line } of batch) bySession.set(session, [...(bySession.get(session) ?? []), line]);
  for (const [session, lines] of bySession) {
    let left = lines.length;
    try {
      const file = st.ctl.settings.logFile;
      if (file === '') return;
      const id = session ?? (st.sessionId ??= await $.session.id());
      const home = await $.env.get('HOME');
      const logFile = expandHome(file, home);
      const newest = await newestSegment($, st, logFile, id);
      const opened = newest.segment;
      let skipped = 0;
      for (const part of fillSegments(newest.text, newest.segment, lines, SEGMENT_ROWS)) {
        let segment = part.segment + skipped;
        // A new file the probe did not reach (past a missing one) is never written over: the next free number is taken.
        while (segment > opened && (await $.fs.exists(sessionLogPath(logFile, id, segment)))) {
          segment += 1;
          skipped += 1;
        }
        await $.fs.write(sessionLogPath(logFile, id, segment), part.text);
        left -= part.added;
        newest.segment = segment;
        newest.text = part.text;
      }
    } catch (error) {
      note($, st, 'error', 'decision-log-write-failed', 'hooks/auto-effort-control.ts#flush', 'writing the decision log', error, `${left} rows were not kept`);
    }
  }
}

function record($: EngineInterface, st: State, rows: readonly Row[]): void {
  if (rows.length === 0 || st.ctl.settings.logFile === '') return;
  const ts = new Date().toISOString();
  st.pending.push(...rows.map((row) => ({ session: st.sessionId, line: JSON.stringify({ ts, ...row }) })));
  st.writing = st.writing.then(() => flush($, st));
}

function notice($: EngineInterface, st: State, text: string): void {
  try {
    $.ui.toast(text);
  } catch (error) {
    note($, st, 'warning', 'toast-failed', 'hooks/auto-effort-control.ts#notice', 'showing a notice', error, `the notice was: ${text}`);
  }
}

// The keeper vouches for the state file's line while this module is loaded: the host kills it when the module unloads
// (a disable, a reload, the session's process ending), and it exits within two seconds of the process that started it.
// It prints its own pid first, on stdout; one that cannot start, prints no pid within two seconds or ends leaves keeper 0,
// written to the line it vouched for at once, so the line reads stale. It never rejects.
function ensureKeeper($: EngineInterface, st: State): Promise<void> {
  if (st.keeper !== 0) return Promise.resolve();
  st.keeperStarting ??= startKeeper($, st).finally(() => {
    st.keeperStarting = undefined;
  });
  return st.keeperStarting;
}

async function startKeeper($: EngineInterface, st: State): Promise<void> {
  try {
    const stream = $.process.spawn({ argv: KEEPER_ARGV });
    // The pid is the first stdout line, which may come in pieces; what the shell writes to stderr is no pid.
    const deadline = $.clock.sleep(2000).then(() => undefined);
    let out = '';
    let err = '';
    let why = '';
    while (!out.includes('\n')) {
      const piece = await Promise.race([stream.next(), deadline]);
      if (piece === undefined) why = 'it printed no pid within 2 s';
      else if (piece.done) why = `it exited at once (code ${String(piece.value.code)})`;
      else if (piece.value.stream === 'stdout') out += piece.value.text;
      else err += piece.value.text;
      if (why !== '') break;
    }
    const line = out.split('\n')[0]!.trim();
    if (why === '' && (!/^\d+$/.test(line) || Number(line) <= 0)) why = `its first output ${JSON.stringify(line)} is no pid`;
    if (why !== '') {
      void stream.return(undefined as never).catch(() => undefined);
      throw new Error(err === '' ? why : `${why}; it wrote to stderr: ${JSON.stringify(err.trim())}`);
    }
    st.keeper = Number(line);
    st.keeperFailed = false;
    st.keeperEnded = false;
    void (async () => {
      let why = 'it exited';
      let stopped = false;
      try {
        for (;;) {
          const piece = await stream.next();
          if (piece.done) {
            why = `it exited (code ${String(piece.value.code)}, signal ${String(piece.value.signal ?? 'none')})`;
            stopped = piece.value.signal === 'SIGTERM';
            break;
          }
        }
      } catch (error) {
        why = message(error);
      }
      st.keeper = 0;
      try {
        publish($, st);
      } catch {
        // A module the host unloaded has no state left to write: the unload retired its line.
      }
      if (st.keeperEnded) return;
      st.keeperEnded = true;
      try {
        // SIGTERM is the host unloading the plugin (a session's end, a reload, a disable): the expected end, not a fault.
        if (stopped) plog($, st, 'info', 'state-keeper-stopped', 'auto-effort-control: the state file keeper was stopped by the host (SIGTERM); a status line shows the state stale until the next prompt starts another', 'hooks/auto-effort-control.ts#startKeeper');
        else note($, st, 'warning', 'state-keeper-ended', 'hooks/auto-effort-control.ts#startKeeper', 'keeping the state file keeper', new Error(`the state file keeper ended: ${why}`), 'a status line shows the state stale until the next prompt starts another');
      } catch {
        // A module the host unloaded has no screen left: its keeper ending is the unload itself.
      }
    })();
  } catch (error) {
    st.keeper = 0;
    if (st.keeperFailed) return;
    st.keeperFailed = true;
    try {
      note($, st, 'warning', 'state-keeper-failed', 'hooks/auto-effort-control.ts#startKeeper', 'starting the state file keeper', error, 'the state file names no keeper, so a status line shows it stale; the next prompt tries again');
    } catch (screenError) {
      plog($, st, 'warning', 'state-keeper-failed', `auto-effort-control: showing the state file keeper failure failed: ${message(screenError)}; the failure was: ${message(error)}`, 'hooks/auto-effort-control.ts#startKeeper');
    }
  }
}

// The line the plugin leaves: its last state, vouched by no keeper. A retire that fails is kept and tried again at every
// write until one lands, and said once per path.
async function retireState($: EngineInterface, st: State): Promise<void> {
  const path = st.statePath;
  const last = st.stateLast;
  st.statePath = '';
  st.stateLast = undefined;
  st.stateWritten = '';
  if (path === '' || last === undefined) return;
  const held = st.stateUnretired.get(path);
  st.stateUnretired.set(path, { last, said: held?.said ?? false });
  await retryRetires($, st, '');
}

async function retryRetires($: EngineInterface, st: State, keep: string): Promise<void> {
  for (const [path, held] of [...st.stateUnretired]) {
    if (path === keep) {
      // The line is written again with its keeper: nothing is left to retire there.
      st.stateUnretired.delete(path);
      continue;
    }
    try {
      await $.fs.write(path, stateText(held.last, 0, new Date(await $.clock.now())));
      st.stateUnretired.delete(path);
    } catch (error) {
      if (held.said) continue;
      held.said = true;
      try {
        note($, st, 'warning', 'state-file-retire-failed', 'hooks/auto-effort-control.ts#retireState', `retiring the state file ${path}`, error, 'a status line reading it trusts it until a later write retires it');
      } catch (screenError) {
        plog($, st, 'warning', 'state-file-retire-failed', `auto-effort-control: showing the state file retire failure failed: ${message(screenError)}; the failure was: ${message(error)}`, 'hooks/auto-effort-control.ts#retireState');
      }
    }
  }
}

// The state file a status line reads: rewritten whole when the path, the state or the keeper changes; the line at a
// path the plugin leaves (stateFile changed or emptied, a new session) is retired first. A failed write is tried again
// at every publish until one succeeds, and said once per failing path and state. It never rejects, so a failure cannot
// stop the writes queued after it.
async function writeState($: EngineInterface, st: State, state: EffortState): Promise<void> {
  const file = st.ctl.settings.stateFile;
  let key = `${file}\n${JSON.stringify(state)}`;
  try {
    let path = '';
    if (file !== '') {
      const id = st.sessionId ?? (st.sessionId = await $.session.id());
      path = sessionLogPath(expandHome(file, await $.env.get('HOME')), id);
    }
    if (st.statePath !== '' && st.statePath !== path) await retireState($, st);
    // A line retired at its session's end stays retired: a publish still running for that session writes nothing.
    if (path === '' || (st.stateRetired !== undefined && st.stateRetired === st.sessionId)) {
      await retryRetires($, st, '');
      return;
    }
    await retryRetires($, st, path);
    const keeper = st.keeper;
    key = `${path}\n${JSON.stringify(state)}\n${String(keeper)}`;
    if (key === st.stateWritten) return;
    await $.fs.write(path, stateText(state, keeper, new Date(await $.clock.now())));
    st.stateWritten = key;
    st.statePath = path;
    st.stateLast = state;
    st.stateFailed = '';
  } catch (error) {
    if (st.stateFailed === key) return;
    st.stateFailed = key;
    try {
      note($, st, 'warning', 'state-file-write-failed', 'hooks/auto-effort-control.ts#writeState', 'writing the state file', error, 'a status line reading it shows the state it held before');
    } catch (screenError) {
      plog($, st, 'warning', 'state-file-write-failed', `auto-effort-control: showing the state file failure failed: ${message(screenError)}; the failure was: ${message(error)}`, 'hooks/auto-effort-control.ts#writeState');
    }
  }
}

// The session's state, after anything that may change it: the reason as a notice when the mode, level or reason changed
// while the plugin steers, and the state file, never on the request's path.
function publish($: EngineInterface, st: State): void {
  const state = st.ctl.stateNow();
  const shown = `${state.mode}|${String(state.level)}|${state.reason}`;
  if (shown !== st.shown) {
    st.shown = shown;
    if (st.ctl.settings.statusLine && state.level !== null && (state.mode === 'auto' || state.mode === 'model')) notice($, st, state.reason);
  }
  st.stateWriting = st.stateWriting.then(() => writeState($, st, state));
}

function reportErrors($: EngineInterface, st: State, errors: string[]): void {
  st.errors = errors;
  const key = errors.join('\n');
  if (key === st.errorKey) return;
  for (const line of errors) {
    plog($, st, 'error', 'option-error', line, 'hooks/auto-effort-control.ts#reportErrors');
  }
  st.errorKey = key;
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
        level: { type: 'string', enum: [...levels, 'auto'], description: 'The reasoning effort from the next request on; it holds across turns until you call it with auto, which hands the effort back to the automatic rules.' },
        effort: { type: 'string', enum: [...levels, 'auto'], description: 'The same as level.' },
        reason: { type: 'string', description: 'A few words on why this level fits the work ahead.' },
      },
    },
    isDeferred: false,
  });
  st.ctl.toolName = tool;
  st.toolKey = key;
}

// The host keeps the on/off and the pin per session id, so a reload (an option change) builds a controller that carries on.
// Only a value read back counts as saved: after a failed or unusable read the next save writes what the session does.
async function restoreSession($: EngineInterface, st: State): Promise<void> {
  if (st.sessionId === undefined) return;
  st.restored = st.sessionId;
  st.savedSession = '';
  try {
    const { value } = await $.state.get({ plugin: 'auto-effort-control', key: 'session', id: st.sessionId });
    if (value !== undefined) {
      const saved = readSessionState(value);
      if (saved === undefined) {
        note($, st, 'error', 'saved-switch-unreadable', 'hooks/auto-effort-control.ts#restoreSession', 'reading the saved on/off, the pin and the set_effort level', new Error(`${quote(value)} is not in the expected form`), 'this session is on and unpinned, with no set_effort level');
      } else {
        st.ctl.restoreSession(saved);
        st.savedSession = JSON.stringify(st.ctl.sessionState());
      }
    }
  } catch (error) {
    note($, st, 'error', 'saved-switch-unreadable', 'hooks/auto-effort-control.ts#restoreSession', 'reading the saved on/off, the pin and the set_effort level', error, 'this session is on and unpinned, with no set_effort level');
  }
}

async function saveSession($: EngineInterface, st: State): Promise<void> {
  if (st.sessionId === undefined) return;
  const now = st.ctl.sessionState();
  const text = JSON.stringify(now);
  if (text === st.savedSession) return;
  let failure: unknown;
  try {
    const result = await $.state.set({ plugin: 'auto-effort-control', key: 'session', id: st.sessionId }, now);
    if (result.isSet) {
      st.savedSession = text;
      st.saveFailed = '';
      return;
    }
    failure = new Error('the host refused the write');
  } catch (error) {
    failure = error;
  }
  // The save is tried again at each request; it is said once for each state that cannot be saved.
  if (st.saveFailed === text) return;
  st.saveFailed = text;
  note($, st, 'error', 'saved-switch-unsaved', 'hooks/auto-effort-control.ts#saveSession', 'saving the on/off, the pin and the set_effort level', failure, 'they hold in this session, but a reload would lose them');
}

async function start($: EngineInterface, st: State): Promise<void> {
  try {
    st.sessionId ??= await $.session.id();
  } catch (error) {
    note($, st, 'error', 'session-id-unreadable', 'hooks/auto-effort-control.ts#start', 'reading the session id', error, 'the log file is named at the first row');
  }
  try {
    st.ctl.loadPersisted(readPersisted(await $.store.get(STORE_KEY)));
  } catch (error) {
    note($, st, 'error', 'saved-marks-unreadable', 'hooks/auto-effort-control.ts#start', 'reading the saved model marks', error, 'starting with none');
    st.ctl.loadPersisted(EMPTY_PERSISTED);
  }
  await restoreSession($, st);
  applyLayers($, st, st.options, await currentEnv($, st), 'plugin options');
  try {
    await ensureTool($, st);
  } catch (error) {
    note($, st, 'error', 'tool-register-failed', 'hooks/auto-effort-control.ts#start', 'registering the set_effort tool', error, 'the turn reminder and the planning level still apply; the next prompt tries again');
  }
  // The effort line moved to the state file: a line an older version pinned to the status area goes.
  try {
    $.ui.status(undefined);
  } catch (error) {
    note($, st, 'warning', 'status-failed', 'hooks/auto-effort-control.ts#start', 'clearing the status line', error, 'a line an older version pinned may stay');
  }
  await ensureKeeper($, st);
  publish($, st);
  try {
    await $.command.register({ name: PLUGIN, description: 'Show or change automatic reasoning effort: status, on, off, set <key> <value>, clear [model]' });
  } catch (error) {
    note($, st, 'error', 'command-register-failed', 'hooks/auto-effort-control.ts#start', `registering the /${PLUGIN} command`, error, 'automatic effort works without it');
  }
}

// A start that failed is dropped, so the next hook starts again.
function ensureStarted($: EngineInterface, st: State): Promise<void> {
  st.starting ??= start($, st).catch((error: unknown) => {
    st.starting = undefined;
    throw error;
  });
  return st.starting;
}

// After /clear the process goes on under a new session id, with no session.start: that session starts afresh.
// An id the start could not read is learnt here, and the session's saved state read with it. Called by every hook
// that reads or changes the session's on/off and pin, so a command typed after /clear acts for the new session.
async function followSession($: EngineInterface, st: State): Promise<void> {
  let id: string;
  try {
    id = await $.session.id();
  } catch (error) {
    note($, st, 'error', 'session-id-unreadable', 'hooks/auto-effort-control.ts#followSession', 'reading the session id', error, 'this stays with the session it had');
    return;
  }
  if (st.sessionId !== undefined && id !== st.sessionId) {
    st.ctl.resetSession();
    // The ended session's files are read again from disk should a late row of it arrive; only the current one is held.
    st.segments.clear();
  }
  st.sessionId = id;
  st.stateRetired = undefined;
  if (st.restored !== id) await restoreSession($, st);
}

// The marks as the store holds them, with this session's unsaved changes laid over them and saved:
// another chat's marks for other models survive the save, and a failed save is tried again at the next prompt.
async function syncMarks($: EngineInterface, st: State, changed: readonly string[]): Promise<void> {
  for (const model of changed) st.unsaved.add(normalizeModel(model));
  const merged = mergeModels(readPersisted(await $.store.get(STORE_KEY)), st.ctl.persisted, [...st.unsaved]);
  st.ctl.loadPersisted(merged);
  // Only the models this save carries are done: one marked while it was in flight stays for its own save.
  const saving = [...st.unsaved];
  if (saving.length === 0) return;
  await $.store.set(STORE_KEY, merged);
  for (const model of saving) st.unsaved.delete(model);
}

/** False when the marks could not be read or saved: they hold in this session and the next prompt tries again. */
async function saveMarks($: EngineInterface, st: State, changed: readonly string[]): Promise<boolean> {
  try {
    await syncMarks($, st, changed);
    return true;
  } catch (error) {
    note($, st, 'error', 'marks-failed', 'hooks/auto-effort-control.ts#saveMarks', 'reading or saving the model marks', error, 'they hold in this session, and the next prompt tries again');
    return false;
  }
}

// The environment variables of the options, each spelled as a string literal (Claude Code reads the names off the source)
// and all asked in one round.
async function currentEnv($: EngineInterface, st: State, options = st.options, rows: readonly { key: string; value: unknown; explicit?: boolean }[] = []): Promise<EnvValues> {
  const merged = await readMergedOptions($, 'main', options, rows, st.env);
  st.mergedOptions = merged.options;
  st.migrationErrors = merged.errors;
  st.env = merged.env as EnvValues;
  return st.env;
}

/** The option layer: the `/config` rows of this plugin, by option. */
function rowLayer(rows: readonly ConfigRow[]): Record<string, unknown> {
  const layer: Record<string, unknown> = {};
  for (const row of rows) {
    const field = ROW_KEY.exec(row.key)?.[1];
    if (field !== undefined && (SETTING_KEYS as readonly string[]).includes(field)) layer[field] = row.value;
  }
  return layer;
}

/** The settings of the layers, the variables over the options: applied, their errors reported, and where they came from kept for status. */
function applyLayers($: EngineInterface, st: State, options: Readonly<Record<string, unknown>>, env: EnvValues, base: string) {
  const resolved = resolveSettings(st.mergedOptions, env);
  st.settingsFrom = resolved.fromEnv.length === 0 ? base : `${base}; environment overrides: ${resolved.fromEnv.map(envName).join(', ')}`;
  reportErrors($, st, [...st.migrationErrors, ...resolved.errors]);
  st.ctl.applySettings(resolved.settings);
  return resolved;
}

// The options as /config holds them now, over the options the plugin registered with, under their variables.
async function refresh($: EngineInterface, st: State): Promise<void> {
  try {
    const rows: readonly ConfigRow[] = await $.config.list();
    const fromRows = rowLayer(rows);
    applyLayers($, st, { ...st.options, ...fromRows }, await currentEnv($, st, { ...st.options, ...fromRows }, rows), Object.keys(fromRows).length > 0 ? '/config' : 'plugin options');
    await saveMarks($, st, []);
    await ensureTool($, st);
  } catch (error) {
    note($, st, 'error', 'options-unreadable', 'hooks/auto-effort-control.ts#refresh', 'reading the plugin options', error, 'the settings of the last prompt stay');
  }
}

async function finishStep($: EngineInterface, st: State, raw: unknown): Promise<void> {
  try {
    const end = st.ctl.endStep(toUsage(raw));
    record($, st, end.rows);
    if (end.warning !== undefined) plog($, st, 'warning', end.warning.event, end.warning.msg, end.warning.where);
    publish($, st);
    if (end.model !== undefined) await saveMarks($, st, [end.model]);
  } catch (error) {
    st.ctl.failStep();
    note($, st, 'error', 'judge-failed', 'hooks/auto-effort-control.ts#finishStep', 'judging the request', error, 'the next request is not compared with it');
  }
}

// The main chat's level is the session's, like the on/off and the pin: saved, so a reload keeps it.
async function answerSetEffort($: EngineInterface, st: State, e: Record<string, unknown>): Promise<{ result: string }> {
  try {
    const answer = st.ctl.setEffort({ input: { level: e.level, effort: e.effort, reason: e.reason }, agent: e.agentId !== undefined });
    record($, st, answer.rows);
    publish($, st);
    await saveSession($, st);
    return { result: answer.text };
  } catch (error) {
    note($, st, 'error', 'set-effort-failed', 'hooks/auto-effort-control.ts#answerSetEffort', 'applying set_effort', error, 'the effort stays as it was');
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
      await saveSession($, st);
      publish($, st);
      return `auto-effort-control is ${command.kind} for this session.`;
    case 'clear': {
      const stored = readPersisted(await $.store.get(STORE_KEY));
      const mine = st.ctl.persisted;
      const named = command.model === undefined ? [...Object.keys(stored.unsafe), ...Object.keys(mine.unsafe)] : [normalizeModel(command.model)];
      if (!named.some((model) => stored.unsafe[model] !== undefined || mine.unsafe[model] !== undefined)) {
        return command.model === undefined ? 'Nothing to clear: no model has a cache mark.' : `Nothing to clear: ${command.model} has no cache mark.`;
      }
      st.ctl.clear(command.model);
      publish($, st);
      const saved = await saveMarks($, st, named);
      const cleared = `Cache mark cleared for ${command.model ?? 'every model'}; automatic effort applies to it again.`;
      return saved ? cleared : `${cleared} Saving it failed, so it holds in this session; the next prompt tries again.`;
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
      // What the next prompt would compute: the options with this one saved, under the variables.
      const fromRows = rowLayer(rows);
      const applied = applyLayers($, st, { ...st.options, ...fromRows, [command.key]: typed }, await currentEnv($, st, { ...st.options, ...fromRows, [command.key]: typed }, [...rows, { key, value: typed, explicit: true }]), Object.keys(fromRows).length > 0 ? '/config' : 'plugin options');
      await ensureTool($, st);
      publish($, st);
      const now = JSON.stringify(applied.settings[command.key]);
      if (applied.fromEnv.includes(command.key)) return `${command.key} is saved as ${JSON.stringify(typed)}, but ${envName(command.key)} is set and still applies: ${command.key} stays ${now}.`;
      if (now !== JSON.stringify(typed)) return `${command.key} is saved as ${JSON.stringify(typed)}, but ${now} is in effect: see the option errors in /auto-effort-control status.`;
      return `${command.key} is now ${JSON.stringify(typed)}.`;
    }
    case 'status': {
      await refresh($, st);
      return statusText({ view: st.ctl.view(), settings: st.ctl.settings, errors: st.errors, version: VERSION, settingsFrom: st.settingsFrom });
    }
  }
}


import { Definitions as SubDefinitions, type ControlConfig as SubControlConfig, type Definition as SubDefinition } from '../src/subagent/agents.ts';
import { Controller as SubController, type Action as SubAction } from '../src/subagent/control.ts';
import { describe as SubDescribe, denyText as SubDenyText, EMPTY_TEXT as SubEMPTY_TEXT, isStillRunning as SubIsStillRunning, parseTag as SubParseTag, stepEffort as SubStepEffort, stripTag as SubStripTag, type Effort as SubEffort, type Pin as SubPin } from '../src/subagent/effort.ts';
import { JUDGE_SYSTEM as SubJUDGE_SYSTEM, parseTripwires as SubParseTripwires, TRIPWIRES as SubTRIPWIRES } from '../src/subagent/judge.ts';
import { isLevel as SubIsLevel } from '../src/subagent/ladder.ts';
import { appendRows as SubAppendRows, sessionLogPath as SubSessionLogPath } from '../src/subagent/log.ts';
import { diagnosticVisible as SubDiagnosticVisible, levelRow as SubLevelRow, pluginLogDir as SubPluginLogDir, PluginLogQueue as SubPluginLogQueue, type Level as SubLevel } from '../src/subagent/plugin-log.ts';
import { compile as SubCompile, envName as SubEnvName, resolveSettings as SubResolveSettings, SETTING_KEYS as SubSETTING_KEYS, type Compiled as SubCompiled, type OptionEnv as SubOptionEnv, type Settings as SubSettings } from '../src/subagent/settings.ts';
import { isRead as SubIsRead, isTestRun as SubIsTestRun, testOutcome as SubTestOutcome } from '../src/subagent/signals.ts';
import { startOf as SubStartOf } from '../src/subagent/start.ts';
import { BUTTON_AUTO as SubBUTTON_AUTO, BUTTON_DOWN as SubBUTTON_DOWN, BUTTON_UP as SubBUTTON_UP, MAIN_REFUSED as SubMAIN_REFUSED, mainEffortToolOf as SubMainEffortToolOf, REFUSED as SubREFUSED, type Direction as SubDirection } from '../src/subagent/text.ts';

// Thin adapter: every decision lives in src/. A failure is logged with its context and
// the spawn, request or tool call goes through at the effort it already had.

/** The spawning tool's name, past and present. */
const SubAGENT_TOOLS = new Set(['Agent', 'Task']);

/** How long a request of a loop the plugin has not seen waits for spawns in flight. */
const SubSPAWN_WAIT_MS = 5000;

const SubLOG_CAP = 5000;
const SubJUDGE_MAX_TOKENS = 4000;

/** The main chat's id in the decision log: it is never steered here. */
const SubMAIN = 'main';
/** How long the main chat's button waits for the session's tool list before its refusal names /effort. */
const SubTOOL_LIST_WAIT_MS = 2000;

type SubFields = Record<string, unknown>;
/** What a button tool does: one step either way, or back to the automatic rules. */
type SubButton = SubDirection | 'auto';

function SubMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Pins live in host state, so a plugin reload keeps them; one value per agent id.
async function SubReadPin(rt: SubRuntime, $: EngineInterface, agentId: string): Promise<SubPin | undefined> {
  try {
    const { value } = await $.state.get({ plugin: 'auto-effort-control', key: 'pin', id: agentId });
    return value ?? undefined;
  } catch (error) {
    SubNotice(rt, $, 'error', 'pin-unreadable', `auto-effort-control: reading sub-agent ${agentId}'s pin failed: ${SubMessage(error)}; its request goes at the effort it carries`, 'readPin');
    throw error;
  }
}

async function SubWritePin($: EngineInterface, agentId: string, pin: SubPin): Promise<void> {
  await $.state.set({ plugin: 'auto-effort-control', key: 'pin', id: agentId }, pin);
}

type SubSpawns = {
  /** Spawns whose next() has not returned yet. */
  inFlight: number;
  /** Resolved and replaced each time a spawn settles. */
  settled: Promise<void>;
  wake: () => void;
  /** Loops that waited once and were never attributed to a spawn: never wait again. */
  strangers: Set<string>;
};

function SubNewSpawns(): SubSpawns {
  const spawns = { inFlight: 0, strangers: new Set<string>() } as SubSpawns;
  spawns.settled = new Promise((resolve) => (spawns.wake = resolve));
  return spawns;
}

function SubSettle(spawns: SubSpawns): void {
  spawns.inFlight -= 1;
  const wake = spawns.wake;
  spawns.settled = new Promise((resolve) => (spawns.wake = resolve));
  wake();
}

// A sub-agent's first request can start before agent.spawn returns its id. An
// unknown id waits until its own pin appears or no spawn is in flight, never past
// SPAWN_WAIT_MS, and at most once for its lifetime. The turn's abort ends the
// wait at once, and however the wait ends its timer is cancelled.
async function SubAwaitPin(rt: SubRuntime, $: EngineInterface, spawns: SubSpawns, agentId: string, signal: AbortSignal): Promise<SubPin | undefined> {
  let pin = await SubReadPin(rt, $, agentId);
  if (pin !== undefined || spawns.strangers.has(agentId)) return pin;
  const waiting = new AbortController();
  const stop = () => waiting.abort();
  signal.addEventListener('abort', stop);
  if (signal.aborted) stop();
  const deadline = $.clock.sleep(SubSPAWN_WAIT_MS, { signal: waiting.signal }).then(
    () => 'over' as const,
    (error: unknown) => {
      if (!waiting.signal.aborted) SubNotice(rt, $, 'error', 'spawn-wait-failed', `auto-effort-control: sub-agent ${agentId}'s wait for its spawn failed: ${SubMessage(error)}; it goes on without waiting`, 'awaitPin');
      return 'over' as const;
    },
  );
  try {
    while (pin === undefined && spawns.inFlight > 0) {
      if ((await Promise.race([spawns.settled.then(() => 'settled' as const), deadline])) === 'over') break;
      pin = await SubReadPin(rt, $, agentId);
    }
  } finally {
    signal.removeEventListener('abort', stop);
    waiting.abort();
  }
  if (pin === undefined) spawns.strangers.add(agentId);
  return pin;
}

/** A steered agent whose home waits for its first request. */
type SubAwaiting = { type: string; control: SubControlConfig; brief: string };

type SubRuntime = {
  /** The plugin options as the host gave them; the environment variables are layered over them once, by `settleOptions`. */
  rawOptions: Readonly<Record<string, unknown>>;
  optionsSettled?: Promise<void>;
  pluginSetup?: Promise<string | undefined>;
  pluginDir?: string;
  pluginSession?: Promise<string | undefined>;
  pluginQueue?: SubPluginLogQueue;
  pluginWriting: Promise<void>;
  pluginFlushing: Promise<void>;
  modelFallback?: string;
  modelUnavailable?: boolean;
  config: SubSettings;
  compiled: SubCompiled;
  optionErrors: string[];
  started?: Promise<void>;
  defs?: SubDefinitions;
  /** The decision log's path pattern with `~` expanded; empty: no log. */
  logFile: string;
  logPath?: Promise<string | undefined>;
  pending: string[];
  writing: Promise<void>;
  steered: Map<string, SubController>;
  awaiting: Map<string, SubAwaiting>;
  /** Each child agent's id → its steered parent's id. */
  childOf: Map<string, string>;
  /** The full tool names `$.tool.register` returned. */
  buttons: Map<string, SubButton>;
};

// The fallback must not log itself or turn a failed log write into failed work.
function SubLogFallback($: EngineInterface, line: string): void {
  try { $.ui.log(line); } catch { /* The screen door itself is unavailable; no other sink exists. */ }
}

function SubSetupPlugin(rt: SubRuntime, $: EngineInterface): Promise<string | undefined> {
  rt.pluginSetup ??= (async () => {
    let home: string | undefined;
    let configured: string | undefined;
    let homeError: { cause: unknown } | undefined;
    let dirError: { cause: unknown } | undefined;
    try { home = await $.env.get('HOME'); } catch (error) { homeError = { cause: error }; }
    try { configured = await $.env.get('PLUGIN_LOG_DIR'); } catch (error) { dirError = { cause: error }; }
    rt.pluginDir = SubPluginLogDir(configured, home, 'auto-effort-control');
    rt.pluginQueue = new SubPluginLogQueue(rt.pluginDir, 'auto-effort-control');
    if (homeError !== undefined) SubNotice(rt, $, 'error', 'home-missing', `auto-effort-control: reading HOME failed: ${SubMessage(homeError.cause)}; skipping ~/.claude/agents and ~ in logFile`, 'start');
    if (dirError !== undefined) SubNotice(rt, $, 'warning', 'plugin-log-dir-unreadable', `auto-effort-control: reading PLUGIN_LOG_DIR failed: ${SubMessage(dirError.cause)}; using the HOME fallback when available`, 'start');
    return home;
  })();
  return rt.pluginSetup;
}

async function SubFlushPlugin(rt: SubRuntime, $: EngineInterface): Promise<void> {
  const out = await rt.pluginQueue!.flush(async (argv, init) => {
    try { return await $.process.run(argv, init); }
    catch (error) { throw new Error(`$.process.run failed: ${SubMessage(error)}`); }
  });
  for (const line of out.fallback ?? []) SubLogFallback($, line);
  if (out.error !== undefined) {
    SubLogFallback($, `auto-effort-control: ${out.error}`);
    SubRecord(rt, $, 'main', 'plugin', { event: 'plugin-log-failed', error: out.error });
  }
}

// Only the metadata preparation is queued here; subprocesses have their own
// serial chain, so ordinary hooks never wait for the write.
function SubPlog(rt: SubRuntime, $: EngineInterface, level: SubLevel, event: string, msg: string, where: string, detail?: SubFields): void {
  rt.pluginWriting = rt.pluginWriting.then(async () => {
    await SubSetupPlugin(rt, $);
    rt.pluginSession ??= $.session.id().catch((error) => {
      SubNotice(rt, $, 'warning', 'session-id-unreadable', `auto-effort-control: reading the session id for plugin logs failed: ${SubMessage(error)}; rows omit the session`, 'plog');
      return undefined;
    });
    const session = await rt.pluginSession;
    const now = await $.clock.now();
    rt.pluginQueue!.add(SubLevelRow({ plugin: 'auto-effort-control', level, event, msg, where, session, detail }, now));
  }).catch((error) => {
    if (!SubDiagnosticVisible(level, true)) SubLogFallback($, msg);
    SubLogFallback($, `auto-effort-control: plugin log ${rt.pluginDir ?? 'off'}: preparing ${event} failed: ${SubMessage(error)}`);
  });
  rt.pluginFlushing = rt.pluginWriting.then(() => SubFlushPlugin(rt, $)).catch((error) => SubLogFallback($, `auto-effort-control: plugin log ${rt.pluginDir ?? 'off'}: flushing failed: ${SubMessage(error)}`));
  if (SubDiagnosticVisible(level, true)) $.ui.log(msg);
}

function SubNotice(rt: SubRuntime, $: EngineInterface, level: SubLevel, event: string, text: string, component: string): void {
  SubPlog(rt, $, level, event, text, `hooks/auto-effort-control.ts#${component}`);
}

// Rows queue in memory; each flush reads the session's file and appends them,
// so a resumed session keeps its earlier rows and no other chat shares the file.
function SubRecord(rt: SubRuntime, $: EngineInterface, agent: string, type: string, row: SubFields): void {
  const file = rt.logFile;
  if (!file) return;
  const { event, ...rest } = row;
  rt.pending.push(JSON.stringify({ ts: new Date().toISOString(), event, agent, type, ...rest }));
  rt.logPath ??= $.session.id().then(
    (id) => SubSessionLogPath(file, id),
    (error) => {
      SubNotice(rt, $, 'error', 'session-id-unreadable', `auto-effort-control: reading the session id failed: ${SubMessage(error)}; the decision log is off for this session`, 'record');
      return undefined;
    },
  );
  rt.writing = rt.writing
    .then(async () => {
      const path = await rt.logPath;
      const rows = rt.pending.splice(0);
      if (!path || rows.length === 0) return;
      const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      await $.fs.write(path, SubAppendRows(existing, rows, SubLOG_CAP));
    })
    .catch((error) => SubNotice(rt, $, 'error', 'decision-log-write-failed', `auto-effort-control: writing the decision log for ${file} failed: ${SubMessage(error)}`, 'record'));
}

// The option was validated when the settings resolved, so a list that fails here is a bug: arm all four rather than none.
function SubTripwiresOf(text: string) {
  const found = SubParseTripwires(text);
  return found.ok ? found.value : [...SubTRIPWIRES];
}

function SubSettleOptions(rt: SubRuntime, $: EngineInterface): Promise<void> {
  rt.optionsSettled ??= (async () => {
    const merged = await readMergedOptions($, 'subagent', rt.rawOptions);
    const { settings, errors } = SubResolveSettings(merged.options, merged.env as SubOptionEnv);
    rt.config = settings;
    rt.compiled = SubCompile(settings);
    rt.optionErrors = [...merged.errors, ...errors];
  })().catch((error) => SubNotice(rt, $, 'error', 'environment-unreadable', `auto-effort-control: reading configuration failed: ${SubMessage(error)}; using the plugin options`, 'settleOptions'));
  return rt.optionsSettled;
}

// First hook call: read where definitions live, report option errors, build the resolver.
function SubStart(rt: SubRuntime, $: EngineInterface): Promise<void> {
  rt.started ??= (async () => {
    await SubSettleOptions(rt, $);
    const home = await SubSetupPlugin(rt, $);
    let cwd = '.';
    let configDir: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch (error) {
      SubNotice(rt, $, 'error', 'cwd-unreadable', `auto-effort-control: reading the session cwd failed: ${SubMessage(error)}; using relative paths`, 'start');
    }
    try {
      configDir = await $.env.get('CLAUDE_CONFIG_DIR');
    } catch (error) {
      SubNotice(rt, $, 'error', 'config-dir-missing', `auto-effort-control: reading CLAUDE_CONFIG_DIR failed: ${SubMessage(error)}; skipping its agents directory`, 'start');
    }
    const file = rt.config.logFile;
    if (file.startsWith('~') && !home) SubNotice(rt, $, 'error', 'log-file-needs-home', `auto-effort-control: logFile ${file} needs HOME, which is unset; the decision log is off`, 'start');
    else rt.logFile = file.startsWith('~') ? `${home}${file.slice(1)}` : file;
    for (const line of rt.optionErrors) {
      SubNotice(rt, $, 'error', 'option-error', line, 'start');
      SubRecord(rt, $, 'main', 'option-error', { event: 'option-error', line });
    }
    const dirs = [`${cwd}/.claude/agents`, ...(configDir ? [`${configDir}/agents`] : []), ...(home ? [`${home}/.claude/agents`] : []), ...rt.config.agentDirs];
    rt.defs = new SubDefinitions(
      dirs,
      { floor: rt.config.floor, ceiling: rt.config.ceiling, judge: rt.config.judge, tripwires: SubTripwiresOf(rt.config.tripwires), parentTag: rt.config.parentTag, struggleDecay: rt.config.struggleDecay },
      {
        exists: (path) => $.fs.exists(path),
        read: (path) => $.fs.read(path),
        listMarkdown: async (dir) => (await $.fs.list(dir)).filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md')).map((entry) => entry.name),
      },
      (line) => SubNotice(rt, $, 'error', 'definition-unreadable', line, 'definitionOf'),
    );
  })().catch((error) => SubNotice(rt, $, 'error', 'start-failed', `auto-effort-control: starting failed: ${SubMessage(error)}; sub-agents run unsteered at the effort they carry`, 'start'));
  return rt.started;
}

const SubNO_DEFINITION = (rt: SubRuntime): SubDefinition => ({ path: undefined, effort: undefined, control: undefined, parentTag: rt.config.parentTag, errors: [] });

async function SubDefinitionOf(rt: SubRuntime, $: EngineInterface, type: string | undefined): Promise<SubDefinition> {
  if (!type || !rt.defs) return SubNO_DEFINITION(rt);
  try {
    return await rt.defs.resolve(type);
  } catch (error) {
    SubNotice(rt, $, 'error', 'definition-unreadable', `auto-effort-control: reading the definition of ${type} failed: ${SubMessage(error)}; treating it as having none`, 'definitionOf');
    return SubNO_DEFINITION(rt);
  }
}

// The steered controller of an agent id; the main chat (no id) is never steered here.
function SubControllerOf(rt: SubRuntime, agentId: string | undefined): SubController | undefined {
  return agentId === undefined ? undefined : rt.steered.get(agentId);
}

function SubNewController(rt: SubRuntime, id: string, type: string, control: SubControlConfig, home: SubEffort, brief: string): SubController {
  const controller = new SubController({
    id,
    type,
    home,
    floor: control.floor,
    ceiling: control.ceiling,
    judge: control.judge,
    judgeRaiseAt: rt.config.judgeRaiseAt,
    tripwires: new Set(control.tripwires),
    landing: control.landing,
    models: rt.config.models,
    words: { red: rt.config.redWords, green: rt.config.greenWords },
    announce: rt.config.announce,
    struggleDecay: control.struggleDecay,
    brief,
  });
  rt.steered.set(id, controller);
  return controller;
}

// Carries out what a controller decided: log rows, and judge calls started detached.
function SubPerform(rt: SubRuntime, $: EngineInterface, controller: SubController, actions: readonly SubAction[]): void {
  for (const action of actions) {
    if (action.kind === 'log') {
      const { event, ...rest } = action.row;
      if (event === 'judge-failed' && rest.reason !== 'model-unavailable') SubPlog(rt, $, 'error', 'judge-failed', `auto-effort-control: judge failed for ${controller.id}: ${String(rest.reason)}; effort ${String(rest.from)} -> ${String(rest.to)}`, 'src/subagent/control.ts#failed', { agent: controller.id, error: String(rest.reason) });
      if (rest.from !== undefined && rest.to !== undefined && rest.from !== rest.to) SubPlog(rt, $, 'info', 'effort-steered', `auto-effort-control: ${controller.id}'s effort changed from ${String(rest.from)} to ${String(rest.to)}`, 'hooks/auto-effort-control.ts#perform', { agent: controller.id, from: rest.from, to: rest.to });
      SubRecord(rt, $, controller.id, controller.type, { event, ...rest, ...(rt.config.logPackets ? action.detail : {}) });
    } else {
      SubRunJudge(rt, $, controller, action);
    }
  }
}

function SubOauthDenied(reply: ModelCompleteResult): boolean {
  return !reply.isAnswered && reply.reason === 'api-error' && reply.status === 403 && reply.error === 'oauth_org_not_allowed';
}

// Only the default model may switch: explicit model choices remain authoritative.
async function SubCompleteModel(rt: SubRuntime, $: EngineInterface, request: ModelCompleteRequest): Promise<ModelCompleteResult | undefined> {
  if (request.model !== 'haiku') return $.model.complete(request);
  if (rt.modelUnavailable) return undefined;
  const sentModel = rt.modelFallback ?? request.model;
  let reply = await $.model.complete({ ...request, model: sentModel });
  if (SubOauthDenied(reply) && sentModel === request.model) {
    const current = rt.modelFallback ?? await $.session.model();
    if (rt.modelFallback === undefined) {
      rt.modelFallback = current;
      SubPlog(rt, $, 'warning', 'model-fallback', `auto-effort-control: default haiku refused (api-error 403 oauth_org_not_allowed); using current main model ${current} for the default judge`, 'hooks/auto-effort-control.ts#completeModel', { model: current });
    }
    if (rt.modelFallback !== request.model) reply = await $.model.complete({ ...request, model: rt.modelFallback });
  }
  if (SubOauthDenied(reply)) {
    if (!rt.modelUnavailable) {
      rt.modelUnavailable = true;
      SubNotice(rt, $, 'error', 'model-unavailable', 'auto-effort-control: model judgment unavailable for this session (api-error 403 oauth_org_not_allowed); judges use deterministic failure handling', 'completeModel');
    }
    return undefined;
  }
  return reply;
}

// One judge call, never awaited by a hook: no request waits for it. Whatever it
// comes back with is read by the controller, which raises one step when it gives no level.
function SubRunJudge(rt: SubRuntime, $: EngineInterface, controller: SubController, action: Extract<SubAction, { kind: 'judge' }>): void {
  const started = Date.now();
  SubCompleteModel(rt, $, { model: rt.config.judgeModel, effort: rt.config.judgeEffort, system: SubJUDGE_SYSTEM, prompt: action.packet, maxTokens: SubJUDGE_MAX_TOKENS, timeoutMs: rt.config.judgeTimeoutMs })
    .then(
      (reply) => {
        if (rt.steered.get(controller.id) !== controller) return;
        const ms = Date.now() - started;
        const out = reply === undefined
          ? controller.onJudgeFailure(action.epoch, 'model-unavailable')
          : reply.isAnswered
            ? controller.onJudgeAnswer(action.epoch, reply.text, ms, reply.usage)
            : controller.onJudgeFailure(action.epoch, reply.reason === 'api-error' ? `api-error ${reply.status ?? 'no status'} ${reply.error}` : reply.reason, reply.usage);
        SubPerform(rt, $, controller, out.actions);
      },
      (error: unknown) => {
        if (rt.steered.get(controller.id) !== controller) return;
        SubPerform(rt, $, controller, controller.onJudgeFailure(action.epoch, `threw: ${SubMessage(error)}`).actions);
      },
    )
    .catch((error: unknown) => SubNotice(rt, $, 'error', 'judge-threw', `auto-effort-control: reading the judge's answer for ${controller.id} failed: ${SubMessage(error)}; its effort stays where it is`, 'runJudge'));
}

// What a spawn starts at: the tag against the definition's own effort, by `parentTag`.
// A steered agent's home waits for its first request when neither names a level.
function SubStartOfSpawn(definition: SubDefinition, tagged: SubEffort | undefined) {
  return SubStartOf({ tagged, own: definition.effort, parentTag: definition.parentTag, range: definition.control });
}

// A spawn returned an id: log what the tag did, tell a steered parent, and start steering the child.
function SubAfterSpawn(rt: SubRuntime, $: EngineInterface, agentId: string, type: string, parentId: string | undefined, name: string | undefined, definition: SubDefinition, tagged: SubEffort | undefined, brief: string): void {
  try {
    const opening = SubStartOfSpawn(definition, tagged);
    if (opening.row) SubRecord(rt, $, agentId, type, opening.row);
    const parent = SubControllerOf(rt, parentId);
    if (parent) {
      rt.childOf.set(agentId, parent.id);
      SubPerform(rt, $, parent, parent.onSpawn({ childId: agentId, type, name }).actions);
    }
    if (definition.control) {
      if (opening.level !== undefined) SubNewController(rt, agentId, type, definition.control, opening.level, brief);
      else rt.awaiting.set(agentId, { type, control: definition.control, brief });
    }
  } catch (error) {
    SubNotice(rt, $, 'error', 'steer-subagent-failed', `auto-effort-control: steering sub-agent ${agentId} failed: ${SubMessage(error)}; it runs unsteered at its pin`, 'afterSpawn');
  }
}

// The first request of an agent whose home is its effort: steer it when that is a level.
function SubAdoptFirst(rt: SubRuntime, $: EngineInterface, agentId: string, requested: unknown): SubController | undefined {
  const waiting = rt.awaiting.get(agentId);
  if (!waiting) return undefined;
  rt.awaiting.delete(agentId);
  if (!SubIsLevel(requested)) {
    SubRecord(rt, $, agentId, waiting.type, { event: 'not-steered', requested: requested ?? null });
    SubNotice(rt, $, 'error', 'not-a-level', `auto-effort-control: sub-agent ${agentId} (${waiting.type}) starts at ${String(requested)}, not a level; it is not steered`, 'adoptFirst');
    return undefined;
  }
  return SubNewController(rt, agentId, waiting.type, waiting.control, requested, waiting.brief);
}

// What a steered agent's own tool call tells the controller.
function SubObserve(rt: SubRuntime, $: EngineInterface, controller: SubController, e: SubFields & { tool: string }, result: { text?: string; isError?: boolean }): void {
  const text = result.text ?? '';
  if (e.tool === 'SendMessage') {
    SubPerform(rt, $, controller, controller.onSendMessage(String(e.to)).actions);
    return;
  }
  const command = SubIsTestRun(e.tool, e, rt.compiled.testCommand, rt.compiled.readOnly);
  if (command !== undefined) {
    const failed = SubTestOutcome(result.isError, text, rt.compiled.failure) === 'fail';
    SubPerform(rt, $, controller, controller.onTestRun({ command, failed, text }).actions);
    return;
  }
  if (SubIsRead(e.tool, e, rt.compiled.readOnly)) SubPerform(rt, $, controller, controller.onRead(text).actions);
}

// The session's own tool that sets the main chat's effort, by its listed name (mainEffortToolOf); undefined when none
// is listed, or when the list fails or does not answer within TOOL_LIST_WAIT_MS, so a button call is never held. The
// call's abort ends the wait at once, with no timeout logged, and however the wait ends its timer is cancelled.
async function SubMainEffortTool(rt: SubRuntime, $: EngineInterface, signal: AbortSignal): Promise<string | undefined> {
  const waiting = new AbortController();
  const stop = () => waiting.abort();
  signal.addEventListener('abort', stop);
  if (signal.aborted) stop();
  try {
    const deadline = $.clock.sleep(SubTOOL_LIST_WAIT_MS, { signal: waiting.signal }).then(
      () => 'over' as const,
      (error: unknown) => {
        if (!waiting.signal.aborted) SubNotice(rt, $, 'warning', 'tool-list-wait-failed', `auto-effort-control: the wait for the session's tool list failed: ${SubMessage(error)}; the main chat's refusal names /effort`, 'mainEffortTool');
        return 'failed' as const;
      },
    );
    const listed = await Promise.race([$.tool.list(), deadline]);
    if (listed === 'failed') return undefined;
    if (listed === 'over') {
      SubNotice(rt, $, 'warning', 'tool-list-timeout', `auto-effort-control: the session's tool list did not answer within ${SubTOOL_LIST_WAIT_MS} ms; the main chat's refusal names /effort`, 'mainEffortTool');
      return undefined;
    }
    return SubMainEffortToolOf(listed.map((tool) => tool.name));
  } catch (error) {
    SubNotice(rt, $, 'warning', 'tool-list-failed', `auto-effort-control: listing the session's tools failed: ${SubMessage(error)}; the main chat's refusal names /effort`, 'mainEffortTool');
    return undefined;
  } finally {
    signal.removeEventListener('abort', stop);
    waiting.abort();
  }
}

async function SubAnswerButton(rt: SubRuntime, $: EngineInterface, agentId: string | undefined, button: SubButton, signal: AbortSignal): Promise<{ result: string }> {
  const controller = SubControllerOf(rt, agentId);
  if (!controller) {
    SubRecord(rt, $, agentId ?? SubMAIN, 'unsteered', { event: 'button-refused', direction: button });
    return { result: agentId === undefined ? SubMAIN_REFUSED(await SubMainEffortTool(rt, $, signal)) : SubREFUSED };
  }
  const out = button === 'auto' ? controller.onAuto() : controller.onButton(button);
  SubPerform(rt, $, controller, out.actions);
  return { result: out.text };
}

async function SubRegisterButtons(rt: SubRuntime, $: EngineInterface): Promise<void> {
  await SubSettleOptions(rt, $);
  if (!rt.config.buttons) return;
  const specs: Array<{ name: string; description: string; button: SubButton }> = [
    { name: 'effort_up', description: SubBUTTON_UP, button: 'up' },
    { name: 'effort_down', description: SubBUTTON_DOWN, button: 'down' },
    { name: 'effort_auto', description: SubBUTTON_AUTO, button: 'auto' },
  ];
  for (const spec of specs) {
    try {
      const { tool } = await $.tool.register({ name: spec.name, description: spec.description, inputSchema: { type: 'object', properties: {} } });
      rt.buttons.set(tool, spec.button);
      SubRecord(rt, $, 'main', 'plugin', { event: 'tool-registered', tool });
    } catch (error) {
      SubNotice(rt, $, 'error', 'tool-register-failed', `auto-effort-control: registering the ${spec.name} tool failed: ${SubMessage(error)}; agents have no ${spec.name} button`, 'registerButtons');
      SubRecord(rt, $, 'main', 'plugin', { event: 'tool-register-failed', tool: spec.name, error: SubMessage(error) });
    }
  }
}

// A finished agent: its end row, and a child's final answer to its steered parent.
function SubFinish(rt: SubRuntime, $: EngineInterface, agentId: string, answer: string): void {
  try {
    const parentId = rt.childOf.get(agentId);
    const parent = parentId === undefined ? undefined : rt.steered.get(parentId);
    if (parent) SubPerform(rt, $, parent, parent.onChildReturn(agentId, answer).actions);
    const own = rt.steered.get(agentId);
    if (own) {
      SubRecord(rt, $, own.id, own.type, own.end());
      rt.steered.delete(agentId);
      for (const [child, owner] of rt.childOf) if (owner === agentId) rt.childOf.delete(child);
    }
    rt.awaiting.delete(agentId);
  } catch (error) {
    SubNotice(rt, $, 'error', 'close-steering-failed', `auto-effort-control: closing sub-agent ${agentId}'s steering failed: ${SubMessage(error)}; its pin is cleared as usual`, 'finish');
  }
}



// Literal reads are the engine's static capability declarations; the resolver itself is pure.
async function readMergedOptions($: EngineInterface, scope: Scope, registered: Readonly<Record<string, unknown>>, rows: readonly { key: string; value: unknown; explicit?: boolean }[] = [], previousEnv: Readonly<Record<string, string | undefined>> = {}) {
  let snapshot: ReadValue;
  try { snapshot = { ok: true, value: await $.settings.read() }; }
  catch (error) { snapshot = { ok: false, error: message(error) }; }
  const asked = {
    'AUTO_EFFORT_CONTROL_FLOOR': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_FLOOR')),
    'AUTO_EFFORT_CONTROL_CEILING': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_CEILING')),
    'AUTO_EFFORT_CONTROL_PLAN_LEVEL': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_PLAN_LEVEL')),
    'AUTO_EFFORT_CONTROL_PLAN_UPSHIFT_PATTERNS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_PLAN_UPSHIFT_PATTERNS')),
    'AUTO_EFFORT_CONTROL_PLAN_UPSHIFT_CHARS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_PLAN_UPSHIFT_CHARS')),
    'AUTO_EFFORT_CONTROL_TURN_REMINDER': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_TURN_REMINDER')),
    'AUTO_EFFORT_CONTROL_ESCALATE_AFTER_FAILURES': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_ESCALATE_AFTER_FAILURES')),
    'AUTO_EFFORT_CONTROL_LOWER_ON_PASS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_LOWER_ON_PASS')),
    'AUTO_EFFORT_CONTROL_FAILURE_PATTERNS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_FAILURE_PATTERNS')),
    'AUTO_EFFORT_CONTROL_FAILURE_TOOLS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_FAILURE_TOOLS')),
    'AUTO_EFFORT_CONTROL_TEST_COMMAND_PATTERNS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_TEST_COMMAND_PATTERNS')),
    'AUTO_EFFORT_CONTROL_USER_EFFORT_PINS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_USER_EFFORT_PINS')),
    'AUTO_EFFORT_CONTROL_MODELS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_MODELS')),
    'AUTO_EFFORT_CONTROL_UNKNOWN_MODELS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_UNKNOWN_MODELS')),
    'AUTO_EFFORT_CONTROL_PROBATION_SWITCHES': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_PROBATION_SWITCHES')),
    'AUTO_EFFORT_CONTROL_CANARY_THRESHOLD': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_CANARY_THRESHOLD')),
    'AUTO_EFFORT_CONTROL_CACHE_TTL_SECONDS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_CACHE_TTL_SECONDS')),
    'AUTO_EFFORT_CONTROL_STATUS_LINE': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_STATUS_LINE')),
    'AUTO_EFFORT_CONTROL_LOG_FILE': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_LOG_FILE')),
    'AUTO_EFFORT_CONTROL_STATE_FILE': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_STATE_FILE')),
    'AUTO_EFFORT_CONTROL_PARENT_TAG': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_PARENT_TAG')),
    'AUTO_EFFORT_CONTROL_JUDGE': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_JUDGE')),
    'AUTO_EFFORT_CONTROL_JUDGE_RAISE_AT': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_JUDGE_RAISE_AT')),
    'AUTO_EFFORT_CONTROL_TRIPWIRES': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_TRIPWIRES')),
    'AUTO_EFFORT_CONTROL_STRUGGLE_DECAY': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_STRUGGLE_DECAY')),
    'AUTO_EFFORT_CONTROL_JUDGE_MODEL': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_JUDGE_MODEL')),
    'AUTO_EFFORT_CONTROL_JUDGE_EFFORT': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_JUDGE_EFFORT')),
    'AUTO_EFFORT_CONTROL_JUDGE_TIMEOUT_MS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_JUDGE_TIMEOUT_MS')),
    'AUTO_EFFORT_CONTROL_BUTTONS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_BUTTONS')),
    'AUTO_EFFORT_CONTROL_ANNOUNCE': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_ANNOUNCE')),
    'AUTO_EFFORT_CONTROL_READ_ONLY_COMMANDS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_READ_ONLY_COMMANDS')),
    'AUTO_EFFORT_CONTROL_RED_WORDS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_RED_WORDS')),
    'AUTO_EFFORT_CONTROL_GREEN_WORDS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_GREEN_WORDS')),
    'AUTO_EFFORT_CONTROL_AGENT_DIRS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_AGENT_DIRS')),
    'AUTO_EFFORT_CONTROL_LOG_PACKETS': attemptEnv($.env.get('AUTO_EFFORT_CONTROL_LOG_PACKETS')),
    'AUTO_EFFORT_FLOOR': attemptEnv($.env.get('AUTO_EFFORT_FLOOR')),
    'AUTO_EFFORT_CEILING': attemptEnv($.env.get('AUTO_EFFORT_CEILING')),
    'AUTO_EFFORT_PLAN_LEVEL': attemptEnv($.env.get('AUTO_EFFORT_PLAN_LEVEL')),
    'AUTO_EFFORT_PLAN_UPSHIFT_PATTERNS': attemptEnv($.env.get('AUTO_EFFORT_PLAN_UPSHIFT_PATTERNS')),
    'AUTO_EFFORT_PLAN_UPSHIFT_CHARS': attemptEnv($.env.get('AUTO_EFFORT_PLAN_UPSHIFT_CHARS')),
    'AUTO_EFFORT_TURN_REMINDER': attemptEnv($.env.get('AUTO_EFFORT_TURN_REMINDER')),
    'AUTO_EFFORT_ESCALATE_AFTER_FAILURES': attemptEnv($.env.get('AUTO_EFFORT_ESCALATE_AFTER_FAILURES')),
    'AUTO_EFFORT_FAILURE_PATTERNS': attemptEnv($.env.get('AUTO_EFFORT_FAILURE_PATTERNS')),
    'AUTO_EFFORT_FAILURE_TOOLS': attemptEnv($.env.get('AUTO_EFFORT_FAILURE_TOOLS')),
    'AUTO_EFFORT_USER_EFFORT_PINS': attemptEnv($.env.get('AUTO_EFFORT_USER_EFFORT_PINS')),
    'AUTO_EFFORT_MODELS': attemptEnv($.env.get('AUTO_EFFORT_MODELS')),
    'AUTO_EFFORT_UNKNOWN_MODELS': attemptEnv($.env.get('AUTO_EFFORT_UNKNOWN_MODELS')),
    'AUTO_EFFORT_PROBATION_SWITCHES': attemptEnv($.env.get('AUTO_EFFORT_PROBATION_SWITCHES')),
    'AUTO_EFFORT_CANARY_THRESHOLD': attemptEnv($.env.get('AUTO_EFFORT_CANARY_THRESHOLD')),
    'AUTO_EFFORT_CACHE_TTL_SECONDS': attemptEnv($.env.get('AUTO_EFFORT_CACHE_TTL_SECONDS')),
    'AUTO_EFFORT_STATUS_LINE': attemptEnv($.env.get('AUTO_EFFORT_STATUS_LINE')),
    'AUTO_EFFORT_LOG_FILE': attemptEnv($.env.get('AUTO_EFFORT_LOG_FILE')),
    'AUTO_EFFORT_STATE_FILE': attemptEnv($.env.get('AUTO_EFFORT_STATE_FILE')),
    'AUTO_EFFORT_LOWER_ON_PASS': attemptEnv($.env.get('AUTO_EFFORT_LOWER_ON_PASS')),
    'AUTO_EFFORT_TEST_COMMAND_PATTERNS': attemptEnv($.env.get('AUTO_EFFORT_TEST_COMMAND_PATTERNS')),
    'EFFORT_LIVE_CONTROL_FLOOR': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_FLOOR')),
    'EFFORT_LIVE_CONTROL_CEILING': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_CEILING')),
    'EFFORT_LIVE_CONTROL_PARENT_TAG': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_PARENT_TAG')),
    'EFFORT_LIVE_CONTROL_MODELS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_MODELS')),
    'EFFORT_LIVE_CONTROL_JUDGE': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_JUDGE')),
    'EFFORT_LIVE_CONTROL_JUDGE_RAISE_AT': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_JUDGE_RAISE_AT')),
    'EFFORT_LIVE_CONTROL_TRIPWIRES': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_TRIPWIRES')),
    'EFFORT_LIVE_CONTROL_STRUGGLE_DECAY': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_STRUGGLE_DECAY')),
    'EFFORT_LIVE_CONTROL_JUDGE_MODEL': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_JUDGE_MODEL')),
    'EFFORT_LIVE_CONTROL_JUDGE_EFFORT': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_JUDGE_EFFORT')),
    'EFFORT_LIVE_CONTROL_JUDGE_TIMEOUT_MS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_JUDGE_TIMEOUT_MS')),
    'EFFORT_LIVE_CONTROL_BUTTONS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_BUTTONS')),
    'EFFORT_LIVE_CONTROL_ANNOUNCE': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_ANNOUNCE')),
    'EFFORT_LIVE_CONTROL_TEST_COMMAND_PATTERNS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_TEST_COMMAND_PATTERNS')),
    'EFFORT_LIVE_CONTROL_READ_ONLY_COMMANDS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_READ_ONLY_COMMANDS')),
    'EFFORT_LIVE_CONTROL_FAILURE_PATTERNS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_FAILURE_PATTERNS')),
    'EFFORT_LIVE_CONTROL_RED_WORDS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_RED_WORDS')),
    'EFFORT_LIVE_CONTROL_GREEN_WORDS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_GREEN_WORDS')),
    'EFFORT_LIVE_CONTROL_AGENT_DIRS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_AGENT_DIRS')),
    'EFFORT_LIVE_CONTROL_LOG_FILE': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_LOG_FILE')),
    'EFFORT_LIVE_CONTROL_LOG_PACKETS': attemptEnv($.env.get('EFFORT_LIVE_CONTROL_LOG_PACKETS')),
  };
  const values = await Promise.all(Object.values(asked));
  const reads = Object.fromEntries(Object.keys(asked).map((name, i) => [name, values[i]!])) as Record<string, ReadValue>;
  return resolveOptions(scope, registered, snapshot, reads, rows, previousEnv);
}
const attemptEnv = (read: Promise<string | undefined>): Promise<ReadValue> => read.then(value => ({ ok: true, value }), error => ({ ok: false, error: message(error) }));

export const register: Register = (on, options) => {
const initial = projectOptions(options, 'main');
const { settings, errors } = resolveSettings(initial.options);
const st: State = {
    ctl: new Controller(settings, EMPTY_PERSISTED, () => Date.now()),
    options: { ...options },
    errors,
    env: {},
    mergedOptions: {},
    migrationErrors: [],
    errorKey: '',
    settingsFrom: 'plugin options',
    starting: undefined,
    toolKey: undefined,
    sessionId: undefined,
    savedSession: '',
    restored: undefined,
    saveFailed: '',
    pending: [],
    unsaved: new Set(),
    segments: new Map(),
    writing: Promise.resolve(),
    pluginWriting: Promise.resolve(),
    pluginFailure: false,
    shown: '',
    stateWritten: '',
    statePath: '',
    stateLast: undefined,
    keeper: 0,
    keeperStarting: undefined,
    keeperFailed: false,
    keeperEnded: false,
    stateRetired: undefined,
    stateUnretired: new Map(),
    stateFailed: '',
    stateWriting: Promise.resolve(),
  };
const spawns = SubNewSpawns();
const rawOptions = options as Record<string, unknown>;
const { settings: subSettings, errors: subErrors } = SubResolveSettings(projectOptions(rawOptions, 'subagent').options);
const rt: SubRuntime = {
    rawOptions,
    pluginWriting: Promise.resolve(),
    pluginFlushing: Promise.resolve(),
    config: subSettings,
    compiled: SubCompile(subSettings),
    optionErrors: subErrors,
    logFile: '',
    pending: [],
    writing: Promise.resolve(),
    steered: new Map(),
    awaiting: new Map(),
    childOf: new Map(),
    buttons: new Map(),
  };
on('session.start', async ($, e, next) => {
    await ensureStarted($, st);

    const result = await next(e);
    await SubStart(rt, $);
    await SubRegisterButtons(rt, $);
    return result;

});
on('prompt.submit', async ($, e, next) => {
    let context = e.context;
    try {
      await ensureStarted($, st);
      await followSession($, st);
      await refresh($, st);
      const out = st.ctl.onPrompt({ text: e.text, model: await $.session.model(), midTurn: e.turnId !== undefined, wait: e.wait });
      record($, st, out.rows);
      publish($, st);
      // A keeper that ended is started again off the request's path; the line names it once it runs.
      if (st.keeper === 0) void ensureKeeper($, st).then(() => publish($, st));
      if (out.reminder !== undefined) context = [...(e.context ?? []), out.reminder];
    } catch (error) {
      note($, st, 'error', 'plan-failed', 'hooks/auto-effort-control.ts#prompt.submit', 'planning the turn', error, 'the prompt goes through unchanged');
    }
    return next(context === e.context ? e : { ...e, context });
  });
on('turn.step', async function* ($, e, next) {if (e.agentId !== undefined) {
    const agentId = e.agentId;
    // The main chat is never steered here: its request goes at the effort it carries.
    if (agentId === undefined) return yield* next(e);
    let send = e.effort;
    let controller: SubController | undefined;
    try {
      await SubStart(rt, $);
      const pin = await SubAwaitPin(rt, $, spawns, agentId, next.signal);
      controller = rt.steered.get(agentId) ?? SubAdoptFirst(rt, $, agentId, e.effort);
      if (controller) {
        const out = controller.onRequest(e.model, e.effort);
        SubPerform(rt, $, controller, out.actions);
        send = out.send ?? e.effort;
      } else {
        const step = SubStepEffort(pin, e.effort);
        send = step.send;
        if (step.pin !== undefined) await SubWritePin($, agentId, { level: step.pin });
      }
    } catch (error) {
      SubNotice(rt, $, 'error', 'resolve-effort-failed', `auto-effort-control: resolving sub-agent ${agentId}'s effort failed: ${SubMessage(error)}; this request goes at ${String(e.effort)}`, 'turn.step');
    }
    const result = yield* next(send === undefined || send === e.effort ? e : { ...e, effort: send });
    try {
      controller?.onAnswer(result.answer);
    } catch (error) {
      SubNotice(rt, $, 'error', 'subagent-reply-unreadable', `auto-effort-control: reading sub-agent ${agentId}'s reply failed: ${SubMessage(error)}; its last words are not kept`, 'turn.step');
    }
    return result;
   }

    if (e.agentId !== undefined) return yield* next(e);
    let request = e;
    let plan: StepPlan | undefined;
    try {
      await ensureStarted($, st);
      plan = st.ctl.beginStep({ turnId: e.turnId, index: e.index, model: e.model, effort: e.effort, messageCount: e.messageCount });
    } catch (error) {
      st.ctl.failStep();
      note($, st, 'error', 'choose-effort-failed', 'hooks/auto-effort-control.ts#turn.step', `choosing the effort of request ${e.index}`, error, `it goes at ${String(e.effort)}`);
    }
    if (plan !== undefined) {
      record($, st, plan.rows);
      // Never on the request's path: the save is the host's, and the request goes now.
      void saveSession($, st);
      if (plan.warning !== undefined) plog($, st, 'warning', plan.warning.event, plan.warning.msg, plan.warning.where);
      publish($, st);
      if (plan.send !== undefined) {
        request = { ...e, effort: plan.send };
        plog($, st, 'info', 'effort-applied', `effort applied: ${plan.send}`, 'hooks/auto-effort-control.ts#turn.step', { level: plan.send, source: plan.source });
      }
    }
    let result;
    try {
      result = yield* next(request);
    } catch (error) {
      if (plan !== undefined) st.ctl.failStep();
      plog($, st, 'error', 'hook-threw', `request failed: ${message(error)}`, 'hooks/auto-effort-control.ts#turn.step', { error: message(error) });
      throw error;
    }
    if (plan !== undefined) await finishStep($, st, result.usage);
    return result;

});
on('tool.call', async ($, e, next) => {const name = st.ctl.toolName;
    if (name !== undefined && e.tool === name) return answerSetEffort($, st, e as Record<string, unknown>);
if (e.agentId !== undefined || rt.buttons.has(e.tool)) {
    const button = rt.buttons.get(e.tool);
    if (button !== undefined) {
      try {
        return await SubAnswerButton(rt, $, e.agentId, button, next.signal);
      } catch (error) {
        SubNotice(rt, $, 'error', 'answer-tool-failed', `auto-effort-control: answering ${e.tool} failed: ${SubMessage(error)}; nothing changed`, 'answerButton');
        return { result: `Nothing changed: ${SubMessage(error)}` };
      }
    }
    const controller = SubControllerOf(rt, e.agentId);
    if (!controller) return next(e);
    const result = await next(e);
    if (result.deny !== undefined) return result;
    try {
      SubObserve(rt, $, controller, e as unknown as SubFields & { tool: string }, result);
      const line = controller.takeAnnouncement();
      if (line !== undefined) return { ...result, context: [...(result.context ?? []), line] };
    } catch (error) {
      SubNotice(rt, $, 'error', 'tool-result-unreadable', `auto-effort-control: reading ${e.agentId}'s ${e.tool} result failed: ${SubMessage(error)}; its effort stays where it is`, 'tool.call');
    }
    return result;
   }


    const result = await next(e);
    if (e.agentId !== undefined || result.deny !== undefined) return result;
    try {
      const text = result.text ?? (typeof result.result === 'string' ? result.result : '');
      // The tool's arguments ride beside `tool` (`e.command` for Bash); a call without a command is no test run.
      const command = typeof e.command === 'string' ? e.command : undefined;
      const seen = st.ctl.onToolResult({ tool: e.tool, command, text });
      record($, st, seen.rows);
      if (seen.context !== undefined) return { ...result, context: [...(result.context ?? []), seen.context] };
    } catch (error) {
      note($, st, 'error', 'tool-result-unreadable', 'hooks/auto-effort-control.ts#tool.call', `reading the ${e.tool} result`, error, 'the result goes through unchanged');
    }
    return result;

});
on('turn.complete', async ($, e, next) => {if (e.agentId !== undefined) {
    const result = await next(e);
    if (e.agentId === undefined) return result;
    try {
      const status = (await $.agent.list()).find((agent) => agent.id === e.agentId)?.status;
      if (SubIsStillRunning(status)) return result;
      SubFinish(rt, $, e.agentId, e.answer);
      if ((await SubReadPin(rt, $, e.agentId)) !== undefined) await SubWritePin($, e.agentId, { level: null });
    } catch (error) {
      SubNotice(rt, $, 'error', 'pin-clear-failed', `auto-effort-control: clearing sub-agent ${e.agentId}'s pin failed: ${SubMessage(error)}; its next run keeps the old pin`, 'turn.complete');
    }
    return result;
   }

    const result = await next(e);
    if (e.agentId !== undefined) return result;
    try {
      record($, st, st.ctl.completeTurn({ turnId: e.turnId, durationMs: e.durationMs, usage: toUsage(e.usage) ?? undefined }));
    } catch (error) {
      note($, st, 'error', 'turn-record-failed', 'hooks/auto-effort-control.ts#turn.complete', 'recording the turn', error, 'the turn ended as it would have');
    }
    return result;

});
on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && e.trigger !== 'precompute' && typeof (result as { skip?: unknown }).skip !== 'string') st.ctl.noteCompaction();
    return result;
  });
on('session.end', async ($, e, next) => {
    st.stateRetired = st.sessionId;
    st.stateWriting = st.stateWriting.then(() => retireState($, st));
    await st.stateWriting;
    await st.pluginWriting;

    await rt.pluginWriting;
    await rt.pluginFlushing;
    // The last flush may queue a decision row (a failed append's plugin-log-failed): it is on disk before the session ends.
    // A write failure's notice has queued its level row before a throwing screen rejected the chain; the session still ends.
    await rt.writing.catch((error) => SubLogFallback($, `auto-effort-control: finishing the decision log failed: ${SubMessage(error)}`));
    return next(e);

});
on('command.run', { command: PLUGIN }, async ($, e) => {
    try {
      await ensureStarted($, st);
      await followSession($, st);
      return { text: await runCommand($, st, e.args) };
    } catch (error) {
      note($, st, 'error', 'command-failed', 'hooks/auto-effort-control.ts#command.run', `/${PLUGIN} ${e.args}`, error, 'nothing was changed');
      return { text: `/${PLUGIN} failed: ${message(error)}\n${USAGE}` };
    }
  });
on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!SubAGENT_TOOLS.has(e.tool)) return result;
    await SubSettleOptions(rt, $);
    return { ...result, description: SubDescribe(result.description, rt.config.parentTag) };
  });
on('agent.spawn', async ($, e, next) => {
    const tag = SubParseTag(e.prompt);
    if (tag.kind === 'bad') return { deny: SubDenyText(tag.raw) };
    if (tag.kind === 'empty') return { deny: SubEMPTY_TEXT };
    await SubStart(rt, $);
    const definition = await SubDefinitionOf(rt, $, e.subagentType);
    const tagged = tag.kind === 'ok' ? tag.effort : undefined;
    const prompt = tag.kind === 'ok' ? SubStripTag(e.prompt) : e.prompt;
    spawns.inFlight += 1;
    try {
      const result = await next(tag.kind === 'ok' ? { ...e, prompt } : e);
      if (result.agentId !== undefined) {
        SubAfterSpawn(rt, $, result.agentId, e.subagentType ?? 'unknown', e.parentAgentId, e.name, definition, tagged, prompt);
        try {
          await SubWritePin($, result.agentId, { level: SubStartOfSpawn(definition, tagged).level ?? null });
        } catch (error) {
          SubNotice(rt, $, 'error', 'pin-write-failed', `auto-effort-control: recording sub-agent ${result.agentId}'s pin failed: ${SubMessage(error)}; it runs at the session's effort, unpinned`, 'agent.spawn');
        }
      }
      return result;
    } finally {
      SubSettle(spawns);
    }
  });

};
