---
name: worktree-branch
description: Create a git worktree for a branch, placed in-repo under .claude/worktrees/. Accepts a Linear issue ID (e.g. ENG-1234) and derives branch + folder name from it, an explicit branch name, or nothing (then asks). Use when the user asks to worktree an issue or branch, set up a worktree, or "make a tree" for an issue.
---

# Worktree a branch (in-repo, Linear-aware)

Create a git worktree under `<repo-root>/.claude/worktrees/<folder>`. That path is
git-ignored in this monorepo and sits outside the yarn workspace globs
(`apps/*`, `backend/*`, `packages/*`), so a nested worktree won't be picked up as
a duplicate workspace member.

Invocation input means explicit command/skill arguments when the runtime
provides them; otherwise use the target named in the user's request. It may be
a Linear issue ID, an explicit branch name, or empty.

## Step 1 — Resolve the branch name + folder name

Decide the branch and folder from the invocation input:

1. **Linear issue ID** — if the invocation input contains a token matching `[A-Za-z]+-[0-9]+`
   (e.g. `ENG-10860`), treat it as a Linear issue:
   - Fetch the issue with the Linear MCP tool `get_issue` (or the `linear` skill).
   - `branch` = the issue's `gitBranchName` (Linear's suggested branch name).
   - `folder` = the issue identifier, lowercased (e.g. `eng-10860`) — short and
     reflects the ticket; the full slug lives on the branch name.
2. **Explicit branch name** — otherwise, if the invocation input names a branch:
   - `branch` = that name.
   - `folder` = the branch with any `<user>/` prefix stripped and `/` → `-`
     (e.g. `simon/eng-33-foo` → `eng-33-foo`).
3. **Nothing given** — if the invocation input is empty, STOP and ask the user for a Linear
   issue ID or a branch name / desired folder name. Do not guess. Do not proceed
   until they answer.

## Step 2 — Existing branch or new branch?

Run `git fetch origin` (best-effort), then check whether `branch` exists:
- Local:  `git branch --list <branch>`
- Remote: `git branch -r --list "origin/<branch>"`

- **Exists (local or remote)** → you'll check out the existing branch.
- **Does not exist** → you'll create it new off the default branch (`main`).
  This is expected for the Linear-issue flow (Linear hands you a branch name to
  create). State clearly in the final report that the branch was created new.

## Step 3 — Guard: not already checked out

Run `git worktree list`. If `<branch>` is already checked out in a worktree, STOP
and say so — a branch can only be checked out in one worktree at a time. Also stop
if `<repo-root>/.claude/worktrees/<folder>` already exists.

## Step 4 — Create the worktree

Compute the repo root once: `ROOT=$(git rev-parse --show-toplevel)`.
Target path: `$ROOT/.claude/worktrees/<folder>`.

- Existing local branch:  `git worktree add "$ROOT/.claude/worktrees/<folder>" <branch>`
- Existing remote-only:    `git worktree add "$ROOT/.claude/worktrees/<folder>" -b <branch> origin/<branch>`
- New branch off main:      `git worktree add "$ROOT/.claude/worktrees/<folder>" -b <branch> main`

## Step 5 — Report

Report the new worktree path, the branch, and whether it was existing or newly
created. Do not modify the current checkout. If this is a JS worktree, remind the
user it still needs its own `yarn install` + env/doppler setup.
