import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { width } from "../src/term.mjs";
import { initial, reduce, view } from "../src/tui.mjs";
import { accept } from "../src/ws.mjs";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const can = (over = {}) => ({ send: true, interrupt: true, open: true, rename: true, archive: true, settings: true, stop: true, respawn: true, remove: true, ...over });
const CODEX_ELSEWHERE = "Codex manages this itself.";
// A card shaped like the board's: an idle Claude Code session in Done, unless a test says otherwise.
const card = (id, over = {}) => ({
  id, agent: "claude", name: `Session ${id}`, archived: false, column: "done", phase: "research", tags: [], group: "Group",
  summary: null, summaryMeta: {}, can: can(), context: [], cwd: "/Users/me/repo", sessionId: `${id}-0000`,
  startedAt: NOW - 3_600_000, updatedAt: NOW - 60_000, ...over,
});
const BOARD = {
  at: NOW,
  dirs: ["/Users/me/repo", "/Users/me/other"],
  defaults: { model: "opus", effort: "high" },
  engines: { cards: "claude", brief: "codex", daily: "codex" },
  outcomes: { none: "No status", done: "Done", merged: "PR merged" },
  groupSummaries: { budgets: "Budget alerts, in review." },
  pins: [{ id: "pin1", at: new Date(NOW - 60_000).toISOString(), session: "aaaa0004-0000", group: null, source: { kind: "link", id: "https://example.com/spec", url: "https://example.com/spec", title: "The spec" } }],
  prs: { open: 1, needsYou: 0 },
  cards: [
    card("aaaa0001", { name: "Builder", column: "working", phase: "build", detail: "Writing tests", tags: ["budgets"], live: true, background: true, can: can({ terminal: true }), settings: { model: "", effort: "max", permissionMode: "", agent: "" } }),
    card("aaaa0002", { name: "Asker", column: "needs-input", blocker: "Which repository?", waitingSince: NOW - 600_000 }),
    card("aaaa0003", { name: "Older asker", summary: { needsYou: ["Approve the plan"] }, waitingSince: NOW - 3_600_000 }),
    card("aaaa0004", { name: "Finished", status: "All done", branch: "feature", context: [{ kind: "pr", id: "acme/app#7", url: "https://github.com/acme/app/pull/7", produced: 1 }] }),
    card("aaaa0006", { name: "Codex helper", agent: "codex", status: "Ready", can: can({ terminal: true, settings: CODEX_ELSEWHERE, stop: CODEX_ELSEWHERE, respawn: CODEX_ELSEWHERE }) }),
    card("aaaa0005", { name: "Put away", agent: "codex", archived: true, away: true, archivedAt: NOW - 7_200_000, can: can({ open: "Unarchive it first.", terminal: "Unarchive it first." }) }),
    card("aaaa0007", { name: "Shelved", archived: true, away: false, saved: true, archivedAt: NOW - 3_600_000, outcome: { key: "merged", label: "PR merged", auto: true } }),
  ],
};
const DETAIL = {
  ...BOARD.cards.find((c) => c.id === "aaaa0004"),
  result: "**Shipped** the change.", plan: "# Plan\n\n- Write it", docs: [{ path: "/Users/me/repo/SPEC.md", content: "## Spec\n\nThe spec text." }], links: [],
  intent: "Fix the thing.", tasks: [{ subject: "Write the tests", status: "completed" }, { subject: "Ship it", status: "in_progress", owner: "me" }],
  timeline: [{ at: NOW - 60_000, state: "done", text: "Finished the work." }], fan: [{ label: "Explore the code", doneAt: NOW }],
  team: [{ name: "reviewer", agentType: "code-reviewer", model: "opus", prompt: "Review the diff." }],
};
const PRS = {
  at: NOW, viewer: "me", total: 1, reading: false, error: null,
  prs: [{
    id: "acme/app#7", repo: "acme/app", number: 7, title: "Add a thing", url: "https://github.com/acme/app/pull/7", status: "waiting", why: [],
    head: "feature", base: "main", stacked: false, requested: ["core"], reviews: [], checks: "pass", failing: [], additions: 3, deletions: 1,
    botThreads: 0, createdAt: NOW - 86_400_000, updatedAt: NOW, waitingSince: NOW - 3_600_000,
  }],
};
const DIGEST = {
  days: { "2026-10-08": { slack: { headline: "A quiet day.", sections: [{ title: "Worth a look", items: [{ text: "A release went out.", where: "#eng" }] }], gaps: [], at: NOW }, repo: { headline: "One merge.", sections: [], gaps: [], at: NOW, prs: [{ number: 9, title: "Fix the build", author: "ann", additions: 2, deletions: 1 }] } } },
  running: {}, repo: "acme/app", autoHour: 7,
};
const JOURNAL = {
  items: [
    { id: "11111111-1111-1111-1111-111111111111", text: "Ship it", horizon: "today", done: false, createdAt: NOW - 1000 },
    { id: "22222222-2222-2222-2222-222222222222", text: "Plan the week", horizon: "week", done: false, createdAt: NOW - 2000 },
  ],
  notes: [{ id: "33333333-3333-3333-3333-333333333333", text: "Remember the **demo**.", createdAt: NOW - 5000 }],
  summary: { headline: "All quiet.", text: "**Now**\n\nNothing waits.\n\n- one", at: NOW, suggestions: [{ text: "Review the PR", why: "It waits on you", horizon: "today", url: "https://github.com/acme/app/pull/7" }] },
  running: null,
};

