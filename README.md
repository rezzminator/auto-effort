<div align="center">

# auto-effort

**Automatic reasoning effort for the Claude Code main chat: each turn starts at a planned level, the model raises or lowers it with one tool call, and a cache check keeps every change safe.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

</div>

```text
effort auto: xhigh · root cause not found (model)
```

<sup>The status line the plugin pins while it steers a turn: the level held, why, and what decided it.</sup>

## Why

`/effort` is one setting for the whole session. A session that renames a function, hunts a bug and designs a cache pays the same thinking budget for all three. Mechanical steps then run slower and dearer than they need to, and the one decision that matters runs no harder than the rest.

With this plugin the main chat's effort follows the work:

- **A turn starts at a planned level** (`high` by default; `xhigh` when the prompt asks for thought or is long).
- **The model sets the level it needs** with the `set_effort` tool, in its first response and again when the work changes. It is told to call it by the tool's description and by one line added to each prompt.
- **Failing tests raise it**: two failing test runs in one turn lift the level one step.
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
| `session.start` | Registers the `set_effort` tool (always loaded, never behind tool search) and the `/auto-effort` command; loads the saved model marks. |
| `prompt.submit` | Reads the options as `/config` holds them, then adds one context line: the level the turn starts at and a request to call `set_effort` first. |
| `turn.step` | Before each main-chat request, rewrites its `effort` to the level held for the turn (only when it differs from the effort the request carries), pins the status line, and afterwards runs the cache check on the answer's token usage. A sub-agent's request passes untouched. |
| `tool.call` | Serves `set_effort`; counts failing test runs in the results of `failureTools` and, at the threshold, adds one line to the result that tells the model its level rose. |
| `turn.complete` | Writes the turn's summary row to the decision log. |
| `session.compact` | Notes the compaction, so the cache check does not judge the switch right after it. |
| `command.run` | Answers `/auto-effort`. |

A level is always clamped to `floor`..`ceiling`. A model that takes no effort level (no setting, or a number) is left alone, and so is a chat where you set `/effort` yourself between turns (see `userEffortPins`).

### The model gate

`models` names each model `allow`, `probation` or `deny`; `unknownModels` covers the rest (`off` by default: untouched). A `probation` model is steered like an `allow` one, and each switch whose cache check passes counts; `probationSwitches` of them graduate it to `allow` on this machine.

### The cache check

The request that follows an effort change must read at least `canaryThreshold` of the previous request's whole prompt (uncached input plus cache read plus cache write) from the cache. If it does not, the plugin stops changing effort on that model, shows one notice, and remembers it across sessions. `/auto-effort clear <model>` turns it back on. A check that cannot hold judges nothing: more than `cacheTtlSeconds` between the two requests, a compaction in between, a different model, or a request whose message count shrank.

## `/auto-effort`

| Command | What it does |
| --- | --- |
| `/auto-effort` or `/auto-effort status` | The level held, what decided it, the gate state of the current model, the option errors, and the settings in effect. |
| `/auto-effort off` / `on` | Stops or resumes steering for this session. `on` also resumes after a `/effort` pin. |
| `/auto-effort set <key> <value>` | Saves a single-valued option through `/config`'s own writer. Lists (`models`, `failurePatterns`, ...) are edited in `/config` or `settings.json`. |
| `/auto-effort clear [model]` | Lifts a cache mark from one model, or from every model. |

## Options

Every option is a plugin option (`userConfig`): edit it in `/config`, in `settings.json` under `pluginConfigs["auto-effort@<marketplace>"].options`, or with `/auto-effort set`. The options are read again at each prompt, so a change applies from the next turn without restarting the chat. A value that does not fit is reported by key and value (in the log of the session and in `/auto-effort status`) and its default applies.

