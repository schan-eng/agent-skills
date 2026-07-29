---
name: remind-me
description: >-
  Resume-work briefing for a git worktree/branch: gathers git state, Linear
  ticket + relations, GitHub PR (incl. stacked/sibling PRs), docs/artifacts
  SPEC progress, prior session plans, memory gotchas, and local k3d cluster
  health, then prints a COMPACT digest — where you left off, next steps,
  related branches & PRs with links and status, and one-line status tallies —
  and answers drill-down questions (done, decisions, remaining, PR, verify,
  infra) from the gathered material on request.
  Read-only — writes no files. Invoke explicitly via /remind-me (not
  auto-invoked). Optional argument: a Linear ID (ENG-1234) or branch name.
argument-hint: "[ENG-1234 | branch-name]"
user-invocable: true
disable-model-invocation: true
compatibility: >-
  Works in any repo; richest output in the Kindo mono repo. Optional probes
  degrade gracefully: gh (PR), LINEAR_API_KEY or Linear MCP (ticket),
  ~/.kindo/clusters.json + yarn local:status (infra).
---

# Remind Me — resume-work briefing

Invocation input means explicit command/skill arguments when the runtime
provides them; otherwise use the target named in the user's request.

Rebuild the context an engineer needs after a long break, assuming they have
forgotten everything: what this effort is and why, what has been done, what
decisions were already made (so nothing gets re-litigated or reinvented), what
was mid-flight when work stopped, what remains to ship, how the work was being
verified, and whether the local test stack is up. Gather from every available
source, synthesize one concise terminal briefing, and point at sources instead
of dumping them.

## Hard rules

- **Strictly read-only.** Write no files anywhere — no scratch, no notes, no
  RESUME.md, no persistence of the briefing itself. Never mutate git state,
  never `git fetch`. The only commands you may run: `git` read subcommands,
  `gh auth status` / `gh pr list` / `gh pr view`,
  `python3 <repo>/.agents/skills/linear/scripts/linear.py issue …`,
  `yarn local:status`, and plain file reads.
- **Every probe is optional.** A missing/failed source becomes a one-line note
  in the relevant section — never abort the briefing.
- **Targeting a worktree you are not cd'd into:** run git as
  `git -C <worktreePath> …` and read files by absolute path. The one exception
  is the infra probe, which runs `(cd <worktree> && yarn local:status --json)`.
- **No pagers:** use `git --no-pager` and `GH_PAGER=cat`.

## Step 1 — Resolve the target `{branch, worktreePath, ticketId}`

Parse the invocation input:

1. **Empty** → current checkout:
   - `branch = git rev-parse --abbrev-ref HEAD`,
     `worktreePath = git rev-parse --show-toplevel`.
   - `ticketId` = first token matching `[A-Za-z]+-[0-9]+` in the branch name
     (e.g. `simon/eng-10860-foo` → `ENG-10860`). Uppercase it for Linear;
     lowercase for file globs.
   - Detached HEAD → report "detached at `<sha>`"; produce a git-only snapshot.
   - On `main` or no ticket token → produce a repo-level snapshot (probe A, and
     B if a PR exists for the branch) and note: "no ticket context — pass an
     ENG-id or branch name to target an effort."
   - Not a git repo → say so and stop, mentioning the argument form.
2. **Contains a `[A-Za-z]+-[0-9]+` token** → `ticketId` = token uppercased.
   Resolve the branch/worktree, in order:
   a. `git worktree list --porcelain` — a worktree path or branch containing
      the lowercased id. Worktrees conventionally live at
      `<repo>/.claude/worktrees/<eng-nnnnn>*`, but sibling checkouts like
      `<repo>-<eng-nnnnn>` and `<repo>-auto-<ENG-NNNNN>` exist too — match on
      the full `git worktree list` output, not just the `.claude/worktrees`
      prefix.
   b. `git --no-pager branch --list "*<id-lower>*"`, then
      `git --no-pager branch -r --list "*<id-lower>*"`.
   c. The Linear issue's `gitBranchName` (once probe C runs).
   - **Multiple candidates** (e.g. eng-10751 has many worktree variants):
     prefer the worktree that is the cwd; otherwise the candidate with the most
     recent commit (`git for-each-ref --sort=-committerdate` over the
     candidates). State which one you chose and list the alternates in one
     line so the user can re-invoke with an explicit branch name.
   - **No local branch found** → still run probes C/D/E keyed on the ticket id;
     git/PR/infra sections report "no local branch".
