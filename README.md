<div align="center">

# auto-effort

**Automatic reasoning effort for the Claude Code main chat: each turn starts at a planned level, the model raises or lowers it with one tool call, and a cache check keeps every change safe.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.2.4--dev.1-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

</div>

```json
{"version":2,"mode":"model","level":"xhigh","reason":"root cause not found","keeper":48213,"updatedAt":"2026-10-17T09:30:00.000Z"}
```

<sup>The state file the plugin keeps per session, for your status line to show the mode and level (such as `MODEL - XHigh`); the reason shows as a notice when it changes.</sup>

## Why

`/effort` is one setting for the whole session. A session that renames a function, hunts a bug and designs a cache pays the same thinking budget for all three. Mechanical steps then run slower and dearer than they need to, and the one decision that matters runs no harder than the rest.

With this plugin the main chat's effort follows the work:

- **A turn starts at a planned level** (`high` by default; `xhigh` when the prompt asks for thought or is long).
- **The model sets the level it needs** with the `set_effort` tool, in its first response and again when the work changes. It is told to call it by the tool's description and by one line added to each prompt. The level it sets holds across turns, over the planned level and the test rules, until it calls `set_effort` with `auto`; your own `/effort` and `/auto-effort off` still win over it.
- **Failing tests raise it, passing tests bring it back** while the automatic rules hold: two failing test runs in a row lift the level one step, and the next passing run returns it to where the failures found it. Only a test command counts: the output of `cat`, `grep` or a build that happens to print `FAIL` does not.
- **A cache check keeps it safe.** Changing effort mid-turn must not break the prompt cache. After every change the plugin compares the cache read of the switched request with the previous request's prompt; if it drops, the plugin stops changing effort on that model and tells you.

