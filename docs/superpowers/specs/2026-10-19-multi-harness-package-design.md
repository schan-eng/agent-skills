# Multi-harness package — design

- **Date:** 2026-10-19
- **Status:** Draft for review
- **Scope:** Part 1 of 3 (see "Later parts" at the end)

## Goal

Turn this repo into one package that installs in Claude Code, Codex and
OpenCode with each tool's own installer. One install gives the user every
skill in `skills/`, including humanizer. The automatic hooks ship with the
package but stay off until the user turns them on.

The package is meant to become public. This part ends with the repo still
private; Part 2 makes it ready to publish.

## Why

- Today nothing installs cleanly. `setup.sh` only works when the repo sits at
  `~/.agents`, the Claude Code wiring lives outside the repo, and Codex has no
  wiring at all.
- The OpenCode plugin has `~/.agents/hooks/agent_activity.py` written into it.
- Humanizer lives in a separate repo with its own install.

## Decisions

| Topic | Decision |
|---|---|
| Pattern | One repo, one plugin, a manifest per tool (the Superpowers pattern) |
| Plugin and catalog name | `agent-skills`; install as `agent-skills@agent-skills` |
| Codex manifests | None of its own. Codex reads `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` |
| OpenCode | V1: skills, commands and hooks. V2: skills and commands only |
| Automatic hooks | Installed everywhere, off until the user turns them on |
| Hook records | Move from `<project>/.claude/` to `~/.cache/agent-skills/<project>/` |
| Humanizer | Pulled into `skills/humanizer/` with `git subtree --squash` from the user's fork |
| `tools/agent-board` | Stays in the repo; no tool wires it up |
| Work-specific skill content | Unchanged in this part; generalized in Part 2 |

## Repo layout

```
agent-skills/
├── skills/                          # single source for every tool
│   ├── <8 existing skills>/
│   ├── toggle/                      # new: flips the switches
│   └── humanizer/                   # git subtree of schan-eng/humanizer
├── hooks/
│   ├── hooks.json                   # Claude Code and Codex
│   ├── agent_activity.py            # runtime; gains a `hook` entry point
│   └── test_agent_activity.py
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json             # one entry, "source": "./"
├── .opencode/plugins/agent-skills.ts  # moved from opencode/plugin/agent-hooks.ts
├── index.js                         # OpenCode V2 directory-form entry
├── package.json                     # name "agent-skills", "main" -> the OpenCode plugin
├── scripts/
│   ├── bump-version.sh              # one version in every manifest
│   ├── check-package.mjs            # package checks (see Testing)
│   └── update-humanizer.sh          # git subtree pull
├── docs/testing.md                  # manual install checklist
├── tools/agent-board/               # unchanged, not installed by any tool
├── .github/workflows/test.yml
├── LICENSE                          # MIT
└── README.md
```

Removed: `setup.sh`, the `setup` npm script, and the whole `opencode/` folder
(the plugin moves; the 8 command wrappers are deleted).

## Install and loading

| Tool | Install | Skills load from | User calls a skill with |
|---|---|---|---|
| Claude Code | `/plugin marketplace add schan-eng/agent-skills`, then `/plugin install agent-skills@agent-skills` | `skills/` (found automatically) | `/agent-skills:<name>` |
| Codex | `codex plugin marketplace add schan-eng/agent-skills`, then `codex plugin add agent-skills@agent-skills` | `skills/` (default folder) | `$<name>` or the `/skills` picker |
| OpenCode | Add `"agent-skills@git+https://github.com/schan-eng/agent-skills.git"` to `plugin` (V1) or `plugins` (V2) in `opencode.json` | The plugin registers `skills/` | `/<name>` |
| Other agents | `npx skills add schan-eng/agent-skills` | Copied skill folders; no hooks | Depends on the agent |

**Manual-only skills in Codex.** Codex ignores `disable-model-invocation`.
Every skill with `disable-model-invocation: true` gets
`skills/<name>/agents/openai.yaml` that turns off implicit use
(`allow_implicit_invocation: false`). Today that is `decompose`,
`linear-project-update`, `recommend-reviewer`, `remind-me`, plus the new
`toggle`. A package check keeps the two settings in step.

**OpenCode commands.** OpenCode V1 turns every skill it finds into a `/name`
command, so no wrapper files are needed. If testing shows that skills
registered by a plugin do not become commands, the V1 plugin registers them
itself through the config hook (`config.command[name] = { template, description }`),
one per skill with `user-invocable: true`.

**Local development.**
- Claude Code: `claude --plugin-dir .`, or `claude plugin marketplace add ./`.
- Codex: `codex plugin marketplace add ./`.
- OpenCode: point `plugin` at the clone's absolute path (`~` is not expanded).

**Duplicates.** If a user also copies the skills into `~/.agents/skills`
(for example with `npx skills add`), OpenCode and Codex show them twice. The
README says to use one method per tool.

## Hooks and the switch file

### What the hooks do