3. **Anything else** → treat as a branch name; find its worktree via
   `git worktree list`; extract `ticketId` from it per rule 1.

## Step 2 — Gather

Run all applicable probes A–F **in one parallel batch** (they are independent
once the target is resolved); G is best-effort afterwards.

| Probe | Run when | Skip with a one-line note when |
|---|---|---|
| A. Git snapshot | branch resolved | not a git repo |
| B. GitHub PRs | `gh auth status` succeeds | gh missing/unauthenticated |
| C. Linear | ticketId AND (`LINEAR_API_KEY` set OR Linear MCP tools available) | otherwise |
| D. docs/artifacts | ticketId AND `<repo>/docs/artifacts/` exists | otherwise |
| E. Session plans | `~/.claude/plans/` exists AND (ticketId or branch) | otherwise |
| F. Local infra | `~/.kindo/clusters.json` has an entry for this branch | file absent, no entry, or stale |
| G. Memory | project memory `MEMORY.md` exists | otherwise |

**A. Git** (all with `git --no-pager -C <worktreePath>`):
- `status --short` · `log --oneline -15` · `log -1 --format='%cd (%cr)'`
  (staleness anchor) · `stash list` ·
  `rev-list --left-right --count origin/main...HEAD` (fall back to
  `origin/HEAD`; do not fetch — note that ahead/behind is as of the last
  fetch) · `git worktree list` once for the repo.
- **What the branch already built:** `diff --stat origin/main...HEAD`
  (keep the summary line + the ~15 most-changed files). New files/modules the
  branch adds are the "already in place — extend, don't recreate" inventory.
- **Characterize the mid-flight work:** if there are uncommitted changes, run
  `diff --stat` for the working tree, then read the diff of the 2–3
  most-changed files (cap ~200 lines total) so the briefing can say *what was
  being done* ("mid-way through adding retry logic to X"), not just count
  files. Skim untracked files' names/paths for the same purpose.

**B. PRs:** two lookups —
1. `gh pr list --head <branch> --json number,state,title,url` and, if one
   exists, `gh pr view <n> --json state,title,url,reviews,reviewDecision,statusCheckRollup,mergeable,comments,updatedAt`.
   Extract review decision, failing/pending checks by name, comment count, and
   `updatedAt` (staleness anchor). The JSON does not expose thread resolution —
   report "N review comments", never claim a count of *unresolved* threads.
2. **Sibling/stacked PRs:** `gh pr list --search "<TICKET> in:title" --state all --json number,state,title,url,headRefName,reviewDecision,updatedAt`.
   Merged siblings are already-shipped work; open siblings are part of the
   same stack. Keep each PR's number, state, review decision, head branch, and
   URL — they feed the "Related branches & PRs" digest section.
3. **Related branches without PRs:** the ticket-matching branches/worktrees
   already found during Step 1 resolution (worktree list + `git branch
   --list "*<id-lower>*"` local and remote). For each, note its worktree path
   (if any) and last-commit date (`git for-each-ref --sort=-committerdate
   --format='%(refname:short) %(committerdate:short)'` over the candidates),
   and whether a PR from probe B.2 points at it.

**C. Linear:** if `<repo>/.agents/skills/linear/scripts/linear.py` exists and
`LINEAR_API_KEY` is set, run
`python3 <repo>/.agents/skills/linear/scripts/linear.py issue <TICKET>`;
otherwise fall back to Linear MCP tools (`get_issue`, `list_comments`) if
present. Capture: state, assignee, title, first ~10 lines of description (the
"why" for the story-so-far), parent (identifier + title), children/sub-issues
with states, blocks/related relations, and the latest 2–3 comments —
prioritize comments that record a decision or direction change.

