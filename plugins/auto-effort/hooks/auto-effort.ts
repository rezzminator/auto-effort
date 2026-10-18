import type { ConfigRow, EngineInterface, Register } from 'claude-code';
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
  $.ui.log(`auto-effort: ${notice}`);
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
  const text = `auto-effort: ${what} failed: ${message(error)}; ${then}`;
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
      note($, st, 'error', 'decision-log-write-failed', 'hooks/auto-effort.ts#flush', 'writing the decision log', error, `${left} rows were not kept`);
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
    note($, st, 'warning', 'toast-failed', 'hooks/auto-effort.ts#notice', 'showing a notice', error, `the notice was: ${text}`);
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
        if (stopped) plog($, st, 'info', 'state-keeper-stopped', 'auto-effort: the state file keeper was stopped by the host (SIGTERM); a status line shows the state stale until the next prompt starts another', 'hooks/auto-effort.ts#startKeeper');
        else note($, st, 'warning', 'state-keeper-ended', 'hooks/auto-effort.ts#startKeeper', 'keeping the state file keeper', new Error(`the state file keeper ended: ${why}`), 'a status line shows the state stale until the next prompt starts another');
      } catch {
        // A module the host unloaded has no screen left: its keeper ending is the unload itself.
      }
    })();
  } catch (error) {
    st.keeper = 0;
    if (st.keeperFailed) return;
    st.keeperFailed = true;
    try {
      note($, st, 'warning', 'state-keeper-failed', 'hooks/auto-effort.ts#startKeeper', 'starting the state file keeper', error, 'the state file names no keeper, so a status line shows it stale; the next prompt tries again');
    } catch (screenError) {
      plog($, st, 'warning', 'state-keeper-failed', `auto-effort: showing the state file keeper failure failed: ${message(screenError)}; the failure was: ${message(error)}`, 'hooks/auto-effort.ts#startKeeper');
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
        note($, st, 'warning', 'state-file-retire-failed', 'hooks/auto-effort.ts#retireState', `retiring the state file ${path}`, error, 'a status line reading it trusts it until a later write retires it');
      } catch (screenError) {
        plog($, st, 'warning', 'state-file-retire-failed', `auto-effort: showing the state file retire failure failed: ${message(screenError)}; the failure was: ${message(error)}`, 'hooks/auto-effort.ts#retireState');
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
      note($, st, 'warning', 'state-file-write-failed', 'hooks/auto-effort.ts#writeState', 'writing the state file', error, 'a status line reading it shows the state it held before');
    } catch (screenError) {
      plog($, st, 'warning', 'state-file-write-failed', `auto-effort: showing the state file failure failed: ${message(screenError)}; the failure was: ${message(error)}`, 'hooks/auto-effort.ts#writeState');
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
    plog($, st, 'error', 'option-error', line, 'hooks/auto-effort.ts#reportErrors');
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
    const { value } = await $.state.get({ plugin: 'auto-effort', key: 'session', id: st.sessionId });
    if (value !== undefined) {
      const saved = readSessionState(value);
      if (saved === undefined) {
        note($, st, 'error', 'saved-switch-unreadable', 'hooks/auto-effort.ts#restoreSession', 'reading the saved on/off, the pin and the set_effort level', new Error(`${quote(value)} is not in the expected form`), 'this session is on and unpinned, with no set_effort level');
      } else {
        st.ctl.restoreSession(saved);
        st.savedSession = JSON.stringify(st.ctl.sessionState());
      }
    }
  } catch (error) {
    note($, st, 'error', 'saved-switch-unreadable', 'hooks/auto-effort.ts#restoreSession', 'reading the saved on/off, the pin and the set_effort level', error, 'this session is on and unpinned, with no set_effort level');
  }
}

