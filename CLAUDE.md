# auto-effort

A Claude Code function-hooks plugin: automatic reasoning effort for the main chat and the sub-agents it launches. Each main-chat turn starts at a planned level, the model raises or lowers it with the `set_effort` tool, failing tests raise it, and a cache check switches a model off when changing effort breaks its prompt cache. A tag at the start of an Agent prompt sets that sub-agent's effort; an agent whose definition carries `effortControl` is raised at each tripwire, brought home once the trouble resolves, and moves its own effort with `effort_up`, `effort_down` and `effort_auto`. `README.md` is the behavioural spec.

## Layout

- `plugins/auto-effort/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it.
- `plugins/auto-effort/hooks/`: the adapter, the only file that touches `$`. It feeds the hook events to the controllers and does what they return.
- `plugins/auto-effort/contract.d.ts`: the plugin state the host keeps per session (on/off and the pin), declared for `$.state`; `plugin.json` names it in `types`.
- `plugins/auto-effort/src/`: every decision, pure and unit-tested — the main chat's at its top level, the sub-agents' under `src/subagent/`. `options.ts` declares the one option set (`OPTION_DEFAULTS`, with `models` and `testCommandPatterns` scope-tagged) and resolves each scope's values from every source, legacy ones included (`resolveOptions`); `settings.ts` and `subagent/settings.ts` parse those values for their scope; `state.ts` the per-session state file; `text.ts` and `subagent/text.ts` every sentence the model or the user reads.
- `tests/`: one vitest file per concern, the sub-agents' under `tests/subagent/`; `options.test.ts` covers the option set, its scope projection and the legacy sources; each `adapter.test.ts` drives the hooks module over a stand-in engine.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/auto-effort/.claude-plugin/`: `plugin.json` (the manifest and its `userConfig` options) and `icon.svg`; the plugin installs as `auto-effort@professor` from Professor's marketplace.
- `scripts/release-check.sh`: the version places.

## Commands

`npm test`, `npm run typecheck`, `npm run validate:plugin` and `npm run release:check` all pass before a commit. `validate:plugin` runs `claude plugin validate --strict`; run it with `CLAUDE_CONFIG_DIR` pointing at a scratch directory so the check reads no live config. `make release-check` runs every check the release workflow runs on a `develop → main` pull request, the same make targets (`check`, `release`) under Node 22.

A live check loads the checkout with `--plugin-dir plugins/auto-effort` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, with any installed copy disabled for that run. `/auto-effort status` shows the level, the gate and the settings in effect; the decision logs (`decisions.{session}.jsonl`, the sub-agents' `decisions.{session}.subagent.jsonl`, in the plugin log directory) show every request.

## Testing

- A new behaviour lands in `plugins/auto-effort/src/` as a pure function with a test watched failing first; the adapter only wires it.
- Each decision is tested once, in the test file of the module that makes it; `adapter.test.ts` proves only the wiring (what each hook passes in and does with the answer).
- The three places that hold an option's default — `src/options.ts`'s `OPTION_DEFAULTS`, `plugin.json`'s `userConfig`, the options tables of `README.md` and `plugins/auto-effort/README.md` — must agree; `tests/defaults.test.ts` and `tests/subagent/defaults.test.ts` fail when they do not.
- Precedence per scope, with every legacy source and its diagnostic, is `README.md` § Precedence, implemented once in `resolveOptions`; unset, empty or blank is absent; booleans `1|0|true|false`, lists a JSON array of strings; a bad value is reported by its key or variable name and its scope's default applies.
- A new option adds its default to `OPTION_DEFAULTS`, its string-literal `$.env.get` line in the adapter, its row with the variable column in both READMEs, and a case in its scope's `settings.test.ts`.
- A test that asserts nothing a broken build would change is not a test: a negative assertion comes with a positive control.

## Rules

- An error never holds a request or a spawn: log it with context (`auto-effort: {what} failed: {why}; {what happens instead}`) and let it through at the effort it already had.
- The main loop follows the main-chat rules, a sub-agent only the tag and `effortControl` rules; neither scope's request reaches the other's controller.
- A malformed tag refuses the spawn with a message naming the valid levels; it is never silently dropped.
- A setting under a former name — a `pluginConfigs` entry of `auto-effort-control@…` or `effort-live-control@…`, an `AUTO_EFFORT_CONTROL_*` or `EFFORT_LIVE_CONTROL_*` variable — is read under the `auto-effort` name or reported naming the old and the new key, never dropped.
- The state file (`~/.local/state/auto-effort/state.json` by default) is a published interface: `version` 3 with `mode`, `level`, `reason`, `keeper`, `updatedAt`, a failing-test raise's reason `{N} failing test runs`, the keeper's last argument `auto-effort-keeper`; a change to any of them bumps `STATE_VERSION`.
- `~/.local/state/effort-live-control/` is never moved, rewritten or deleted. `~/.local/state/auto-effort-control/` and `$PLUGIN_LOG_DIR/auto-effort-control/` move once to their `auto-effort` place while that place is free (`src/former.ts`), never overwriting it; a state-file destination inside either former tree is refused.
- The decision log never holds prompt or tool-result text, except the judge packets the opt-in `logPackets` option writes (off by default; README § Options says what they hold).
- Standalone: the plugin runs on a machine with nothing but Claude Code. No path, agent, policy or wording of any other tool appears in code or in a file the plugin writes; credit is in the README and the manifest only.
- A version bump moves `plugin.json`, `package.json`, `package-lock.json`, `src/version.ts` and the README badge together; `npm run release:check` proves it.
- No machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.
- Never write to the live Claude Code config (`~/.claude/**`, `settings.json`) from a test or a check.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and no CI runs on a push. `.github/workflows/release.yml` runs on the `develop → main` pull request only. `develop` is protected by the ruleset `develop keeps its history`: never force-push or delete it.
- `main` is release-only (ruleset `main is release-only`). It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history, and only after `check` and `release` pass: never a direct push, never an admin override. Professor's marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- A release, in order:
  1. On `develop`: bump the version in every place `npm run release:check` checks, and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. Every merge into `main` publishes, so a pre-release suffix (`-dev.N`, `-alpha`) becomes the real release version here.
  2. `make release-check` passes, after `git fetch origin main`.
  3. Open the `develop → main` pull request. Its `check` and `release` checks run the same make targets; `release` requires the version to have moved past `main`'s and the CHANGELOG section to yield notes.
  4. Merge once both are green. The merge is the release: `release.yml`'s `publish` job tags the merge commit `auto-effort--vX.Y.Z` and publishes the GitHub release from the CHANGELOG section. No tag is pushed by hand.
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option is a major, and its CHANGELOG entry says how to migrate.
- Publishing: README and marketing changes on `develop` are pushed as soon as they are committed. Code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