| Option | Default | What it does |
| --- | --- | --- |
| `floor` | `medium` | The lowest reasoning effort the plugin sends: low, medium, high, xhigh or max. A lower level the model asks for is raised to this one. Must not be above ceiling. |
| `ceiling` | `xhigh` | The highest reasoning effort the plugin sends: low, medium, high, xhigh or max. A higher level the model asks for, or an escalation, is lowered to this one. Must not be below floor. |
| `planLevel` | `high` | The effort the first request of every turn runs at, before the model has said what the work needs: low, medium, high, xhigh or max. |
| `planUpshiftPatterns` | `\bthink`<br>`\bdesign` | One regular expression per entry, matched case-insensitively against the prompt. A prompt that matches any entry starts its turn at xhigh instead of planLevel. |
| `planUpshiftChars` | `1500` | A prompt longer than this many characters starts its turn at xhigh instead of planLevel. |
| `turnReminder` | `true` | On: each prompt carries one line naming the effort the turn starts at and asking the model to call set_effort in its first response. Off: only the tool's description asks for the call. |
| `escalateAfterFailures` | `2` | After this many failing test runs in one turn the effort rises one step, up to the ceiling, for the requests that follow; the count then starts again. |
| `failurePatterns` | `--- FAIL`<br>`FAIL(ED)?`<br>`(?<!\d)[1-9]\d* (failed\|failing)`<br>`AssertionError`<br>`panic:`<br>`Traceback` | One regular expression per entry, matched case-sensitively against a tool result. A result that matches any entry counts as one failing test run. |
| `failureTools` | `Bash` | One tool name per entry (Bash runs the tests). Only results of these tools are matched against failurePatterns. |
| `userEffortPins` | `true` | On: when you change the effort yourself with /effort, auto-effort stops steering that session until /auto-effort on. Off: it keeps steering whatever you set. |
| `models` | `claude-opus-5-5=allow`<br>`claude-fable-5-1=allow`<br>`claude-sonnet-5-5=probation`<br>`claude-haiku-5-5=probation`<br>`claude-sonnet-5=deny` | One entry per model, as model=allow, model=probation or model=deny. allow steers it. probation steers it while counting clean effort switches; probationSwitches of them earn allow. deny never touches it. A model without an entry gets unknownModels. |
| `unknownModels` | `off` | off leaves it untouched; allow, probation and deny act as in models. |
| `probationSwitches` | `5` | How many effort switches in a row of a probation model must keep the cache (see canaryThreshold) before it counts as allow. |
| `canaryThreshold` | `0.9` | After an effort change, the switched request must read at least this fraction of the previous request's whole prompt from the prompt cache. Below it the plugin stops changing effort on that model, tells you once, and remembers across sessions until /auto-effort clear. |
| `cacheTtlSeconds` | `300` | When more than this many seconds passed between two requests the cache may have expired on its own, so the check judges nothing. 300 fits the five-minute cache; use 3600 with the one-hour cache. |
| `statusLine` | `true` | On: one line shows the level held, why, and what decided it (plan, model, escalation or pin). Off: nothing is shown. |
| `logFile` | `~/.local/state/auto-effort/decisions.jsonl` | Where decisions are appended, one JSON row per decision, request and turn, never the prompt text. The session id is inserted before the extension, one file per session; after 1000 rows the next file starts (`decisions.<session>.2.jsonl`, `.3.jsonl`, ...). A leading ~ is your home directory. Empty: no log. |

## The decision log

One JSON row per line in `logFile` (one file per session, a new numbered file every 1000 rows), never the prompt text:

| `event` | When |
| --- | --- |
| `decision` | A turn's first request: the level, what decided it (`plan`, `pin`), and the reason. |
| `step` | Each main-chat request: the level sent, the token counts, the time it took. |
| `switch` | An effort change between two requests of one model. |
| `set_effort` | Each call of the tool: the level asked, the level applied, the reason given. |
| `escalation` | A rise from failing test runs. |
| `canary` | The cache check of a switch: `ok`, `fail` or `skip` with the reason. |
| `gate` | A model graduating from probation, or marked unsafe. |
| `pin` | A `/effort` change the plugin recognised. |
| `turn` | A turn's summary: start and end level, steps, switches, calls, tokens. |
| `option-error` | An option value that was rejected. |

## Limits

- Main chat only. Sub-agents keep their own effort.
- The session's on/off and a `/effort` pin are kept per session id in the host's plugin state, so a `/reload-plugins` or a settings change (in `/config` or by `/auto-effort set`), which reloads the plugin, keeps them. They do not survive closing the chat. `/clear` starts a new session: on, unpinned, with its own log file. The model marks and probation counts are saved and shared by every chat on the machine; a chat's save rewrites only the models it changed, so for one model the last write wins.
- `failurePatterns` entries are regular expressions you write, run over every main-loop Bash result. They are checked for syntax only, so a pattern that backtracks without end (such as `(a+)+$`) can stall the plugin's tool-result hook on a long result; the host treats a hook that overruns as absent and the result goes through unchanged. Keep patterns plain.
- The only effort control the plugin has is the request's `effort` field, set per request. It does not read the session's setting; it recognises a pin by the request's effort changing between turns on the same model.
- A failing test run is recognised by text in the result of a `failureTools` tool; a tool that prints none of the `failurePatterns` counts nothing.

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

Errors, warnings and info append to `errors.jsonl`, `warnings.jsonl` and `info.jsonl` under `$PLUGIN_LOG_DIR/auto-effort/`. With `PLUGIN_LOG_DIR` unset they use `$HOME/.local/state/auto-effort/logs/`. Each row identifies its event and relative component; a session starts with one `logger-ready` heartbeat. Rows are limited to 4096 bytes, and a file past 20 MiB moves to `.1` (replacing the previous `.1`). A write failure emits one screen notice per failing streak, re-armed after a successful write. Existing screen messages and the `logFile` decision log are unchanged.