const key = (k) => ({ type: "key", key: [...k].length === 1 ? { name: "char", ch: k } : { name: k } });
// Feeds keys and replies in order, collecting every effect asked for.
function run(s, ...actions) {
  const effects = [];
  for (const action of actions) {
    const next = reduce(s, typeof action === "string" ? key(action) : action);
    s = next.state;
    effects.push(...next.effects);
  }
  return { s, effects };
}
const loaded = (what, data, extra = {}) => ({ type: "loaded", what, data, ...extra });
const start = (size = { cols: 120, rows: 30 }) => run(initial({ now: NOW, size, cwd: "/Users/me/here" }), loaded("board", BOARD)).s;
const screen = (s) => view(s).map((line) => line.map(([t]) => t).join(""));
const row = (s, text) => screen(s).find((l) => l.includes(text)) ?? "";
const writes = (effects) => effects.filter((fx) => fx.write);
const answered = (s, fx, ok = true, res = { ok }) => run(s, { type: "posted", fx, ok, res }).s;
// The board with a card picked by its name.
const at = (name, s = start()) => ({ ...s, sel: { ...s.sel, board: BOARD.cards.find((c) => c.name === name).id } });
const opened = (name, data) => {
  const s = run(at(name), "enter").s;
  return data ? run(s, loaded("detail", data, { id: s.detail.id })).s : s;
};

test("the screen reads what it shows, each at its own interval", () => {
  const first = run(initial({ now: NOW }), { type: "tick", now: NOW });
  assert.deepEqual(first.effects, [{ get: "board" }]);
  assert.deepEqual(run(first.s, { type: "tick", now: NOW + 1000 }).effects, []);
  assert.deepEqual(run(first.s, { type: "tick", now: NOW + 5000 }).effects, [{ get: "board" }]);
  assert.deepEqual(run(first.s, "2").effects, [{ get: "prs" }]);
});

test("the board has the page's columns and lanes, with the oldest ask first and selected", () => {
  const s = start();
  const lines = screen(s);
  assert.match(lines[0], /1 Board 5 2!.*3 Archived 2/);
  assert.match(row(s, "Researching"), /Researching 0 +Building 1 +Needs input 2 +Done 2/);
  assert.match(row(s, " All 5"), /All 5 +2! +budgets 1 +Group 4 2!/);
  assert.ok(row(s, "Older asker").includes("▌"));
  assert.ok(lines.findIndex((l) => l.includes("Older asker")) < lines.findIndex((l) => l.includes("Asker ")));
});

