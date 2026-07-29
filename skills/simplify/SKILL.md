---
name: simplify
description: >-
  Post-implementation refinement pass: remove slop from recently changed code,
  tests, and docs — dead code, needless abstraction, duplication, comment
  noise, excess coupling/state/logic complexity, and stale references left by
  mid-development pivots. Behavior-preserving edits are applied directly;
  API/semantic changes are only reported. Invoked automatically by personal
  coding-agent hooks after large changes, or manually by invoking the simplify
  skill. Arguments: a file list (hook path),
  --diff <ref>, or empty to use the current uncommitted diff.
argument-hint: "[file list | --diff <ref>]"
user-invocable: true
compatibility: >-
  Works in any repo. Repo-specific heavy checks (scoped typecheck, knip) run
  only when the repo provides the commands; skipped silently otherwise.
---

# Simplify — post-implementation refinement pass

Invocation input means explicit command/skill arguments when the runtime
provides them; otherwise use the files named in the user's request or hook
instruction.

Clean up what was just implemented so the shipped output is clean, concise, and free of slop. This is a **concision gate**, not a defect gate — bug-finding belongs to `self-review`.

## Hard rules

- **Behavior-preserving edits only.** If an edit could change observable behavior, it goes in the report, not the diff.
- **Safe-only auto**: never auto-apply anything that changes exports, public API shape, function signatures used elsewhere, or semantics (including collapsing a helper into its single caller if the helper is exported). Report those in one line each instead.
- **Never widen scope** beyond the resolved file set. Sole exception: the stale-reference grep (below) may *read* anywhere, and may fix stale references it finds in docs/artifacts belonging to the current effort.
- **No subagents.** Run inline; this pass must stay cheap.
- Do not re-explain or justify edits in code comments. Apply, then summarize per the output contract.
- If there is nothing to do, say "Diff is already minimal." and stop.

## 1. Resolve scope and tier

- A hook instruction containing a file list takes precedence; otherwise, the
  invocation input is a file list and is used as-is.
- Invocation input starting with `--diff <ref>`: `b=$(git merge-base <ref> HEAD)`, then `git diff --name-only "$b"` plus `git ls-files --others --exclude-standard`.
- Empty: uncommitted changes — `git diff --name-only HEAD` plus untracked via `git ls-files --others --exclude-standard`.

Read the **diff** of tracked files (`git --no-pager diff -U10 HEAD -- <files>` or vs the merge-base), and full contents only for new/untracked files. Do not re-read whole files whose diff you already have.

**Tier**: if the hook's instruction stated a tier, use it. Otherwise compute: total changed lines ≤ 40 AND < 3 files → **micro** (taxonomy pass only, no heavy checks); otherwise **full** (taxonomy pass + conditional heavy checks).

Drop from scope: lockfiles, `*.d.ts`, minified/generated files, anything under `node_modules/`, `dist/`, build output.

## 2. Slop taxonomy — what to look for

Work through the diff hunks against these checklists. Fix what is safe; note the rest.

### Code