| Job | Event | Switch |
|---|---|---|
| Track edited files and line counts | After an edit tool runs | `autoReview` |
| Make the agent run `intent-check` and `simplify` on tracked edits | End of turn | `autoReview` |
| Record each skill the agent uses | After a skill runs | `prSkillReport` |
| Render the "skills used" report | End of turn | `prSkillReport` |
| Block `gh pr create` / `gh pr edit` until the PR body has the current report | Before a shell command | `prSkillReport` |

The logic is the same as today. Only where it runs, where it stores data, and
the switches are new.

### The switch file

- Path: `$XDG_CONFIG_HOME/agent-skills/settings.json`, falling back to
  `~/.config/agent-skills/settings.json`. Tests override it with the
  `AGENT_SKILLS_CONFIG` environment variable.
- Content: `{"autoReview": false, "prSkillReport": false}`. Part 3 adds `ste`.
- A missing file means everything is off. An unreadable or invalid file also
  means everything is off, and the hook prints one warning to stderr.
- Unknown keys are ignored.
- Every hook reads the file first. When its switch is off it exits at once
  with no output and writes nothing.

### The `toggle` skill

- `skills/toggle/SKILL.md`, `user-invocable: true`,
  `disable-model-invocation: true`, plus its `openai.yaml`.
- Input: `<switch> on|off`, where the switch is `auto-review` or
  `pr-skill-report`. No input prints the current state of each switch.
- It edits the settings file directly (creating it if needed) and keeps any
  keys it does not know. No script is involved, so it works the same in
  every tool.
- Calls: `/agent-skills:toggle auto-review on` (Claude Code),
  `$toggle auto-review on` (Codex), `/toggle auto-review on` (OpenCode).

### Records location

- Records move to `$XDG_CACHE_HOME/agent-skills/<project-key>/`, falling back
  to `~/.cache/agent-skills/<project-key>/`.
- `<project-key>` is `<repo folder name>-<first 8 hex chars of sha256 of the
  absolute repo root>`. That keeps it readable and unique per checkout.
- The PR check already gives the agent the report's full path, so nothing
  else depends on the old `.claude/` location.
- Pending-edit files stay in the system temp folder, as today.

### Claude Code and Codex wiring

- One `hooks/hooks.json` with three hooks: before shell commands, after tool
  use, and end of turn (`Stop`).
- Each calls `python3 "${CLAUDE_PLUGIN_ROOT}/hooks/agent_activity.py" hook`.
  Codex sets `CLAUDE_PLUGIN_ROOT` too. Calling through `python3` avoids
  relying on the file's executable flag, which Codex's install cache drops.
- The new `hook` entry point reads the hook data from stdin, picks the job
  from `hook_event_name` and `tool_name`, and writes the reply each tool
  expects.
- It recognizes each tool's names: Claude Code's `Edit`, `Write`,
  `MultiEdit`, `NotebookEdit`, `Bash` and `Skill`, and Codex's `apply_patch`
  and shell tool. The exact Codex names come from captured real payloads
  (first task in the plan).
- The patch reader (which files an `apply_patch` touches, and how many lines)
  moves from the OpenCode plugin into Python, so all tools share it. The
  OpenCode plugin calls it through the runtime.
- Blocking the PR command uses `PreToolUse` with
  `permissionDecision: "deny"` and the reason.
- End-of-turn review:
  1. On `Stop`, if `autoReview` is on and there are pending edits, claim them
     and block the stop with the review instruction (the same text the
     OpenCode plugin sends today). Mark the session as "in review".
  2. While in review, edits are not tracked, so `simplify`'s own edits do not
     start another review. The hook still notes whether `intent-check` and
     `simplify` ran, even when `prSkillReport` is off; this note is session
     state only, not the skill record.
  3. On the next `Stop` (`stop_hook_active` is true), clear the review state
     and let the turn end. If either skill did not run, put the claimed edits
     back so the next turn reviews them.

### OpenCode wiring

- **V1 (full).** The current plugin logic, with three changes:
  - It finds `agent_activity.py` from its own location
    (`import.meta.url`), not `~/.agents`.
  - It reads the switch file before each job.
  - Its config hook adds the absolute `skills/` path to `config.skills.paths`.
- **V2 (skills only).** `setup()` registers each skill with
  `ctx.skill.transform`, with every `add` in its own try/catch so one bad
  skill cannot disable the plugin. No hooks.
- **One file serves both**, following Superpowers' pattern: a named function
  export for V1 and a default `{ id, setup, server }` export for V2, with
  `setup()` guarded against a V1-shaped context.
- Root `index.js` re-exports the plugin for V2 local installs, which require a
  folder path.

### Requirements and limits

- Hooks need `python3` on the PATH. Skills do not.
- Windows is untested. Hooks are off by default, so Windows users still get
  the skills.
- Codex asks each user to approve the plugin's hooks in `/hooks`, even while
  every switch is off, and again whenever a hook changes. The README explains
  this.

## Humanizer