async function saveSession($: EngineInterface, st: State): Promise<void> {
  if (st.sessionId === undefined) return;
  const now = st.ctl.sessionState();
  const text = JSON.stringify(now);
  if (text === st.savedSession) return;
  let failure: unknown;
  try {
    const result = await $.state.set({ plugin: 'auto-effort', key: 'session', id: st.sessionId }, now);
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
  note($, st, 'error', 'saved-switch-unsaved', 'hooks/auto-effort.ts#saveSession', 'saving the on/off, the pin and the set_effort level', failure, 'they hold in this session, but a reload would lose them');
}

async function start($: EngineInterface, st: State): Promise<void> {
  try {
    st.sessionId ??= await $.session.id();
  } catch (error) {
    note($, st, 'error', 'session-id-unreadable', 'hooks/auto-effort.ts#start', 'reading the session id', error, 'the log file is named at the first row');
  }
  try {
    st.ctl.loadPersisted(readPersisted(await $.store.get(STORE_KEY)));
  } catch (error) {
    note($, st, 'error', 'saved-marks-unreadable', 'hooks/auto-effort.ts#start', 'reading the saved model marks', error, 'starting with none');
    st.ctl.loadPersisted(EMPTY_PERSISTED);
  }
  await restoreSession($, st);
  applyLayers($, st, st.options, await currentEnv($, st), 'plugin options');
  try {
    await ensureTool($, st);
  } catch (error) {
    note($, st, 'error', 'tool-register-failed', 'hooks/auto-effort.ts#start', 'registering the set_effort tool', error, 'the turn reminder and the planning level still apply; the next prompt tries again');
  }
  // The effort line moved to the state file: a line an older version pinned to the status area goes.
  try {
    $.ui.status(undefined);
  } catch (error) {
    note($, st, 'warning', 'status-failed', 'hooks/auto-effort.ts#start', 'clearing the status line', error, 'a line an older version pinned may stay');
  }
  await ensureKeeper($, st);
  publish($, st);
  try {
    await $.command.register({ name: PLUGIN, description: 'Show or change automatic reasoning effort: status, on, off, set <key> <value>, clear [model]' });
  } catch (error) {
    note($, st, 'error', 'command-register-failed', 'hooks/auto-effort.ts#start', `registering the /${PLUGIN} command`, error, 'automatic effort works without it');
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
    note($, st, 'error', 'session-id-unreadable', 'hooks/auto-effort.ts#followSession', 'reading the session id', error, 'this stays with the session it had');
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
    note($, st, 'error', 'marks-failed', 'hooks/auto-effort.ts#saveMarks', 'reading or saving the model marks', error, 'they hold in this session, and the next prompt tries again');
    return false;
  }
}

// The environment variables of the options, each spelled as a string literal (Claude Code reads the names off the source)
// and all asked in one round.
async function readEnv($: EngineInterface): Promise<EnvValues> {
  const asked = {
    floor: $.env.get('AUTO_EFFORT_FLOOR'),
    ceiling: $.env.get('AUTO_EFFORT_CEILING'),
    planLevel: $.env.get('AUTO_EFFORT_PLAN_LEVEL'),
    planUpshiftPatterns: $.env.get('AUTO_EFFORT_PLAN_UPSHIFT_PATTERNS'),
    planUpshiftChars: $.env.get('AUTO_EFFORT_PLAN_UPSHIFT_CHARS'),
    turnReminder: $.env.get('AUTO_EFFORT_TURN_REMINDER'),
    escalateAfterFailures: $.env.get('AUTO_EFFORT_ESCALATE_AFTER_FAILURES'),
    failurePatterns: $.env.get('AUTO_EFFORT_FAILURE_PATTERNS'),
    failureTools: $.env.get('AUTO_EFFORT_FAILURE_TOOLS'),
    userEffortPins: $.env.get('AUTO_EFFORT_USER_EFFORT_PINS'),
    models: $.env.get('AUTO_EFFORT_MODELS'),
    unknownModels: $.env.get('AUTO_EFFORT_UNKNOWN_MODELS'),
    probationSwitches: $.env.get('AUTO_EFFORT_PROBATION_SWITCHES'),
    canaryThreshold: $.env.get('AUTO_EFFORT_CANARY_THRESHOLD'),
    cacheTtlSeconds: $.env.get('AUTO_EFFORT_CACHE_TTL_SECONDS'),
    statusLine: $.env.get('AUTO_EFFORT_STATUS_LINE'),
    logFile: $.env.get('AUTO_EFFORT_LOG_FILE'),
    stateFile: $.env.get('AUTO_EFFORT_STATE_FILE'),
    lowerOnPass: $.env.get('AUTO_EFFORT_LOWER_ON_PASS'),
    testCommandPatterns: $.env.get('AUTO_EFFORT_TEST_COMMAND_PATTERNS'),
  };
  const values = await Promise.all(Object.values(asked));
  return Object.fromEntries(Object.keys(asked).map((key, index) => [key, values[index]])) as EnvValues;
}

// The variables now. A read that fails is reported and the last successful read stands: the overrides are never dropped silently.
async function currentEnv($: EngineInterface, st: State): Promise<EnvValues> {
  try {
    st.env = await readEnv($);
  } catch (error) {
    note($, st, 'error', 'env-unreadable', 'hooks/auto-effort.ts#currentEnv', 'reading the option environment variables', error, 'the variables of the last read stay');
  }
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
  const resolved = resolveSettings(options, env);
  st.settingsFrom = resolved.fromEnv.length === 0 ? base : `${base}; environment overrides: ${resolved.fromEnv.map(envName).join(', ')}`;
  reportErrors($, st, resolved.errors);
  st.ctl.applySettings(resolved.settings);
  return resolved;
}

// The options as /config holds them now, over the options the plugin registered with, under their variables.
async function refresh($: EngineInterface, st: State): Promise<void> {
  try {
    const rows: readonly ConfigRow[] = await $.config.list();
    const fromRows = rowLayer(rows);
    applyLayers($, st, { ...st.options, ...fromRows }, await currentEnv($, st), Object.keys(fromRows).length > 0 ? '/config' : 'plugin options');
    await saveMarks($, st, []);
    await ensureTool($, st);
  } catch (error) {
    note($, st, 'error', 'options-unreadable', 'hooks/auto-effort.ts#refresh', 'reading the plugin options', error, 'the settings of the last prompt stay');
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
    note($, st, 'error', 'judge-failed', 'hooks/auto-effort.ts#finishStep', 'judging the request', error, 'the next request is not compared with it');
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
    note($, st, 'error', 'set-effort-failed', 'hooks/auto-effort.ts#answerSetEffort', 'applying set_effort', error, 'the effort stays as it was');
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
      return `auto-effort is ${command.kind} for this session.`;
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
      const applied = applyLayers($, st, { ...st.options, ...fromRows, [command.key]: typed }, await currentEnv($, st), Object.keys(fromRows).length > 0 ? '/config' : 'plugin options');
      await ensureTool($, st);
      publish($, st);
      const now = JSON.stringify(applied.settings[command.key]);
      if (applied.fromEnv.includes(command.key)) return `${command.key} is saved as ${JSON.stringify(typed)}, but ${envName(command.key)} is set and still applies: ${command.key} stays ${now}.`;
      if (now !== JSON.stringify(typed)) return `${command.key} is saved as ${JSON.stringify(typed)}, but ${now} is in effect: see the option errors in /auto-effort status.`;
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
    env: {},
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

  on('session.start', async ($, e, next) => {
    await ensureStarted($, st);
    return next(e);
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
      note($, st, 'error', 'plan-failed', 'hooks/auto-effort.ts#prompt.submit', 'planning the turn', error, 'the prompt goes through unchanged');
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
      note($, st, 'error', 'choose-effort-failed', 'hooks/auto-effort.ts#turn.step', `choosing the effort of request ${e.index}`, error, `it goes at ${String(e.effort)}`);
    }
    if (plan !== undefined) {
      record($, st, plan.rows);
      // Never on the request's path: the save is the host's, and the request goes now.
      void saveSession($, st);
      if (plan.warning !== undefined) plog($, st, 'warning', plan.warning.event, plan.warning.msg, plan.warning.where);
      publish($, st);
      if (plan.send !== undefined) {
        request = { ...e, effort: plan.send };
        plog($, st, 'info', 'effort-applied', `effort applied: ${plan.send}`, 'hooks/auto-effort.ts#turn.step', { level: plan.send, source: plan.source });
      }
    }
    let result;
    try {
      result = yield* next(request);
    } catch (error) {
      if (plan !== undefined) st.ctl.failStep();
      plog($, st, 'error', 'hook-threw', `request failed: ${message(error)}`, 'hooks/auto-effort.ts#turn.step', { error: message(error) });
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
      // The tool's arguments ride beside `tool` (`e.command` for Bash); a call without a command is no test run.
      const command = typeof e.command === 'string' ? e.command : undefined;
      const seen = st.ctl.onToolResult({ tool: e.tool, command, text });
      record($, st, seen.rows);
      if (seen.context !== undefined) return { ...result, context: [...(result.context ?? []), seen.context] };
    } catch (error) {
      note($, st, 'error', 'tool-result-unreadable', 'hooks/auto-effort.ts#tool.call', `reading the ${e.tool} result`, error, 'the result goes through unchanged');
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined) return result;
    try {
      record($, st, st.ctl.completeTurn({ turnId: e.turnId, durationMs: e.durationMs, usage: toUsage(e.usage) ?? undefined }));
    } catch (error) {
      note($, st, 'error', 'turn-record-failed', 'hooks/auto-effort.ts#turn.complete', 'recording the turn', error, 'the turn ended as it would have');
    }
    return result;
  });

  // A compaction rewrites the prompt, so the switch right after it is not judged by the cache canary.
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && e.trigger !== 'precompute' && typeof (result as { skip?: unknown }).skip !== 'string') st.ctl.noteCompaction();
    return result;
  });

  // The session's line is retired at its end: its last state, vouched by no keeper. A publish still running for the
  // ended session writes nothing; once a hook follows the session again (the process goes on after /clear), the next
  // publish writes the line with the keeper.
  on('session.end', async ($, e, next) => {
    st.stateRetired = st.sessionId;
    st.stateWriting = st.stateWriting.then(() => retireState($, st));
    await st.stateWriting;
    await st.pluginWriting;
    return next(e);
  });

  on('command.run', { command: PLUGIN }, async ($, e) => {
    try {
      await ensureStarted($, st);
      await followSession($, st);
      return { text: await runCommand($, st, e.args) };
    } catch (error) {
      note($, st, 'error', 'command-failed', 'hooks/auto-effort.ts#command.run', `/${PLUGIN} ${e.args}`, error, 'nothing was changed');
      return { text: `/${PLUGIN} failed: ${message(error)}\n${USAGE}` };
    }
  });
};