**D. Artifacts:** use file-pattern search (not shell `ls` — zsh errors on
unmatched globs) over both layouts —
`<repo>/docs/artifacts/*/*<eng-nnnnn>*/SPEC.md` (month dirs) and
`<repo>/docs/artifacts/*<eng-nnnnn>*/SPEC.md` (bare ticket dirs), matching the
id case-insensitively. From each SPEC read:
- the `**Status:**` header line;
- `## Goal` and `## Context` (first ~5 lines each — feeds the story-so-far);
- `## Non-Goals / Rejected Approaches` in full (capped ~20 lines) — this is
  the do-not-reinvent record; feeds the `decisions` drill-down and, when next
  steps touch a rejected approach, the Heads-up line;
- `## Deliverables` checkbox tallies (checked vs unchecked, keep the unchecked
  items);
- the last 3 dated entries of `## Progress Log`;
- `## E2E Evidence` ✅/⬜ tallies.
Also glob `qa-evidence-*/SUMMARY.md` in those dirs and read the newest one for
the exact verification commands, cluster/context used, and per-scenario
verdicts (feeds "How to verify"). Multiple SPEC dirs → summarize the newest
(by month dir), list the others under Sources.

**E. Plans:** `grep -il -e <eng-nnnnn> -e <branch> ~/.claude/plans/*.md`.
Rank hits: filenames containing the ticket id first, then by modification
time (content-only matches can be false positives — another session merely
mentioning the ticket). Read the top match in full and one runner-up's
headings. Extract: the chosen approach, explicit decision points, and
unfinished checkboxes. If an approved plan exists, the briefing MUST say so
prominently: "an approved plan already exists at `<path>` — read it before
re-planning."

**F. Infra:** read `~/.kindo/clusters.json`; find the entry under `.clusters`
whose `.branch` equals the target branch (shape:
`{branch, worktree, ports{api,next,hatchet,grafana,…}, tier, createdAt}`).
Staleness check: the entry's `worktree` path and the branch must still exist —
otherwise report "stale registry entry for `<cluster>`" and skip the status
call. If valid: `(cd <entry.worktree> && yarn local:status --json)` with a
~60s timeout. On failure: "cluster `<name>` registered (api :<port>,
next :<port>) but not responding — try `yarn local:up`."

**G. Memory:** grep the project memory index
(`~/.claude/projects/<slugified-cwd>/memory/MEMORY.md`) for the ticket id or
branch. **Read the matching memory files (≤2), not just the index** — they
hold exactly the anti-waste content (gotchas, "how to apply", landed
decisions). Feed gotchas into the `how-to-verify` drill-down and decisions
into the `decisions` drill-down (or the Heads-up line if the next steps touch
them), each with a pointer to the memory file.

## Step 3 — Synthesize a COMPACT digest

The default output is a short digest — roughly 25 lines, never more than ~35.
Everything you gathered stays available for follow-up questions; the digest
shows only what's needed to re-orient and start. Do not write it to a file.

```
# ENG-10751 — <Linear title>
`simon/eng-10751-…` · Linear: In Progress · PR #11423 open (CI ❌) https://github.com/org/repo/pull/11423 · SPEC 🟡 · last touched 2 weeks ago

## 🧭 Where you left off
<2–3 sentences: the goal in one clause, what's built so far, and exactly what
was mid-flight when work stopped (from the uncommitted-diff characterization).>

## ▶️ Next steps
1. <max 3 — see priority order below; each one imperative sentence + source pointer>

## 🔗 Related branches & PRs
- PR #11829 merged ✅ — [ENG-10860] backend bulk delete — https://github.com/org/repo/pull/11829 · `simon/eng-10860-pr1-backend-bulk-delete`
- PR #11833 open · review pending · CI ❌ — frontend select-all — https://github.com/org/repo/pull/11833 · `simon/eng-10860-pr2-frontend-select-all` ← you are here
- `eng-10860-spike` — no PR · local worktree .claude/worktrees/eng-10860-spike · last commit 06-12

Status: 7/10 deliverables · 2 sub-issues open · 8 files uncommitted · behind main by 41 · cluster up (api :8000, next :3000)
Heads-up: <0–2 lines ONLY for traps: a decision on record that the next steps touch, a conflicting signal (SPEC 🟢 but PR open), a stale/broken cluster>

Ask me to expand: done · decisions · remaining · PR/review · how-to-verify · infra · sources
```