1. In `~/Documents/GitHub/humanizer`: drop the two commits that only add
   `.DS_Store` files (`c945506`, `9bdd6ef`), add `.DS_Store` to its
   `.gitignore`, merge `persona-library` into `main`, and push to the fork.
   Pushing needs the user's go-ahead at that step.
2. In this repo:
   `git subtree add --prefix=skills/humanizer https://github.com/schan-eng/humanizer.git main --squash`.
3. `scripts/update-humanizer.sh` runs the matching `git subtree pull ... --squash`.
   To take changes from `blader/humanizer`, sync the fork first.
4. Rule: change humanizer in the fork, never inside `skills/humanizer/`.
5. Its MIT `LICENSE` stays in `skills/humanizer/`. The README credits
   `blader/humanizer`. Humanizer keeps its own version (3.2.0).

## Testing

### Automated (`npm test`, and GitHub Actions on every push and PR)

- **Python runtime.** Feed the `hook` entry point saved Claude Code and Codex
  payloads (edit, `apply_patch`, skill use, `gh pr create`, `Stop`, and a
  second `Stop` with `stop_hook_active`). Check the replies, that switches set
  to off mean no output and no files, and that records land in the cache
  folder.
- **OpenCode plugin.** Update the existing tests for the new runtime path and
  the switch file. Add a V2 `setup()` test with a fake `ctx`.
- **Package checks** (`scripts/check-package.mjs`):
  - the version is the same in `.claude-plugin/plugin.json`,
    `.claude-plugin/marketplace.json` and `package.json`;
  - every `skills/*/SKILL.md` has `name` and `description`, and `name`
    matches its folder;
  - `disable-model-invocation: true` and an `openai.yaml` with implicit use
    turned off always come together;
  - no `~/.agents` or `.agents/hooks` paths remain;
  - every hook command runs through `python3` and uses `${CLAUDE_PLUGIN_ROOT}`.
- `npm run typecheck` covers the OpenCode plugin.

### Manual install checklist (`docs/testing.md`)

Run in a throwaway test repo, never in a real project. Script with `claude -p`
and `codex exec` where possible.

| Tool | Checks |
|---|---|
| Claude Code | Install from the local folder through the marketplace. `/agent-skills:simplify` and `/agent-skills:humanizer` load. With `autoReview` on, editing a file triggers both checks at end of turn; with it off, nothing runs. With `prSkillReport` on, `gh pr create` without the report is blocked. |
| Codex | Same checks with `codex plugin marketplace add ./`, `$simplify`, and hook approval in `/hooks`. Manual-only skills are not picked on their own. |
| OpenCode V1 | Same checks with the plugin pointed at the local folder. Needs OpenCode installed; ask before `brew install`. |
| OpenCode V2 | Skills and commands appear. No hooks run. |

Also confirm in every tool: humanizer's own `.claude-plugin/` is not loaded
as a second plugin, and humanizer's persona files load.

## Release

- `scripts/bump-version.sh <version>` sets the version in all three files.
  First release is `0.1.0`, tagged `v0.1.0` so OpenCode users can pin it.
- Rewrite the README: install per tool, the switch file and `toggle`,
  requirements, the duplicate-skills note, Codex hook approval, credits.
  Remove the `~/.agents` and `setup.sh` instructions.
- Update `hooks/README.md` for the new wiring and records location.
- Add an MIT `LICENSE`.
- Before starting, check whether `schan-eng/agent-skills` is already public.
  If it is, the Kindo-specific content is already exposed and Part 2 moves up.

## To verify during planning

Each item has a fallback, so none blocks the design.

1. **Claude Code `Stop` block format.** The background reports disagree
   (`{"decision":"block","reason":...}` at the top level vs. inside
   `hookSpecificOutput`). Check the hooks docs; test both tools.
2. **Codex tool names in hook payloads.** Capture real payloads before writing
   the parser.
3. **Codex reads the Claude manifests**, including the `"./"` source and the
   default `skills/` folder. Fallback: add `.codex-plugin/plugin.json` and
   `.agents/plugins/marketplace.json`.
4. **OpenCode V1 turns plugin-registered skills into commands.** Fallback: the
   config-hook command registration above.
5. **OpenCode loads a `.ts` file as `main` from a git install.** Fallback:
   write the plugin in plain JavaScript, as Superpowers does.
6. **The exact `openai.yaml` key** for turning off implicit use.
7. **Nested humanizer manifests are ignored** by all three tools. Fallback:
   delete them in the fork.

## Later parts

- **Part 2: ready to publish.** Generalize the work-specific skills (Kindo
  paths, cluster checks; Linear and Slack become optional extras). Fix the
  `self-review` references to a skill that does not exist here. Use
  `skill-creator` evals to show each rewritten skill still works and still
  triggers. Then make the repo public.
- **Part 3: STE mode.** An ASD-STE100 writing mode as a skill in this package,
  using the switch file (`ste`) and the hooks shipped here. Build it with
  `superpowers:writing-skills`. Notes so far: inject the rules at session
  start plus a short reminder each turn; in OpenCode, inject through the
  message history, not the system prompt; write our own short word list and
  do not copy ASD's dictionary.
