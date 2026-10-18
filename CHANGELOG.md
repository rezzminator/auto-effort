# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin follows [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.3.0-dev.1] — 2026-10-18

The plugin is now `auto-effort-control`: `auto-effort` (the main chat) and `effort-live-control` (the sub-agents, named `agent-effort` through its 0.1.3) merged into one installation with one option set. Both are retired.

### Added

- Everything `effort-live-control` 0.4.0-dev.1 did, for the sub-agents the main chat launches: the spawn tag `[effort: low|medium|high|xhigh|max]`, the pin on every sub-agent's requests, `effortControl` steering from an agent definition's frontmatter (tripwires on failing test runs and red returns, the optional judge, `landing` types, `struggleDecay`), the `effort_up`, `effort_down` and `effort_auto` buttons and the announcements. Both original test suites are kept; steering behaviour is unchanged. README § Sub-agents is the contract.
- Visible reporting of every retired-plugin setting, so none is dropped without a word (§ Migration).

### Changed

- Names: the plugin and its marketplace `auto-effort-control`; the MCP tools keep their names (`set_effort`, `effort_up`, `effort_down`, `effort_auto`) under the server prefix `mcp__auto-effort-control__` (was `mcp__auto-effort__` for `set_effort` and `mcp__effort-live-control__` for the buttons); the command `/auto-effort-control` (was `/auto-effort`); every option's variable `AUTO_EFFORT_CONTROL_{OPTION}` (was `AUTO_EFFORT_{OPTION}` and `EFFORT_LIVE_CONTROL_{OPTION}`); the keeper's argv mark `auto-effort-control-keeper` (was `auto-effort-keeper`). No alias of an old tool or command remains.
- Paths: the state file defaults to `~/.local/state/auto-effort-control/state.json`, `logFile` to `~/.local/state/auto-effort-control/decisions.jsonl`, the plugin logs to `$PLUGIN_LOG_DIR/auto-effort-control/` (or `~/.local/state/auto-effort-control/logs/`). Under one `logFile` the main chat writes `decisions.<session>[.<n>].jsonl` and the sub-agents `decisions.<session>.subagent.jsonl`, so the two writers and their row caps never share a file.
- The state file's contract is unchanged: `version` 2 with `mode`, `level`, `reason`, `keeper` and `updatedAt`. A status line reads the escalation's failing-test count from `reason`, which on an escalation is exactly `{N} failing test runs`.
- One module, `hooks/auto-effort-control.ts`, registers each event once and routes it by whose event it is; `src/` keeps the main chat's decisions and `src/subagent/` the sub-agents'. The package directory is `plugins/auto-effort-control/`.
- One option set of 35, each concept once. `models` and `testCommandPatterns` are scoped lists: an entry is `main:model=allow|probation|deny` or `subagent:model-prefix` for `models`, and `main:regexp`, `subagent:regexp` or an unprefixed regexp (both scopes) for `testCommandPatterns`; a `models` entry with no scope is rejected with the syntax. The defaults are the two plugins' lists, each kept in its scope (Haiku on probation for the main chat and not steered in sub-agents; `python -m unittest` and `node --test` for sub-agents only). The floor stays `medium`. README § Options lists every option and variable.

### Migration

