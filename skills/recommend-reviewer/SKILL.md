---
name: recommend-reviewer
description: >-
  Recommend 2–3 PR reviewers by blending four evidence signals: line-level
  blame of the code the PR actually modifies, recent commit activity in the
  touched files/directories, who reviewed past PRs in those paths, and Linear
  context (the PR's ticket, its related/blocking issues, and who is actively
  working nearby). Read-only until the human approves assignment; after
  assignment, optionally pings the chosen reviewers in #eng-discussion with
  links to the selected PR(s). Invoke explicitly via `/recommend-reviewer`
  (not auto-invoked).
argument-hint: "[pr-number]"
user-invocable: true
disable-model-invocation: true
compatibility: Requires git and an authenticated GitHub CLI (gh). Linear signals need a resolvable ticket id plus a linear skill or Linear MCP tools in the session; skip that signal gracefully when absent. The Slack ping (Phase 7) needs Slack MCP tools in the session; without them, print the composed message for copy-paste instead.
---

# Recommend Reviewer — evidence-based reviewer picks for a PR

Invocation input means explicit command/skill arguments when the runtime
provides them; otherwise use the PR named in the user's request.

Picking a reviewer by gut ("who's around?") wastes the strongest predictor of review quality: **familiarity with the exact code being changed**. This skill gathers hard evidence — who wrote the modified lines, who works in these files, who reviews this area, who holds adjacent Linear context — scores candidates, and presents the top picks *with receipts* so the human can assign in one keystroke.

## Prime directive — recommend, never assign

Everything up to the final step is **read-only** (git plumbing, `gh` reads, Linear reads). Requesting a review notifies a human, so it is an outward-facing action: present the recommendation table, then ask. Only after explicit approval run `gh pr edit <n> --add-reviewer <login>`. Never post comments, never @-mention anyone in PR bodies, never assign on silence. The same gate applies to the Slack ping (Phase 7): a channel post notifies humans, so it is drafted, shown, and sent only on explicit approval.

## Phase 1 — Resolve the PR / change set

1. Invocation input given → `pr=<number>`; `gh pr view "$pr" --json number,title,author,baseRefName,headRefName,files,url`.
2. No argument → try the current branch: `gh pr view --json ...` (same fields). If an open PR exists, use it.
3. No PR at all → fall back to the working diff: `base=$(git merge-base origin/main HEAD)`; the change set is `git diff --name-only "$base"` plus untracked files. Note in the output that recommendations are pre-PR.
4. Record `author_login` (excluded from candidacy) and the changed file list. **Cap the analysis at the 20 highest-churn files** (`git diff --stat` ordering) — beyond that, signals saturate and API calls balloon; say so when you truncate.
5. Resolve the Linear ticket id from the PR title or branch name (match `[A-Za-z]+-[0-9]+`, e.g. `ENG-1234`). Absent → skip Phase 2.4, note "no ticket resolved" in the output.

## Phase 2 — Gather the four signals

Run all four; each produces `(candidate, raw-weight, receipt-line)` tuples. A candidate at this stage is a git author identity (name + email) or a GitHub login — Phase 3 unifies them.

### 2.1 Line-level authorship of the modified code — weight 40%

Who wrote the exact lines this PR touches (the strongest signal):

1. For each changed file, get the old-side hunk ranges: `git diff -U0 "$base" -- <file>` and parse each `@@ -<start>,<count> ... @@` header (skip files that are pure additions — no old side).
2. Blame those ranges **at the base commit** so you see pre-PR authorship: `git blame -w -M -C -L <start>,+<count> --line-porcelain "$base" -- <file>`, collecting `author` / `author-mail` / `author-time` per line.
3. Tally blamed lines per author. Receipt format: `wrote 58% of the modified lines in backend/api/chat/`.

### 2.2 Recent activity in the touched files and directories — weight 25%

1. Per changed file: `git log --since=6.months --no-merges --format='%ae|%an|%ct' -- <file>`. For **new** files (no history), run the same on the parent directory instead.
2. Also parse `Co-Authored-By:` trailers (`git log --since=6.months --no-merges --format='%(trailers:key=Co-Authored-By,valueonly)' -- <path>`) — squash merges hide collaborators.
3. Weight each commit by recency decay (see Phase 4). Receipt: `9 commits in apps/next/chat/ in the last 3 months`.