test("every view, tab and form fills the terminal exactly, wide or narrow", () => {
  for (const size of [{ cols: 120, rows: 30 }, { cols: 60, rows: 12 }]) {
    const s = run(start(size), loaded("prs", PRS), loaded("digest", DIGEST), loaded("journal", JOURNAL)).s;
    const detail = run(at("Finished", s), "enter", loaded("detail", DETAIL, { id: "aaaa0004" })).s;
    const views = [[], ["2"], ["3"], ["4"], ["5"], ["5", "right"], ["5", "left"], ["?"], ["]"], ["c"], ["n"], ["N"], ["m"], ["3", "O"]];
    const tabs = [[], ["right"], ["right", "right"], ["left", "left", "left"], ["left", "left"], ["left"], ["e"]];
    for (const [base, keys] of [...views.map((k) => [s, k]), ...tabs.map((k) => [detail, k])]) {
      const lines = screen(run(base, ...keys).s);
      assert.equal(lines.length, size.rows, `${keys} at ${size.cols}`);
      for (const l of lines) assert.equal(width(l), size.cols, `${keys} at ${size.cols}: ${l}`);
    }
  }
});

test("arrows move the selection, and Enter opens the session and reads it", () => {
  const { s, effects } = run(start(), "down", "left", "enter");
  assert.equal(s.detail.id, "aaaa0001");
  assert.deepEqual(effects, [{ get: "detail", id: "aaaa0001" }]);
  const conversation = run(s, "right");
  assert.equal(conversation.s.detail.tab, "conversation");
  assert.deepEqual(conversation.effects, [{ get: "conversation", id: "aaaa0001", from: null }]);
  const prs = run(s, "2").s;
  assert.equal(prs.detail, null);
  assert.equal(prs.view, "prs");
});

test("a narrow terminal lists the columns, and down runs on into the next one", () => {
  const s = start({ cols: 80, rows: 40 });
  const lines = screen(s);
  assert.ok(lines.findIndex((l) => l.startsWith("Needs input 2")) > lines.findIndex((l) => l.startsWith("Building 1")));
  assert.equal(run(s, "down", "down").s.sel.board, "aaaa0004");
});

test("conversation replies append in order, and one read from an older position is dropped", () => {
  let { s } = run(start(), "down", "left", "enter", "right");
  const step = (text) => ({ kind: "text", at: "", text });
  const reply = (from, next, steps, reset = false) => loaded("conversation", { next, reset, steps }, { id: "aaaa0001", from });
  s = run(s, reply(null, 10, [step("one")], true), reply(10, 20, [step("two")]), reply(10, 30, [step("stale")])).s;
  assert.deepEqual(s.detail.steps.map((x) => x.text), ["one", "two"]);
  assert.ok(row(s, "two"));
});

test("v and V hand the terminal to Claude's and Codex's agent views, from anywhere", () => {
  assert.deepEqual(run(start(), "v").effects, [{ relay: "/api/agent-view/term", label: "Claude's agent view" }]);
  assert.deepEqual(run(opened("Finished"), "V").effects, [{ relay: "/api/agent-view/term?agent=codex", label: "Codex's agent view" }]);
  const back = run(start(), { type: "returned", note: "Codex's agent view closed." });
  assert.equal(back.s.toast.text, "Codex's agent view closed.");
  assert.deepEqual(back.effects, [{ get: "board" }]);
});

test("a joins a running session in the board's terminal, resumes one without a process, and says why not elsewhere", () => {
  assert.deepEqual(run(at("Builder"), "a").effects, [{ relay: "/api/card/aaaa0001/term", label: "Builder's terminal" }]);
  assert.deepEqual(run(at("Codex helper"), "a").effects, [{ relay: "/api/card/aaaa0006/term", label: "Codex helper's terminal" }]);
  assert.deepEqual(run(start(), "a").effects, [{ resume: "aaaa0003" }]);
  const { s, effects } = run(start(), "3", "down", "a");
  assert.deepEqual(effects, []);
  assert.equal(s.toast.text, "Unarchive it first.");
});