- **Old state and logs are kept.** Nothing under `~/.local/state/auto-effort/` or `~/.local/state/effort-live-control/` (state files, decision logs, the `logs/` folders, a casebook) is read, deleted, moved or rewritten; the plugin writes under `~/.local/state/auto-effort-control/` from now on. Delete the old folders yourself when you no longer need them.
- **Old options.** A value under `pluginConfigs["auto-effort@…"].options` keeps the main chat's scope, and one under `pluginConfigs["effort-live-control@…"].options` the sub-agents'; each is honoured as `pluginConfigs["auto-effort-control@…"].options.{key}` would be. An option key means what it meant: `floor`, `ceiling`, `failurePatterns`, `models` (an old `models` list in the old syntax keeps its scope), `testCommandPatterns` and `logFile`/`stateFile` included.
- **Old variables.** `AUTO_EFFORT_{OPTION}` is read for the main chat and `EFFORT_LIVE_CONTROL_{OPTION}` for the sub-agents, as `AUTO_EFFORT_CONTROL_{OPTION}` would be.
- **Precedence**, per scope, highest first: the non-blank canonical variable; the scope's old variable; a canonical `/config` row; a canonical `pluginConfigs` option; a registered canonical option with a non-default value; the scope's old `pluginConfigs` option; the registered canonical default; the original built-in default. A canonical option written explicitly shadows an old value even at its default; the manifest's own defaults never do. Flip by writing the value under the canonical key and removing the old one.
- **Nothing is silent.** Each old source is reported as `auto-effort-control: {old key} -> {new key}: honored for {scope}` or `... displaced by a higher-precedence value`. Reported by key as well: an old option this plugin does not know, an option entry that is not an object, a list with a non-string entry, two marketplace entries of one identity (the lexically first wins), a `settings.env` entry of an old prefix, an unreadable or unusable settings snapshot, a variable that cannot be read (its last value is kept). The host cannot list the operating system's variables, so an old variable set only there and not read by name cannot be found, and the plugin emits no warning for it; `/auto-effort-control status` states the limit (a limit of the host API, not a clean check).
- **Uninstall the old plugins** (`claude plugin uninstall auto-effort`, `claude plugin uninstall effort-live-control`); `pfm doctor` flags a retired copy still enabled.
- **Agent definitions.** An `effortControl` key keeps its meaning; a `tools:` line naming `mcp__effort-live-control__effort_up|down|auto` names `mcp__auto-effort-control__effort_up|down|auto` now.
- The GitHub repository is still `rezzminator/auto-effort` until it is renamed (the one place the old name stays live); the `effort-live-control` repository is not archived by this release.

## [0.2.4-dev.3] — 2026-10-18

### Fixed

