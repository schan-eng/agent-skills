---
name: blast-radius-check
description: After a heavy implementation is done, map the full blast radius of the change — every component of the stack it reaches, what a bug in it could break, and whether any of that reach is wider than the task actually required. Use when the user says "blast radius", "what could this break", "what does this touch", "is this safe to ship/release", "did I over-reach", "pre-release risk check", or right after finishing a large/risky implementation and before opening a PR or cutting a release.
---

# Blast Radius Check

Given a finished implementation, produce a **complete picture of what the change touches and what it can reach** — so the user can answer two questions:

1. **Risk:** assume a bug slips through. What is the worst it can reach, and would we catch it before customers do?
2. **Scope:** does this change reach further into the architecture than the task required? Which reaches are load-bearing, which are avoidable?

Question 2 is the one people skip. Unnecessary reach is not just a code-smell — every extra component touched is extra blast radius that the task never asked for. Treat "this change didn't need to touch `packages/*` at all" as a finding of equal weight to "this could take down the cluster."

This is **not** a correctness review — use `/code-review` or `self-review` for "is this code right." Do not modify code. Produce an analysis and a report.

Invocation input means explicit command/skill arguments when the runtime
provides them; otherwise use the target named in the user's request.

---

## Step 1 — Establish the change set *and* the intended surface

**The diff.** Determine exactly what changed, in order of preference:

1. If the invocation input names a ref/range/PR, use it (`git diff main...HEAD`, `gh pr diff <n>`).
2. Otherwise default to the working diff vs the default branch: `git fetch`, then `git diff --stat $(git merge-base HEAD origin/main)...HEAD`, plus uncommitted changes (`git status`, `git diff`).
3. If nothing is staged or committed, ask the user what to scope against.

List changed files grouped by **component/layer**. In this monorepo that means at minimum: `apps/next` (frontend), `backend/api` (tRPC), `backend/task-worker-ts` (Hatchet workflows), `packages/*` (shared — high blast), `packages/prisma` (schema/migrations — often irreversible), `tools/kindo-cli` (incl. its `deploy/`) + per-service `helm_chart/` (install/release), infra/Terraform. If a `monorepo-architecture` skill exists, consult it for layer boundaries and dependency rules.

**The intent.** You cannot judge whether reach is necessary without knowing what the task was. Get it from the ticket, PR description, commit messages, or the conversation; if none of that is available, ask the user for one sentence on what the change was supposed to do.

Then, *before* looking further, write down the **minimal surface**: the smallest set of components a competent implementation of that task would have had to touch. Keep this rough — it's a baseline for Step 5, not a verdict. Note where you're guessing.

---

## Step 2 — Map edges in both directions

The change is only the epicenter. Map both what depends on it and what it now depends on.

### 2a. Reverse dependencies — who consumes the changed code

For each changed symbol/module, find its consumers. This is the blast radius surface.

- Shared package / exported util / exported type → grep for importers across all workspaces. Changes here radiate widest.
- tRPC procedure / service → which screens, agents, workflows, or other services call it.
- Prisma schema/migration → every query touching those tables/columns.
- Env var / feature flag / config → every runtime that reads it; default-on vs default-off; build-time vs runtime.
- Helm/deploy/CLI change → which services redeploy, install ordering, post-install scripts, secrets.

**Grep for imports will miss dynamic references.** Also search for the changed names as *strings*: string-keyed registries and handler maps, DI/provider names, feature-flag keys, raw SQL and `$queryRaw`, i18n keys, codegen templates and config files, dashboard/saved queries. Renames are the dangerous case — a rename that compiles clean can still break a runtime lookup.

**Check generated artifacts.** Prisma client, tRPC types, any openapi/graphql codegen: did the diff include the regenerated output, or is it now stale relative to the source of truth?

### 2b. Forward dependencies — what the change now reaches out to

New outgoing edges are both a risk and the clearest signal of unnecessary reach. For each changed file, list edges that did not exist before:

- New imports, especially across layer boundaries (frontend reaching into backend internals, `backend/api` importing worker internals, anything importing *upward* against the dependency rules).
- New third-party dependencies.
- New required env vars, secrets, or config keys.
- New outbound network/service calls, new DB tables or queries touched, new external APIs.

Flag every new **architectural** edge explicitly — a new cross-layer dependency outlives this PR and constrains everything after it.

For a large diff, fan this out through parallel read-only exploration subagents
when the runtime provides them (one per changed component). Otherwise inspect
the components directly. Wait for every pass before writing the report, and
note thin or unavailable coverage in the confidence section.

---

## Step 3 — Check what *didn't* change but should have

A diff cannot show omissions, and omissions are a large share of real blast radius. For each kind of thing the change introduces, grep for the other places that pattern already exists and confirm all of them were updated.

- **New env var / config key** → is it in `.env.example`, docker-compose, helm values, Terraform, CI config, the CLI's config schema, and the docs?
- **New tRPC procedure** → does it apply the same auth/authorization middleware and validation its siblings apply?
- **Changed shared type or interface** → updated in every workspace and every parallel implementation of it?
- **Migration** → seeds, fixtures, factories, test data updated?
- **Deleted or renamed export / endpoint / env var / column** → does anything still reference the old name, including non-code consumers?
- **New pattern where N similar cases exist** → were the other N handled, or is this now inconsistent?

---

## Step 4 — Reason about failure modes per affected area

For each affected area, ask "what if there's a bug here" — and cover all four families below, not just the first.

### 4a. Correctness failures

What concretely breaks? Be specific: "chat send 500s", "agent runs silently stop firing", "all orgs lose model X".

### 4b. Resource and concurrency failures

Code that is logically correct can still take down a cluster. Check for: new N+1 patterns; filters/joins on unindexed columns; queries against tables that are only large in prod; synchronous calls added to a hot path; fan-out that can hit a third-party rate limit; connection-pool or memory pressure; non-idempotent work inside a retried Hatchet workflow; frontend bundle growth; LLM token-cost blowups. These are frequently cluster-tier with **no failing test anywhere**.

### 4c. Contract and version-skew failures

During a rolling deploy or a self-managed upgrade, old and new run side by side. For every versioned contract the change touches, ask whether N-1 still works:

- tRPC input/output schemas — old frontend against new API, and new frontend against old API.
- **Hatchet job payload shapes** — jobs enqueued with the old shape and deserialized by new code. Silent by nature; treat as high risk.
- Cache/Redis key shapes and cached value shapes; persisted client state; webhook/event payloads consumed externally; CLI flags and config-file format.
- Prisma migration: additive or destructive; locking; backward-compatible with currently-running code.

Also determine, explicitly: **is there a required deploy order** (migration first? API before frontend? code that tolerates both schemas?), and **does rollback work in both directions** — if code rolls back after the migration ran, does the old code still function against the new schema?

### 4d. Tenant isolation

Don't leave this as a category to "consider" — make it a mechanical check. For every changed query, confirm the org/tenant scoping predicate is still present. For every new procedure or data access path, confirm it has one. A bug here is org-data-leak class, not broken-feature class.

### Then score each affected area

- **Breadth** — `LOCAL` (one screen/endpoint, single user) / `ORG` (whole tenant) / `CLUSTER` (whole deployment) / `RELEASE` (every self-managed customer).
- **Severity** — cosmetic / degraded / broken / **data loss or leak**. Score separately from breadth: `LOCAL` + silent data corruption outranks `CLUSTER` + cosmetic.
- **Accumulating?** — does the damage stop when you notice it, or keep compounding until fixed (corrupting rows, dropping events, leaking spend)?
- **Reversibility** — feature-flagged (flip off) / config (re-roll) / code (redeploy or rollback) / **irreversible** (data migration, dropped column, deleted data, released artifact).
- **Detection** — name the *specific* test file and assertion, or monitor/alert, that would catch it, and whether the diff touched that test. "A test file exists for this module" is not coverage of this branch — say which is true. For the `kindo validate` e2e gate, check whether it exercises this *configuration*: flag on and off, cloud and self-managed, fresh install and upgrade. Mark anything with no coverage as **undetected**.

