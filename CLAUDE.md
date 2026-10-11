# auto-effort

A Claude Code function-hooks plugin: automatic reasoning effort for the main chat. Each turn starts at a planned level, the model raises or lowers it with the `set_effort` tool, failing tests raise it, and a cache check switches a model off when changing effort breaks its prompt cache. `README.md` is the behavioural spec.

## Layout

- `plugins/auto-effort/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it.
- `plugins/auto-effort/hooks/auto-effort.ts`: the adapter, the only file that touches `$`. It feeds the hook events to the controller and does what it returns.
- `plugins/auto-effort/contract.d.ts`: the plugin state the host keeps per session (on/off and the pin), declared for `$.state`; `plugin.json` names it in `types`.
- `plugins/auto-effort/src/`: every decision, pure and unit-tested. `controller.ts` holds the turn state; `settings.ts` the options and their defaults; `gate.ts` the model gate and the saved marks; `canary.ts` the cache check; `plan.ts` the planning level; `text.ts` every sentence the model or the user reads; `command.ts` `/auto-effort`; `log.ts` the decision log paths.
- `tests/`: one vitest file per concern; `adapter.test.ts` drives the hooks module over a stand-in engine.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/auto-effort/.claude-plugin/`: `plugin.json` (the manifest and the 17 `userConfig` options) and `icon.svg`; the root `.claude-plugin/marketplace.json` makes the repo its own marketplace.
- `scripts/dev-marketplace.sh`: builds the local `auto-effort-dev` directory marketplace from a checkout; `scripts/release-check.sh`: the version places.

## Commands

`npm test`, `npm run typecheck`, `npm run validate:plugin` and `npm run release:check` all pass before a commit. `validate:plugin` runs `claude plugin validate --strict`; run it with `CLAUDE_CONFIG_DIR` pointing at a scratch directory so the check reads no live config.

A live check loads the checkout with `--plugin-dir plugins/auto-effort` and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, with any installed copy disabled for that run. `/auto-effort status` shows the level, the gate and the settings in effect; the decision log (`logFile`) shows every request.

## Testing

- A new behaviour lands in `plugins/auto-effort/src/` as a pure function with a test watched failing first; the adapter only wires it.
- Each decision is tested once, in the test file of the module that makes it; `adapter.test.ts` proves only the wiring (what each hook passes in and does with the answer).
- The three places that hold an option's default — `src/settings.ts`, `plugin.json`'s `userConfig`, the README options table — must agree; `tests/defaults.test.ts` fails when they do not.
- A test that asserts nothing a broken build would change is not a test: a negative assertion comes with a positive control.

## Rules

- An error never holds a request: log it with context (`auto-effort: {what} failed: {why}; {what happens instead}`) and send the request at the effort it already had.
- Only the main loop is steered; a sub-agent's request, tool call and turn pass through untouched.
- The decision log never holds prompt or tool-result text.
- Standalone: the plugin runs on a machine with nothing but Claude Code. No path, agent, policy or wording of any other tool appears in code or in a file the plugin writes; credit is in the README and the manifest only.
- A version bump moves `plugin.json`, `marketplace.json`, `package.json`, `package-lock.json`, `src/version.ts` and the README badge together; `npm run release:check` proves it.
- No machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.
- Never write to the live Claude Code config (`~/.claude/**`, `settings.json`) from a test or a check.

## Branches

- `develop` is the default branch; every change lands there. There is no remote yet: nothing is pushed, tagged or released until the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
