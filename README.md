<div align="center">

# auto-effort

**Reasoning effort for the Claude Code main chat and for the sub-agents it launches: each turn starts at a planned level, the model raises or lowers its own with one tool call, a spawn tag sets a sub-agent's, an opted-in agent's effort follows its own trouble, and a cache check keeps every change safe.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-2.0.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

</div>

```json
{"version":3,"mode":"model","level":"xhigh","reason":"root cause not found","keeper":48213,"updatedAt":"2026-10-17T09:30:00.000Z"}
```

<sup>The state file the plugin keeps per session, for your status line to show the mode, the level and where it came from (such as `▰▰▰▰ xhigh · model's pick`); the reason shows as a notice when it changes.</sup>

```text
Agent({
  subagent_type: "general-purpose",
  prompt: "[effort: low]\nList every file under src/ that imports lodash."
})
```

<sup>The sub-agent runs its model requests at `low`, whatever the session's `/effort` says. A tag also wins over a definition's own `effort:` (`parentTag: ignore` pins the definition's). Two requests made on a sub-agent's behalf are not pinned ([Sub-agents](#sub-agents)).</sup>

This plugin was named `auto-effort-control` from 1.0.0 to 2.0.0, and is the merge of `auto-effort` 0.x (the main chat) and `effort-live-control` (the sub-agents). Coming from any of them: [Migrating](#migrating).

## Why

`/effort` is one setting for the whole session. A session that renames a function, hunts a bug and designs a cache pays the same thinking budget for all three. Mechanical steps then run slower and dearer than they need to, and the one decision that matters runs no harder than the rest. Claude Code also sets effort per agent type (`effort:` in a definition), but neither it nor `/effort` lets the model choose effort for one dispatch, and neither moves while an agent works: the Agent tool takes a `model`, not an `effort`.

With this plugin the main chat's effort follows the work:

- **A turn starts at a planned level** (`high` by default; `xhigh` when the prompt is long or matches configured `planUpshiftPatterns`).
- **The model sets the level it needs** with the `set_effort` tool, in its first response and again when the work changes. It is told to call it by the tool's description and by one line added to each prompt. The level it sets holds until this turn ends, over the planned level and the test rules, or until it calls `set_effort` with `auto`; your own `/effort` and `/auto-effort off` still win over it.
- **Failing tests raise it, passing tests bring it back** while the automatic rules hold: two failing test runs in a row lift the level one step, and the next passing run returns it to where the failures found it. Only a test command counts: the output of `cat`, `grep` or a build that happens to print `FAIL` does not.
- **A cache check keeps it safe.** Changing effort mid-turn must not break the prompt cache. After every change the plugin compares the cache read of the switched request with the previous request's prompt; if it drops, the plugin stops changing effort on that model and records a warning in its plugin log.

And the sub-agents it launches follow it too: the model that writes a dispatch also picks the effort, and an agent you mark with `effortControl` steps its own effort up when it is in trouble and back down when the trouble is over.

## Quick start

Function hooks are experimental; turn them on first:

```bash
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
```

Install from GitHub, inside Claude Code:

```text
/plugin marketplace add rezzminator/professor
/plugin install auto-effort@professor
```

The plugin installs from Professor's marketplace; this repository holds its source. Local development goes through Professor's alpha `pfm install`, which installs `auto-effort@professor` from a local copy.

Start a chat and run `/auto-effort status`. Each turn starts at `high` by default; design and architecture words hint to the model without moving the level. `/effort high` locks your choice; `/effort auto` hands control back. The Agent tool's description now tells the model about the tag, so no prompt change is needed on your side. Live control is off until an agent definition asks for it ([Live control](#live-control)). To remove it:

```bash
claude plugin uninstall auto-effort@professor
```

Requires Claude Code with function hooks (tested on 2.1.296).

## How it works

| Hook | What it does |
| --- | --- |
| `session.start` | Registers the `set_effort` tool and the `/auto-effort` command (always loaded, never behind tool search) and the three button tools; loads the saved model marks; clears a status line an older version pinned. |
| `tool.describe` | Appends the tag's usage to the Agent tool's description. |
| `prompt.submit` | Reads the options as `/config` holds them, then adds one context line: the planned starting level, why a length or pattern upshift applies, any matched hints, and a request to call `set_effort` first. A model-set level lasts only for that turn. |
| `agent.spawn` | Reads a sub-agent's tag and definition, pins its effort, and starts steering it when its definition opts in ([Sub-agents](#sub-agents)). |
| `turn.step` | Before each main-chat request, rewrites its `effort` to the level held (only when it differs from the effort the request carries), writes the state file and shows the reason as a notice when the mode, level or reason changed, and afterwards runs the cache check on the answer's token usage. Before each sub-agent request, sets its `effort` to the agent's pin, or to its live level when steered. |
| `tool.call` | Serves `set_effort` (a level, or `auto`) for the main chat and `effort_up`, `effort_down` and `effort_auto` for sub-agents; reads each main-chat call of `failureTools` whose command matches `testCommandPatterns` as a test run, failing when its result matches `failurePatterns` and passing otherwise, and a steered sub-agent's own test runs, reads and messages the same way. At the threshold of failing runs in a row it adds one line to the result telling the model its level rose, or, while the model's own level holds, that it stays; with `lowerOnPass`, the next passing run adds one line saying the level is back. |
| `turn.complete` | Writes the main chat's turn summary row to the decision log; when a sub-agent finishes, clears its pin and drops its steering state. |
| `session.compact` | Notes the compaction, so the cache check does not judge the switch right after it. |
| `session.end` | Retires the session's state file line (`keeper` 0) ([The state file](#the-state-file)). |
| `command.run` | Answers `/auto-effort`; observes the built-in `/effort` after the host handles it, without changing its event or result. |

A level is always clamped to `floor`..`ceiling`. A model that takes no effort level (no setting, or a number) is left alone, and so is a main chat where you set `/effort` yourself between turns (see `userEffortPins`).

### The model's own level

`set_effort` with a level sets the main chat's effort from the next request until this turn ends: failing or passing tests do not move it within that turn. The next turn starts at its planned level again. `set_effort` with `auto` hands the running turn back to its plan and the failing-test rules. Your `/effort` pin and `/auto-effort off` outrank the model's level. A reload within the same turn keeps it; `/clear` drops it. A sub-agent's call is refused.

`hintPatterns` names work such as design, architecture and root causes in the reminder. These words never raise the level by themselves. The reminder quotes up to three matches and names the guide's xhigh level, clamped to your floor and ceiling; the model decides whether the turn is that work. `planUpshiftPatterns` is empty by default; configured patterns still raise the starting level. Long prompts still raise it and the reminder gives the character count.

### The model gate

`models` names each model `allow`, `probation` or `deny`; `unknownModels` covers the rest (`off` by default: untouched). A `probation` model is steered like an `allow` one, and each switch whose cache check passes counts; `probationSwitches` of them graduate it to `allow` on this machine.

### The cache check

The request that follows an effort change must read at least `canaryThreshold` of the previous request's whole prompt (uncached input plus cache read plus cache write) from the cache. If it does not, the plugin stops changing effort on that model, logs one warning, and remembers it across sessions. `/auto-effort clear <model>` turns it back on. A check that cannot hold judges nothing: more than `cacheTtlSeconds` between the two requests, a compaction in between, a different model, or a request whose message count shrank.

## Sub-agents

A sub-agent's effort comes from three things, in this order: its spawn tag, its definition, and, for a steered agent, its own trouble.

### The tag

Make `[effort: low|medium|high|xhigh|max]` the first non-blank text of the Agent prompt, on one line. The tag is removed before the sub-agent reads its prompt, and its own model requests run at that level.

- The tag counts only as the prompt's first non-blank text, written on one line. `[effort: high]` later in the prompt is ordinary prose, and a markdown link `[effort: high](…)` is not a tag.
- Levels are case-insensitive. An unknown level refuses the spawn, and the model sees why. A prompt that is only a tag is refused.
- A tag beats the definition's `effort:`: measured over 147 orchestrator runs, the effort the parent tags predicts trouble (18% of runs tagged medium struggled, 53% high, 77% xhigh), so the tag is kept. A steered agent starts at the tag held within its floor and ceiling (`tag` row: `tag`, `effort`, `home`, and `clamped` when the range moved it). `parentTag: ignore`, as the option or per type as `effortControl.parentTag`, keeps the definition's `effort:` instead: the tag is stripped, ignored and logged. A malformed tag still refuses the spawn, whatever the definition says.
- Every sub-agent is pinned. A tagged one runs at its tag (or, under `parentTag: ignore`, its definition's effort). An untagged one runs at the effort its first request carries (its frontmatter `effort:`, else the session's), so changing `/effort` mid-run never reaches a sub-agent already working.
- A pin lasts until the sub-agent finishes. Then it is cleared, and a continuation (SendMessage) is pinned afresh at its own first request, at the effort current then.
- Pins are held by Claude Code for the session and survive a plugin reload. A sub-agent resumed in a new session runs unpinned, at its own effort. Steering state lives in memory: a reload ends it, and the agent goes on at its pin.
- A model that takes no effort setting (such as Haiku) is sent none, whatever the tag says.
- Two requests made on a sub-agent's behalf are not pinned. Its compaction forks are loops no spawn names, so they keep the effort they carry. The agent panel's progress line for a background sub-agent comes from a separate short request Claude Code sends about every 30 seconds (`agent_summary`); it passes through no plugin hook, so it carries the effort the sub-agent's definition declares, never its tag's. The sub-agent's own requests are pinned.

### Live control

An agent definition turns it on with `effortControl`. Bare, `effortControl: on` (also `true` or `yes`; `off`, `false`, `no`) uses the option defaults. Nested, one level, it sets the agent's own range:

```markdown
---
name: lead
description: Coordinates a build across builder and lander sub-agents.
effort: medium
effortControl:
  floor: medium
  ceiling: xhigh
  landing: lander, reviewer
  judge: on
---
You coordinate the build. Spawn builders, check their returns, run the tests, then hand off to the lander.
```

| Key | Meaning |
| --- | --- |
| `effortControl.floor`, `effortControl.ceiling` | The range of levels the agent is ever sent (default: the options). |
| `effortControl.landing` | Agent types, separated by spaces or commas: spawning one lowers the agent one step below its home level. |
| `effortControl.judge` | `on` or `off`: ask the judge at a tripwire, or raise one step mechanically (default: the option). |
| `effortControl.tripwires` | The armed tripwires for this agent, comma-separated (`fail1`, `fail2`, `red`, `redispatch`; empty arms none), e.g. `red, redispatch` for an agent that writes its tests first (default: the option). |
| `effortControl.struggleDecay` | Requests without a new tripwire after which this agent's raised level comes home; `0` turns it off (default: the option). |
| `effortControl.parentTag` | `honor` or `ignore`: whether a tag beats this type's `effort:` (default: the option). Read even when steering is off, and it alone never turns steering on, so `effortControl:` holding only `parentTag: ignore` pins a type at its own `effort:` without steering it. |
| `effortControl.enabled` | `on` or `off`; on by default when any nested key other than `parentTag` is present. |

An invalid value is logged and the default used. An agent whose definition has no `effortControl`, or has it off, is not steered; only the tag rules above apply to it.

A steered agent starts at its **home** level: its tag, else its definition's `effort:`, else the effort of its first request (a numeric effort leaves the agent unsteered); the home is held within floor..ceiling, so `[effort: low]` on a floor-`medium` agent starts at `medium`. Under `parentTag: ignore` the definition's `effort:` comes first. Every request is sent at its current level, held within floor..ceiling, on a model the plugin steers; any other model passes through untouched.

| Moment | What happens |
| --- | --- |
| The agent's own test run fails (the 1st failing run, the 2nd in a row, then every even count: 4th, 6th, …) | A **tripwire**: the level rises one step, or is judged when the judge is on. A test run is a foreground Bash call whose commands match `testCommandPatterns`: the patterns match only the commands a call runs, never a heredoc body, a search, an echo or another read-only program (`readOnlyCommands`), so a brief written with `cat <<'EOF'` that mentions `pytest` is not a test run; it fails when its result is an error or matches `failurePatterns`. |
| A sub-agent returns a red line (`FAIL`, `FAILED`, `BLOCKED`, `PARTIAL`, `SPEC-DRIFT` first on a line of its final answer, or in a file the agent reads: a `Read`, or a shell call that only runs read-only programs such as `cat`, never a program's output) | A tripwire, and that unit is marked red. A final answer counts on its token alone, in its first 15 lines, whatever follows (`DONE probe-unit (handoff skipped: no write tool)`); the unit is the name right after the token when a boundary follows it (the line's end, `.:,;!?)]`, or a space and a symbol such as `(`, `—` or a quote), else the child's type. A result the agent reads counts only as its first non-blank line, and only in that strict form: `DONE and dusted` is prose there. |
| The agent sends a message to a red child, or spawns a type that has a red child | A tripwire (the red result is being sent back). |
| A tripwire (one armed in `tripwires`; a disarmed one is only counted) | A struggle opens at the level the agent had outside trouble. With the judge off (the default), the level rises one step, up to the ceiling (`mechanical`). With it on, the judge is asked, detached: no request waits for it; requests go at the old level until it answers. A call already in flight for this struggle makes this tripwire a no-op (`judge-busy`); a call left over from a struggle that is over does not hold it: the level rises one step mechanically (`mechanical` with `busy: true`). |
| The judge answers | A probability at or above `judgeRaiseAt` raises the level one step, within the range; below it the level holds. The judge never lowers. A late answer for a closed struggle is dropped (`judge-stale`). |
| The judge times out, fails or answers off-format (no leading number from 0 to 100) | The level rises one step (`judge-failed`). |
| A test run passes and no unit is red, or a green return (`DONE`, `PASS`, `FIXED`) clears the last red unit | The struggle is **resolved**: the level returns to what it was before. A green return that names no open red unit closes the only open red of its own agent type, if there is exactly one. |
| `struggleDecay` requests of the agent's own (default 20) pass with no new tripwire | The struggle is **resolved** by decay: the level returns to what it was before, the open red units are cleared and the failure streak resets to 0. A later tripwire opens a new struggle from the level then in force. `0` turns decay off. |
| The agent spawns a `landing` type | Its resting level becomes one step below home, floored. |
| The agent presses `effort_up` or `effort_down` | One step, within the range; outside a struggle it also moves the resting level. The level is then **held**: no tripwire, judge answer or failure, resolution, decay or landing moves it. A tripwire is still counted and opens or keeps its struggle (a `tripwire` row with `held: true`), but asks no judge; every `judge`, `judge-failed`, `resolved` and `landing` row written while the level is held carries `held: true`, whether or not its rule would have moved the level. A press at a bound holds too. |
| The agent presses `effort_auto` | The hold ends: the level and the resting level go back to home (the agent's launch level: its definition's effort or its tag, else its first request's), held within the range, and an open struggle now resolves to home. The automatic rules steer again. Already at home, the answer says so, and the hold still ends. |
| The agent finishes | An `end` row summarises its requests by level, struggles and judge calls. |

**The judge** is off by default: with `judge: false`, every tripwire raises the effort one step. That is the measured better default. On 258 recorded tripwires from 147 orchestrator runs, a Haiku judge could not tell trouble that continues from trouble that ends (AUC 0.35 to 0.56 within each tripwire kind), and raising one step at every tripwire beat every judge variant on the replay loss (3 for a missed needed raise, 1 for an unneeded one): 0.283 against 0.517 for the best judge. Turn it on with the `judge` option, or per agent with `effortControl.judge: on`. When on, it is one `haiku` call per tripwire (`judgeModel`, `judgeEffort`, `judgeTimeoutMs`), 4000 tokens at most, and it estimates the probability that the trouble continues, starting from the rate measured for that tripwire kind: at or above `judgeRaiseAt` the effort rises one step, below it holds, and the judge never lowers it.

**The buttons** are three tools every agent sees, `effort_up`, `effort_down` and `effort_auto`, with no parameters. A steered agent moves its own level one step (or hears that it is already at the bound of its range), and that level holds until it calls `effort_auto`, which hands its effort back to the automatic rules at its home level. The main chat is refused with the name of its own effort control, the tool `set_effort` (call it with a level or `auto`). Any other caller is refused. `buttons: false` registers none.

**Announcements** (`announce`): after any change of a steered agent's level, the agent's next tool result carries one line, `auto-effort: your reasoning effort is now high — a failing test run.`, so the agent knows. A newer change replaces an undelivered one; a button press is answered by its own result instead.

## `/auto-effort`

| Command | What it does |
| --- | --- |
| `/auto-effort` or `/auto-effort status` | The level held, what decided it (the model's own level is marked as held until `set_effort` with `auto`), the gate state of the current model, the option errors, and the settings in effect. |
| `/auto-effort off` / `on` | Stops or resumes steering for this session. `on` also resumes after a `/effort` pin. |
| `/auto-effort set <key> <value>` | Saves one of the main chat's single-valued options through `/config`'s own writer: `floor`, `ceiling`, `planLevel`, `planUpshiftChars`, `turnReminder`, `escalateAfterFailures`, `lowerOnPass`, `userEffortPins`, `unknownModels`, `probationSwitches`, `canaryThreshold`, `cacheTtlSeconds`, `statusLine`, `stateFile`. An environment variable of that option still overrides it. Every other option (the lists, and every sub-agent option) is edited in `/config` or `settings.json`. |
| `/auto-effort clear [model]` | Lifts a cache mark from one model, or from every model. |

`/effort <level>` locks one of the five levels, even when it equals the carried effort. `/effort auto` releases the pin and treats the next request's carried effort as the new baseline; it leaves `/auto-effort off` in force. `/auto-effort on` also releases a pin. The lock survives `/clear`; a new chat process starts steered. Bare `/effort` opens the host's picker, which offers the five levels and no auto: its choice is inferred from the effort the next turn carries, as a `via: carried` pin. Claude Code 2.1.307 runs the plugin's hook for the built-in `/effort` with its arguments as typed. The host also saves a typed `/effort <level>` as its default for new sessions (the picker's `s` keeps a choice to the session), and `/effort auto` clears that default; the plugin's pin itself ends with the chat process.

## Migrating

### From auto-effort-control

The plugin was named `auto-effort-control` from 1.0.0 to 2.0.0; it is `auto-effort` again, the name of this repository.

- **Install it under its name.** Run `claude plugin uninstall auto-effort-control@professor`, then `claude plugin install auto-effort@professor`.
- **Settings carry over, honoured and named.** An option under `pluginConfigs["auto-effort-control@…"]` and a variable `AUTO_EFFORT_CONTROL_*` are read as this name's own, below them, in both scopes, and each is reported by old and new key ([Precedence](#precedence)); move them to `pluginConfigs["auto-effort@…"]` and `AUTO_EFFORT_*`.
- **State and logs move once.** At start, `~/.local/state/auto-effort-control/`, and `$PLUGIN_LOG_DIR/auto-effort-control/` when `PLUGIN_LOG_DIR` is set, move to the same place under `auto-effort/` while that place is free, said as `former-dir-moved` in `info.jsonl`. When it is taken, both stay as they are, said as `former-dir-kept` in `warnings.jsonl`; a move that fails is an error on the screen. Nothing is overwritten or deleted.
- **The tools and the command follow the name.** The tools keep their names (`set_effort`, `effort_up`, `effort_down`, `effort_auto`) under the server prefix `mcp__auto-effort__` (was `mcp__auto-effort-control__`), and the command is `/auto-effort`; an agent that listed `mcp__auto-effort-control__…` in `tools:` names the new prefix. No alias of the old tools or command remains.
- **The state file is `version` 3.** Its keeper's last argument is `auto-effort-keeper` ([The state file](#the-state-file)).

### From auto-effort 0.x and effort-live-control

Both are retired in favour of this plugin; `auto-effort` 0.x was this plugin's name before 1.0.0, so its options and variables are this plugin's own again.

- **Old state and logs.** Nothing in `~/.local/state/effort-live-control/` is read, deleted, moved or rewritten. `~/.local/state/auto-effort/` is this plugin's own directory again: files `auto-effort` 0.x left there stay beside this plugin's. Delete the old files yourself when you no longer need them.
- **Old settings are honoured or named, never dropped.** An option under `pluginConfigs["effort-live-control@…"]` and a variable `EFFORT_LIVE_CONTROL_*` keep the sub-agent scope and are reported by old and new key; [Precedence](#precedence) lists the order, the CHANGELOG the keys.
- **Uninstall the old ones.** Run `claude plugin uninstall` for `auto-effort` 0.x and `effort-live-control`.
- **Agent definitions name the new prefix.** An agent that listed `mcp__effort-live-control__…` in `tools:` names `mcp__auto-effort__…`.

## Options

Every option is a plugin option (`userConfig`), 36 in all: edit it in `/config` or in `settings.json` under `pluginConfigs["auto-effort@professor"].options`; `/auto-effort set` also saves the main chat's single-valued ones ([`/auto-effort`](#auto-effort)). Each option can also be set in the environment of Claude Code, as `AUTO_EFFORT_` and the option name in upper snake case (`planLevel` is `AUTO_EFFORT_PLAN_LEVEL`). The main chat reads its options again at each prompt, so a change applies from the next turn without restarting the chat. The sub-agent options are resolved once when the plugin loads (at session start, and again when a settings change reloads the plugin): after a change, `/reload-plugins` or a new session applies it to sub-agents. A value that does not fit is reported (on the screen, in the plugin log and in `/auto-effort status`) and the default of its scope applies.

An option is shared by both scopes (the main chat and the sub-agents) unless its description says otherwise: `floor`, `ceiling`, `failurePatterns` and the others apply to both, and an option only one of the two former plugins had (`planLevel`, `judge`, `buttons`, ...) keeps its meaning in its own scope.

### Scoped lists: `models` and `testCommandPatterns`

The main chat and the sub-agents used different values here, so these two lists carry the scope in each entry and each scope reads only its own:

| Entry | Meaning |
| --- | --- |
| `main:claude-opus-5-5=allow` | `main:` model `=allow`, `=probation` or `=deny`: the main chat's model gate ([The model gate](#the-model-gate)). |
| `subagent:claude-opus-5-5` | `subagent:` and a model id prefix (`claude-opus-5-5` also matches `claude-opus-5-5[1m]`): a model whose sub-agent requests are steered. Any other model passes through untouched. |
| `main:\bpytest\b` and `subagent:\bpytest\b` | `testCommandPatterns`: a regular expression for one scope. An entry with no prefix applies to both. |

An entry in `models` with neither prefix is rejected with a message that gives this syntax, and the scope's default list applies. The defaults are the two former plugins' lists, each kept in its own scope: the main chat gates Haiku on probation, the sub-agents never steer it, and the `python -m unittest` and `node --test` patterns are sub-agent only. An empty list stays empty. In the environment the variable holds a JSON array of such strings, as in `AUTO_EFFORT_MODELS='["main:claude-opus-5-5=allow","subagent:claude-opus-5-5"]'`.

### Precedence

Per scope, highest first:

1. The canonical environment variable (`AUTO_EFFORT_…`), when not blank, else the former name's (`AUTO_EFFORT_CONTROL_…`).
2. The sub-agents' former variable (`EFFORT_LIVE_CONTROL_…`).
3. A canonical row set in `/config`.
4. A canonical option written in `settings.json` under `pluginConfigs["auto-effort@…"].options`.
5. A canonical option the host registered with a value other than the default.
6. The former name's `pluginConfigs["auto-effort-control@…"]` option, read as a canonical one.
7. The sub-agents' former `pluginConfigs["effort-live-control@…"]` option.
8. The canonical registered default.
9. The scope's original built-in default.

An unset or blank variable is absent. A canonical option explicitly written in `settings.json` or `/config` shadows a former one even when its value equals the default; the manifest's own defaults never shadow a former value. A variable that does not fit is reported by its name and the scope's default applies, not a lower-precedence value. Booleans take `1`, `0`, `true` or `false` in any case, lists a JSON array of strings (`[]` is the empty list), and no variable can set `stateFile` to empty (a blank variable is unset), which only the option can.

Every former source is reported by its exact old and new key, as `auto-effort: {old key} -> {new key}: honored for {scope}` or `... displaced by …` naming what displaced it, so no old setting is dropped without a word. Also reported, each naming its key: a former key this plugin does not know (`unknown option; not applied`), an option entry that is not an object, a list with a non-string entry, two marketplace entries of one identity (the lexically first qualified key wins, the rest are reported), a `settings.env` entry of a former prefix this plugin does not read, and a settings read that failed or returned nothing usable (the options that could not be inspected are named). The host offers no list of the operating system's variables, so a former variable that is set only there and is not one the plugin reads by name cannot be found. `/auto-effort status` states this limit; the plugin emits no warning for it, and it is a limit of the host, not a check that came back clean. Set such a variable under its `AUTO_EFFORT_` name or in `settings.json`'s `env`, where the plugin reads it. Nothing in `effort-live-control`'s state directory is read, moved or deleted; the `auto-effort-control` directories move once ([Migrating](#from-auto-effort-control)), and a `stateFile` under either former directory is refused for the default.

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
| `planUpshiftPatterns` | `AUTO_EFFORT_PLAN_UPSHIFT_PATTERNS` | *(none)* | Optional regular expressions, matched case-insensitively. A match starts the turn at xhigh instead of planLevel. Empty by default; set patterns to restore keyword upshifts. |
| `hintPatterns` | `AUTO_EFFORT_HINT_PATTERNS` | `\bdesign`<br>`\barchitect`<br>`\btrade-?offs?\b`<br>`\broot[- ]?causes?\b`<br>`\bspec(s\|ced\|ification)?\b`<br>`\bthink (hard\|harder\|deeply\|carefully\|it through)\b`<br>`\bultrathink\b` | Main chat only. Case-insensitive regular expressions whose matches the reminder names as hints, never level changes. Up to three distinct whole words or phrases, in prompt order, each clipped to 40 characters. |
| `planUpshiftChars` | `AUTO_EFFORT_PLAN_UPSHIFT_CHARS` | `1500` | A prompt longer than this many characters starts its turn at xhigh instead of planLevel. |
| `turnReminder` | `AUTO_EFFORT_TURN_REMINDER` | `true` | On: each prompt carries one line naming the effort the turn starts at and asking the model to call set_effort in its first response. Off: only the tool's description asks for the call. |
| `escalateAfterFailures` | `AUTO_EFFORT_ESCALATE_AFTER_FAILURES` | `2` | After this many failing test runs in a row in one turn the effort rises one step, up to the ceiling, for the requests that follow; the count then starts again. A passing test run sets the count back to 0. |
| `lowerOnPass` | `AUTO_EFFORT_LOWER_ON_PASS` | `true` | On: the first passing test run after a rise returns the effort to the level the turn had before its failing streak raised it (never below floor), unless the model set a level with set_effort since. Off: the raised level holds until the turn ends. |
| `failurePatterns` | `AUTO_EFFORT_FAILURE_PATTERNS` | `--- FAIL`<br>`FAIL(ED)?`<br>`(?<!\d)[1-9]\d* (failed\|failing)`<br>`AssertionError`<br>`panic:`<br>`Traceback` | One regular expression per entry, matched case-sensitively against the result of a test run (see testCommandPatterns). A test run whose result matches any entry fails; one that matches none passes. |
| `failureTools` | `AUTO_EFFORT_FAILURE_TOOLS` | `Bash` | One tool name per entry (Bash runs the tests). A call of these tools whose command matches testCommandPatterns is a test run; its result is matched against failurePatterns. |
| `testCommandPatterns` | `AUTO_EFFORT_TEST_COMMAND_PATTERNS` | `main:\bgo\s+(-C\s+\S+\s+)?test\b`<br>`main:\b(npm\|pnpm\|yarn\|bun)\s+(run\s+)?test\b`<br>`main:\bvitest\b`<br>`main:\bjest\b`<br>`main:\bpytest\b`<br>`main:\bcargo\s+(test\|nextest)\b`<br>`main:\bmake\b[^;&\|\n]*?\b(test\|check\|verify)\b`<br>`main:\bjust\b[^;&\|\n]*?\b(test\|check)\b`<br>`main:\b(mvn\|gradle\|gradlew)\b[^;&\|\n]*?\btest\b`<br>`main:\bdotnet\s+test\b`<br>`main:\bdeno\s+test\b`<br>`main:\bswift\s+test\b`<br>`main:\bmix\s+test\b`<br>`main:\b(rspec\|phpunit\|ctest\|tox\|nox)\b`<br>`main:\bscripts?/test[\w.-]*\.sh\b`<br>`subagent:\bgo\s+(-C\s+\S+\s+)?test\b`<br>`subagent:\b(npm\|pnpm\|yarn\|bun)\s+(run\s+)?test\b`<br>`subagent:\bvitest\b`<br>`subagent:\bjest\b`<br>`subagent:\bpytest\b`<br>`subagent:\bpython(\d(\.\d+)?)?\s+-m\s+unittest\b`<br>`subagent:\bnode\s+(--test\|--test-only)\b`<br>`subagent:\bcargo\s+(test\|nextest)\b`<br>`subagent:\bmake\b[^;&\|\n]*?\b(test\|check\|verify)\b`<br>`subagent:\bjust\b[^;&\|\n]*?\b(test\|check)\b`<br>`subagent:\b(mvn\|gradle\|gradlew)\b[^;&\|\n]*?\btest\b`<br>`subagent:\bdotnet\s+test\b`<br>`subagent:\bdeno\s+test\b`<br>`subagent:\bswift\s+test\b`<br>`subagent:\bmix\s+test\b`<br>`subagent:\b(rspec\|phpunit\|ctest\|tox\|nox)\b`<br>`subagent:\bscripts?/test[\w.-]*\.sh\b` | Regular expressions prefixed main: or subagent: select that scope; unprefixed expressions apply to both. Defaults retain each original scope. |
| `userEffortPins` | `AUTO_EFFORT_USER_EFFORT_PINS` | `true` | On: when you change the effort yourself with /effort, auto-effort stops steering that session until /effort auto or /auto-effort on. The pin survives /clear. Off: it keeps steering whatever you set. |
| `models` | `AUTO_EFFORT_MODELS` | `main:claude-opus-5-5=allow`<br>`main:claude-fable-5-1=allow`<br>`main:claude-sonnet-5-5=probation`<br>`main:claude-haiku-5-5=probation`<br>`main:claude-sonnet-5=deny`<br>`subagent:claude-opus-5-5`<br>`subagent:claude-fable-5-1`<br>`subagent:claude-sonnet-5-5` | Scope-tagged entries: main:model=allow\|probation\|deny and subagent:model-prefix. Unqualified entries are rejected. |
| `unknownModels` | `AUTO_EFFORT_UNKNOWN_MODELS` | `off` | off leaves it untouched; allow, probation and deny act as in models. |
| `probationSwitches` | `AUTO_EFFORT_PROBATION_SWITCHES` | `5` | How many effort switches in a row of a probation model must keep the cache (see canaryThreshold) before it counts as allow. |
| `canaryThreshold` | `AUTO_EFFORT_CANARY_THRESHOLD` | `0.9` | After an effort change, the switched request must read at least this fraction of the previous request's whole prompt from the prompt cache. Below it the plugin stops changing effort on that model, tells you once, and remembers across sessions until /auto-effort clear. |
| `cacheTtlSeconds` | `AUTO_EFFORT_CACHE_TTL_SECONDS` | `300` | When more than this many seconds passed between two requests the cache may have expired on its own, so the check judges nothing. 300 fits the five-minute cache; use 3600 with the one-hour cache. |
| `statusLine` | `AUTO_EFFORT_STATUS_LINE` | `true` | On: when the effort's mode, level or reason changes, a short notice shows the reason alone. The mode and level themselves are in stateFile, for a status line to show. Off: no such notice. |
| `stateFile` | `AUTO_EFFORT_STATE_FILE` | `~/.local/state/auto-effort/state.json` | One JSON line per session naming the mode the main chat's effort is in (auto, model, pin or off), its level, the reason and the keeper that vouches for it, rewritten when one of them changes; the line at a path the plugin leaves is retired (keeper 0). The session id is inserted before the extension (state.<session>.json). A leading ~ is your home directory; a relative path is under the session's working directory, so give an absolute one. Empty: no file. |
| `parentTag` | `AUTO_EFFORT_PARENT_TAG` | `honor` | `honor`: a tag on the Agent prompt wins over the `effort:` of the agent's definition, and a steered agent starts at the tag held within its floor and ceiling. `ignore`: the definition's `effort:` keeps and the tag is ignored. `effortControl.parentTag` overrides it. |
| `judge` | `AUTO_EFFORT_JUDGE` | `false` | Off (default): every tripwire (a failing test run, a sub-task that returned red, a red result sent back) raises the effort one step. On: a tripwire makes one cheap model call that estimates the probability that the trouble continues; the effort rises one step only when it is at least judgeRaiseAt. An agent's effortControl.judge overrides it. |
| `judgeRaiseAt` | `AUTO_EFFORT_JUDGE_RAISE_AT` | `25` | With the judge on: a probability (0 to 100) at or above this raises the effort one step; below it the effort holds. The judge never lowers it. |
| `tripwires` | `AUTO_EFFORT_TRIPWIRES` | `fail1,fail2,red,redispatch` | The armed tripwires, comma-separated: `fail1` (the first failing test run), `fail2` (the 2nd failing run in a row, then every even count), `red` (a sub-task returned red), `redispatch` (a red result sent back). A disarmed tripwire is counted but raises nothing; empty arms none. `effortControl.tripwires` overrides it. |
| `struggleDecay` | `AUTO_EFFORT_STRUGGLE_DECAY` | `20` | A steered agent's open struggle ends once it has made this many requests without a new tripwire: its effort returns to the level it had before, and the red sub-agent returns still open and the failing-test streak are cleared. A later tripwire opens a new struggle. `0` turns it off. `effortControl.struggleDecay` overrides it. |
| `judgeModel` | `AUTO_EFFORT_JUDGE_MODEL` | `haiku` | The model alias or id of the judge call (it costs one call per tripwire). |
| `judgeEffort` | `AUTO_EFFORT_JUDGE_EFFORT` | `xhigh` | The reasoning effort of the judge call: low, medium, high, xhigh or max. |
| `judgeTimeoutMs` | `AUTO_EFFORT_JUDGE_TIMEOUT_MS` | `45000` | A judge call that has not answered after this many milliseconds is dropped and the effort rises one step instead. |
| `buttons` | `AUTO_EFFORT_BUTTONS` | `true` | On: every agent can call effort_up, effort_down and effort_auto; a live-controlled agent moves its own effort one step and holds it there until effort_auto hands it back to the automatic rules at its home level; any other agent is refused, the main chat with the name of its own effort control. Off: the tools are not registered. |
| `announce` | `AUTO_EFFORT_ANNOUNCE` | `true` | On: the agent's next tool result carries one line naming its new effort and why. Off: it is not told. |
| `readOnlyCommands` | `AUTO_EFFORT_READ_ONLY_COMMANDS` | `cat`<br>`grep`<br>`egrep`<br>`fgrep`<br>`rg`<br>`ag`<br>`ack`<br>`echo`<br>`printf`<br>`sed`<br>`awk`<br>`head`<br>`tail`<br>`less`<br>`more`<br>`ls`<br>`find`<br>`fd`<br>`git`<br>`wc`<br>`which`<br>`type`<br>`man`<br>`file`<br>`stat`<br>`diff`<br>`jq`<br>`yq`<br>`sort`<br>`uniq`<br>`cut`<br>`tr`<br>`tee`<br>`test`<br>`[`<br>`[[`<br>`cd`<br>`pushd`<br>`popd`<br>`mkdir`<br>`rm`<br>`cp`<br>`mv`<br>`touch`<br>`chmod`<br>`ln`<br>`basename`<br>`dirname`<br>`realpath`<br>`readlink`<br>`date`<br>`sleep`<br>`true`<br>`false`<br>`export`<br>`read`<br>`wait`<br>`kill` | One program name per entry. A command whose program is listed is skipped when a Bash call is checked for a test run, so grep, cat, echo or git naming a test command is not one. The Bash call is split at ; & \| and newlines, heredoc bodies are dropped, and env, time, nice, nohup, sudo, command, exec and timeout are looked through. source and . are not listed because they execute. A foreground Bash call whose every command is listed is also a file read, the only shell call a return line is read from. |
| `redWords` | `AUTO_EFFORT_RED_WORDS` | `FAIL`<br>`FAILED`<br>`BLOCKED`<br>`PARTIAL`<br>`SPEC-DRIFT` | A sub-agent answer or a read result whose line is WORD, WORD name or WORD name: detail with one of these words is a failed return. Case-sensitive. |
| `greenWords` | `AUTO_EFFORT_GREEN_WORDS` | `DONE`<br>`PASS`<br>`FIXED` | Like redWords, for a return that clears an earlier red one from the same unit. |
| `agentDirs` | `AUTO_EFFORT_AGENT_DIRS` | *(none)* | One directory per entry, searched after .claude/agents of the project, of CLAUDE_CONFIG_DIR and of the home directory, for the definition of an agent type (its effort and effortControl). |
| `logPackets` | `AUTO_EFFORT_LOG_PACKETS` | `false` | On: judge rows carry the snapshot sent to the judge and its answer, which holds the agent's opening brief and last words. Off: they do not. |

## The state file

One JSON line per session at `stateFile` (`state.<session>.json`), rewritten whole when the mode, the level, the reason or the keeper changes, so a status line can show the main chat's effort:

```json
{"version":3,"mode":"auto","level":"medium","reason":"planning turn","keeper":48213,"updatedAt":"2026-10-17T09:30:00.000Z"}
```

| `mode` | `level` | When |
| --- | --- | --- |
| `auto` | The level the turn runs at; `null` before the first request | The automatic rules decide: the planned level, test-failure rises. |
| `model` | The model's own level | The model set it with `set_effort`; it holds until this turn ends or `set_effort` with `auto`. |
| `pin` | Your `/effort` level | You set `/effort`; `/effort auto` or `/auto-effort on` resumes. |
| `off` | `null` | `/auto-effort off`, the model gate leaves the model untouched, or the model takes no effort level. |

`keeper` says whether anything still stands behind the line. While the plugin is loaded it runs a keeper, `/bin/sh -c 'echo $$; while kill -0 "$PPID" 2>/dev/null; do sleep 2; done' auto-effort-keeper`: the host kills it when the plugin unloads (disabled, reloaded, or its process ending), and it exits within two seconds of the process that started it. The line names its pid, the first line it prints on stdout; what the shell writes to stderr is no pid. A reader trusts the line only while a live process at that pid has `auto-effort-keeper` among its arguments; any other line is stale, a state nothing steers, to show as such and never as the mode it names. `keeper` is `0` when no keeper vouches: the plugin writes the line's last state with `0` at the session's end and on leaving a path (`stateFile` moved or emptied, a new session after `/clear`), and as soon as no keeper runs (a keeper that cannot start is said once until one starts, each keeper that ends once; the next prompt starts another). A retire that cannot be written is tried again at each later write, and said once per path; a publish still running for a session that ended writes nothing.

`reason` holds at most 60 characters; `version` changes only when a field changes meaning or the keeper's argument changes (3 since the keeper became `auto-effort-keeper`). No file means no session of this plugin wrote one; a file a reader cannot parse, or one without an integer `keeper` of `0` or more, is an error to show as one, never as `auto`. The host's file writer promises no atomic replace, so a reader that finds a partial line reads it again. The plugin never removes a file, it retires it. A limit: a dead keeper's pid the system hands to another session's keeper reads live until that line is rewritten.

## The decision log

The decision log lives in the plugin log directory (§ Logs): `$PLUGIN_LOG_DIR/auto-effort/`, or `~/.local/state/auto-effort/logs/` when `PLUGIN_LOG_DIR` is unset; no option or variable moves it. With neither `PLUGIN_LOG_DIR` nor `HOME`, there is no decision log, and an error says so once. Each scope writes its own file there, so two writers never share one and each keeps its own cap. The session id is inserted before the extension. Never the prompt text, except the judge packets `logPackets` writes when you turn it on.

The main chat writes `decisions.<session>.jsonl`, a new numbered file every 1000 rows (`decisions.<session>.2.jsonl`, ...):

| `event` | When |
| --- | --- |
| `decision` | A turn's first request: the level, what decided it (`plan`, `pin`), and the reason; `hints` holds matching pattern sources or `null`, never the matched prompt words. |
| `step` | Each main-chat request: the level sent, the token counts, the time it took. |
| `switch` | An effort change between two requests of one model. |
| `set_effort` | Each call of the tool: the level asked (or `auto`), the level applied, the reason given. |
| `escalation` | A rise from failing test runs; `held: override` when the model's own level kept the effort where it was. |
| `deescalation` | A passing test run returning the level to where the failing streak found it (`lowerOnPass`). |
| `canary` | The cache check of a switch: `ok`, `fail` or `skip` with the reason. |
| `gate` | A model graduating from probation, or marked unsafe. |
| `pin` | A recognised `/effort` change: `via: command` for an explicit level, `via: carried` for a changed request effort. |
| `unpin` | `/effort auto`, with `via: command` and the released pin level (or `null`). |
| `turn` | A turn's summary: start and end level, steps, switches, calls, tokens. |
| `option-error` | An option value that was rejected. |

The sub-agents write `decisions.<session>.subagent.jsonl`, the newest 5,000 rows. Every row has `ts`, `event`, `agent` (an id, or `main`) and `type`:

| `event` | When |
| --- | --- |
| `step` | Each steered sub-agent request: `model`, `requested`, `sent`, `struggle`. |
| `tag` | A spawn tag read: `tag`, `effort`; `home` and `clamped` for a steered agent. `tag-ignored` when `parentTag: ignore` kept the definition's effort. |
| `tripwire` | A tripwire: `tripwire`, `level`, `held` (a tripwire under a held level). |
| `judge`, `judge-failed`, `judge-stale`, `judge-busy` | The judge's answer (`tripwire`, `p`, `from`, `to`, `reason`, `ms`, `usage`), its failure, a late answer for a closed struggle, a call already in flight. |
| `mechanical` | A one-step rise without the judge (`tripwire`, `from`, `to`; `busy` when it replaced a stale judge call). |
| `resolved` | A struggle ending (`from`, `to`, `requests`, `why`: `resolved` or `decay`). |
| `landing` | A `landing` type spawned. |
| `button`, `auto`, `button-refused` | An `effort_up` or `effort_down` press (`direction`, `from`, `to`), an `effort_auto` press (`held`: whether a press held the level), a refused press (`direction`: `up`, `down` or `auto`). |
| `model-gated`, `not-steered` | A request on a model the scope does not steer; an agent not steered. |
| `end` | A summary of the agent's requests by level, struggles and judge calls. |
| `plugin-log-failed` | A level-log append failed (`error`). |

## Limits

- A sub-agent is steered by its tag and by `effortControl` only: the model's `set_effort` level, the automatic rules and the cache check belong to the main chat, and a sub-agent without a tag keeps the effort its first request carries.
- The session's on/off, a `/effort` pin and the model's own level are kept per session id in the host's plugin state, so a `/reload-plugins` or a settings change (in `/config` or by `/auto-effort set`), which reloads the plugin, keeps them. They do not survive closing the chat. `/clear` starts a new session: on, keeping the user pin, with no model override and with its own log file. A saved model override without a turn id expires at the next turn. The model marks and probation counts are saved and shared by every chat on the machine; a chat's save rewrites only the models it changed, so for one model the last write wins.
- `testCommandPatterns` and `failurePatterns` entries are regular expressions you write, run over every main-loop Bash command and every test run's result. They are checked for syntax only, so a pattern that backtracks without end (such as `(a+)+$`) can stall the plugin's tool-result hook on a long result; the host treats a hook that overruns as absent and the result goes through unchanged. Keep patterns plain.
- The only effort control the plugin has is the request's `effort` field, set per request. It observes explicit `/effort` arguments through `command.run`. The picker path is inferred from a change in carried effort between turns on the same model, so choosing the same level cannot be inferred.
- A test run is recognised by its command alone: a test runner no `testCommandPatterns` entry names counts nothing, and a command that merely mentions one (`grep pytest notes.md`) counts. Add your own runner or script as an entry.
- A test run's verdict is text in its result: one that prints none of the `failurePatterns` counts as passing, even when it failed some other way (a compile error, a crash before the first test).

## Development

```bash
npm install
npm test            # unit and adapter tests (vitest), both scopes
npm run typecheck   # the repo and the hooks module
npm run validate:plugin
npm run release:check
```

`plugins/auto-effort/` is everything that installs. `src/` holds the main chat's decisions and `src/subagent/` the sub-agents', each a pure, unit-tested function; `src/options.ts` is the one option set and its precedence. `hooks/auto-effort.ts` is the only file that touches the engine: one module that registers each event once and routes by whose event it is. `CLAUDE.md` is the contributor guide.

## Credit

Built by Reza with [Professor](https://github.com/rezzminator/professor). MIT licensed.

## Logs

Errors, warnings and info append to `errors.jsonl`, `warnings.jsonl` and `info.jsonl` under `$PLUGIN_LOG_DIR/auto-effort/`, for both scopes. With `PLUGIN_LOG_DIR` unset they use `$HOME/.local/state/auto-effort/logs/`. Each row identifies its event and relative component. Rows are limited to 4096 bytes, and a file past 20 MiB moves aside to `.1`, older ones shifting up to `.5`, with a `log-capped` row in `warnings.jsonl`. Error diagnostics appear on screen immediately and are also logged. Warning and info diagnostics never reach the screen, including cache-safety warnings and optional status-display failures, even when their log cannot be written. When no log directory can be resolved or a log write fails, one screen line says so per failing streak, re-armed after a successful write; a failed write keeps its rows for the next one (up to 2,000, then the oldest go and an error row counts them). Invalid settings and failures of registration, state persistence, settings reads or effort control are errors, not warnings: the requested feature could not complete. The level status line, `set_effort` replies, escalation/de-escalation context and `/auto-effort` command replies are requested product output, not diagnostics, and remain unchanged. The decision logs (`decisions.<session>.jsonl`, `decisions.<session>.subagent.jsonl`) share this directory; § The decision log describes them. The writer is one shared plugin-log library, vendored as `src/plugin-log.ts`.
