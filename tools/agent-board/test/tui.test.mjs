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

const NOW = Date.parse("2026-10-09T12:00:00Z");
const can = (over = {}) => ({ send: true, interrupt: true, open: true, rename: true, archive: true, ...over });
// A card shaped like the board's: an idle Claude Code session in Done, unless a test says otherwise.
const card = (id, over = {}) => ({
  id, agent: "claude", name: `Session ${id}`, archived: false, column: "done", phase: "research", tags: [], group: "Group",
  summary: null, summaryMeta: {}, can: can(), context: [], cwd: "/Users/me/repo", sessionId: `${id}-0000`,
  startedAt: NOW - 3_600_000, updatedAt: NOW - 60_000, ...over,
});
const BOARD = {
  at: NOW,
  dirs: ["/Users/me/repo", "/Users/me/other"],
  prs: { open: 1, needsYou: 0 },
  cards: [
    card("aaaa0001", { name: "Builder", column: "working", phase: "build", detail: "Writing tests" }),
    card("aaaa0002", { name: "Asker", column: "needs-input", blocker: "Which repository?", waitingSince: NOW - 600_000 }),
    card("aaaa0003", { name: "Older asker", summary: { needsYou: ["Approve the plan"] }, waitingSince: NOW - 3_600_000 }),
    card("aaaa0004", { name: "Finished", status: "All done", branch: "feature" }),
    card("aaaa0005", { name: "Put away", agent: "codex", archived: true, archivedAt: NOW - 7_200_000, can: can({ open: "Unarchive it first." }) }),
  ],
};
const PRS = {
  at: NOW, viewer: "me", total: 1, reading: false, error: null,
  prs: [{
    id: "acme/app#7", repo: "acme/app", number: 7, title: "Add a thing", url: "https://github.com/acme/app/pull/7", status: "waiting", why: [],
    head: "feature", base: "main", stacked: false, requested: ["core"], reviews: [], checks: "pass", failing: [], additions: 3, deletions: 1,
    botThreads: 0, createdAt: NOW - 86_400_000, updatedAt: NOW, waitingSince: NOW - 3_600_000,
  }],
};
const DIGEST = { days: { "2026-10-08": { slack: { headline: "A quiet day.", sections: [{ title: "Worth a look", items: [{ text: "A release went out.", where: "#eng" }] }], gaps: [], at: NOW } } }, running: {}, repo: "acme/app", autoHour: 7 };
const JOURNAL = { items: [{ id: "1", text: "Ship it", horizon: "today", done: false }], notes: [], summary: { headline: "All quiet.", text: "**Now**\n\nNothing waits.\n\n- one", at: NOW }, running: null };

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

test("the screen reads what it shows, each at its own interval", () => {
  const first = run(initial({ now: NOW }), { type: "tick", now: NOW });
  assert.deepEqual(first.effects, [{ get: "board" }]);
  assert.deepEqual(run(first.s, { type: "tick", now: NOW + 1000 }).effects, []);
  assert.deepEqual(run(first.s, { type: "tick", now: NOW + 5000 }).effects, [{ get: "board" }]);
  assert.deepEqual(run(first.s, "2").effects, [{ get: "prs" }]);
});

test("the board has the page's columns, with the oldest ask first and selected", () => {
  const lines = screen(start());
  assert.match(lines[0], /1 Board 4 2!.*3 Archived 1/);
  assert.match(lines[1], /Researching 0 +Building 1 +Needs input 2 +Done 1/);
  assert.ok(row(start(), "Older asker").includes("▌"));
  assert.ok(lines.findIndex((l) => l.includes("Older asker")) < lines.findIndex((l) => l.includes("Asker")));
});