test("c shows Claude's sessions only, then Codex's, then all again", () => {
  const claude = run(start(), "c").s;
  assert.match(screen(claude)[0], /1 Board 4 2!.*3 Archived 1.*● Claude only/);
  assert.equal(row(claude, "Codex helper"), "");
  const codex = run(claude, "c").s;
  assert.match(screen(codex)[0], /1 Board 1 .*3 Archived 1.*◆ Codex only/);
  assert.ok(row(codex, "Codex helper"));
  assert.equal(row(codex, "Builder"), "");
  assert.ok(row(run(codex, "3").s, "Put away"));
  assert.equal(run(codex, "c").s.agent, null);
});

test("[ and ] go through the lanes, showing a lane's sessions and summary, and a new session there is tagged with it", () => {
  const lane = run(start(), "]").s;
  assert.equal(lane.lane, "budgets");
  assert.ok(row(lane, "Budget alerts, in review."));
  assert.ok(row(lane, "Builder"));
  assert.equal(row(lane, "Asker"), "");
  assert.equal(run(lane, "n").s.form.fields.find((f) => f.key === "tags").value, "budgets");
  assert.equal(run(lane, "]", "]").s.lane, null);
  assert.equal(run(start(), "[").s.lane, "group");
});

test("m sends what was typed, and its answer replaces the pending note and has everything read again", () => {
  const typed = run(start(), "m", "h", "i", "enter");
  assert.deepEqual(typed.effects, [{ write: "/api/card/aaaa0003/send", body: { text: "hi" }, pending: "Sending…", done: "Sent." }]);
  assert.equal(typed.s.toast.text, "Sending…");
  const done = run(typed.s, { type: "posted", fx: typed.effects[0], ok: true, res: { ok: true } });
  assert.equal(done.s.toast.text, "Sent.");
  assert.deepEqual(done.effects, [{ get: "board" }]);
  assert.equal(run(start(), "m", "h", "escape").s.prompt, null);
});

test("archiving asks first, and only y goes ahead; archived, A takes it out of the agent view", () => {
  assert.deepEqual(run(start(), "A", "n").effects, []);
  assert.deepEqual(run(start(), "A", "y").effects, [{ write: "/api/card/aaaa0003/archive", pending: "Archiving…", done: "Archived." }]);
  const shelved = run(start(), "3", "A");
  assert.match(shelved.s.ask.text, /Take Shelved out of the agent view/);
  assert.equal(writes(run(shelved.s, "y").effects)[0].write, "/api/card/aaaa0007/archive");
  assert.equal(run(start(), "3", "down", "A").s.toast.text, "Already archived, and out of the agent view.");
});

test("S stops, asking first mid-turn; X restarts; neither is for Codex", () => {
  assert.deepEqual(writes(run(start(), "S").effects), [{ write: "/api/card/aaaa0003/stop", pending: "Stopping…" }]);
  const builder = run(at("Builder"), "S");
  assert.equal(builder.s.ask.text, "Builder is mid-turn. Stop it anyway? y/n");
  assert.equal(writes(run(builder.s, "y").effects)[0].write, "/api/card/aaaa0001/stop");
  assert.deepEqual(writes(run(start(), "X").effects), [{ write: "/api/card/aaaa0003/respawn", pending: "Restarting…" }]);
  assert.match(run(at("Codex helper"), "S").s.toast.text, /no process of its own/);
});

test("D deletes after asking, closing the open session once it is gone", () => {
  const asked = run(opened("Finished"), "D");
  assert.equal(asked.s.ask.text, "Delete Finished? This removes the session, and its worktree when that is safe. y/n");
  const [fx] = writes(run(asked.s, "y").effects);
  assert.deepEqual(fx, { write: "/api/card/aaaa0004/remove", pending: "Deleting…", close: true });
  assert.equal(answered(asked.s, fx).detail, null);
  assert.match(run(at("Codex helper"), "D").s.ask.text, /from Codex\? It cannot be brought back/);
  assert.match(run(start(), "3", "down", "D").s.ask.text, /^Delete Put away/);
});