Rules for the digest:
- **One line per fact.** The Status line replaces the old Done / In flight /
  Remaining / Infra sections — tallies only, no bullets. Omit any tally with
  nothing to say.
- **Next steps cap at 3.** If more exist, fold them into the `remaining`
  drill-down and say "…more under remaining".
- **Related branches & PRs: one line per item, max 6.** Every line carries the
  status and the link: PRs as `PR #n <state> [· review decision · CI] — <short
  title> — <url> · <branch>`; PR-less branches as `<branch> — no PR · <worktree
  path or "local/remote only"> · last commit <date>`. Mark the target branch
  with "← you are here". Order: open PRs, then merged/closed, then PR-less
  branches. More than 6 → keep the 6 most recently updated and add "…N more
  under PR/review". Omit the whole section when the ticket has exactly one
  branch and no sibling PRs (the header already shows the primary PR and its
  link). The header line always carries the primary PR's URL, so a link
  renders even when this section is omitted.
- **Heads-up is not a section, it's a tripwire** — include it only when
  silence would cause rework (e.g. "approved plan exists at <path> — read
  before re-planning", "Jira-DC mode was rejected, see SPEC non-goals").
  Otherwise omit it entirely.
- **No source dumps.** Paths/URLs appear only in the header, Heads-up, or on
  request via `sources`.

**Drill-downs:** after printing the digest, answer follow-ups (`done`,
`decisions`, `remaining`, `PR/review`, `how-to-verify`, `infra`, `sources`, or
any free-form question) **from the material already gathered in Step 2 —
do not re-run probes** unless the question needs data no probe collected.
Drill-down answers may use the fuller formats: done (≤6 bullets + the
"already in place on this branch" file inventory), decisions (≤5 with source
pointers), remaining (≤8), how-to-verify (≤4 runnable commands + gotchas).

**Next-steps priority** — pick the top ≤3, in this order:
1. failing/erroring CI checks → "fix `<check>`"
2. pending review / review comments → "address N review comments on PR #n"
3. mid-flight uncommitted work → "finish <characterized change> (or stash it)"
4. first unchecked SPEC deliverable(s)
5. open or blocking Linear sub-issues
6. ⬜ E2E Evidence scenarios
7. infra needed but down → "`yarn local:up`"

## Degradation & edge cases

| Case | Behavior |
|---|---|
| `gh` missing or unauthenticated | "PR state unknown (gh not authenticated)" |
| No `LINEAR_API_KEY` and no Linear MCP | "Linear skipped (no API key / MCP)" |
| No SPEC found for the ticket | "No docs/artifacts spec found for ENG-N" |
| Multiple SPEC dirs match | Summarize newest; list the rest under Sources |
| No plan / no memory hit | Omit the callout lines; never invent decisions |
| Detached HEAD or `main` / no ticket token | Git-only repo snapshot + hint to pass an ENG-id |
| Multiple worktrees/branches for one ticket | Prefer cwd, else most recent commit; list alternates |
| Target worktree ≠ cwd | `git -C`, absolute-path reads; never `cd` except for `yarn local:status` |
| Stale `clusters.json` entry | Flag as stale; do not run `yarn local:status` |
| Non-mono repo | Git + PR sections only; skip linear-script/artifacts/infra probes silently |
| Not a git repo | Say so; suggest `/remind-me ENG-1234` |
