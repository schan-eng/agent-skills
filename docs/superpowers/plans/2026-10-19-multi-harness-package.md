# Multi-harness Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this repo one plugin that installs in Claude Code, Codex and OpenCode with each tool's own installer, with the automatic hooks shipped but off until the user turns them on.

**Architecture:** `skills/` stays the single source. Claude Code and Codex both read `.claude-plugin/` manifests and one `hooks/hooks.json`, which calls a new `hook` entry point in the existing Python runtime. The OpenCode plugin moves to `.opencode/plugins/`, calls the same runtime for every job, and also registers the skills (V1 fully, V2 skills only). A per-user switch file turns hook jobs on.

**Tech Stack:** Python 3.9+ standard library (hook runtime), TypeScript run directly by Node 22 and Bun (OpenCode plugin), Node's test runner, `unittest`, git subtree, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-19-multi-harness-package-design.md`

## Global Constraints

- The Python runtime uses only the standard library and must run on Python 3.9 (macOS's built-in `/usr/bin/python3` is 3.9.6). Keep `from __future__ import annotations`. Do not use `datetime.UTC`, `match`, `zip(strict=...)`, or `X | Y` types outside annotations.
- Tests run on Node 22+ with `node --experimental-strip-types --test`. The OpenCode plugin keeps type-only imports so Node and Bun load it without a build step.
- Names: plugin `agent-skills`, marketplace `agent-skills`, npm package `agent-skills`, OpenCode plugin id `agent-skills`. First version `0.1.0`.
- Switch file: `$AGENT_SKILLS_CONFIG`, else `$XDG_CONFIG_HOME/agent-skills/settings.json`, else `~/.config/agent-skills/settings.json`. Keys `autoReview` and `prSkillReport`. Only the JSON value `true` turns a switch on.
- Records: `$XDG_CACHE_HOME/agent-skills/<project-key>/`, else `~/.cache/agent-skills/<project-key>/`. `<project-key>` is `<repo folder name>-<first 8 hex chars of sha256 of the absolute repo root>`.
- Every hook command is exactly: `python3 "${CLAUDE_PLUGIN_ROOT}/hooks/agent_activity.py" hook`
- A hook whose switch is off exits 0, prints nothing and writes nothing. A hook that hits an unexpected error also exits 0 and prints nothing.
- Never edit the user's own tool config (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`) by hand. Payload captures and manual checks run in throwaway repos made with `mktemp -d`, using `AGENT_SKILLS_CONFIG` and `XDG_CACHE_HOME` overrides.
- Ask the user before: pushing anything to GitHub, installing software (`npm ci`, `brew install`), any web request, and registering a marketplace with a tool's own installer.
- Docs use plain English: short sentences, everyday words.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec deviation: there are four hooks, not three. `UserPromptSubmit` clears review state when the user interrupts a review (Task 7 updates the spec).

## Review Focus

1. The user interrupts the end-of-turn review and types a new prompt: the claimed edits come back and later edits are tracked again (Task 7, `test_user_prompt_during_review_restores_and_resumes_tracking`).
2. A switch file with non-boolean values (`"true"`, `1`) or a JSON array: every switch is off, nothing crashes (Task 3, `test_only_literal_true_turns_a_switch_on`, `test_invalid_settings_warn_once_and_turn_everything_off`).
3. A hook runs outside any git repo, or gets stdin that is not JSON: outside git the cwd names the project, and bad stdin prints nothing (Task 3, `test_project_state_dir_outside_git_uses_cwd`; Task 6, `test_bad_stdin_prints_nothing`).
4. Codex gives no reliable sign that a skill ran: the review must end after one round and never loop (Task 7, `test_codex_review_ends_after_one_round`).
5. The plugin is installed under a path with spaces: the hook command must quote the plugin root (Task 9, `reports unquoted plugin root in a hook command`).

---

### Task 1: Green baseline in the new layout

**Files:**
- Modify: `hooks/agent_activity.py` (`timestamp`)
- Move: `opencode/plugin/agent-hooks.ts` → `.opencode/plugins/agent-skills.ts`
- Move: `opencode/plugin/agent-hooks.test.ts` → `tests/opencode/agent-skills.test.ts`
- Delete: `setup.sh`
- Modify: `package.json`, `tsconfig.json`
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Produces: the plugin resolves its runtime as `<repo root>/hooks/agent_activity.py` from `import.meta.url`; the test resolves it as `fileURLToPath(new URL("../../hooks/agent_activity.py", import.meta.url))`.

- [ ] **Step 1: Check whether the GitHub repo is public.** Ask the user, or with their OK run `curl -s -o /dev/null -w '%{http_code}' https://github.com/schan-eng/agent-skills` (200 = public, 404 = private). If it is public, stop and tell the user: the Kindo content is already exposed and Part 2 should come first.

- [ ] **Step 2: Run the Python tests to see the failure**

Run: `python3 -m unittest -v hooks/test_agent_activity.py`
Expected: `FAILED (errors=4)`, each with `AttributeError: module 'datetime' has no attribute 'UTC'`

- [ ] **Step 3: Make `timestamp()` use `datetime.timezone.utc`** in `hooks/agent_activity.py`.

- [ ] **Step 4: Run the Python tests again**

Run: `python3 -m unittest -v hooks/test_agent_activity.py`
Expected: `Ran 11 tests` … `OK`

- [ ] **Step 5: Move the OpenCode plugin and its test** with `git mv`. In the plugin, replace the `homedir()` runtime path with one built from `dirname(fileURLToPath(import.meta.url))` plus `../../hooks/agent_activity.py`. In the test, import from `../../.opencode/plugins/agent-skills.ts` and build `runtime` the same way. Drop now-unused `homedir` imports. Remove `setup.sh` and the empty `opencode/plugin/` folder; leave `opencode/commands/` until Task 10.

- [ ] **Step 6: Update `package.json` and `tsconfig.json`**

`package.json`: set `"name": "agent-skills"`, delete the `setup` script, and set:

```json
"test": "node --experimental-strip-types --test \"tests/opencode/*.test.ts\" && python3 -m unittest discover -s hooks -p \"test_*.py\" -v && node --test \"tools/agent-board/test/*.test.mjs\""
```

`tsconfig.json`: `"include": [".opencode/**/*.ts", "tests/**/*.ts"]`.

- [ ] **Step 7: Add CI.** `.github/workflows/test.yml` runs on `push` and `pull_request`, with a matrix of Python `3.9` and `3.12`, Node `22`: checkout, `actions/setup-node`, `actions/setup-python`, `npm ci`, `npm run typecheck`, `npm test`.

- [ ] **Step 8: Install dev dependencies and run everything.** Ask the user before `npm ci`.

Run: `npm ci && npm run typecheck && npm test`
Expected: typecheck has no output; the OpenCode tests report `# pass 7`, Python reports `OK`, agent-board tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A hooks/agent_activity.py .opencode tests package.json tsconfig.json .github setup.sh opencode
git commit -m "Move the OpenCode plugin into .opencode and get the tests passing on Python 3.9"
```

---

### Task 2: Capture real hook payloads

Discovery task: no production code. It turns the spec's open questions into test fixtures and written answers.

**Files:**
- Create: `hooks/fixtures/capture.py`
- Create: `hooks/fixtures/claude/{pre-bash.json,post-edit.json,post-write.json,post-skill.json,stop.json,user-prompt.json}`
- Create: `hooks/fixtures/codex/{pre-shell.json,post-apply-patch.json,post-shell.json,stop.json,user-prompt.json}` plus any file that shows skill use
- Modify: the spec's "To verify during planning" section (items 1, 2 and 6, plus two new findings)

**Interfaces:**
- Produces: the fixture files above, with the throwaway repo path replaced by `/work/demo` and home paths by `/home/user`. Edited files live at `/work/demo/src/example.ts`.
- Produces, written into the spec: (a) the `Stop` "block" reply format for each tool; (b) Codex's shell tool name and the field holding the command; (c) the field holding `apply_patch` text; (d) how skill use shows up in Codex, if at all; (e) the payload field that tells Claude Code from Codex; (f) the exact `openai.yaml` key that turns off implicit use.

- [ ] **Step 1: Make sure both tools are logged in.** If `codex login status` prints `Not logged in`, ask the user to run `! codex login`.

- [ ] **Step 2: Write `hooks/fixtures/capture.py`.** It takes the platform name as `argv[1]`, reads stdin, and writes it unchanged to `$CAPTURE_DIR/<platform>-<hook_event_name>-<tool_name or "none">-<n>.json`. `n` counts up from 1. It prints nothing and always exits 0.

- [ ] **Step 3: Build a throwaway repo.** `T=$(mktemp -d)`, `git init`, add `src/example.ts` with a few lines, and copy `skills/simplify` into `$T/.claude/skills/` and `$T/.agents/skills/`.

- [ ] **Step 4: Capture Claude Code.** Write `$T/.claude/settings.json` registering `PreToolUse`, `PostToolUse` (matcher `*`), `Stop` and `UserPromptSubmit`, each calling `python3 <repo>/hooks/fixtures/capture.py claude`. In `$T`, run `CAPTURE_DIR=$T/cap claude -p --permission-mode acceptEdits "Add a comment to src/example.ts, create src/new.ts with one line, run: echo gh pr create --title demo, then use the simplify skill on src/example.ts"`.

- [ ] **Step 5: Capture Codex.** Write `$T/.codex/hooks.json` with the same four events calling `capture.py codex`. Run the same prompt with `codex exec`, using `$simplify` to name the skill. If the hooks do not fire because they are not trusted yet, ask the user to open `codex` in `$T` once, approve them in `/hooks`, and then rerun.

- [ ] **Step 6: Find the `Stop` block format.** Read the Claude Code hooks reference (ask before the web request). In `$T`, swap in a `Stop` hook that blocks exactly once (it keeps a marker file) with the documented reply. Check that each tool continues with the reason. Record the working format for each tool.

- [ ] **Step 7: Save the fixtures.** Copy one capture per name listed above into `hooks/fixtures/<tool>/`. Replace `$T` with `/work/demo` and the home folder with `/home/user`. Write findings (a)–(f) into the spec's "To verify during planning" section, marking items 1, 2 and 6 as resolved.

- [ ] **Step 8: Commit**

```bash
git add hooks/fixtures docs/superpowers/specs/2026-10-19-multi-harness-package-design.md
git commit -m "Capture real Claude Code and Codex hook payloads as fixtures"
```

---

### Task 3: Switch file and records location

**Files:**
- Modify: `hooks/agent_activity.py`
- Test: `hooks/test_settings.py`

**Interfaces:**
- Produces:
  - `SWITCHES: tuple[str, ...] = ("autoReview", "prSkillReport")`
  - `settings_path(environ: Mapping[str, str]) -> pathlib.Path`
  - `load_settings(environ: Mapping[str, str]) -> dict[str, bool]`, which returns every key in `SWITCHES`
  - `project_state_dir(cwd: str | pathlib.Path, environ: Mapping[str, str]) -> pathlib.Path`, which does not create the folder
  - CLI `settings` prints `{"autoReview": bool, "prSkillReport": bool}`
  - CLI `state-dir --cwd PATH` prints `{"stateDir": "<absolute path>"}`
  - Both CLIs read `os.environ`.

- [ ] **Step 1: Write the failing tests**

```python
class SettingsTest(unittest.TestCase):
    def test_missing_settings_file_turns_everything_off(self) -> None:
        # environ = {"AGENT_SKILLS_CONFIG": f"{tmp}/none.json"}
        self.assertEqual(agent_activity.load_settings(environ),
                         {"autoReview": False, "prSkillReport": False})

    def test_only_literal_true_turns_a_switch_on(self) -> None:
        # file: {"autoReview": true, "prSkillReport": "true", "ste": true}
        self.assertEqual(agent_activity.load_settings(environ),
                         {"autoReview": True, "prSkillReport": False})

    def test_invalid_settings_warn_once_and_turn_everything_off(self) -> None:
        # file "[" and, separately, file "[1, 2]": both give all False.
        # Capture stderr: exactly one line, starting
        # "agent-skills: ignoring settings file".

    def test_settings_path_prefers_override_then_xdg_then_home(self) -> None:
        # {"AGENT_SKILLS_CONFIG": "/x/s.json"} -> /x/s.json
        # {"XDG_CONFIG_HOME": "/cfg"} -> /cfg/agent-skills/settings.json
        # {"HOME": "/h"} -> /h/.config/agent-skills/settings.json

    def test_project_state_dir_uses_repo_root_and_hash(self) -> None:
        # git init <tmp>/demo; cwd = <tmp>/demo/sub; environ = {"XDG_CACHE_HOME": f"{tmp}/cache"}
        root = pathlib.Path(tmp, "demo").resolve()
        key = "demo-" + hashlib.sha256(str(root).encode()).hexdigest()[:8]
        self.assertEqual(result, pathlib.Path(tmp, "cache", "agent-skills", key))

    def test_project_state_dir_outside_git_uses_cwd(self) -> None:
        # a plain tmp folder: the key starts with that folder's name
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest -v hooks/test_settings.py`
Expected: FAIL with `AttributeError: module 'agent_activity' has no attribute 'load_settings'`

- [ ] **Step 3: Implement the three functions and the two CLI commands** in `hooks/agent_activity.py`. Find the repo root with `git rev-parse --show-toplevel` run in `cwd` (output ignored on failure, stderr discarded), falling back to the resolved `cwd`. Read `HOME` from `environ`, falling back to `pathlib.Path.home()`.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest -v hooks/test_settings.py`
Expected: `Ran 6 tests` … `OK`

- [ ] **Step 5: Commit**

```bash
git add hooks/agent_activity.py hooks/test_settings.py
git commit -m "Add the switch file and the per-project cache folder to the hook runtime"
```

---

### Task 4: Shared edit reader

**Files:**
- Modify: `hooks/agent_activity.py`
- Test: `hooks/test_edits.py`

**Interfaces:**
- Consumes: `track_edit` (existing); fixtures `claude/post-edit.json`, `claude/post-write.json`, `codex/post-apply-patch.json` (Task 2).
- Produces:
  - `patch_edits(patch: str) -> list[tuple[str, int]]`
  - `edited_files(tool_name: str, tool_input: Mapping[str, Any]) -> list[tuple[str, int]]`
  - CLI `track-tool --state-dir DIR --session-id ID --tool NAME --args-json JSON` prints `{"tracked": [<paths that were tracked>]}`

- [ ] **Step 1: Write the failing tests**

```python
class EditsTest(unittest.TestCase):
    def test_patch_edits_counts_changed_lines_per_file(self) -> None:
        # Use the patch text and expected files/counts from the OpenCode test
        # "tracks multi-file patches including deletions" in tests/opencode/agent-skills.test.ts.

    def test_edited_files_reads_claude_edit_and_write_fixtures(self) -> None:
        # post-edit -> [("/work/demo/src/example.ts", <lines in new_string>)]
        # post-write -> [("/work/demo/src/new.ts", <lines in content>)]

    def test_edited_files_reads_codex_apply_patch_fixture(self) -> None:
        # -> the files named in the fixture's patch, each with its +/- line count

    def test_edited_files_ignores_other_tools(self) -> None:
        self.assertEqual(agent_activity.edited_files("Read", {"file_path": "a.ts"}), [])

    def test_track_tool_cli_tracks_only_trackable_paths(self) -> None:
        # apply_patch args touching src/a.ts and dist/a.js -> {"tracked": ["src/a.ts"]}
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest -v hooks/test_edits.py`
Expected: FAIL with `AttributeError: ... 'patch_edits'`

- [ ] **Step 3: Implement.** Port `patchEdits`, `editedLineCount` and `editedFiles` from `.opencode/plugins/agent-skills.ts`. The tool regex is `(apply_patch|edit|write)`, case-insensitive. Path keys are `filePath`, `file_path`, `path`, `notebook_path`. Patch keys are `patchText`, `patch`, plus the Codex field from Task 2 finding (c). Line-count keys are the patch keys plus `newString`, `new_string`, `content`. The minimum count is 1.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest -v hooks/test_edits.py`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add hooks/agent_activity.py hooks/test_edits.py
git commit -m "Move the edit and patch reader into the shared hook runtime"
```

---

### Task 5: Shared review claim and restore

**Files:**
- Modify: `hooks/agent_activity.py`
- Test: `hooks/test_review.py`

**Interfaces:**
- Consumes: `pending`, `track_edit`.
- Produces:
  - `review_instruction(intent: Mapping[str, Any], simplify: Mapping[str, Any]) -> str`. Its text is the four lines of `reviewInstruction` in the OpenCode plugin, with file lists as `json.dumps(files)`, plus a fifth line: `You must invoke both named skills before completing this review turn.`
  - `claim_review(*, state_dir, session_id) -> dict[str, Any] | None`. It consumes both pending lists. It returns `None` when both are empty, otherwise `{"intent": ..., "simplify": ..., "instruction": ...}`.
  - `restore_pending(*, state_dir, session_id, intent, simplify) -> None`, a port of the plugin's `restorePending`.
  - CLI `claim-review --state-dir --session-id` prints that dict or `null`.
  - CLI `restore-pending --state-dir --session-id --claim-json JSON` prints `{"restored": true}`.

- [ ] **Step 1: Write the failing tests**

```python
class ReviewTest(unittest.TestCase):
    def test_claim_review_returns_none_without_pending_edits(self) -> None: ...

    def test_claim_review_consumes_pending_and_builds_instruction(self) -> None:
        # track src/a.ts with 10 lines, then claim
        self.assertEqual(claim["intent"]["files"], ["src/a.ts"])
        self.assertEqual(claim["simplify"]["total"], 10)
        self.assertIn('Simplify files: ["src/a.ts"]. Use the micro tier (~10 changed lines).', claim["instruction"])
        self.assertTrue(claim["instruction"].endswith("You must invoke both named skills before completing this review turn."))
        self.assertIsNone(agent_activity.claim_review(state_dir=d, session_id="s"))

    def test_review_instruction_uses_full_tier_for_large_or_wide_changes(self) -> None:
        # total 41 with 1 file -> "full tier"; total 10 across 3 files -> "full tier"

    def test_restore_pending_puts_claimed_edits_back(self) -> None:
        # claim, restore -> pending("simplify") lists the same files again
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest -v hooks/test_review.py`
Expected: FAIL with `AttributeError: ... 'claim_review'`

- [ ] **Step 3: Implement the three functions and two CLI commands.**

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest -v hooks/test_review.py`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add hooks/agent_activity.py hooks/test_review.py
git commit -m "Move review claiming and restoring into the shared hook runtime"
```

---

### Task 6: `hook` entry point for tool events

**Files:**
- Modify: `hooks/agent_activity.py`
- Test: `hooks/test_hook_entry.py`

**Interfaces:**
- Consumes: `load_settings`, `project_state_dir` (Task 3); `edited_files` (Task 4); `record_skill`, `track_edit`, `check_pr_body` (existing); fixtures (Task 2).
- Produces:
  - `detect_platform(payload: Mapping[str, Any], environ: Mapping[str, str]) -> str`, returning `"claude"` or `"codex"`. It uses Task 2 finding (e). With no such field, it returns `"codex"` when `transcript_path` contains `/.codex/`, otherwise `"claude"`.
  - `skill_used(platform: str, payload: Mapping[str, Any]) -> str | None`. Claude Code: the `Skill` tool's skill name, keeping only the text after the last `:` (so `agent-skills:simplify` becomes `simplify`). Codex: per Task 2 finding (d); if Codex gives no signal, return `None`.
  - `load_review(state_dir, session_id) -> dict | None`, `save_review(state_dir, session_id, review: Mapping) -> None`, `clear_review(state_dir, session_id) -> None`. The state lives in `temporary_path(state_dir, "review", session_id)` as JSON `{"intent", "simplify", "skills": [...]}`.
  - `handle_hook(payload, *, settings: Mapping[str, bool], state_dir: pathlib.Path, platform: str) -> dict | None`
  - `run_hook(stdin_text: str, environ: Mapping[str, str]) -> str`. It returns the JSON reply, or `""` for no output. It returns `""` before touching git or disk when every switch is off, and `""` on any exception.
  - CLI `hook` runs `print(run_hook(sys.stdin.read(), os.environ), end="")`.
  - `SHELL_TOOLS = {"Bash", <Codex shell name from Task 2>}`.

- [ ] **Step 1: Write the failing tests.** Every test sets `AGENT_SKILLS_CONFIG` and `XDG_CACHE_HOME` to temp paths.

```python
class HookToolEventsTest(unittest.TestCase):
    def test_switches_off_means_no_output_and_no_files(self) -> None:
        # every fixture in hooks/fixtures/*/ through run_hook with no settings file
        # -> output "" and the cache folder does not exist

    def test_pr_create_without_report_is_denied_on_both_tools(self) -> None:
        # claude/pre-bash and codex/pre-shell, with the command replaced by
        # "gh pr create --title x --body hi" and prSkillReport on
        out = json.loads(output)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("skill report", out["permissionDecisionReason"])

    def test_pr_guard_off_allows_pr_commands(self) -> None:
        # same payload, prSkillReport off -> ""

    def test_post_tool_use_tracks_edits_when_auto_review_on(self) -> None:
        # claude/post-edit -> pending(simplify).files == ["/work/demo/src/example.ts"]

    def test_codex_apply_patch_is_tracked(self) -> None: ...

    def test_post_tool_use_records_skill_when_report_on(self) -> None:
        # claude/post-skill -> <state>/skill-ledger/<session>.jsonl has
        # skill "simplify", mode "model", platform "claude"

    def test_edits_during_review_are_not_tracked(self) -> None:
        # save_review(...) first; post-edit -> nothing pending;
        # post-skill (simplify) -> load_review(...)["skills"] == ["simplify"]

    def test_bad_stdin_prints_nothing(self) -> None:
        self.assertEqual(agent_activity.run_hook("not json", environ), "")
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest -v hooks/test_hook_entry.py`
Expected: FAIL with `AttributeError: ... 'run_hook'`

- [ ] **Step 3: Implement `PreToolUse` and `PostToolUse` handling.**
  - **Deny reply:** `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": <reason>}}` for any `check_pr_body` status other than `allow`, as the OpenCode plugin does today.
  - **Skill use:** record it with `mode="model"` and `platform=<platform>` when `prSkillReport` is on. Add `intent-check` or `simplify` to the review state when a review is open, whatever the switches say.
  - **Edits:** track them only when `autoReview` is on and no review is open.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest -v hooks/test_hook_entry.py`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add hooks/agent_activity.py hooks/test_hook_entry.py
git commit -m "Add a hook entry point for Claude Code and Codex tool events"
```

---

### Task 7: End-of-turn review in the `hook` entry point

**Files:**
- Modify: `hooks/agent_activity.py`
- Test: `hooks/test_hook_entry.py` (new class `HookReviewTest`)
- Modify: the spec's "Claude Code and Codex wiring" section

**Interfaces:**
- Consumes: `claim_review`, `restore_pending` (Task 5); `load_review`, `save_review`, `clear_review`, `skill_used` (Task 6); `render_report` (existing).
- Produces: `block_reply(platform: str, reason: str) -> dict` in the format from Task 2 finding (a); `Stop` and `UserPromptSubmit` handling inside `handle_hook`.

- [ ] **Step 1: Write the failing tests**

```python
class HookReviewTest(unittest.TestCase):
    def test_stop_without_edits_lets_turn_end(self) -> None: ...          # -> ""

    def test_stop_with_edits_blocks_once_with_review_instruction(self) -> None:
        # post-edit, then stop -> output == json of block_reply("claude", <instruction naming src/example.ts>)
        # and load_review(...) is not None

    def test_second_stop_after_both_skills_ends_review(self) -> None:
        # block; skill events for simplify and intent-check; stop with stop_hook_active true
        # -> "", review cleared, nothing pending

    def test_second_stop_missing_a_skill_restores_edits_on_claude(self) -> None:
        # only simplify ran -> "", review cleared, pending(simplify) lists the file again

    def test_codex_review_ends_after_one_round(self) -> None:
        # codex stop -> block; codex stop again with no skill events -> ""; a third stop -> ""
        # (no restore when Codex gives no skill signal, so no loop)

    def test_user_prompt_during_review_restores_and_resumes_tracking(self) -> None:
        # block; user-prompt -> review cleared, edits pending again; a later post-edit is tracked

    def test_stop_renders_report_when_report_switch_on(self) -> None:
        # after a recorded skill, stop -> <state>/artifacts/skill-report-<session>.md exists
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest -v hooks/test_hook_entry.py`
Expected: the new tests FAIL (the `Stop` output is `""` where a block is expected)

- [ ] **Step 3: Implement `Stop` and `UserPromptSubmit`.**
  - **`Stop`:**
    1. If `prSkillReport` is on, run `render_report`.
    2. If `autoReview` is on and a review is open: clear it. If either skill is missing and the platform reports skill use (always for `claude`; for `codex` only if Task 2 found a signal), restore the claimed edits. Print nothing.
    3. Otherwise, if `stop_hook_active` is true, print nothing.
    4. Otherwise run `claim_review`. If it returns a claim, save it as the open review with `skills: []` and print `block_reply`.
  - **`UserPromptSubmit`:** if `autoReview` is on and a review is open, clear it and restore the claimed edits. Print nothing.

- [ ] **Step 4: Run the tests**

Run: `python3 -m unittest -v hooks/test_hook_entry.py`
Expected: `OK`

- [ ] **Step 5: Update the spec.** In "Claude Code and Codex wiring", change "three hooks" to four. Add: "`UserPromptSubmit`: if the user sends a prompt while a review is open, clear it and put the claimed edits back."

- [ ] **Step 6: Commit**

```bash
git add hooks/agent_activity.py hooks/test_hook_entry.py docs/superpowers/specs/2026-10-19-multi-harness-package-design.md
git commit -m "Run the end-of-turn review from the shared hook entry point"
```

---

### Task 8: The `toggle` skill and Codex manual-only flags

**Files:**
- Create: `skills/toggle/SKILL.md`, `skills/toggle/agents/openai.yaml`
- Create: `skills/{decompose,linear-project-update,recommend-reviewer,remind-me}/agents/openai.yaml`

**Interfaces:**
- Produces: the switch names `auto-review` → `autoReview` and `pr-skill-report` → `prSkillReport`. Each `openai.yaml` uses the key from Task 2 finding (f), expected to be:

```yaml
policy:
  allow_implicit_invocation: false
```

- [ ] **Step 1: Write a failing check.** In a throwaway repo `T`, copy `skills/toggle` (empty for now) into `$T/.claude/skills/`. Run `AGENT_SKILLS_CONFIG=$T/cfg/settings.json claude -p "/toggle auto-review on"`, then `cat $T/cfg/settings.json`.
Expected: the file does not exist.

- [ ] **Step 2: Write `skills/toggle/SKILL.md`.**
  - **Frontmatter:** `name: toggle`; a description saying it turns this package's automatic hooks on or off; `argument-hint: "[auto-review | pr-skill-report] [on | off]"`; `user-invocable: true`; `disable-model-invocation: true`.
  - **Find the file:** resolve the path in the Global Constraints order.
  - **Read:** a missing file counts as `{}`. If the file holds invalid JSON, show the error and change nothing.
  - **Write:** set only the named key to `true`/`false`, keep every other key, and write with 2-space indent and a trailing newline. Create the folder if needed.
  - **Bad input:** an unknown switch name lists the valid ones and changes nothing.
  - **No input:** print each switch and its state.
  - **When it applies:** changes take effect on the next tool call, with no restart. In Codex, the hooks must be approved once in `/hooks`.
  - Keep it in plain English and under 60 lines.

- [ ] **Step 3: Write the five `openai.yaml` files.**

- [ ] **Step 4: Run the check again**

Run: the same commands as Step 1, then `claude -p "/toggle"` and `claude -p "/toggle bogus on"`.
Expected: the first prints `{"autoReview": true}` (2-space indent). `/toggle` lists both switches with `autoReview` on. `/toggle bogus on` names the valid switches, and the file is unchanged.

- [ ] **Step 5: Commit**

```bash
git add skills/toggle skills/*/agents/openai.yaml
git commit -m "Add the toggle skill and mark manual-only skills for Codex"
```

---

### Task 9: Manifests, hook wiring, version script and package checks

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`
- Create: `scripts/bump-version.sh`, `scripts/check-package.mjs`
- Test: `tests/package/check-package.test.mjs`
- Modify: `package.json` (`"version": "0.1.0"`, and add `node --test "tests/package/*.test.mjs"` to `test`), `hooks/README.md`

**Interfaces:**
- Consumes: the `hook` CLI (Tasks 6–7); tool names from Task 2.
- Produces:
  - `checkPackage(root: string): string[]` exported from `scripts/check-package.mjs`. It returns one message per problem. Running the file directly prints them and exits 1 if there are any.
  - `scripts/bump-version.sh <x.y.z>` sets the version in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`plugins[0].version`) and `package.json`. It rejects anything not matching `^[0-9]+\.[0-9]+\.[0-9]+$`.

- [ ] **Step 1: Write the failing tests.** Each builds a small fake repo in a temp folder.

```js
test("reports a version mismatch between manifests", ...)          // message names both files
test("reports a skill whose name differs from its folder", ...)
test("reports a manual-only skill without a matching openai.yaml, and the reverse", ...)
test("reports a leftover ~/.agents path", ...)                      // outside docs/superpowers/ and skills/humanizer/
test("reports unquoted plugin root in a hook command", ...)         // python3 ${CLAUDE_PLUGIN_ROOT}/hooks/... is rejected
test("passes on this repo", () => assert.deepEqual(checkPackage(repoRoot), []))
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test tests/package/check-package.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/check-package.mjs`

- [ ] **Step 3: Write `scripts/check-package.mjs`.** The checks are the spec's five package checks:
  - Version numbers match across the manifests.
  - Each skill's frontmatter `name` matches its folder, and its `description` is not empty. Parse frontmatter with the same rules as Task 11's parser; `>-` and `|` blocks count as values.
  - `disable-model-invocation: true` and an `openai.yaml` with implicit use off always come together.
  - No `~/.agents`, `.agents/hooks` or `homedir(), ".agents"` appears in tracked files outside `docs/superpowers/` and `skills/humanizer/`.
  - Every hook command equals the Global Constraints string.

- [ ] **Step 4: Write the manifests, `hooks.json` and the bump script.**

`plugin.json`:

```json
{
  "name": "agent-skills",
  "version": "0.1.0",
  "description": "Coding-agent skills and optional review hooks for Claude Code, Codex and OpenCode.",
  "author": { "name": "schan-eng", "url": "https://github.com/schan-eng" },
  "homepage": "https://github.com/schan-eng/agent-skills",
  "repository": "https://github.com/schan-eng/agent-skills",
  "license": "MIT",
  "keywords": ["skills", "hooks", "code-review", "codex", "opencode"]
}
```

`marketplace.json`: `{"name": "agent-skills", "owner": {"name": "schan-eng"}, "plugins": [{"name": "agent-skills", "source": "./", "description": <same>, "version": "0.1.0"}]}`.

`hooks.json`:
- `PreToolUse` with matcher `Bash|<Codex shell name>`.
- `PostToolUse` with matcher `Edit|Write|MultiEdit|NotebookEdit|Skill|apply_patch`, plus any Codex tool from Task 2 finding (d).
- `Stop` and `UserPromptSubmit` with no matcher.
- Every entry is `{"type": "command", "command": <Global Constraints string>}`.

Update `hooks/README.md` to describe the new wiring, the switch file and the cache location, and remove `~/.agents`.

- [ ] **Step 5: Run the tests and the validator**

Run: `node --test tests/package/check-package.test.mjs && node scripts/check-package.mjs && claude plugin validate .`
Expected: all pass. Run `claude plugin validate .` only if `claude plugin --help` lists `validate`.

- [ ] **Step 6: Check that the plugin loads in Claude Code.** In a throwaway repo, run `claude --plugin-dir <repo> -p "List the skills you have from the agent-skills plugin."`
Expected: the answer names `agent-skills:simplify` and `agent-skills:toggle`.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin hooks/hooks.json hooks/README.md scripts tests/package package.json
git commit -m "Add plugin manifests, shared hook wiring, version script and package checks"
```

---

### Task 10: OpenCode V1 plugin on the shared runtime

**Files:**
- Modify: `.opencode/plugins/agent-skills.ts`
- Test: `tests/opencode/agent-skills.test.ts`
- Delete: `opencode/commands/` (8 files)

**Interfaces:**
- Consumes: CLI `settings`, `state-dir` (Task 3), `track-tool` (Task 4), `claim-review`, `restore-pending` (Task 5), and the existing `record-skill`, `render`, `check-pr-body`.
- Produces: named export `AgentSkillsPlugin` (a V1 `Plugin`) with a `config` hook that adds `<repo>/skills` to `config.skills.paths`. `export default AgentSkillsPlugin` stays until Task 11. Tests import the named export.

- [ ] **Step 1: Write the failing tests and update the old ones.**
  - **Old tests:** the 7 existing tests now set `AGENT_SKILLS_CONFIG` to a temp file with both switches on, and set `XDG_CACHE_HOME` to a temp folder. They get the state folder from the `state-dir` CLI and restore `process.env` afterwards.
  - **New tests:**

```ts
test("does nothing when every switch is off", ...)
// no settings file: an edit leaves nothing pending, idle never calls promptAsync,
// and "gh pr create" is not blocked
test("registers the skills folder in V1 config once", ...)
// config({skills: {paths: []}}) twice -> paths == [<repo>/skills]
test("leaves a V2-shaped skills config alone", ...)
// config({skills: []}) -> still []
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/opencode/agent-skills.test.ts`
Expected: the new tests FAIL (no `config` hook, and edits are tracked with the switches off)

- [ ] **Step 3: Change the plugin.**
  - Get the state folder once from `state-dir --cwd <directory>`.
  - Read `settings` at the start of each handler, and gate each job by its switch as in the spec's table.
  - Replace the TypeScript `editedFiles`, `patchEdits`, `editedLineCount`, `reviewInstruction`, `claimPending` and `restorePending` with calls to `track-tool`, `claim-review` and `restore-pending`.
  - Keep the `[agent-hooks:auto-review]` marker in front of the instruction text.
  - Add the `config` hook. Skip it when `config.skills` is an array; otherwise create `skills.paths` if needed and add the folder once.
  - Delete `opencode/commands/`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm run typecheck && node --experimental-strip-types --test tests/opencode/agent-skills.test.ts`
Expected: no type errors; `# pass 10`

- [ ] **Step 5: Commit**

```bash
git add .opencode tests/opencode opencode
git commit -m "Run the OpenCode plugin on the shared runtime and register skills in V1"
```

---

### Task 11: OpenCode V2 skills and the dual export

**Files:**
- Modify: `.opencode/plugins/agent-skills.ts`
- Create: `index.js`
- Modify: `package.json` (`"main": ".opencode/plugins/agent-skills.ts"`)
- Test: `tests/opencode/agent-skills-v2.test.ts`

**Interfaces:**
- Consumes: `AgentSkillsPlugin` (Task 10).
- Produces:
  - `readSkills(skillsDir: string): Array<{ id: string; name: string; description?: string; path: string; content: string }>`
  - `setup(ctx: unknown): Promise<void>`
  - `export default { id: "agent-skills", server: AgentSkillsPlugin, setup }`
  - `index.js` containing `export { default } from "./.opencode/plugins/agent-skills.ts";`

- [ ] **Step 1: Write the failing tests**

```ts
test("setup registers every skill with name, description and path", ...)
// fake ctx.skill.transform(cb) calls cb(draft); collected ids include "simplify" and "toggle";
// remind-me's folded description is one non-empty line; simplify's path ends with skills/simplify/SKILL.md
test("one rejected skill does not stop the rest", ...)
// draft.add throws for "simplify" -> every other skill is still added; setup resolves
test("setup ignores a V1-shaped context", ...)          // setup({ directory: "/x" }) resolves
test("default export exposes id, server and setup", ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/opencode/agent-skills-v2.test.ts`
Expected: FAIL (`setup` is undefined)

- [ ] **Step 3: Implement.** Port Superpowers' frontmatter parser (`extractAndStripFrontmatter` in its `.opencode/plugins/superpowers.js`, MIT) and credit it in one comment. `setup` returns quietly unless `ctx.skill.transform` is a function. Wrap each `draft.add` in its own try/catch that logs `[agent-skills] skill "<id>" rejected by host, skipping`, and wrap the whole transform in an outer try/catch. Set `main` and add `index.js`.

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm run typecheck && npm test`
Expected: everything passes

- [ ] **Step 5: Commit**

```bash
git add .opencode index.js package.json tests/opencode
git commit -m "Register skills in OpenCode V2 and export the plugin for both versions"
```

---

### Task 12: Humanizer

**Files:**
- Create: `skills/humanizer/` (git subtree), `scripts/update-humanizer.sh`
- Outside this repo: `~/Documents/GitHub/humanizer` (`.gitignore`, branches)

- [ ] **Step 1: Look before rewriting the fork.** In `~/Documents/GitHub/humanizer`, run `git status --short` (expect clean) and `git show --stat c945506 9bdd6ef`. Expect only `.DS_Store` files. If either shows anything else, stop and ask the user.

- [ ] **Step 2: Clean up the persona branch.** On `persona-library`, run `git reset --hard b005add`. Add `.DS_Store` to `.gitignore` and commit "Ignore .DS_Store". Then `git switch main && git merge --ff-only persona-library`.
Expected: `main` is 8 commits ahead of `origin/main`.

- [ ] **Step 3: Ask the user, then push** with `git push origin main`.

- [ ] **Step 4: Pull it into this repo**

Run: `git subtree add --prefix=skills/humanizer https://github.com/schan-eng/humanizer.git main --squash`
Expected: `skills/humanizer/SKILL.md` and `skills/humanizer/personas/` exist; `git log --oneline -2` shows a squash commit and a merge commit.

- [ ] **Step 5: Write `scripts/update-humanizer.sh`.** It stops with a message unless run from the repo root with a clean tree (`git diff --quiet && git diff --cached --quiet`), then runs `git subtree pull --prefix=skills/humanizer https://github.com/schan-eng/humanizer.git main --squash -m "Update humanizer from schan-eng/humanizer"`.

- [ ] **Step 6: Run the checks**

Run: `npm test`
Expected: pass. `checkPackage` accepts `skills/humanizer` (its name matches the folder, and it has no `disable-model-invocation`), and the V2 test now also sees `humanizer`.

- [ ] **Step 7: Commit the script**

```bash
git add scripts/update-humanizer.sh
git commit -m "Add a script to pull humanizer updates from the fork"
```

---

### Task 13: Docs and license

**Files:**
- Modify: `README.md` (rewrite)
- Create: `docs/testing.md`, `LICENSE`

- [ ] **Step 1: Write `LICENSE`.** Use the standard MIT text with `Copyright (c) 2026 schan-eng`.

- [ ] **Step 2: Rewrite `README.md`** in plain English with these sections:
  - **What's inside:** one line per skill.
  - **Install:** Claude Code, Codex, OpenCode V1 and V2, and other agents. Use the commands from the spec's install table.
  - **Turn on the automatic hooks:** `toggle`, the switch file path, what each switch does, the `python3` requirement, Windows untested, and Codex's `/hooks` approval.
  - **Updating:** includes the OpenCode cache note.
  - **Duplicate skills:** the note from the spec.
  - **Working on this repo:** local loading for each tool, `npm test`, and `scripts/bump-version.sh`.
  - **Credits:** humanizer by blader (MIT), and the packaging pattern from Superpowers.

- [ ] **Step 3: Write `docs/testing.md`.** Turn the spec's manual checklist into exact commands for each tool, using a throwaway repo, `AGENT_SKILLS_CONFIG` and `XDG_CACHE_HOME`. End it with an empty "Last run" table: tool, version, date, result.

- [ ] **Step 4: Run the checks**

Run: `npm test`
Expected: pass. The `~/.agents` check now covers the new README too.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/testing.md LICENSE
git commit -m "Document install, switches and testing; add MIT license"
```

---

### Task 14: Install checks in every tool, then release 0.1.0

**Files:**
- Modify: `docs/testing.md` ("Last run")
- Modify: the spec ("To verify during planning" items 3, 4, 5 and 7)
- Modify: any file a fallback needs (see Step 4)

- [ ] **Step 1: Ask the user three things.** May we register the local marketplace in Claude Code and Codex? Should it stay installed afterwards? May we `brew install` OpenCode V1, and V2 (`@opencode/cli`)?

- [ ] **Step 2: Run the `docs/testing.md` checklist** in a throwaway repo for Claude Code, Codex, OpenCode V1 and OpenCode V2. For OpenCode, put the plugin's absolute path in the throwaway repo's own `opencode.json`. Fill in "Last run".

- [ ] **Step 3: Resolve the remaining verify items.** These are: 3 (Codex reads the Claude manifests), 4 (OpenCode V1 makes commands from plugin skills), 5 (OpenCode loads a `.ts` main), and 7 (humanizer's own manifests are ignored). Write each result into the spec.

- [ ] **Step 4: If an item failed, apply the spec's fallback,** with a test where the change is code:
  - Item 3: add `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`, and add them to the version check and `bump-version.sh`.
  - Item 4: register a command for each `user-invocable` skill in the V1 `config` hook, with a test.
  - Item 5: convert the plugin to plain JavaScript.
  - Item 7: delete the nested manifests in the fork, then run `scripts/update-humanizer.sh`.

  Rerun the checklist for the affected tool.

- [ ] **Step 5: Release**

Run: `npm test && node scripts/check-package.mjs && git tag v0.1.0`
Expected: all pass; the tag exists. Ask the user before pushing the branch or the tag.

- [ ] **Step 6: Commit and hand off**

```bash
git add docs/testing.md docs/superpowers/specs/2026-10-19-multi-harness-package-design.md
git commit -m "Record install checks for Claude Code, Codex and OpenCode"
```

Then use superpowers:finishing-a-development-branch.
