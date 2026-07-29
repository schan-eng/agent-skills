---
name: decompose
description: >-
  Decompose the current branch into a small number of digestible, modular PRs
  that each branch off and target a shared integration branch — independent
  buildups in reading order, then one wiring PR that ties them together — with
  the umbrella integration PR as the single hub for all set-level context.
  Prefer parallel spokes over stacked dependencies, and prefer fewer PRs over
  more: never over-decompose. Plan-first: always display a decomposition plan and
  REQUIRE explicit human approval before creating any branch, commit, or PR.
  Invoke explicitly via `/decompose` (not auto-invoked) to decompose / split a
  branch into smaller reviewable PRs.
argument-hint: "[base-ref (default: origin/main)]"
user-invocable: true
disable-model-invocation: true
compatibility: Requires git and an authenticated GitHub CLI (gh) to open the decomposed PRs, and a repo with a runnable test suite (plus optional lint/build) so each compartment can be verified green. Invokes the simplify and self-review skills.
---

# Decompose — split a fat branch into a few modular PRs

Invocation input means explicit command/skill arguments when the runtime
provides them; otherwise use the target named in the user's request.

Big PRs hide intent and let slop slip through. This skill splits one branch's objective into a **small set of digestible modular PRs** plus **one wiring PR** that ties them together, so a reviewer reads the work as a story: one intention per PR, graspable at a glance, green on its own.

**The shape — parallel spokes and one hub.** Every PR branches off the **integration branch** and targets it directly. Buildups depend only on the base, so they merge in any order and can be reviewed simultaneously. The wiring PR alone references the others and alone flips behavior; it merges last. Main is untouched until the assembled integration branch merges in one final PR — and because each buildup is inert, integration is main-mergeable at every point.

**Two failure modes, equally bad.** One fat PR nobody can review — and a swarm of tiny PRs that costs more to track than it saves to read. Aim between: as few PRs as the distinct intentions require, each independently reviewable.

## Prerequisites

`git`; `gh auth status` succeeding; a runnable test suite (ideally lint/build too) so each compartment can be proven green. If either is missing, say so up front — the plan can still be produced, but flag that PR creation / per-PR verification can't complete.

## PRIME DIRECTIVE — plan first, never auto-execute

Two halves separated by a HARD GATE: **Analyze + Plan** (read-only), then **Execute** (branches/commits/PRs) — ONLY after the human explicitly approves the displayed plan. **Nothing mutates before the gate**: no branches, commits, PRs, pushes, and no cleanup passes (simplify runs after decomposition, per compartment, in Phase 4). Present the plan and request approval. Silence or an ambiguous reply = not approved.

## The integration PR is the hub

All **set-level** context lives in exactly one place: the umbrella `integration → main` PR, mirrored by the committed `CHECKLIST.md`. Individual PR bodies stay brief and point back to it (`Context: <umbrella link>`), so there's one thing to update when the plan changes and no reviewer has to reconstruct the arc from N descriptions. The hub carries:

- the thesis, and the numbered reading order with each PR's live status;
- the merge rules — buildups any order, wiring last, plus any declared dependency edge;
- a **symbol map**: `Name` — defined v\<i>, consumed v\<j> — so nobody greps across PRs to orient;
- **reviewer assignment per PR** (this is what makes parallel review actually happen — a DB owner and a service owner can review at the same time);
- cut-candidate decisions, the cleanup ledger, and the amendment log;
- **deploy ordering** for the final merge: migrations vs code, flag state at deploy, what to watch after.

When a PR is re-scoped, added, or dropped, update the hub first, then the affected PR bodies — including the symbol map whenever anything renames.

**Approving the hub PR means:** every checkbox ticked, CI green on integration, the reconstruction check passed, deploy ordering confirmed, cut candidates resolved. It does **not** mean re-reading the reassembled diff line-by-line — each compartment was already reviewed on its own, and re-reviewing the whole thing discards the split. State this in the hub body so the final approver knows exactly what they're signing.