Silent + irreversible is the worst quadrant. Say so plainly when you find it.

---

## Step 5 — Judge the scope: is any of this reach unnecessary?

Compare the surface actually touched (Steps 2–3) against the minimal surface from Step 1. For each component touched beyond it, classify:

- **Necessary** — the task genuinely requires reaching here.
- **Narrowable** — the same result was achievable with a more local change. Watch for: a shared util widened to satisfy one caller; a type loosened globally to fix one call site; an abstraction hoisted into `packages/*` for a single consumer; a new config knob where a constant would do; a helper added to a shared module instead of next to its only user.
- **Unrelated** — drive-by refactor, opportunistic rename, formatting churn, unrelated fix bundled in. Recommend splitting into its own PR; it inflates review surface and blast radius for free.

Call out specifically any code that moved **up** the dependency graph (local → shared, app → `packages/*`) and ask whether the number of real consumers justifies it. Also flag reach that is *load-bearing but avoidable with a different design* — e.g. "this needs a migration only because the value is persisted; deriving it at read time would keep this out of `packages/prisma` entirely." That's the highest-value finding this skill can produce.

---

## Step 6 — Flag the cross-cutting amplifiers

Surface these even if Steps 2–3 didn't reach them, since each multiplies everything above:

- **DB migrations** — destructive or locking operations; non-backward-compatible schema during rolling deploy.
- **Auth / authorization / security boundaries** — data-leak class.
- **Shared packages / widely-imported code** — one bug, many callers.
- **Feature flags / env defaults** — is the new path default-on (ships hot) or behind a flag (safe ramp)?
- **Release/install path** (kindo-cli, helm, post-install, secrets) — a bug here bricks a customer's *install*, not just a feature.
- **Background/async** (Hatchet workflows, crons, webhooks) — failures are often silent; nobody is staring at a 500.

---

## Step 7 — Report

Use this structure:

```markdown
# Blast Radius: <change description>

## Verdict
One line: safe to ship as-is / ship behind a flag / hold. Name the single biggest risk.

## What this change touches
Components touched, grouped by layer. Note new architectural edges.

## Blast radius
| Affected area | What breaks | Breadth | Severity | Reversible? | Detected by? |

## Top risks
The few high-breadth × high-severity × irreversible × undetected items, with reasoning.

## Scope assessment
| Component touched | Necessary / Narrowable / Unrelated | Why |
Plus: reach that a different design would have avoided.

## Deploy & rollback notes
Required ordering, N-1 compatibility, whether rollback works in both directions.

## Recommended guardrails before release
Concrete and specific.

## Confidence & gaps
What surface could not be mapped.
```

Guidance on the last two sections:

**Guardrails** should be concrete: "put X behind flag Y for a staged ramp", "add an integration assertion for Z (currently uncovered)", "make the migration additive and backfill separately", "run `kindo validate` against a fresh install", "split the rename in `packages/shared` into its own PR".

**Confidence & gaps** matters because this skill's failure mode is producing a clean-looking table that *implies* completeness. Always list what you couldn't map: dynamic/string-based references you may have missed, non-code consumers (dashboards, saved queries, runbooks, external integrations, customer scripts), areas where parallel exploration returned thin results or was unavailable, and any place your minimal-surface baseline was a guess.

---

Keep it actionable. The value is telling the user *where to look, what to gate, and what to pull back* — not a generic risk lecture. If the change is genuinely low-radius and tightly scoped (isolated leaf component, fully flagged, no new edges), say so plainly rather than inventing risk; a short honest "this is contained, here's why" is a successful run of this skill.