test("t sets the tags, and e changes the settings in a form, where the page allows it", () => {
  const tagged = run(start(), "t", "a", ",", " ", "b", "enter");
  assert.deepEqual(writes(tagged.effects), [{ write: "/api/card/aaaa0003/tags", method: "PUT", body: { tags: ["a", "b"] }, pending: "Saving the tags…", done: "Tags saved." }]);
  const form = run(at("Builder"), "e").s;
  assert.ok(row(form, "Settings of Builder"));
  assert.ok(row(form, "Effort").includes("max"));
  const sent = run(form, "s", "o", "n", "n", "e", "t", "down", "left", "enter");
  const [fx] = writes(sent.effects);
  assert.equal(fx.write, "/api/card/aaaa0001/settings");
  assert.deepEqual(fx.body, { model: "sonnet", effort: "xhigh", permissionMode: "", agent: "" });
  assert.match(run(at("Codex helper"), "e").s.toast.text, /Codex manages this itself/);
});

test("p runs the PR sync in a session on a branch, after asking", () => {
  const asked = run(at("Finished"), "p");
  assert.match(asked.s.ask.text, /^Run \/pr-status-sync https:\/\/github.com\/acme\/app\/pull\/7 in Finished\?/);
  assert.deepEqual(writes(run(asked.s, "y").effects)[0].body, { text: "/pr-status-sync https://github.com/acme/app/pull/7" });
  assert.match(run(start(), "p").s.toast.text, /on a branch or with a pull request/);
});

test("O sets an archived session's status, Automatic following its pull requests", () => {
  const form = run(start(), "3", "O").s;
  assert.ok(row(form, "Automatic (PR merged)"));
  const [fx] = writes(run(form, "right", "right", "enter").effects);
  assert.deepEqual([fx.write, fx.method, fx.body], ["/api/card/aaaa0007/outcome", "PUT", { outcome: "done" }]);
  assert.equal(run(start(), "O").s.toast.text, "Only an archived session keeps a status.");
});

test("an open session has the page's tabs, Codex's only Summary and Conversation", () => {
  const s = opened("Finished", DETAIL);
  assert.match(row(s, "Summary"), /Summary +Conversation +Context +Spec +Progress +Team/);
  const spec = run(s, "left", "left", "left").s;
  assert.equal(spec.detail.tab, "spec");
  assert.ok(row(spec, "Approved plan"));
  assert.ok(row(spec, "~/repo/SPEC.md"));
  assert.ok(row(spec, "The spec text."));
  const progress = run(s, "left", "left").s;
  assert.ok(row(progress, "1 of 2 done"));
  assert.ok(row(progress, "Ship it · me"));
  assert.ok(row(progress, "Finished the work."));
  assert.ok(row(run(s, "left").s, "code-reviewer · opus"));
  const codex = opened("Codex helper");
  assert.ok(!row(codex, "Summary").includes("Context"));
  assert.equal(run(codex, "right", "right").s.detail.tab, "summary");
});

test("the Context tab lists pins first; + pins a link and x unpins one", () => {
  const s = run(opened("Finished", DETAIL), "right", "right").s;
  assert.ok(row(s, "Pinned Link").includes("The spec"));
  assert.ok(row(s, "PR acme/app#7"));
  const pinned = run(s, "+", ..."https://x.dev", "enter", ..."Doc", "enter");
  assert.deepEqual(writes(pinned.effects), [{ write: "/api/pins", body: { url: "https://x.dev", session: "aaaa0004-0000", title: "Doc" }, pending: "Pinning…", done: "Pinned." }]);
  assert.deepEqual(writes(run(s, "x").effects), [{ write: "/api/pins/pin1", method: "DELETE", pending: "Unpinning…", done: "Unpinned." }]);
  assert.match(run(s, "down", "x").s.toast.text, /Only a pinned link comes off/);
});

