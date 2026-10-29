# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin follows [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

- Installs as `auto-effort-control@professor` from the professor marketplace; the repo's own marketplace file and `scripts/dev-marketplace.sh` are gone.
- The plugin logs go through the shared plugin-log library, vendored as `src/plugin-log.ts`; the sub-agents' own copy (`src/subagent/plugin-log.ts`) is gone, and both scopes write through one queue. A level file past 20 MiB now keeps up to five rotated generations (`.1` to `.5`); a failed write keeps its rows for the next one instead of dropping them.
- Warnings and info never reach the screen, even when their log cannot be written. The screen shows only errors and one line per failing streak of the log itself.

### Removed

- **Migration:** the `logFile` option and the `AUTO_EFFORT_CONTROL_LOG_FILE`, `AUTO_EFFORT_LOG_FILE` and `EFFORT_LIVE_CONTROL_LOG_FILE` variables are gone; the decision log now lives at `$PLUGIN_LOG_DIR/auto-effort-control/decisions.jsonl`, else `~/.local/state/auto-effort-control/logs/decisions.jsonl` (each session's `decisions.<session>.jsonl` and `decisions.<session>.subagent.jsonl` beside it). A `logFile` still set is reported as an unknown option; the empty value no longer turns the decision log off. Logs written before stay where they are.

### Fixed

- **A cancelled log write no longer shows on screen.** When Claude Code abandons a hook mid-write, the shared plugin-log library keeps the rows for the next write, and nothing is lost; it used to print a "plugin log … failed" line. A real write failure is still said once per failing streak.

## [1.0.0] — 2026-10-27

The plugin is now `auto-effort-control`: `auto-effort` (the main chat) and `effort-live-control` (the sub-agents, named `agent-effort` through its 0.1.3) merged into one installation with one option set. Both are retired. A major release: every tool prefix, the command, every option variable and the state and log paths are renamed; § Migration says how to move.

### Added

- Everything `effort-live-control` 0.4.0-dev.1 did, for the sub-agents the main chat launches: the spawn tag `[effort: low|medium|high|xhigh|max]`, the pin on every sub-agent's requests, `effortControl` steering from an agent definition's frontmatter (tripwires on failing test runs and red returns, the optional judge, `landing` types, `struggleDecay`), the `effort_up`, `effort_down` and `effort_auto` buttons and the announcements. README § Sub-agents is the contract.
- `set_effort` takes `auto`: it hands the main chat's effort back to the automatic rules, so the current turn runs at its planned level again.
- The state file (`stateFile`, default `~/.local/state/auto-effort-control/state.json`): one JSON line per session, `state.<session>.json`, naming the effort's mode (`auto`, `model`, `pin` or `off`), its level, the reason and `keeper`, the pid of a keeper process that lives while the plugin is loaded, so a status line shows a line no plugin stands behind as stale. The line is retired (`keeper` 0) at the session's end and when `stateFile` moves or empties. A keeper the host stops with SIGTERM is logged at info, not warned. README § The state file is its contract.
- Direct observation of `/effort <level>` and `/effort auto`: explicit levels pin even at the carried level, auto releases without mistaking the model default for a new pin, and user pins survive `/clear`.
- Main-chat `hintPatterns` defaults to design, architect, trade-offs, root causes, specs, deliberate thinking and ultrathink patterns. Matching words are hints in the turn reminder, never level moves; set `hintPatterns` to `[]` to omit them. Decision logs record pattern sources only.
- Turn reminders explain a long prompt's character count or an explicit `planUpshiftPatterns` match.
- Visible reporting of every retired-plugin setting, so none is dropped without a word (§ Migration).

### Changed

- Names: the plugin and its marketplace `auto-effort-control`; the MCP tools keep their names (`set_effort`, `effort_up`, `effort_down`, `effort_auto`) under the server prefix `mcp__auto-effort-control__` (was `mcp__auto-effort__` for `set_effort` and `mcp__effort-live-control__` for the buttons); the command `/auto-effort-control` (was `/auto-effort`); every option's variable `AUTO_EFFORT_CONTROL_{OPTION}` (was `AUTO_EFFORT_{OPTION}` and `EFFORT_LIVE_CONTROL_{OPTION}`). No alias of an old tool or command remains.
- Paths: `logFile` defaults to `~/.local/state/auto-effort-control/decisions.jsonl`, the plugin logs to `$PLUGIN_LOG_DIR/auto-effort-control/` (or `~/.local/state/auto-effort-control/logs/`). Under one `logFile` the main chat writes `decisions.<session>[.<n>].jsonl` and the sub-agents `decisions.<session>.subagent.jsonl`, so the two writers and their row caps never share a file.
- A level the model sets with `set_effort` lasts until the turn ends; each next turn starts at its plan. Reloads within the same turn preserve the level. Call `set_effort` again in the next turn to keep a model choice, or pin a user choice with `/effort`.
- `planUpshiftPatterns` defaults to `[]` instead of `['\\bthink', '\\bdesign']`. Set `planUpshiftPatterns` to those patterns to restore keyword upshifts. Length upshifts and failing-test rules are unchanged.
- One option set of 36, each concept once. `models` and `testCommandPatterns` are scoped lists: an entry is `main:model=allow|probation|deny` or `subagent:model-prefix` for `models`, and `main:regexp`, `subagent:regexp` or an unprefixed regexp (both scopes) for `testCommandPatterns`; a `models` entry with no scope is rejected with the syntax. The floor stays `medium`. README § Options lists every option and variable.
- No line in the status area any more: the plugin clears the `⚠ auto-effort: effort auto: …` line an older version pinned. With `statusLine` on, the reason shows as a notice when the mode, level or reason changes while the plugin sets the level.
- Errors always reach the screen and the plugin log; warning and info diagnostics stay in the plugin log while it works, and fall back to the screen when it does not.

### Fixed

- A plugin-log lock left by a writer that was killed mid-append no longer turns both plugin logs off: a lock untouched for over a minute is broken and the append goes on. Before, every later append in every session gave up with `append lock busy` and its rows went to the screen until the lock was removed by hand.
- The state file stops naming the model's `set_effort` level when its turn ends, instead of showing `model` until the next turn's first request.
- After `/clear`, the sub-agents' decision rows and plugin-log rows go to the new session; they kept the session the process started with.

### Migration

- **Old state and logs are kept.** Nothing under `~/.local/state/auto-effort/` or `~/.local/state/effort-live-control/` (state files, decision logs, the `logs/` folders, a casebook) is read, deleted, moved or rewritten; the plugin writes under `~/.local/state/auto-effort-control/` from now on. Delete the old folders yourself when you no longer need them.
- **Old options.** A value under `pluginConfigs["auto-effort@…"].options` keeps the main chat's scope, and one under `pluginConfigs["effort-live-control@…"].options` the sub-agents'; each is honoured as `pluginConfigs["auto-effort-control@…"].options.{key}` would be. An option key means what it meant: `floor`, `ceiling`, `failurePatterns`, `models` (an old `models` list in the old syntax keeps its scope), `testCommandPatterns` and `logFile`/`stateFile` included.
- **Old variables.** `AUTO_EFFORT_{OPTION}` is read for the main chat and `EFFORT_LIVE_CONTROL_{OPTION}` for the sub-agents, as `AUTO_EFFORT_CONTROL_{OPTION}` would be.
- **Precedence**, per scope, highest first: the non-blank canonical variable; the scope's old variable; a canonical `/config` row; a canonical `pluginConfigs` option; a registered canonical option with a non-default value; the scope's old `pluginConfigs` option; the registered canonical default; the original built-in default. A canonical option written explicitly shadows an old value even at its default; the manifest's own defaults never do. Flip by writing the value under the canonical key and removing the old one.
- **Nothing is silent.** Each old source is reported as `auto-effort-control: {old key} -> {new key}: honored for {scope}` or `... displaced by a higher-precedence value`. Reported by key as well: an old option this plugin does not know, an option entry that is not an object, a list with a non-string entry, two marketplace entries of one identity (the lexically first wins), a `settings.env` entry of an old prefix, an unreadable or unusable settings snapshot, a variable that cannot be read (its last value is kept). The host cannot list the operating system's variables, so an old variable set only there and not read by name cannot be found; `/auto-effort-control status` states the limit.
- **Uninstall the old plugins** (`claude plugin uninstall auto-effort`, `claude plugin uninstall effort-live-control`).
- **Agent definitions.** An `effortControl` key keeps its meaning; a `tools:` line naming `mcp__effort-live-control__effort_up|down|auto` names `mcp__auto-effort-control__effort_up|down|auto` now; a prompt or rule naming `mcp__auto-effort__set_effort` names `mcp__auto-effort-control__set_effort`.
- **Keyword upshifts.** To keep the old `think`/`design` upshifts, set `planUpshiftPatterns` to `["\\bthink", "\\bdesign"]`.
- The GitHub repository is still `rezzminator/auto-effort` until it is renamed (the one place the old name stays live): add the marketplace with `/plugin marketplace add rezzminator/auto-effort`.

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