Sub-agents are never touched; they keep the effort Claude Code gives them (see [agent-effort](https://github.com/rezzminator/agent-effort) to set theirs per spawn).

## Quick start

Function hooks are experimental; turn them on first:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Install from GitHub, inside Claude Code:

```text
/plugin marketplace add rezzminator/auto-effort
/plugin install auto-effort@auto-effort
```

Or from a clone of this repository, through a local directory marketplace:

```bash
scripts/dev-marketplace.sh                        # builds ~/.local/share/auto-effort-dev from this checkout
claude plugin marketplace add ~/.local/share/auto-effort-dev
claude plugin install auto-effort@auto-effort-dev
```

Start a chat and run `/auto-effort status`. To remove it:

```bash
claude plugin uninstall auto-effort@auto-effort-dev
```

Requires Claude Code with function hooks (tested on 2.1.296).

## How it works

| Hook | What it does |
| --- | --- |
| `session.start` | Registers the `set_effort` tool (always loaded, never behind tool search) and the `/auto-effort` command; loads the saved model marks; clears a status line an older version pinned. |
| `prompt.submit` | Reads the options as `/config` holds them, then adds one context line: the level the turn starts at and a request to call `set_effort` first, or, while the model's own level holds, that level and how to hand it back. |
| `turn.step` | Before each main-chat request, rewrites its `effort` to the level held (only when it differs from the effort the request carries), writes the state file and shows the reason as a notice when the mode, level or reason changed, and afterwards runs the cache check on the answer's token usage. A sub-agent's request passes untouched. |
| `tool.call` | Serves `set_effort` (a level, or `auto`); reads each main-chat call of `failureTools` whose command matches `testCommandPatterns` as a test run, failing when its result matches `failurePatterns` and passing otherwise. At the threshold of failing runs in a row it adds one line to the result telling the model its level rose, or, while the model's own level holds, that it stays; with `lowerOnPass`, the next passing run adds one line saying the level is back. |
| `turn.complete` | Writes the turn's summary row to the decision log. |
| `session.compact` | Notes the compaction, so the cache check does not judge the switch right after it. |
| `command.run` | Answers `/auto-effort`. |

A level is always clamped to `floor`..`ceiling`. A model that takes no effort level (no setting, or a number) is left alone, and so is a chat where you set `/effort` yourself between turns (see `userEffortPins`).

### The model's own level

`set_effort` with a level sets the main chat's effort from the next request, and the level holds across turns: no planned level, failing test run or passing one moves it. `set_effort` with `auto` hands the effort back: the current turn runs at its planned level again from the next request, and each turn after starts at its own. Your `/effort` (with `userEffortPins`) and `/auto-effort off` outrank the model's level: while either applies, the level is kept, and after `/auto-effort on` it holds again until the model calls `set_effort` with `auto`. `/clear` drops it. A sub-agent's call is refused.

### The model gate

`models` names each model `allow`, `probation` or `deny`; `unknownModels` covers the rest (`off` by default: untouched). A `probation` model is steered like an `allow` one, and each switch whose cache check passes counts; `probationSwitches` of them graduate it to `allow` on this machine.

### The cache check

The request that follows an effort change must read at least `canaryThreshold` of the previous request's whole prompt (uncached input plus cache read plus cache write) from the cache. If it does not, the plugin stops changing effort on that model, shows one notice, and remembers it across sessions. `/auto-effort clear <model>` turns it back on. A check that cannot hold judges nothing: more than `cacheTtlSeconds` between the two requests, a compaction in between, a different model, or a request whose message count shrank.

## `/auto-effort`

| Command | What it does |
| --- | --- |
| `/auto-effort` or `/auto-effort status` | The level held, what decided it (the model's own level is marked as held until `set_effort` with `auto`), the gate state of the current model, the option errors, and the settings in effect. |
| `/auto-effort off` / `on` | Stops or resumes steering for this session. `on` also resumes after a `/effort` pin. |
| `/auto-effort set <key> <value>` | Saves a single-valued option through `/config`'s own writer; an environment variable of that option still overrides it. Lists (`models`, `failurePatterns`, ...) are edited in `/config` or `settings.json`. |
| `/auto-effort clear [model]` | Lifts a cache mark from one model, or from every model. |

## Options

Every option is a plugin option (`userConfig`): edit it in `/config`, in `settings.json` under `pluginConfigs["auto-effort@<marketplace>"].options`, or with `/auto-effort set`. Each option can also be set in the environment of Claude Code, as `AUTO_EFFORT_` and the option name in upper snake case (`planLevel` is `AUTO_EFFORT_PLAN_LEVEL`). The options are read again at each prompt, so a change applies from the next turn without restarting the chat. A value that does not fit is reported (in the log of the session and in `/auto-effort status`) and its default applies.

The order, highest first: the environment variable, the option (`/config`, `settings.json`, `/auto-effort set`), the default. An unset, empty or blank variable is absent, so the option decides; this also means no variable can set `logFile` or `stateFile` to empty, which turns that file off as an option. A variable that does not fit is reported by its name and the option's default applies, not the option's value. `/auto-effort set` still saves the option, and says when a variable overrides it; `/auto-effort status` names the variables in effect.

| Option type | The variable holds |
| --- | --- |
| true or false | `1`, `0`, `true` or `false`, in any case |
| number | the number as the option takes it |
| text and level | the value as the option takes it |
| list | a JSON array of strings, such as `["Bash","PowerShell"]`; `[]` is the empty list |

| Option | Environment variable | Default | What it does |
| --- | --- | --- | --- |
| `floor` | `AUTO_EFFORT_FLOOR` | `medium` | The lowest reasoning effort the plugin sends: low, medium, high, xhigh or max. A lower level the model asks for is raised to this one. Must not be above ceiling. |
| `ceiling` | `AUTO_EFFORT_CEILING` | `xhigh` | The highest reasoning effort the plugin sends: low, medium, high, xhigh or max. A higher level the model asks for, or an escalation, is lowered to this one. Must not be below floor. |
| `planLevel` | `AUTO_EFFORT_PLAN_LEVEL` | `high` | The effort the first request of every turn runs at, before the model has said what the work needs: low, medium, high, xhigh or max. |
| `planUpshiftPatterns` | `AUTO_EFFORT_PLAN_UPSHIFT_PATTERNS` | `\bthink`<br>`\bdesign` | One regular expression per entry, matched case-insensitively against the prompt. A prompt that matches any entry starts its turn at xhigh instead of planLevel. |
| `planUpshiftChars` | `AUTO_EFFORT_PLAN_UPSHIFT_CHARS` | `1500` | A prompt longer than this many characters starts its turn at xhigh instead of planLevel. |
| `turnReminder` | `AUTO_EFFORT_TURN_REMINDER` | `true` | On: each prompt carries one line naming the effort the turn starts at and asking the model to call set_effort in its first response. Off: only the tool's description asks for the call. |
| `escalateAfterFailures` | `AUTO_EFFORT_ESCALATE_AFTER_FAILURES` | `2` | After this many failing test runs in a row in one turn the effort rises one step, up to the ceiling, for the requests that follow; the count then starts again. A passing test run sets the count back to 0. While the model's own level holds, nothing rises: the model is told and decides. |
| `lowerOnPass` | `AUTO_EFFORT_LOWER_ON_PASS` | `true` | On: the first passing test run after a rise returns the effort to the level the turn had before its failing streak raised it (never below floor), unless the model set a level with set_effort since. Off: the raised level holds until the turn ends. |
| `failurePatterns` | `AUTO_EFFORT_FAILURE_PATTERNS` | `--- FAIL`<br>`FAIL(ED)?`<br>`(?<!\d)[1-9]\d* (failed\|failing)`<br>`AssertionError`<br>`panic:`<br>`Traceback` | One regular expression per entry, matched case-sensitively against the result of a test run (see testCommandPatterns). A test run whose result matches any entry fails; one that matches none passes. |
| `failureTools` | `AUTO_EFFORT_FAILURE_TOOLS` | `Bash` | One tool name per entry (Bash runs the tests). A call of these tools whose command matches testCommandPatterns is a test run; its result is matched against failurePatterns. |
| `testCommandPatterns` | `AUTO_EFFORT_TEST_COMMAND_PATTERNS` | `\bgo\s+(-C\s+\S+\s+)?test\b`<br>`\b(npm\|pnpm\|yarn\|bun)\s+(run\s+)?test\b`<br>`\bvitest\b`<br>`\bjest\b`<br>`\bpytest\b`<br>`\bcargo\s+(test\|nextest)\b`<br>`\bmake\b[^;&\|\n]*?\b(test\|check\|verify)\b`<br>`\bjust\b[^;&\|\n]*?\b(test\|check)\b`<br>`\b(mvn\|gradle\|gradlew)\b[^;&\|\n]*?\btest\b`<br>`\bdotnet\s+test\b`<br>`\bdeno\s+test\b`<br>`\bswift\s+test\b`<br>`\bmix\s+test\b`<br>`\b(rspec\|phpunit\|ctest\|tox\|nox)\b`<br>`\bscripts?/test[\w.-]*\.sh\b` | One regular expression per entry, matched case-sensitively against the command of a failureTools call. A call whose command matches any entry is a test run and counts as failing or passing; the output of any other command (cat, grep, a build) counts nothing. A run sent to the background counts neither way. |
| `userEffortPins` | `AUTO_EFFORT_USER_EFFORT_PINS` | `true` | On: when you change the effort yourself with /effort, auto-effort stops steering that session until /auto-effort on. Off: it keeps steering whatever you set. |
| `models` | `AUTO_EFFORT_MODELS` | `claude-opus-5-5=allow`<br>`claude-fable-5-1=allow`<br>`claude-sonnet-5-5=probation`<br>`claude-haiku-5-5=probation`<br>`claude-sonnet-5=deny` | One entry per model, as model=allow, model=probation or model=deny. allow steers it. probation steers it while counting clean effort switches; probationSwitches of them earn allow. deny never touches it. A model without an entry gets unknownModels. |
| `unknownModels` | `AUTO_EFFORT_UNKNOWN_MODELS` | `off` | off leaves it untouched; allow, probation and deny act as in models. |
| `probationSwitches` | `AUTO_EFFORT_PROBATION_SWITCHES` | `5` | How many effort switches in a row of a probation model must keep the cache (see canaryThreshold) before it counts as allow. |
| `canaryThreshold` | `AUTO_EFFORT_CANARY_THRESHOLD` | `0.9` | After an effort change, the switched request must read at least this fraction of the previous request's whole prompt from the prompt cache. Below it the plugin stops changing effort on that model, tells you once, and remembers across sessions until /auto-effort clear. |
| `cacheTtlSeconds` | `AUTO_EFFORT_CACHE_TTL_SECONDS` | `300` | When more than this many seconds passed between two requests the cache may have expired on its own, so the check judges nothing. 300 fits the five-minute cache; use 3600 with the one-hour cache. |
| `statusLine` | `AUTO_EFFORT_STATUS_LINE` | `true` | On: when the effort's mode, level or reason changes while the plugin sets the level (mode auto or model), a short notice shows the reason alone. The mode and level themselves are in stateFile, for a status line to show. Off: no such notice. |
| `logFile` | `AUTO_EFFORT_LOG_FILE` | `~/.local/state/auto-effort/decisions.jsonl` | Where decisions are appended, one JSON row per decision, request and turn, never the prompt text. The session id is inserted before the extension, one file per session; after 1000 rows the next file starts (`decisions.<session>.2.jsonl`, `.3.jsonl`, ...). A leading ~ is your home directory. Empty: no log. |
| `stateFile` | `AUTO_EFFORT_STATE_FILE` | `~/.local/state/auto-effort/state.json` | One JSON line per session naming the mode the main chat's effort is in (auto, model, pin or off), its level, the reason and the keeper that vouches for it, rewritten when one of them changes; the line at a path the plugin leaves is retired (keeper `0`). The session id is inserted before the extension (state.<session>.json). A leading ~ is your home directory; a relative path is under the session's working directory, so give an absolute one. Empty: no file. |

## The state file

One JSON line per session at `stateFile` (`state.<session>.json`), rewritten whole when the mode, the level, the reason or the keeper changes, so a status line can show the main chat's effort:

```json
{"version":2,"mode":"auto","level":"medium","reason":"planning turn","keeper":48213,"updatedAt":"2026-10-17T09:30:00.000Z"}
```

| `mode` | `level` | When |
| --- | --- | --- |
| `auto` | The level the turn runs at; `null` before the first request | The automatic rules decide: the planned level, test-failure rises. |
| `model` | The model's own level | The model set it with `set_effort`; it holds until `set_effort` with `auto`. |
| `pin` | Your `/effort` level | You set `/effort`; `/auto-effort on` resumes. |
| `off` | `null` | `/auto-effort off`, the model gate leaves the model untouched, or the model takes no effort level. |

`keeper` says whether anything still stands behind the line. While the plugin is loaded it runs a keeper, `/bin/sh -c 'echo $$; while kill -0 "$PPID" 2>/dev/null; do sleep 2; done' auto-effort-keeper`: the host kills it when the plugin unloads (disabled, reloaded, or its process ending), and it exits within two seconds of the process that started it. The line names its pid, the first line it prints on stdout; what the shell writes to stderr is no pid. A reader trusts the line only while a live process at that pid has `auto-effort-keeper` among its arguments; any other line is stale, a state nothing steers, to show as such and never as the mode it names. `keeper` is `0` when no keeper vouches: the plugin writes the line's last state with `0` at the session's end and on leaving a path (`stateFile` moved or emptied, a new session after `/clear`), and as soon as no keeper runs (a keeper that cannot start is said once until one starts, each keeper that ends once; the next prompt starts another). A retire that cannot be written is tried again at each later write, and said once per path; a publish still running for a session that ended writes nothing.

`reason` holds at most 60 characters; `version` changes only when a field changes meaning. No file means no session of this plugin wrote one; a file a reader cannot parse, or one without an integer `keeper` of `0` or more, is an error to show as one, never as `auto`. The host's file writer promises no atomic replace, so a reader that finds a partial line reads it again. The plugin never removes a file, it retires it. A limit: a dead keeper's pid the system hands to another session's keeper reads live until that line is rewritten.

## The decision log

One JSON row per line in `logFile` (one file per session, a new numbered file every 1000 rows), never the prompt text:

| `event` | When |
| --- | --- |
| `decision` | A turn's first request: the level, what decided it (`plan`, `pin`), and the reason. |
| `step` | Each main-chat request: the level sent, the token counts, the time it took. |
| `switch` | An effort change between two requests of one model. |
| `set_effort` | Each call of the tool: the level asked (or `auto`), the level applied, the reason given. |
| `escalation` | A rise from failing test runs; `held: override` when the model's own level kept the effort where it was. |
| `deescalation` | A passing test run returning the level to where the failing streak found it (`lowerOnPass`). |
| `canary` | The cache check of a switch: `ok`, `fail` or `skip` with the reason. |
| `gate` | A model graduating from probation, or marked unsafe. |
| `pin` | A `/effort` change the plugin recognised. |
| `turn` | A turn's summary: start and end level, steps, switches, calls, tokens. |
| `option-error` | An option value that was rejected. |

## Limits

- Main chat only. Sub-agents keep their own effort.
- The session's on/off, a `/effort` pin and the model's own level are kept per session id in the host's plugin state, so a `/reload-plugins` or a settings change (in `/config` or by `/auto-effort set`), which reloads the plugin, keeps them. They do not survive closing the chat. `/clear` starts a new session: on, unpinned, with its own log file. The model marks and probation counts are saved and shared by every chat on the machine; a chat's save rewrites only the models it changed, so for one model the last write wins.
- `testCommandPatterns` and `failurePatterns` entries are regular expressions you write, run over every main-loop Bash command and every test run's result. They are checked for syntax only, so a pattern that backtracks without end (such as `(a+)+$`) can stall the plugin's tool-result hook on a long result; the host treats a hook that overruns as absent and the result goes through unchanged. Keep patterns plain.
- The only effort control the plugin has is the request's `effort` field, set per request. It does not read the session's setting; it recognises a pin by the request's effort changing between turns on the same model.
- A test run is recognised by its command alone: a test runner no `testCommandPatterns` entry names counts nothing, and a command that merely mentions one (`grep pytest notes.md`) counts. Add your own runner or script as an entry.
- A test run's verdict is text in its result: one that prints none of the `failurePatterns` counts as passing, even when it failed some other way (a compile error, a crash before the first test).

## Development

```bash
npm install
npm test            # unit and adapter tests (vitest)
npm run typecheck   # the repo and the hooks module
npm run validate:plugin
npm run release:check
```

`plugins/auto-effort/` is everything that installs; `plugins/auto-effort/src/` holds every decision as a pure, unit-tested function and `plugins/auto-effort/hooks/auto-effort.ts` is the only file that touches the engine. See `CLAUDE.md`.

## Credit

Built by Reza with [Professor](https://github.com/rezzminator/professor). MIT licensed.

## Logs

Errors, warnings and info append to `errors.jsonl`, `warnings.jsonl` and `info.jsonl` under `$PLUGIN_LOG_DIR/auto-effort/`. With `PLUGIN_LOG_DIR` unset they use `$HOME/.local/state/auto-effort/logs/`. Each row identifies its event and relative component. Rows are limited to 4096 bytes, and a file past 20 MiB moves to `.1` (replacing the previous `.1`). A write failure emits one screen notice per failing streak, re-armed after a successful write. Existing screen messages and the `logFile` decision log are unchanged.
