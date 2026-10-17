# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin follows [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.2.4-alpha] — 2026-10-17

### Fixed

- Warning and info diagnostics stay off screen while the plugin log works, including cache-safety notices. If logging is unavailable or fails, each unlogged diagnostic falls back to the screen, alongside the log's own failure notice.
- Errors always reach the screen and the plugin log, including request failures previously logged only. Invalid settings and failed registration, state persistence, settings reads and effort-control operations are classified as errors because the requested feature could not complete.
- Requested level status, tool replies, escalation/de-escalation context and command replies are unchanged; cache-guard diagnostics no longer produce separate toasts.

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