test("n opens the page's new-session form, and only what was sent closes it", () => {
  const s = run(start(), "n", "f", "i", "x", "tab").s;
  assert.equal(s.form.focus, "cwd");
  assert.ok(row(s, "/Users/me/here"));
  const filled = run(s, "right", "tab", ..."Fixer", "tab", ..."a, b", "tab", ..."EVE-1", "tab", ..."https://x.dev ~/notes.md", "tab", " ").s;
  const sent = run(filled, "enter");
  const [fx] = writes(sent.effects);
  assert.equal(fx.write, "/api/sessions");
  assert.deepEqual(fx.body, {
    cli: "claude", prompt: "fix", cwd: "/Users/me/repo", name: "Fixer", tags: ["a", "b"], issue: "EVE-1", context: ["https://x.dev", "~/notes.md"],
    worktree: true, addDirs: [], model: "", effort: "", permissionMode: "", agent: "",
  });
  assert.ok(answered(sent.s, fx, false, { ok: false, message: "No such directory" }).form);
  const started = run(sent.s, { type: "posted", fx, ok: true, res: { ok: true, id: "bbbb0001", message: "Started." } }).s;
  assert.equal(started.form, null);
  assert.equal(started.detail.id, "bbbb0001");
  assert.equal(started.toast.text, "Started.");
});

test("a Codex session's form leaves out Claude's options, and an empty one says what is missing", () => {
  const codex = run(start(), "N").s;
  assert.equal(row(codex, "Worktree"), "");
  assert.equal(row(codex, "Effort"), "");
  const [fx] = writes(run(codex, ..."go", "enter").effects);
  assert.deepEqual(Object.keys(fx.body), ["cli", "prompt", "cwd", "name", "tags", "issue", "context"]);
  const empty = run(start(), "n", "enter");
  assert.deepEqual(writes(empty.effects), []);
  assert.equal(empty.s.toast.text, "Say what it should do, or give a Linear issue.");
});

test("/ filters the board as it is typed, Enter keeps the filter and Esc clears it", () => {
  const typed = run(start(), "/", "B", "u", "i").s;
  assert.equal(typed.filter, "Bui");
  assert.ok(row(typed, "Builder"));
  assert.equal(row(typed, "Asker"), "");
  const kept = run(typed, "enter").s;
  assert.equal(kept.filter, "Bui");
  assert.equal(run(kept, "escape").s.filter, "");
});

test("on PRs, Enter opens the pull request, s the session that worked on it and a attaches to it", () => {
  const s = run(start(), "2", loaded("prs", PRS)).s;
  assert.ok(row(s, "app#7").includes("▌"));
  assert.deepEqual(run(s, "enter").effects, [{ browse: "https://github.com/acme/app/pull/7" }]);
  assert.equal(run(s, "s").s.detail.id, "aaaa0004");
  assert.deepEqual(run(s, "a").effects, [{ resume: "aaaa0004" }]);
});

test("on Daily, u asks which of the shown day's digests to update, and E switches the repository digest's engine", () => {
  const s = run(start(), "4", loaded("digest", DIGEST)).s;
  assert.ok(row(s, "A release went out."));
  assert.ok(row(s, "#9 Fix the build · ann"));
  const [fx] = writes(run(s, "u", "s").effects);
  assert.equal(fx.write, "/api/digest/slack");
  assert.deepEqual(fx.body, { day: "2026-10-08" });
  assert.deepEqual(run(s, "u", "x").effects, []);
  assert.deepEqual(writes(run(s, "E").effects)[0].body, { engines: { daily: "claude" } });
});

test("on the Journal, to-dos are added, edited, checked off, moved and deleted, and a suggestion is taken", () => {
  const s = run(start(), "5", loaded("journal", JOURNAL)).s;
  assert.ok(row(s, "Ship it").includes("▌"));
  const item = "/api/journal/items/11111111-1111-1111-1111-111111111111";
  assert.deepEqual(writes(run(s, "a", ..."Call", "enter").effects)[0], { write: "/api/journal/items", body: { horizon: "today", text: "Call" }, pending: "Adding…", done: "Added." });
  assert.deepEqual(writes(run(s, "down", "a", "x", "enter").effects)[0].body, { horizon: "week", text: "x" });
  assert.deepEqual(writes(run(s, "enter", "!", "enter").effects)[0], { write: item, method: "PUT", body: { text: "Ship it!" }, pending: "Saving…", done: "Saved." });
  assert.deepEqual(writes(run(s, " ").effects)[0].body, { done: true });
  assert.deepEqual(writes(run(s, ">").effects)[0].body, { horizon: "week" });
  assert.deepEqual(writes(run(s, "<").effects), []);
  assert.deepEqual(writes(run(s, "d", "y").effects)[0], { write: item, method: "DELETE", pending: "Deleting…", done: "Deleted." });
  const suggestion = run(s, "down", "down", "enter");
  assert.deepEqual(writes(suggestion.effects)[0].body, { text: "Review the PR https://github.com/acme/app/pull/7", horizon: "today", suggestion: 0 });
});