## What you are optimizing: reviewer comprehension

The metric is the **total** time and effort a reviewer spends becoming confident — summed across the set, not per PR. Splitting helps only while it lowers that sum. A PR is comprehensible when the reviewer can, in one sitting with no outside context, answer: *what is this, why now, what changed, what did NOT change, how do I know it's safe.* Hold this bar:

- **One concept per PR — and a whole concept.** Never mix a refactor with a behavior change, or two intentions; equally, never split one intention to make diffs smaller.
- **Name the judgment being asked.** State what approval means for this PR (`Approve if:`) and how hard to look (`Review mode:`). An inert buildup asks "is this abstraction right and is it truly unreachable?" — production correctness isn't on the table. Wiring asks "is this switch safe and undoable?" `Approve if` is a **floor, not a ceiling** — it states what must be true, never what may be skipped, and a bug found outside it is still a blocker.
- **Prove claims, don't assert them.** `INERT` ships with the command and result that show it; "tested" ships with the test that fails if the central line is reverted. Both save every reviewer re-deriving them.
- **Teach, don't just show.** Sequence the files to read, name the ones to skip, point at the 1–3 lines carrying the meaning, and state what's deliberately absent.
- **Introduce vocabulary before use.** A type/helper lands in a buildup and is consumed **only by wiring**; cross-compartment imports live in the hub PR.
- **Each PR earns approval alone**, without re-deriving PRs 1…k-1.
- **Per-PR budget, secondary to the set.** Prefer ~5 minutes of reading (≈ ≤200 net logic lines, one subsystem; generated lines don't count). When that conflicts with keeping the set small, the set wins — ship the larger PR with a good reading guide.

## Phase 0 — Survey the tree (read-only)

If the tree holds **unrelated uncommitted changes**, tell the user and let them set those aside — don't sweep them into the split. Note cleanup opportunities (dead code, debug leftovers, formatting churn) as **Cut candidates** for the plan rather than fixing them now. Don't run simplify: it mutates, and cleaning before the seams are known reshapes the hunks you're about to plan around.

## Phase 1 — Analyze the branch

1. **Resolve the base.** Use the invocation input if given, else the real default branch — `git symbolic-ref --short refs/remotes/origin/HEAD` (fallback `origin/main`). Then `base=$(git merge-base <base-ref> HEAD)`. The source is the **cumulative diff from `base` to the current working state, including uncommitted changes**.
2. **List churn:** `git diff --stat "$base"` across **ALL paths — never scope to one subdirectory.** Branch work often spans services (a backend endpoint + the CLI calling it); narrowing to `-- some/dir/` silently drops cross-cutting changes and yields a mis-ordered split. Read every non-trivial hunk — you cannot group what you haven't read.
3. **Per file/hunk, identify:** **intention** (what feature/fix it serves — group by *why*, not by file type); **kind** (new module, new function, edit to reachable code, config/flag, test, docs, dependency, migration, deletion); **reachability** (executed by a production entrypoint today, or inert — this drives ordering); **dependencies** (what it needs to compile/run — these decide what can be parallel).
4. **Write a one-line thesis.** The PR set must tell that story.
5. **Resolve the Linear ticket id** — it anchors every name. Match `[A-Za-z]+-[0-9]+` in the branch name (`simon/eng-10751-…` → `ENG-10751`); else scan `git log -20 --format=%s` for `[ENG-####]`; else ask. With genuinely no ticket, fall back to a descriptive group slug and note that in the plan.

## Phase 2 — Decompose by intention (the core)

Group hunks into compartments carrying one coherent intention each, then check the grouping against three constraints in order: **right-sized set**, **parallel by default**, **inert until wiring**.

**Test for one intention, applied while grouping:** you can state A's *why now* in one line without mentioning B. If you can't, A and B are one intention — group them together.

### Right-sizing: prefer fewer PRs

**The count follows distinct intentions — never files, modules, or layers.** Target **2–4 PRs including wiring**; **5 is a hard ceiling, not a goal.** Two is a fine answer, and a single-intention branch should get a recommendation NOT to split rather than invented seams. Ask how few PRs could tell this story, then split only where a reviewer would genuinely stall.

**Over-decomposed if any of these holds — merge the offenders:** a PR's "why now" repeats its neighbor's; it adds under ~30 net logic lines and isn't pure mechanical noise; a reviewer would always open two together to understand either; a compartment exists to satisfy structure rather than isolate an intention; the same background is re-explained in three bodies; or splitting produced a dependency you then had to work around.

When merging to respect the ceiling, combine the **two most-related** compartments; a slightly-over-budget PR with a good reading guide beats a sixth PR.

### Parallel by default

Every buildup should stand alone — green against the base, **no dependency on any other compartment** — so all can be opened, reviewed, and merged in any order. If buildup B needs code from A, work these escapes **in order**: (1) **merge A and B** (usually right, and it shrinks the set); (2) **move the consuming line into wiring**, leaving both independent; (3) **make A self-sufficient** so B doesn't need it yet (B ships its own narrow helper, or A's type is exercised only by its own tests).