### 2.3 Past reviewers of these paths — weight 20%

Frequent *reviewers* of a subsystem are often better picks than its original author:

1. For each of the top ~5 files by churn: `gh api "repos/{owner}/{repo}/commits?path=<file>&per_page=10" --jq '.[].sha'`.
2. Map commits to PRs: `gh api "repos/{owner}/{repo}/commits/<sha>/pulls" --jq '.[].number'`, dedupe, keep the ~10 most recent PRs.
3. Collect reviewers: `gh api "repos/{owner}/{repo}/pulls/<n>/reviews" --jq '.[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED") | .user.login'`. Drop bots (`[bot]` suffix, `coderabbit`, `copilot`, `claude`).
4. Receipt: `reviewed 4 of the last 10 PRs touching these paths`.

### 2.4 Linear context — weight 15%

Use the session's linear skill / Linear MCP tools with the ticket from Phase 1.5:

1. Fetch the issue, its **parent**, **blocks / blocked-by / relates-to** relations, and its project.
2. Candidates: assignees of related issues, plus recent commenters on the ticket itself. Receipt: `assignee of ENG-1201, which blocks this ticket`.
3. **Conflict tripwire**: if a related issue is In Progress and its assignee's branch/PR touches the same files, that person is BOTH a top reviewer pick and a coordination risk — flag it explicitly: `⚠ @carol is mid-flight on ENG-1201 in the same files — review by her doubles as conflict detection`.

### Exclusions and availability (applied to all signals)

- Exclude the PR author and all bot identities.
- **Staleness demotion**: a candidate with no commit or review in this repo in the last 90 days gets their total score halved and the receipt `(inactive 4 months — may have moved teams)`; use `git log --author=<email> --since=90.days -1` and the review data from 2.3.
- **Load check** (top 3 finalists only): `gh search prs --review-requested=<login> --repo <owner>/<repo> --state open --json number --jq 'length'`. Annotate, don't disqualify: `already has 6 open review requests`.

## Phase 3 — Unify identities (git email → GitHub login)

Scores must merge across signals, so every candidate needs one canonical GitHub login:

1. For each distinct git author email: `gh api "repos/{owner}/{repo}/commits?author=<email>&per_page=1" --jq '.[0].author.login'` (GitHub links commits to accounts; returns `null` for unlinked emails).
2. `noreply@github.com`-style emails (`<id>+<login>@users.noreply.github.com`) → extract the login directly.
3. Still unmapped → keep the candidate under their git name, mark the login `unknown`, and present them anyway — the human can map it. Never guess a login from a name.

## Phase 4 — Score

