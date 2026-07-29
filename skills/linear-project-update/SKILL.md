---
name: linear-project-update
description: >-
  Draft and post a Linear project status update from evidence gathered across
  Linear (issues, milestones, previous updates), GitHub (PRs, merges, reviews),
  and Slack (project/ticket discussion). Shows the full draft in the CLI,
  supports a revise loop, and NEVER posts without an explicit human approval
  gate. Use ONLY when the user explicitly asks for a project update / status
  update draft (e.g. "/linear-project-update", "draft my project update",
  "write the status update for <project>").
argument-hint: "[Linear project name]"
disable-model-invocation: true
compatibility: >-
  Requires Linear integration tools (hard requirement — abort if unavailable).
  GitHub via `gh` CLI. Slack MCP is optional context: if unauthenticated or
  absent, continue without it and say so in the evidence-gaps footer.
---

# Linear project status update — evidence-based draft + gated post

Invocation input means explicit command/skill arguments when the runtime
provides them; otherwise use the project named in the user's request.

Produce a weekly-cadence Linear **project status update** in the house format,
built only from verifiable evidence (Linear, GitHub, Slack), shown in full on
the CLI, revised until the user is satisfied, and posted **only** after an
explicit approval. The single mutating action in this skill is
`save_status_update` — everything else is read-only.

## Hard rules

- **Human permission is 100% required before posting.** Never call
  `save_status_update` unless the user selected "Post to Linear" in the
  approval gate *in this session, for this exact draft*. A revised draft
  needs a fresh approval. Declined, discarded, or unanswered → nothing is
  posted, no retry, end of skill.
- **Slack is read-only context.** This skill never posts, reacts, or DMs on
  Slack.
- **No invented progress.** Every claim in the draft needs a receipt: a Linear
  issue/state change, a PR/merge, or a Slack message. If something the user
  probably did has no receipt, put it under "Evidence gaps" in the CLI
  display (never in the posted body) and let the revise loop resolve it.
- **Precision about state.** "Merged" ≠ "in review" ≠ "done". Mirror Linear
  issue states and GitHub PR states exactly.

## Phase 1 — Resolve the project

1. Verify that the required Linear read and status-update tools are available.
2. If the invocation input names a project, resolve it with `get_project`.
3. Otherwise `list_projects` with `member: "me"` (active states). One match →
   use it. Multiple → ask the user to select one project, with its state and
   target date in the option description. Never guess between projects.
4. `get_project` with `includeMilestones: true` for the milestone ladder.

## Phase 2 — Baseline: the previous update

Fetch the last 1–2 updates for this project:
`get_status_updates` with `type: "project"`, `project: <id>`, ordered by
`createdAt`.

- **Window start** = previous update's `createdAt`. No previous update →
  window = last 7 days, and the draft notes it's the first update.
- Extract the previous update's **upcoming goals** verbatim — they become the
  "Previous goal check-in" section, graded against this week's evidence.
- Use the previous update's tone/section names as the style anchor for this
  project (some projects use "What changed" / "Goals for upcoming week"
  variants — match the project's own precedent; default template below).

## Phase 3 — Evidence sweep (since window start)

Run the three sources; each bullet in the draft must trace to one of them.

**Linear** — `list_issues` for the project filtered `updatedAt` ≥ window
start. Record per issue: identifier, title, state now, assignee, and whether
it moved (created / started / in review / done). Note milestone movement.

**GitHub** — via `gh` (Bash). Harvest ticket IDs from the Linear sweep, then:

```bash
gh pr list --state all --search "<TICKET-ID> in:title" --json number,title,state,mergedAt,url,reviewDecision
gh pr list --author @me --state all --json number,title,state,mergedAt,url --search "updated:>=<window-start-date>"
```

Check the sibling `../mcp` repo too if the project spans it. Record merged /
in-review / draft per PR.

**Slack** — optional. Check for Slack integration tools; if only
`authenticate` stubs come back, the server is unauthenticated — skip Slack,
note it in Evidence gaps, do **not** start an OAuth flow unless the user asks.
If available: search messages since window start for the project name and the
top ticket IDs; capture decisions, blockers, meetings, and asks (who/what),
not chatter.

## Phase 4 — Draft in the house format

Default template (match the project's own precedent when it differs):

```markdown
# Status Update

**Overall:** <1–3 sentences: headline outcome first, then the main risk or
caveat. This is what a skimming reader takes away.>

## What happened this cycle

* <outcome bullet with receipts: [ENG-XXXX](linear-url) for tickets,
  [#1234](github-url) for PRs, @firstname for people>

## Previous goal check-in

* <prior goal, restated> — ✅ Done / 🟡 In Progress / ❌ Missed
  <one-line why whenever not ✅>

# Upcoming Cycle Goals

* <2–4 concrete goals checkable at next week's update>
```

Drafting rules:

- **Overall** carries the health signal in prose: an `atRisk` update names the
  risk in the Overall line, not just the health enum.
- Bullets are outcomes with receipts, not activity logs ("Shipped X ([ENG-…])"
  not "worked on X").
- Grade every prior goal — missed goals get an honest ❌ with a one-line
  reason; that accountability loop is the point of the section.
- Upcoming goals: few, concrete, checkable. "Merge ENG-XXXX" beats "continue
  making progress".
- Don't hand-write milestone percentages — Linear generates the progress diff
  automatically.
- **Health**: propose `onTrack` / `atRisk` / `offTrack` with a one-line
  justification tied to evidence. atRisk when a stated goal is slipping or a
  dependency is outside the team's control; offTrack when the target date is
  no longer credible.

## Phase 5 — CLI display + revise loop + approval gate

1. Display, every round:
   - the exact body to be posted, in a fenced markdown block (verbatim —
     what's in the fence is what gets posted);
   - `Health: <value> — <one-line justification>`;
   - `Evidence gaps:` anything unverifiable, Slack unavailable, prior goals
     that couldn't be graded (CLI-only; never posted).
2. Ask the user two questions in one interaction:
   - "Health for this update?" — options `onTrack` / `atRisk` / `offTrack`,
     recommended one first with "(Recommended)".
   - "Post this update to Linear?" — options **Post to Linear** (posts
     exactly the displayed body), **Revise** (describe changes via notes /
     "Other"), **Discard** (nothing posted, skill ends).
3. **Revise** → apply the requested edits (or re-sweep if they dispute a
   fact), re-display the full draft, re-ask the gate. Loop as many rounds as
   needed — there is no auto-post on loop exit.
4. **Post to Linear** → `save_status_update` with `type: "project"`, the
   project, the displayed body verbatim, and the chosen health. Report the
   returned update URL.
5. Anything else (discard, unanswered, tool denial) → confirm nothing was
   posted and stop.

## Output contract (after posting or discarding)

≤6 lines: posted-or-discarded, the update URL (if posted), health, window
covered, evidence counts (n issues / n PRs / n Slack threads), and any gaps
the user accepted.