### When a dependency is genuinely needed

Sometimes no escape works: a migration a new query layer needs to compile, an intra-file split touching the same lines, a type whose only meaningful test needs its consumer. Stacking is then permitted under **all** of:
- **at most one dependency edge** in the set, and **never a chain deeper than two** — a child of a child means re-seam;
- the child branches off and targets **the parent's branch** (`--base <parent-branch>`); GitHub re-targets it to integration when the parent merges;
- plan and PR body both declare `Depends on: v<j>/<n> (merges first)`, and the hub records the merge-order constraint;
- the plan states **which escape failed and why** — an undefended stack is a re-seam signal;
- the body notes that the child's GitHub diff includes the parent until the parent lands.

### Inert until wiring

Order compartments so **production behavior does not change until the final PR** — branch-by-abstraction applied to review.

**Buildups (1 … n-1)** add code that is **inert in production**: present, unit-tested in isolation, unreachable from any live entrypoint. A change is production-inert when it is a new file/module nothing imports yet; a new function/class/type no reachable path calls yet; a new flag/config defaulting to *current* behavior (off); tests, docs, or fixtures; an added-but-unused dependency; or an additive, backward-compatible migration (new nullable column / new table nothing reads yet).

**Wiring (n, last)** is the small diff that makes it live: register the route/handler, import-and-call the new module from the existing entrypoint, flip the flag default, swap the old path out, delete dead code. The only PR that flips behavior, kept small enough to read line-by-line; merged after every buildup lands; the place cross-compartment code meets. This inert→wiring order is also the **reading order**, so the reviewer learns the feature incrementally.

