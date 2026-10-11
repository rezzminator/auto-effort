# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin follows [semantic versioning](https://semver.org/).

## [Unreleased]

### Fixed

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