test("the Journal's Brief scrolls and is written again on s, and its Notes are written and deleted", () => {
  const s = run(start(), "5", loaded("journal", JOURNAL)).s;
  const brief = run(s, "right").s;
  assert.ok(row(brief, "All quiet."));
  assert.deepEqual(writes(run(brief, "s").effects)[0].write, "/api/journal/summarize");
  assert.deepEqual(writes(run(brief, "E").effects)[0].body, { engines: { brief: "claude" } });
  const notes = run(s, "left").s;
  assert.ok(row(notes, "Remember the demo."));
  assert.deepEqual(writes(run(notes, "a", ..."Hi", "enter").effects)[0].body, { text: "Hi" });
  assert.equal(writes(run(notes, "d", "y").effects)[0].write, "/api/journal/notes/33333333-3333-3333-3333-333333333333");
});

test("? shows every key, scrolls, and any other key closes it", () => {
  const s = run(start({ cols: 80, rows: 12 }), "?").s;
  assert.ok(row(s, "Everywhere"));
  assert.equal(run(s, "down").s.help, 1);
  assert.equal(run(s, "x").s.help, null);
});

const TUI = fileURLToPath(new URL("../src/tui.mjs", import.meta.url));
test("in a terminal it draws the board, hands the terminal to an agent view and a session, takes it back, then quits", { skip: process.platform !== "darwin" && "uses macOS script(1)", timeout: 30_000 }, async (t) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const attach = { cwd: null, argv: ["sh", "-c", "echo attached-$((6 * 7))"] };
    res.end(JSON.stringify(req.url === "/api/board" ? BOARD : req.url.endsWith("/attach") ? attach : { ok: false }));
  });
  // A stand-in for the board's shared terminal: it replays a screen with a query in it, then echoes what is typed.
  const sockets = new Set();
  const asked = [];
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    asked.push(`${req.url} ${req.headers.origin}`);
    const ws = accept(req, socket, head);
    ws.send(JSON.stringify({ size: { cols: 120, rows: 30 } }));
    ws.send(JSON.stringify({ data: "agent-view-replay\x1b[6n", replay: true }));
    ws.onmessage = (text) => ws.send(JSON.stringify({ data: `echo-${JSON.parse(text).data ?? "size"}` }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const dir = await mkdtemp(join(tmpdir(), "ab-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = join(dir, "runner.mjs");
  await writeFile(runner, `import { runTui } from ${JSON.stringify(TUI)};\nawait runTui({ url: process.argv[2] });\nprocess.exit(0);\n`);
  // script(1) supplies the terminal, and needs a real pipe for its input, hence the cat.
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, NODE: process.execPath, RUNNER: runner, URL: url };
  const child = spawn("sh", ["-c", `cat | script -q /dev/null sh -c 'stty cols 120 rows 30; exec "$NODE" "$RUNNER" "$URL"'`], { env, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const seen = async (text, from = 0) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      if (out.indexOf(text, from) >= 0) return out.indexOf(text, from);
    }
    assert.fail(`never saw ${JSON.stringify(text)} after ${from} in ${JSON.stringify(out.slice(-1500))}`);
  };
  await seen("Older asker");
  child.stdin.write("v");
  const relayed = await seen("agent-view-replay");
  assert.equal(out.indexOf("\x1b[6n", relayed), -1);
  child.stdin.write("x");
  await seen("echo-x", relayed);
  child.stdin.write("\x1c");
  const back = await seen("Older asker", relayed);
  assert.ok(out.slice(relayed, back).includes("\x1b[<99u"));
  assert.deepEqual(asked, [`/api/agent-view/term?cols=120&rows=30 ${url}`]);
  child.stdin.write("a");
  const attached = await seen("attached-42", back);
  await seen("Older asker", attached);
  child.stdin.write("q");
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});