Each compartment must be: **self-contained & green** (full suite passes on its own against its base); **independent** (base only, unless it's wiring or the one declared stack child); **inert until wiring** (a buildup that changes production behavior is mis-grouped — move that line to wiring); **whole** (a complete intention, not a fragment); **covered** (ships tests for what it introduces, never deferred).

### Worked examples — the parallel default and the one exception

**Vertical slice (3 PRs, fully parallel)** — new endpoint plus the CLI that calls it:
- **v1/3 handler** + unit tests, route unregistered. INERT (proof: `rg 'archiveRoute'` → definition only). Review mode: design. Reviewer: service owner.
- **v2/3 client method** + unit tests, nothing calls it. INERT, independent — reviewed *simultaneously* with v1, merges in either order. Reviewer: CLI owner.
- **v3/3 wiring** — register the route, call the method, e2e test. LIVE; undo = clean revert. Review mode: line-by-line.
- The shared request/response type is the classic forced dependency: put it in wiring, or let each side hold a narrow local type until wiring unifies them.

**Additive migration (3 PRs, one declared stack)** — schema plus a new read path:
- **v1/3 migration** — new nullable column, nothing reads it. INERT.
- **v2/3 repository layer** + tests, **stacked on v1** (`Depends on: v1/3`) — it cannot compile without the column, and all three escapes fail: merging buries a migration inside app code, there's no consuming line to move to wiring, and the query can't be tested without the table.
- **v3/3 wiring** — switch reads over, backfill, delete the old path. LIVE. Hub records the deploy ordering: migration runs before the code ships.

### More patterns

- **Flag-gated feature** — v1 flag defaulting to today's behavior · v2 module, unimported · v3 wiring flips the default. Keep the flag *read* in wiring so v1 and v2 stay independent.
- **Refactor to make room** — v1 provable no-op (verify-no-op mode, existing tests updated) · v2 inert capability · v3 wiring. Never interleave a refactor and a feature in the same file; the refactor ships first and the feature rebases.
- **Consolidating N ad-hoc copies** — v1 abstraction + tests, inert · v2 wiring swaps all N call sites and deletes the old copies. Converting N sites is ONE intention.
- **Dependency bump** — v1 manifest/lockfile alone (mechanical, skip-the-diff) · v2 adapt the call sites. If the bump alone is red, they're one PR — never ship red to preserve a seam.
- **Live bugfix inside a feature branch** — pull it out as v1: minimal, LIVE, cherry-pickable, undo stated. Never let a fix hide inside the wiring PR, where its risk blends into the feature's.
- **Hot-path optimization** — v1 benchmark + instrumentation (inert, and it doubles as the falsification device) · v2 the optimization, LIVE. `Approve if:` = the benchmark is honest.
- **Decommission** — the one inversion of inert-then-wiring: v1 stop calling it (LIVE, small, revertible) · v2 delete the now-unreachable code (inert).
- **Multi-service monorepo change** — shared contract first (inert), one independent spoke per service, then wiring flips traffic. Past two services the ceiling bites: merge spokes, and assign a reviewer per service in the hub.

**Never split these — each is one intention:** one PR per layer (model / service / controller); a unit apart from its tests; a config knob into schema + parser + default; a rename by file; an interface from its only implementation; a "types PR" that exists only to unblock two others (you engineered the dependency); a UI feature into component / hook / page / fetch — that's 2 PRs, not 4.

### Tests travel with their code

No PR defers its tests ("tests coming next" is forbidden — each PR is green *and* covered). **Buildup** ships **unit tests** for the unit it adds; a buildup with no accompanying test is incomplete. **Wiring** ships **integration / e2e** tests for the now-connected behavior, plus any contract / migration / smoke tests the live path needs. **Refactor/rename** carries the **updated** existing tests, green. State the levels in each plan entry, and give the **falsification**: which test fails if the central line is reverted. A green suite with zero coverage of the new lines doesn't count.

### When "no impact until last" can't fully hold

Be honest — a bugfix, security patch, or hot-path change is inherently live; don't fake inertness. Isolate each in its own minimal PR, place it as early as safe, and flag it as "has production impact" with blast radius and undo path. Removals invert the order outright (stop calling it, *then* delete the dead code), which is fine — say so in the cover note. Goal: *most* of the set is inert, and the live pieces are tiny and conspicuous.

### Boundary heuristics

- Prefer **whole-file** boundaries. Split a file across PRs only when its hunks serve genuinely different intentions; intra-file splits are harder to keep green and are the commonest source of a forced dependency.
- Keep refactors separate from behavior changes: a rename/move PR is a no-op approvable without thinking; a behavior PR carries no incidental renames.
- **Quarantine the noise** — formatting, moves, regenerated lockfiles/snapshots get their own early PR, but only if there's enough to distort another PR. Mark generated paths `linguist-generated=true` in `.gitattributes` so GitHub collapses them.
- One new dependency = its own (or a clearly-labeled) PR; reviewers scrutinize new deps.

### Flag slop — don't just relocate it

Splitting must not launder unnecessary code into a tidy-looking set. Anything not tracing to the thesis is a **cut candidate**: dead/unreachable code, speculative gold-plating, debug leftovers, unrelated drive-by edits, abstractions with a single caller. List them in the plan with a one-line reason each and let the human decide. A good decomposition usually makes the branch *smaller*, not just rearranged.

## Phase 3 — Present the plan, then STOP (HARD GATE)

Lead with the **cover note** (which becomes the hub PR body), then one terse entry per beat.

**Cover note:** the thesis in one sentence; the integration branch name + checklist path (`docs/artifacts/<YYYY-MM>/<ticket-slug>/`) and that every PR merges into integration, not main; the numbered table of contents in reading order, each line one story beat; the merge rules plus any dependency edge and the escape that failed; the **symbol map**; **suggested reviewer per PR**; **why this count** — one line on where you merged rather than split; which PR flips behavior; **deploy ordering** for the final merge; totals (PR count, LOC, inert-vs-live); any **cut candidates**.

**Naming — anchor on the ticket** so branch, PRs, and checklist are unmistakably one group. Pick a short **group label** from the thesis:
- **Integration branch:** `<ticket-lower>-integration` (e.g. `eng-10751-integration`).
- **PR branch:** `<ticket-lower>-v<k>-of-<n>-<beat-slug>` (e.g. `eng-10751-v1-of-3-archive-endpoint`, n ≤ 5).
- **PR title:** `[<TICKET>] <group label> v<k>/<n>: <brief beat>` — e.g. `[ENG-10751] kindo cli validate v1/3: archiveConversation endpoint`. The prefix matches repo convention; label + `/<n>` show the group and its size from any one PR.
- **Checklist:** committed markdown in the **feature-artifacts directory, NOT the repo root** — `docs/artifacts/<YYYY-MM>/<ticket-slug>/CHECKLIST.md` (e.g. `docs/artifacts/2026-06/eng-10751-kindo-validate/CHECKLIST.md`), a tracked artifact shipping to main like the specs/qa-evidence already there. Mirror it into the hub PR body as `- [ ]` items for live ticking; optionally also render a hosted Artifact.
- **Final PR:** `integration → main`, titled `[<TICKET>] <group label>: integrate <n> PRs`.

`v<k>` is **reading order**; merge order is free for buildups, constrained only by wiring-last and any declared edge. With no ticket, substitute `<group-slug>` for `<ticket-lower>`, drop the prefix, and say so. Show every proposed title **and** branch so the human approves names and count; renumber if the count changes.

**Per PR, in order** — short phrases; this doubles as the shipped body:

```
v<k>/<n>  "[<TICKET>] <label> v<k>/<n>: <beat>"   branch: <ticket-lower>-v<k>-of-<n>-<slug>
  Context:       <umbrella PR link> — read the hub first; the arc takes 60 seconds
  Base:          <ticket-lower>-integration   (a declared stack child bases on its parent)
  Role:          buildup (any order) | wiring (last; ties v1…v<n-1>)
  Depends on:    none | v<j>/<n> — merges first; <escape that failed>
  Why now:       <this beat's intention — distinct from every other PR's>
  Review mode:   verify-no-op | design | line-by-line
  Approve if:    <the single judgment asked — e.g. "the interface is right", not "the code is correct">
  Read in order: <the files/lines carrying the meaning>    Skip: <generated/snapshot/lockfile paths>
  Does NOT:      <deliberately absent — so nothing reads as missing wiring>
  Production:    INERT — proof: `<cmd>` → <result>   |   LIVE — <blast radius>; undo: <flag flip | clean revert>
  Falsification: revert <line> → <test> fails
  Instead of:    <rejected alternative + one-line why>   (only where a new abstraction lands)
  Tests:         <unit | integration | e2e> — <what they assert>
  Size:          ~<net logic LOC> · <#files> · <subsystem>
```

**Filled, so the vague fields have a target** (v1/3 of the vertical slice above):

```
v1/3  "[ENG-10751] archive conversations v1/3: archiveConversation handler"   branch: eng-10751-v1-of-3-archive-handler
  Context:       #482 — read the hub first; the arc takes 60 seconds
  Base:          eng-10751-integration      Role: buildup (any order)      Depends on: none
  Why now:       the server needs somewhere to put an archive before anything can call it
  Review mode:   design
  Approve if:    the handler's contract is right — status codes, idempotency on re-archive
  Read in order: handlers/archive.ts (whole file, 60 lines) · handlers/archive.test.ts    Skip: none
  Does NOT:      register the route, touch the router, or expose this to any client
  Production:    INERT — proof: `rg archiveConversation --type ts` → handler + its test only
  Falsification: revert the `already_archived` early-return → test "re-archive is a no-op" fails
  Instead of:    a status field on updateConversation — a separate handler keeps the permission check narrow
  Tests:         unit — happy path, re-archive idempotency, 404 on missing id
  Size:          ~60 net logic lines · 2 files · api
```

Then a one-paragraph **narrative**: read v1→v<n>, what story unfolds, where behavior flips inside integration, and that main changes only at the final merge once every box is ticked. The reviewer should finish it already understanding the feature, so each diff merely *confirms* it.

End with the gate: execution will create the integration branch + checklist + draft hub PR, then N PRs targeting it (simplify + self-review + tests on each **after** carving); list cut candidates awaiting decision; **ask for approval**. Invite the human to re-group — **merging compartments as readily as splitting them** — reorder, drop cuts, or adjust the narrative. Do not proceed without approval.

## Phase 4 — Execute (ONLY after explicit approval)

When every PR has merged into integration, it equals the **intended** final state (original branch, minus approved cuts, plus post-split cleanup), and one `integration → main` PR ships it.

1. **Capture the target.** Save the source branch, then build a synthetic target commit through a temporary index: initialize it from `HEAD` (`GIT_INDEX_FILE=<tmp> git read-tree HEAD`), run `GIT_INDEX_FILE=<tmp> git add -A`, write its tree, and create `target` with `git commit-tree <tree> -p HEAD`. The temporary-index exception is required to include untracked files without touching the real index; remove the temporary index immediately. If cuts were approved, build the intended target on a scratch branch and use that instead. Only when `git status --porcelain` is non-empty, run `git stash push -u` and remember that restoration is required; a clean tree needs no stash. Return to the source branch before `git stash pop` at the end. For actual compartment staging, **never `git add -A` / `git add .`** — use `git checkout "$target" -- <paths>`, `git rm <path>`, or `git add <explicit-path>`. Open the **cleanup ledger**: a running list of every change simplify or self-review makes after the split — it's what keeps step 4 meaningful.
2. **Create the integration branch + hub.** `git checkout -b <ticket-lower>-integration "$base"`. Write `CHECKLIST.md` at the feature-artifacts path with the thesis, reading order, merge rules (buildups any order, wiring last, any declared edge), deploy ordering, and a checkbox per PR — `- [ ] v<k>/<n> — <beat> — INERT|LIVE — buildup|wiring — <reviewer> — <PR link>` — ending `- [ ] integration → main`. Commit (explicit path), push, refresh any repository-required generated PR-body sections (including the current skill report), and open the **draft** `integration → main` PR titled `[<TICKET>] <group label>: integrate <n> PRs`, with the full cover note plus those required sections as its body. This PR is the hub every other PR links to. If drafts don't run CI or accept approvals in this repo, open it ready-for-review with a WIP label instead — CI green on integration is part of the final gate.
3. **Build each compartment `k` = 1 … n:**
   - Branch off **integration** (or, for the one declared stack child, its parent). Each contains only its own changes. Wiring additionally merges each buildup branch in locally before adding its changes; its PR still bases on integration and merges last.
   - Apply **only** compartment `k`: whole-file → `git checkout "$target" -- <files>`; intra-file → `git apply --3way` a patch for just those hunks.
    - **Now simplify** — run the simplify skill on this compartment's diff and apply safe fixes, so cleanup happens in the context of the compartment's own intention. Record every change in the ledger.
   - Confirm it ships its own tests, then run the full suite (and lint/build). It MUST be green AND its new lines exercised — verify the falsification claim by actually reverting the line once. Red = not self-contained (fix the grouping); uncovered = add the test first.
    - Run self-review on the diff; resolve real findings and log them.
   - **Read your own body as a stranger** before opening: all five questions answerable from it alone, or rewrite it. Filler in `Why now`, `Approve if`, or `Falsification` is the usual failure.
    - Commit as **one well-messaged commit per compartment** so reviewers can read commit-by-commit, refresh any repository-required generated PR-body sections, then `gh pr create --base <ticket-lower>-integration --title "[<TICKET>] <group label> v<k>/<n>: <brief beat>"` (a stack child uses `--base <parent-branch>`). Body = the hub link first, that PR's plan entry, and only the repository-required generated sections (including the current skill report); the hub holds the arc. Require CI green on the PR itself, not just locally. **Open wiring as a draft** and mark it ready only once its buildups have landed and its diff is pure — until then it shows the buildups too, so give reviewers `git diff <last-buildup-branch> <wiring-branch>` for the wiring delta alone.
   - Add the PR link and reviewer to the hub.
4. **Reconstruction check (mandatory).** Assemble the wiring branch (all buildups merged in, plus wiring changes) and run `git diff <wiring branch> "$target"`. Every remaining difference must be the checklist file or a ledger entry; anything else means a hunk was dropped or duplicated. (No wiring compartment? Merge all branches onto a throwaway assembly branch off integration and diff that.) A merge conflict while assembling means two compartments overlap — reconcile, and note the overlap as evidence the seam was wrong.
5. **Hand off — do NOT merge.** Merging PRs into integration, ticking boxes, and merging `integration → main` are **human** actions. Report the hub PR first, then the integration branch, every PR URL in reading order with its reviewer, which PR flips behavior, the cleanup ledger, and the deploy ordering for the final merge. Main stays unchanged until that last merge.

### When a reviewer requests changes

Independence makes amendments cheap — use it. Amend the affected **buildup branch only**; nothing else moves, and re-run its suite. If the wiring branch already merged that buildup locally, **re-merge the updated branch into wiring and re-run the reconstruction check** — never hand-patch wiring to match. If a requested change doesn't fit the compartment's "why now", move it to the compartment that owns it rather than absorbing it. Log every post-approval re-scope in the hub's amendment log, renumber `/<n>` if the count changed, and reflect anything that alters intended content (not just cleanup) in the ledger — otherwise step 4 stops catching drift.

**If a reviewer rejects the seam** — "why are v1 and v2 separate?", or "this buildup isn't actually inert" — treat it as a re-plan, not a patch. Fold the compartments (or move the offending line to wiring), close the emptied PR with a comment pointing at its replacement, **renumber every remaining title and branch so `/<n>` agrees**, update the hub's reading order and checklist first, then the surviving bodies. A rejected buildup that can't be salvaged becomes a cut candidate: drop it, renumber, and note it in the hub rather than leaving a dead PR open.

### Keeping the set moving

If main advances while integration sits, merge main into integration, re-run the suite, and re-run the reconstruction check — otherwise the "main-mergeable at every point" invariant decays and reviewers eat conflicts that aren't theirs. Parallel review only pays off if the spokes are reviewed concurrently: if two buildups sit unreviewed for more than a couple of days, the set is failing its purpose — escalate in the hub rather than waiting.

## Guardrails

- Never push, open a PR, or run simplify before the Phase 3 approval.
- PRs target the **integration branch directly** — never main, never each other, except the single declared stack child. Only the final `integration → main` PR touches main, and only humans merge it.
- **Fewer PRs beats more.** 2–4 target, 5 ceiling; merging two compartments is always an acceptable fix, and an already-single-intention branch gets a recommendation NOT to split. Never split one intention to hit a line budget.
- **Set-level context lives in the hub, once** — update it before the PR bodies, always.
- Simplify and self-review may clean a compartment but must not change its **scope**: every deviation from `target` is the checklist or a logged ledger entry.