For every candidate, per signal: `signal_score = Σ (item_weight × decay)` where `decay = 0.5 ^ (age_days / 90)` (half-life 90 days; blame lines use the blamed commit's `author-time`, commits use commit time, reviews use review time, Linear items use last-activity time). Normalize each signal so the top candidate in that signal gets 100, then combine:

```
total = 0.40·blame + 0.25·activity + 0.20·reviews + 0.15·linear
```

Apply the staleness halving last. The number ranks; the **receipts justify** — never present a score without its evidence lines.

## Phase 5 — CODEOWNERS annotation

1. Find the file: `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`.
2. Match the changed paths against its patterns (last matching rule wins) to get the required owner team(s)/user(s).
3. Try `gh api "orgs/{org}/teams/{team-slug}/members" --jq '.[].login'` to mark which finalists satisfy the requirement (✓). If the API call is forbidden (common), just print the required team and note membership is unverified — do not drop candidates over it.

## Phase 6 — Present, then gate

Output exactly this shape, then stop and ask:

```
Reviewer recommendation for PR #<n> — <title>
1. @<login>  score <t>
   - <receipt line per contributing signal, strongest first>
   - <load / staleness annotation if any>
2. @<login>  ...
3. @<login>  ...
CODEOWNERS: <required team(s)> — <which finalists satisfy it, or "membership unverified">
Linear: <ticket> — <one line of related-issue context and any ⚠ conflict tripwire>
Skipped: <signals that couldn't run and why — e.g. "Linear (no ticket in title)">
```

Then gate with one structured user interaction, offering checkable options for two questions:

1. "Which reviewers should I request?" — allow multiple selections, with one
   option per finalist (label `@login`, description = their strongest receipt).
   Selected → `gh pr edit <n> --add-reviewer <login>` for each.
2. "Ping the chosen reviewers in #eng-discussion?" — yes/no; yes → Phase 7.

Act only on the explicit selections. With no PR (working-diff mode), end at the table and note assignment needs a PR first.

## Phase 7 — Optional: Slack review request in #eng-discussion

Runs only when the user chose "yes" to the ping in the Phase 6 selector, and only for reviewers they actually chose. Needs Slack integration tools; if they're absent or unauthenticated, print the composed message for copy-paste and say why it wasn't sent.

1. **Collect the candidate PR list.** Start with the analyzed PR. If a ticket id resolved in Phase 1.5, also run `gh pr list --search "<TICKET> in:title" --state open --json number,title,url,headRefName` to pick up open sibling/stacked PRs. Exactly one PR → use it, no selector. Multiple → offer a multiple-selection interaction with one option per PR (label `#<number>`, description = short title; the analyzed PR listed first as the recommended default) and include only the chosen ones. If the available interaction UI caps its options, keep the analyzed PR plus the most recently updated alternatives and explain how to name another PR.
2. **Resolve Slack identities for the chosen reviewers.** Try lookup by the reviewer's git author email first; failing that, search Slack users by their GitHub profile name. Confident match → a real `<@USERID>` mention. No confident match → plain-text name, and note in the draft that it won't notify them. Never guess between similar-looking people — an @-mention pings a real human.
3. **Compose the message** — exactly this body shape:

   ```
   Hey @<name>[ and @<name2>], can you review this PR/these PRs — it adds <brief what it does, one clause>.[ You already approved <the specific underlying PR> that merged into this.]
   <PR url>
   ```

   Bare PR URL(s), one per line — no `[TICKET]`/title prefix and no Linear tags anywhere. Context is one short clause of *what* the change does, not why (it's a nudge, not a changelog). One line per selected PR (single PR → the one link still appears). "this PR" vs "these PRs" follows the selection count. If a chosen reviewer already reviewed or approved an underlying/sibling PR that fed into this one, add one clause saying so — verify it against that PR's reviews and name only the PR(s) they actually reviewed (don't say "the PRs" when it was one).
4. **Gate, then post.** Ask "Post this to #eng-discussion?" with options "Post it" / "Don't post", showing the complete message body in the approval interface before accepting consent. Re-draft and re-gate after any edit. Only "Post it" posts. Declined or unanswered → don't post, don't retry, don't fall back to DMs.

## Edge cases

- **Monorepo-wide PR** (files span >2 top-level areas): cluster files by area, run signals per cluster, and either recommend the one candidate who spans the most clusters or one candidate per area — say which structure you chose.
- **Pure-mechanical PR** (renames, formatting, lockfiles): blame is noise; drop signal 2.1 and re-normalize (activity 45 / reviews 35 / linear 20). Say so.
- **Brand-new subsystem** (mostly new files): 2.1 is empty; lean on parent-directory activity and Linear project members.
- **Fewer than 2 viable candidates** (tiny team, everyone excluded): report what you found honestly rather than padding the list.

## Guardrails

- Read-only until the human picks; the only mutating actions this skill may ever take are `gh pr edit <n> --add-reviewer <login>` and the Phase 7 post to `#eng-discussion`, each after its own explicit approval.
- Never invent or guess GitHub logins or Slack identities; unmapped identities stay labeled `login unknown` (table) or plain text (Slack draft).
- The Slack message goes to `#eng-discussion` only — never DMs, never other channels, never a second post if the first gets no reaction.
- Bot approvals don't satisfy human-review requirements — never recommend a bot.
- Every recommendation ships with receipts; a candidate you can't justify in one evidence line doesn't make the list.