- **Dead weight**: unreachable branches, unused imports/variables/parameters, code kept "in case" with no caller.
- **Needless structure**: else-after-return, single-use flags, nesting that flattens with early returns, branching that collapses to an expression.
- **Duplication introduced by this change**: near-identical blocks within the diff — extract or unify (only when the extraction is private to the touched files; otherwise report). Dedupe only when it does **not** add state, coupling, or an abstraction more complex than the repetition it removes — otherwise keep the duplication. "Less code" alone never justifies an edit.
- **Reinvention**: before keeping a new helper, grep for an existing util that already does it (mono principle: *extend, don't duplicate*). Swap to the existing one when the call is a drop-in.
- **Speculative generality**: options, parameters, generics, or abstraction layers with exactly one caller and no concrete second use. Inline private ones; report exported ones.
- **Defensive redundancy**: checks that cannot fail given the types, try/catch that swallows and rethrows or wraps nothing meaningful, duplicate validation of already-validated input.
- **Leftover debug**: `console.log`/`print`/dbg output, commented-out code, TODO markers for work that was actually done.
- **Type slop**: `any`, `as` assertions that a narrower declaration would avoid, redundant type annotations the compiler infers.
- **Comment slop**: comments that narrate the next line, restate the code, describe the change's history, or address a reviewer. Keep only comments stating constraints the code can't show. Change-provenance notes ("was X", "renamed from Y", "added to fix Z") always go — commits and diffs already record that history, and coding agents can mine it from there on demand.
- **Comment length cap (new comments)**: every comment **introduced in this diff** that survives the slop check must be meaningful and fit in **at most 2 lines**. Trim to the load-bearing constraint; if it genuinely needs more, move the explanation to the spec/doc/commit message and leave a ≤2-line pointer or nothing.

### Functional simplicity (code)

Checked on every changed unit, in **priority order: state > coupling > logic complexity > duplication**. When two simplifications conflict, the higher priority wins (e.g. accept complexity if it eliminates state); when unsure how to resolve a tradeoff, choose the option with less state. Lean on functional-programming principles — pure functions, immutability, explicit data-in/data-out, composition — so the shipped code costs the reader the least mental effort.

- **Coupling**: a changed unit should depend on the narrowest surface that serves it. Narrow parameters that take a whole object but read one or two fields; replace reach-through chains (`a.b.c.d`) by passing the needed value; make hidden inputs (module-level state, ambient config reads inside a function) explicit parameters. Private-scope narrowing is applyable; exported signatures are report-only.
- **State**: prefer stateless. `let` that could be `const` + expression; accumulator loops that collapse to `map`/`filter`/`reduce`; boolean/state flags replaced by values derived at the point of use; mutation of shared or module state — separate the pure computation from the effect and push the effect to the edge. In-place mutation of a parameter or shared structure is a semantics risk: apply only when confined to the touched file's private scope, otherwise report. A cache, singleton, memoization layer, or mutable module-level variable **introduced by this diff** is state that outlives a call — report it unless the value is derivable at the point of use (then derive it).
- **Purity**: a computation function that reads the clock (`Date.now()`, `new Date()`) or randomness deep inside its logic isn't referentially transparent and resists testing (env/config reads are the coupling bullet above). Inject the value as a parameter when the function is private; report when exported.
- **Command–query separation**: a new function that both returns a computed value and performs a side effect (writes, mutates a param, logs-as-signal) — split into pure query + effectful command. Private splits are applyable; exported ones report-only.
- **Mutating stdlib traps**: `sort()`/`reverse()`/`splice()` on an array that isn't a fresh local copy, or returning a mutated input. Switch to `toSorted()`/`toReversed()`/spread-copy when it's a drop-in.
- **Redundancy**: beyond the duplication/reinvention bullets above — the same expression computed more than once, values re-derived that an earlier binding already holds, parallel data structures kept in sync by hand when one derives from the other.
- **Logic complexity**: beyond the needless-structure bullet above — compound boolean conditions → named predicates; branch ladders → an expression or lookup map; interleaved concerns → compose small single-purpose functions. Prefer the declarative form when it reads with less effort — if a clever one-liner costs more to parse than the branch it replaced, keep the branch.

### Tests

- Duplicate or fully-overlapping cases — collapse to the distinct behaviors.
- Copy-pasted setup where an existing factory/helper exists — use it.
- Assertions that test the mock instead of the code under test.
- Over-mocking: in repos with a testing standard (mono: `testing-standards` skill — banned mocks list), defer to it; don't invent local exceptions.

### Prose (md, docs, dev artifacts)

- Filler, restating the obvious, sections duplicating other docs — cut.
- **Stale-info sweep** (the ad-hoc-pivot check):
  1. Every identifier, path, command, flag, or option named in md files in scope must exist in the final code — verify each by grep; fix or delete mentions that don't.
  2. From the code diff, extract identifiers that were **removed or renamed** during this change. Grep the effort's docs for survivors: md files in scope, plus `docs/artifacts/**/<ticket>*` when a ticket id is resolvable from the branch name. Fix stale mentions.
  3. SPEC/progress-log claims must match what the implementation finally does — correct descriptions of approaches that were tried and abandoned mid-turn.

## 3. Conditional heavy checks (full tier only)

Run only what the repo provides; skip silently otherwise.

- **Scoped typecheck** of touched packages — mono: `yarn workspace <pkg> typecheck` per touched package (fall back to root `yarn typecheck` only if the change spans many packages). Run after applying edits; fix any type error your edits introduced.
- **Unused exports (knip)** — only if the diff **deleted or moved exports**: mono: `yarn check:unused` from the touched package dir (only some packages wire it). Flag newly-unused exports in the report; deleting them is an API-shape change (report, don't apply — unless the export was introduced in this same diff).

## 4. Output contract

At most 10 lines:

```
Simplify pass (<tier>, N files):
Applied: <count by category, e.g. "3 dead-code, 2 comment-slop, 1 util-reuse">
Stale refs fixed: <count, with file names if ≤3>
Suggested (not applied): <one line per safe-only exclusion, with file:line>
Checks: <typecheck/knip result or "skipped (micro)">
```

Or the single line: `Diff is already minimal.`