test("every view fills the terminal exactly, wide or narrow", () => {
  for (const size of [{ cols: 120, rows: 30 }, { cols: 60, rows: 12 }]) {
    const s = run(start(size), loaded("prs", PRS), loaded("digest", DIGEST), loaded("journal", JOURNAL)).s;
    for (const keys of [[], ["2"], ["3"], ["4"], ["5"], ["?"], ["enter"], ["enter", "right"], ["enter", "right", "right"], ["m"]]) {
      const lines = screen(run(s, ...keys).s);
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

test("a attaches where the page allows opening, and says why not elsewhere", () => {
  assert.deepEqual(run(start(), "a").effects, [{ attach: "aaaa0003" }]);
  const { s, effects } = run(start(), "3", "a");
  assert.deepEqual(effects, []);
  assert.equal(s.toast.text, "Unarchive it first.");
});

test("m sends what was typed, and its answer replaces the pending note and has everything read again", () => {
  const typed = run(start(), "m", "h", "i", "enter");
  assert.deepEqual(typed.effects, [{ post: "/api/card/aaaa0003/send", body: { text: "hi" }, done: "Sent." }]);
  assert.equal(typed.s.toast.text, "Sending…");
  const answered = run(typed.s, { type: "posted", fx: typed.effects[0], ok: true, res: { ok: true } });
  assert.equal(answered.s.toast.text, "Sent.");
  assert.deepEqual(answered.effects, [{ get: "board" }]);
  assert.equal(run(start(), "m", "h", "escape").s.prompt, null);
});

test("archiving asks first, and only y goes ahead", () => {
  assert.deepEqual(run(start(), "A", "n").effects, []);
  assert.deepEqual(run(start(), "A", "y").effects, [{ post: "/api/card/aaaa0003/archive", pending: "Archiving…", done: "Archived." }]);
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

test("n asks what the session should do, then where, offering the folders sessions run in", () => {
  const asked = run(start(), "n", "f", "i", "x", "enter");
  assert.equal(asked.s.prompt.value, "/Users/me/here");
  const started = run(asked.s, "tab", "enter");
  const [fx] = started.effects;
  assert.equal(fx.post, "/api/sessions");
  assert.deepEqual(fx.body, { cli: "claude", prompt: "fix", cwd: "/Users/me/repo" });
  const opened = run(started.s, { type: "posted", fx, ok: true, res: { ok: true, id: "bbbb0001", message: "Started." } });
  assert.equal(opened.s.detail.id, "bbbb0001");
  assert.equal(opened.s.toast.text, "Started.");
});

test("on PRs, Enter opens the pull request and s the session that worked on it", () => {
  const s = run(start(), "2", loaded("prs", PRS)).s;
  assert.ok(row(s, "app#7").includes("▌"));
  assert.deepEqual(run(s, "enter").effects, [{ browse: "https://github.com/acme/app/pull/7" }]);
  assert.equal(run(s, "s").s.detail.id, "aaaa0004");
});

test("on Daily, u asks which of the shown day's digests to update", () => {
  const s = run(start(), "4", loaded("digest", DIGEST)).s;
  assert.ok(row(s, "A release went out."));
  const [fx] = run(s, "u", "s").effects;
  assert.equal(fx.post, "/api/digest/slack");
  assert.deepEqual(fx.body, { day: "2026-10-08" });
  assert.deepEqual(run(s, "u", "x").effects, []);
});

const TUI = fileURLToPath(new URL("../src/tui.mjs", import.meta.url));
test("in a terminal it draws the board, gives the terminal to an attached session, takes it back, then quits", { skip: process.platform !== "darwin" && "uses macOS script(1)", timeout: 30_000 }, async (t) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const attach = { cwd: null, argv: ["sh", "-c", "echo attached-$((6 * 7))"] };
    res.end(JSON.stringify(req.url === "/api/board" ? BOARD : req.url.endsWith("/attach") ? attach : { ok: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const dir = await mkdtemp(join(tmpdir(), "ab-tui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = join(dir, "runner.mjs");
  await writeFile(runner, `import { runTui } from ${JSON.stringify(TUI)};\nawait runTui({ url: process.argv[2] });\nprocess.exit(0);\n`);
  // script(1) supplies the terminal, and needs a real pipe for its input, hence the cat.
  const env = { ...process.env, NODE: process.execPath, RUNNER: runner, URL: `http://127.0.0.1:${server.address().port}` };
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
  child.stdin.write("a");
  const attached = await seen("attached-42");
  await seen("Older asker", attached);
  child.stdin.write("q");
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});
