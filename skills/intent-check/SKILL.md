---
name: intent-check
description: >-
  Post-implementation sanity check that the changes just made stay within the
  session's intent — the Linear issue being resolved and/or the user's stated
  request. Fired automatically by personal coding-agent hooks after
  implementation edits; can be run manually by invoking intent-check. Gathers the intent anchor ONCE
  per session (Linear issue, user context, optionally Slack), caches it, and
  on later invocations only judges the new diff against the cached anchor.
argument-hint: "[changed file list | --refresh]"
user-invocable: true
compatibility: Requires git. Linear and Slack integrations are optional and must be used only when already available.
---

# Intent check — is the implementation still on topic?

Scope-adherence gate: verify that this turn's changes trace to the session's
actual requirements. It is NOT a quality gate (simplify), a bug gate
(self-review), or a reach gate (blast-radius-check). Read-only for project
files — the only file this skill ever writes is its own anchor.

## Hard rules

- **Gather context once.** The anchor is built on the first invocation of the
  session and cached; every later invocation reads the cache. Re-gather only
  on `--refresh` or when the user explicitly redefines the task.
- **No subagents, no heavy sweeps.** This runs after every implementation
  step — it must stay cheap: read anchor, judge diff, report.
- **Never edit or revert code.** Deviations are reported to the user; the
  user decides.

## Step 1 — The anchor (one-time per session)

Resolve the anchor location in order: an exact path supplied by the hook
instruction; `<scratchpad>/intent-anchor.md` when the runtime exposes a session
scratchpad; otherwise the current conversation context. Never create an anchor
inside the project. If the resolved anchor already exists and this is not a
`--refresh`, skip straight to Step 2.

Otherwise gather once, in this order:

1. **User intent** (always available): the originating request and any
   constraints stated in the conversation, quoted or tightly paraphrased.
2. **Linear** (if resolvable): ticket ID from the current branch name
   (`git branch --show-current`, token matching `[A-Za-z]+-[0-9]+`) or one the
   user named. Use the available `get_issue` integration; capture title, description
   requirements, and acceptance criteria. No ticket → skip silently.
3. **Slack** (rarely): only when 1+2 leave the goal genuinely ambiguous AND
   Slack integration is already authenticated. If only `authenticate` stubs
   return, skip — never start an OAuth flow. At most
   one targeted search for the ticket/topic.

Write the anchor:

```markdown
# Intent anchor — <session goal in one line>
## Requirements
- [ ] <each concrete requirement, one per line>
## Non-goals
- <explicit exclusions, if any were stated>
## Sources
- <user request / ENG-XXXX / slack thread>
## Amendments
- (none yet)
```

## Step 2 — Amendments

If the user has changed or extended the direction since the anchor was
written, append a dated one-line amendment before judging — a later user
instruction outranks the original ticket. This is what keeps the check from
nagging about user-approved pivots.

## Step 3 — The check

Files = the hook instruction's file list, then the args list; if both are empty,
use `git diff --name-only HEAD` plus untracked. Prefer the diff knowledge already
in context over re-reading files.

Classify each substantive change:

- **ON-TOPIC** — traces to a requirement or amendment.
- **DRIFT** — no requirement or amendment covers it (unrequested feature,
  opportunistic refactor beyond the task, scope creep into other areas).
- **CONFLICT** — contradicts a requirement or a stated non-goal.

Unaddressed requirements are noted only when the session is claiming the task
is complete — partial progress is not drift.

## Step 4 — Output (≤8 lines)

On track: one line — `Intent check: on track — <n> change(s) map to <goal>.`
Otherwise, per deviation: `DRIFT|CONFLICT <file>:<line> — <what> (<which
requirement/non-goal it misses or violates>)`, then one closing line
recommending exactly one of: confirm with the user, revert, or amend the
anchor. Never act on the recommendation yourself.