- The state file keeper stopped by the host with SIGTERM (a session's end, a reload, a disable) is the expected end: it is logged at info as `state-keeper-stopped`, no longer as a `state-keeper-ended` warning (one per session). The line still reads `keeper` 0 at once, and a keeper that ends any other way is still a warning.

## [0.2.4-dev.2] — 2026-10-17

### Fixed

- Warning and info diagnostics stay off screen while the plugin log works, including cache-safety notices. If logging is unavailable or fails, each unlogged diagnostic falls back to the screen, alongside the log's own failure notice.
- Errors always reach the screen and the plugin log, including request failures previously logged only. Invalid settings and failed registration, state persistence, settings reads and effort-control operations are classified as errors because the requested feature could not complete.
- Requested level status, tool replies, escalation/de-escalation context and command replies are unchanged; cache-guard diagnostics no longer produce separate toasts.
- State-file and keeper warnings (a write or retire that fails, a keeper that cannot start or ends) and a reason notice the screen refuses go to the plugin log, not the screen; the reason notice itself (`statusLine`) is unchanged.

## [0.2.4-dev.1] — 2026-10-17

### Added

- `set_effort` takes `auto`: it hands the main chat's effort back to the automatic rules, so the current turn runs at its planned level again and each turn starts at its own.
- The `stateFile` option (`AUTO_EFFORT_STATE_FILE`, default `~/.local/state/auto-effort/state.json`): one JSON line per session, `state.<session>.json`, naming the effort's mode (`auto`, `model`, `pin` or `off`), its level, the reason and `keeper`, the pid of a keeper process that lives while the plugin is loaded, so a status line shows a line no plugin stands behind as stale. The line is retired (`keeper` 0) at the session's end and when `stateFile` moves or empties, a retire that cannot be written is tried again at each later write, and a keeper that ends leaves `keeper` 0 at once. The keeper's pid is read from its stdout alone, whatever the shell writes to stderr. README § The state file is its contract.

### Changed

- A level the model sets with `set_effort` holds across turns, over the planned level, the turn's start and test-failure rises, until the model calls `set_effort` with `auto`; it was dropped when the turn ended. At the failure threshold the model is told its level stays, and decides. Your `/effort` and `/auto-effort off` still outrank it, and it survives a plugin reload. On a model whose requests carry no effort level, or a level outside the five, `set_effort` refuses a level and says with `auto` that nothing is steered, and `/auto-effort status` shows a held level as kept, not in effect.
- No line in the status area any more: the plugin clears the `⚠ auto-effort: effort auto: …` line an older version pinned. With `statusLine` on, the reason shows as a notice when the mode, level or reason changes while the plugin sets the level; the mode and level are in `stateFile`.

## [0.2.3] — 2026-10-16

### Fixed

- Your own `/effort` no longer puts a line in the status area: a pinned session shows nothing, where the chat showed `⚠ auto-effort: effort auto: xhigh · you set /effort (pin)`. The `pin` row stays in the decision log.

## [0.2.2] — 2026-10-16

### Added

- Every option reads an environment variable named `AUTO_EFFORT_` and the option in upper snake case (`AUTO_EFFORT_PLAN_LEVEL`). The variable beats the option, which beats the default; an unset or empty variable is absent. A variable that does not fit is reported by its name and the option's default applies. Booleans take `1`, `0`, `true` or `false`, and lists a JSON array of strings. `/auto-effort status` names the variables in effect.

## [0.2.1] — 2026-10-15

### Changed

- Level logs use plain directory creation and append, keeping private modes on newly created paths.

## [0.2.0] — 2026-10-14

### Added

- Errors, warnings and info append to separate JSONL files under `PLUGIN_LOG_DIR/auto-effort`, or `~/.local/state/auto-effort/logs` when unset. Rows are capped at 4096 bytes; files past 20 MiB move to `.1`. A failed write gives one screen notice per failing streak without changing the plugin result.

### Added

- `testCommandPatterns`: the commands that are test runs, one regular expression per entry; the defaults name the common runners (`go test`, `npm test`, `vitest`, `jest`, `pytest`, `cargo test`, `make test|check|verify`, `just`, Maven and Gradle, `dotnet`, `deno`, `swift`, `mix`, `rspec`, `phpunit`, `ctest`, `tox`, `nox`, `scripts/test*.sh`).
- `lowerOnPass` (default on): the first passing test run after a rise returns the effort to the level the turn had before its failing streak raised it, with one line to the model and a `deescalation` row in the decision log. A level the model set with `set_effort` after the rise stands.

### Fixed

- Failure counting ignores the output of commands that are not test runs: a `cat`, `grep` or build whose output held `FAIL` used to count as a failing test run and raise the effort. Only failing test runs in a row count now, and a passing run sets the count back to 0.
- `/auto-effort off` and the pin of a `/effort` change now survive a plugin reload and a settings change within the same session: they are saved per session id in the host's plugin state. `/clear` still starts on and unpinned.

## [0.1.0] — 2026-10-11

### Added

- Automatic reasoning effort for the main chat: each turn starts at a planned level (`planLevel`, or `xhigh` when the prompt matches `planUpshiftPatterns` or exceeds `planUpshiftChars`), held for the whole turn.
- The `set_effort` tool, registered always loaded, with a turn reminder on each prompt: the model sets the level the work needs, and the plugin clamps it to `floor`..`ceiling`.
- Escalation: `escalateAfterFailures` failing test runs in one turn raise the level one step.
- The model gate (`models`, `unknownModels`, `probationSwitches`) and the cache check (`canaryThreshold`, `cacheTtlSeconds`): a model whose cache does not survive an effort change is switched off, across sessions, until `/auto-effort clear`.
- A pin on the user's own `/effort` change between turns (`userEffortPins`).
- The `/auto-effort` command: `status`, `on`, `off`, `set <key> <value>`, `clear [model]`.
- A status line, a per-session JSONL decision log, and the options as plugin options, read again at each prompt.
