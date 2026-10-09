// The board in a terminal, on the same server as the page. `reduce` and `view` are pure: a key or a server reply goes
// in, and the next state, with the reads and writes it calls for, comes out. `runTui` performs those and draws.
import { execFile, spawn } from "node:child_process";
import { ansi, clean, createKeyReader, createScreen, cut, fit, graphemes, width, wrap } from "./term.mjs";

const VIEWS = [["board", "Board"], ["prs", "PRs"], ["archived", "Archived"], ["daily", "Daily"], ["journal", "Journal"]];
const COLS = [["researching", "Researching", "cyan"], ["building", "Building", "blue"], ["needs-input", "Needs input", "yellow"], ["done", "Done", "green"]];
const PR_SECTIONS = [["needs-you", "Needs you", "yellow"], ["waiting", "Waiting for review", "blue"], ["approved", "Approved", "green"], ["draft", "Draft", "gray"]];
const DIGESTS = [["repo", "Repository"], ["notion", "Notion"], ["slack", "Slack"]];
const HORIZONS = [["today", "Today"], ["week", "This week"], ["later", "Later"]];
const TABS = [["summary", "Summary"], ["conversation", "Conversation"], ["context", "Context"]];
const MARKS = { claude: ["●", "claude"], codex: ["◆", "codex"] };
const RESTING = { stopped: "red", interactive: "magenta" };
const ENDINGS = { error: "error", interrupted: "interrupted", "cut-off": "cut off" };
const KINDS = { pr: "PR", "linear-issue": "Linear", "linear-project": "Linear project", "linear-doc": "Linear doc", notion: "Notion", "slack-thread": "Slack", "slack-channel": "Slack", artifact: "Artifact" };
const REVIEWS = { APPROVED: ["✓", "green"], CHANGES_REQUESTED: ["✗", "red"], COMMENTED: ["~", "gray"], DISMISSED: ["–", "gray"] };
const CHECKS = { pass: ["✓ checks", "green"], fail: ["✗ checks", "red"], pending: ["● checks", "yellow"] };
const TASK_MARKS = { completed: "✓", in_progress: "▸", pending: "○" };
const FILTERED = new Set(["board", "prs", "archived"]);
// From this many columns the board's columns sit side by side; narrower, they are listed one under another.
const WIDE = 100;
const TOAST_MS = 6000;
// How often each read repeats while what it feeds is on screen, in ms.
const POLL = { board: 5000, prs: 5000, digest: 10_000, journal: 10_000, detail: 5000, conversation: 2000 };
const VIEW_READS = { prs: "prs", daily: "digest", journal: "journal" };
const WRITE_HEADERS = { "x-agent-board": "1", "content-type": "application/json" };

// The page's rules (index.html): what a session waits on the person for, and the column that shows it.
const needsOf = (c) => [c.blocker, ...(c.summary?.needsYou ?? []).filter((x) => x !== c.blocker)].filter(Boolean);
const colOf = (c) => (c.column === "working" ? (c.phase === "build" ? "building" : "researching") : c.column === "needs-input" || needsOf(c).length ? "needs-input" : "done");
const waitOf = (c) => c.waitingSince ?? c.updatedAt ?? c.startedAt ?? 0;
const concernsOf = (c) => [c.failed && `Failed: ${c.failed}`, ...(c.summary?.concerns ?? [])].filter(Boolean);
// And its PRs tab's: the sessions that made a pull request or were pointed at it, or work on its branch in a worktree.
const inWorktree = (c) => Boolean(c.cwd?.includes("/.claude/worktrees/"));
const workedOn = (c, pr) =>
  (c.branch === pr.head && (c.agent !== "codex" || inWorktree(c))) ||
  (c.context ?? []).some((x) => x.kind === "pr" && x.id === pr.id && (x.produced || x.linked || inWorktree(c)));

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const dur = (ms) => {
  const s = Math.max(0, ms / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const home = (p) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dateOf = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const daysAgo = (key, now) => Math.round((dateOf(dayKey(now)) - dateOf(key)) / 86_400_000);
const dayName = (key, now) => ["Today", "Yesterday"][daysAgo(key, now)] ?? dateOf(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const matches = (filter, ...texts) => !filter || texts.join(" ").toLowerCase().includes(filter.toLowerCase());
const spansWidth = (spans) => spans.reduce((n, [t]) => n + width(clean(t)), 0);
// Left spans, then right spans against the right edge; the left ones are cut when both do not fit.
function spread(left, right, cols) {
  const room = cols - spansWidth(left) - spansWidth(right);
  return room > 0 ? [...left, [" ".repeat(room), ""], ...right] : [...fit(left, Math.max(0, cols - spansWidth(right) - 1)), [" ", ""], ...right];
}
// Text wrapped to at most `max` lines, the last ending in an ellipsis when some was left out.
function clip(text, cols, max) {
  const lines = wrap(text, cols);
  return lines.length > max ? [...lines.slice(0, max - 1), cut(`${lines[max - 1]}…`, cols)] : lines;
}
// Lines behind a one-column bar, colored on the selected item.
const barred = (lines, color) => lines.map((l) => [[color ? "▌" : " ", color ?? ""], [" ", ""], ...l]);
const markOf = (c) => MARKS[c.agent] ?? MARKS.claude;
const heading = (label, color, n) => [[label, `bold ${color}`], [` ${n}`, "gray"]];
// A message on a line of its own, such as "Loading…".
const notice = (text, style = "gray") => [[[` ${text}`, style]]];

// ---- What the views list
const cardsOf = (s) => s.board?.cards ?? [];
const cardText = (c) => [c.name, c.group, c.status, c.goal, c.branch, c.cwd, ...(c.tags ?? [])];
function columnsOf(s) {
  const cards = cardsOf(s).filter((c) => !c.archived && matches(s.filter, ...cardText(c)));
  return COLS.map(([key, label, color]) => {
    const list = cards.filter((c) => colOf(c) === key);
    // The oldest ask first, as on the page.
    return { key, label, color, cards: key === "needs-input" ? list.toSorted((x, y) => waitOf(x) - waitOf(y)) : list };
  });
}
// The selected card: the one picked last while it is shown, else the longest-waiting ask, else the first.
function boardPick(s, cols = columnsOf(s)) {
  const all = cols.flatMap((col, ci) => col.cards.map((c, ri) => ({ c, ci, ri })));
  return all.find((x) => x.c.id === s.sel.board) ?? all.find((x) => cols[x.ci].key === "needs-input") ?? all[0] ?? null;
}
const archivedOf = (s) => cardsOf(s).filter((c) => c.archived && matches(s.filter, ...cardText(c))).toSorted((x, y) => (y.archivedAt ?? 0) - (x.archivedAt ?? 0));
function prSections(s) {
  const prs = (s.prs?.prs ?? []).filter((p) => matches(s.filter, p.repo, `#${p.number}`, p.title, p.head, ...p.requested, ...p.reviews.map((r) => r.who)));
  return PR_SECTIONS.map(([key, label, color]) => ({ label, color, items: prs.filter((p) => p.status === key) }));
}
// In a list the selection is an id; when that item is gone, the first one is selected.
const pickIn = (list, id) => list.find((x) => x.id === id) ?? list[0] ?? null;
// The open session: its full detail once read, else its card.
const detailCard = (s) => s.detail.data ?? cardsOf(s).find((c) => c.id === s.detail.id) ?? null;
const daysBack = (now, n) => {
  const d = new Date(now);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));
};
// The last week and every day with a digest, newest first; until one is picked, the newest with a digest is shown.
const digestDays = (s) => [...new Set([...Array.from({ length: 7 }, (_, n) => daysBack(s.now, n)), ...Object.keys(s.digest?.days ?? {})])].toSorted().toReversed();
const shownDay = (s) => s.day ?? Object.keys(s.digest?.days ?? {}).toSorted().at(-1) ?? dayKey(s.now);

// ---- State
export const initial = ({ now = Date.now(), cwd = "", size = { cols: 80, rows: 24 } } = {}) => ({
  now, cwd, size, view: "board", board: null, prs: null, digest: null, journal: null, offline: null,
  polled: {}, sel: {}, scroll: {}, day: null, filter: "", detail: null, prompt: null, ask: null, toast: null, help: false,
});

const keyOf = (fx) => (fx.id ? `${fx.get}:${fx.id}` : fx.get);
// What the screen is drawn from: the board always, and the open view's or session's own reads.
function reads(s) {
  if (!s.detail) return [{ get: "board" }, ...(VIEW_READS[s.view] ? [{ get: VIEW_READS[s.view] }] : [])];
  const { id, tab, next } = s.detail;
  return [{ get: "board" }, { get: "detail", id }, ...(tab === "conversation" ? [{ get: "conversation", id, from: next }] : [])];
}

// The next state and effects: { get } reads, { post } writes, { attach }, { browse }, { suspend } and { quit }. Every
// read the screen needs and has not had for its interval is asked for.
export function reduce(s, action) {
  const [next, effects = []] = step(s, action);
  const due = reads(next).filter((fx) => next.now - (next.polled[keyOf(fx)] ?? -Infinity) >= POLL[fx.get]);
  if (!due.length) return { state: next, effects };
  return { state: { ...next, polled: { ...next.polled, ...Object.fromEntries(due.map((fx) => [keyOf(fx), next.now])) } }, effects: [...effects, ...due] };
}

function step(s, a) {
  if (a.type === "tick") return [{ ...s, now: a.now }];
  if (a.type === "resize") return [{ ...s, size: a.size }];
  if (a.type === "loaded") return [loaded(s, a)];
  if (a.type === "failed") return [failed(s, a)];
  if (a.type === "posted") return posted(s, a);
  // Back from a session or a suspend, everything is read again.
  if (a.type === "returned") return [{ ...s, polled: {} }];
  if (a.type === "key") return onKey(s, a.key);
  return [s];
}

function loaded(s, { what, id, from, data }) {
  if (what === "board") return { ...s, board: data, offline: null };
  if (what !== "detail" && what !== "conversation") return { ...s, [what]: data };
  if (s.detail?.id !== id) return s;
  if (what === "detail") return { ...s, detail: { ...s.detail, data } };
  // A reply read from an older position would repeat or skip steps.
  if ((from ?? null) !== s.detail.next) return s;
  return { ...s, detail: { ...s.detail, steps: data.reset ? data.steps : [...s.detail.steps, ...data.steps], next: data.next } };
}

function failed(s, { what, id, status, error }) {
  if (what === "board") return { ...s, offline: error };
  if (what === "detail" && status === 404 && s.detail?.id === id) return toast({ ...s, detail: null }, "That session is gone.", "red");
  return s;
}

const toast = (s, text, style = "", sticky = false) => ({ ...s, toast: { text, style, sticky, at: s.now } });
// A write, with a note on the bottom line until its answer replaces it.
const write = (s, fx, pending = "Working…") => [toast(s, pending, "", true), [fx]];

function posted(s, { fx, ok, res }) {
  const next = toast({ ...s, polled: {}, ...(ok && fx.into ? { [fx.into]: res } : {}) }, ok ? fx.done ?? res.message ?? "Done." : res.message || res.error || "That did not work.", ok ? "green" : "red");
  return [ok && fx.post === "/api/sessions" && res.id ? openDetail(next, res.id) : next];
}

function openDetail(s, id) {
  const polled = Object.fromEntries(Object.entries(s.polled).filter(([key]) => !key.includes(":")));
  return { ...s, polled, detail: { id, tab: "summary", scroll: 0, pick: 0, follow: true, data: null, steps: [], next: null } };
}

// ---- Keys
const MOVES = { up: "up", down: "down", left: "left", right: "right", home: "home", end: "end", pageup: "pageup", pagedown: "pagedown" };
const VIM = { k: "up", j: "down", h: "left", l: "right", g: "home", G: "end" };
const moveOf = (k) => (k.name === "char" ? VIM[k.ch] : MOVES[k.name]);
const stepBy = (move, page) => ({ up: -1, down: 1, pageup: -page, pagedown: page, home: -Infinity, end: Infinity })[move] ?? 0;
const promptOf = (label, value, then) => ({ label, value, at: graphemes(value).length, then });

function onKey(s, k) {
  const ch = k.name === "char" ? k.ch : null;
  if (k.name === "ctrl" && k.ch === "c") {
    if (!s.prompt && !s.ask && !s.help) return [s, [{ quit: true }]];
    return [{ ...s, prompt: null, ask: null, help: false, ...(s.prompt?.then.live ? { filter: "" } : {}) }];
  }
  if (s.prompt) return promptKey(s, k);
  if (s.ask) return askKey(s, k);
  if (s.help) return [{ ...s, help: false }];
  if (k.name === "ctrl" && k.ch === "z") return [s, [{ suspend: true }]];
  if (ch === "?") return [{ ...s, help: true }];
  const n = Number(ch);
  if (n >= 1 && n <= VIEWS.length) return [{ ...s, view: VIEWS[n - 1][0], filter: "", detail: null }];
  if (ch === "n" || ch === "N") {
    const cli = ch === "N" ? "codex" : "claude";
    return [{ ...s, prompt: promptOf(`New ${cli === "codex" ? "Codex" : "Claude"} session, what should it do`, "", { cli, multiline: true }) }];
  }
  if (ch === "r") return s.view === "prs" && !s.detail ? write(s, { post: "/api/prs", into: "prs", done: "Read your pull requests from GitHub." }, "Reading your pull requests from GitHub…") : [{ ...s, polled: {} }];
  if (s.detail) return detailKey(s, k, ch);
  if (ch === "q") return [s, [{ quit: true }]];
  if (k.name === "tab" || k.name === "backtab") {
    const i = VIEWS.findIndex(([v]) => v === s.view) + (k.name === "tab" ? 1 : -1);
    return [{ ...s, view: VIEWS[(i + VIEWS.length) % VIEWS.length][0], filter: "" }];
  }
  if (ch === "/" && FILTERED.has(s.view)) return [{ ...s, prompt: promptOf("Filter", s.filter, { live: "filter" }) }];
  if (k.name === "escape") return [{ ...s, filter: "" }];
  return VIEW_KEYS[s.view](s, k, ch);
}

const wordStart = (g, at) => {
  let i = at;
  while (i > 0 && g[i - 1] === " ") i--;
  while (i > 0 && g[i - 1] !== " ") i--;
  return i;
};
// Pasted text without control characters; line breaks stay only where the prompt sends them on.
const pasted = (text, multiline) => {
  const t = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[^\P{Cc}\n]|\p{Cf}/gu, "");
  return multiline ? t : t.replace(/\n+/g, " ");
};
// Typing in a prompt; its cursor `at` counts graphemes.
function edit(p, k) {
  const g = graphemes(p.value);
  const { at } = p;
  const to = (parts, cursor) => ({ ...p, value: parts.flat().join(""), at: cursor });
  const ctrl = k.name === "ctrl" ? k.ch : null;
  if (k.name === "char" || k.name === "paste") {
    const add = graphemes(k.name === "char" ? k.ch : pasted(k.text, p.then.multiline));
    return to([g.slice(0, at), add, g.slice(at)], at + add.length);
  }
  if (k.name === "backspace" && at) return to([g.slice(0, at - 1), g.slice(at)], at - 1);
  if (k.name === "delete") return to([g.slice(0, at), g.slice(at + 1)], at);
  if (ctrl === "u") return to([g.slice(at)], 0);
  if (ctrl === "w") return to([g.slice(0, wordStart(g, at)), g.slice(at)], wordStart(g, at));
  const cursor = { left: at - 1, right: at + 1, home: 0, end: g.length }[k.name] ?? { a: 0, e: g.length }[ctrl];
  return cursor === undefined ? p : { ...p, at: clamp(cursor, 0, g.length) };
}

function promptKey(s, k) {
  const p = s.prompt;
  const live = p.then.live;
  if (k.name === "escape") return [{ ...s, prompt: null, ...(live ? { [live]: "" } : {}) }];
  if (k.name === "enter") return submit({ ...s, prompt: null }, p);
  if (k.name === "tab" && p.then.choices?.length) {
    const value = p.then.choices[(p.then.choices.indexOf(p.value) + 1) % p.then.choices.length];
    return [{ ...s, prompt: { ...p, value, at: graphemes(value).length } }];
  }
  const edited = edit(p, k);
  return [{ ...s, prompt: edited, ...(live ? { [live]: edited.value } : {}) }];
}

function submit(s, p) {
  const text = p.value.trim();
  const then = p.then;
  if (then.live || !text) return [s];
  // A new session asks what to do, then where; Tab offers the folders sessions run in.
  if (then.cli) {
    const dirs = [...new Set([s.cwd, ...(s.board?.dirs ?? [])].filter(Boolean))];
    return [{ ...s, prompt: promptOf("In folder (Tab for others)", dirs[0] ?? "", { post: "/api/sessions", body: { cli: then.cli, prompt: text }, field: "cwd", choices: dirs, pending: "Starting…" }) }];
  }
  return write(s, { post: then.post, body: { ...then.body, [then.field]: text }, done: then.done }, then.pending);
}

function askKey(s, k) {
  const fx = k.name === "char" ? s.ask.keys[k.ch.toLowerCase()] : undefined;
  return fx ? write({ ...s, ask: null }, fx, fx.pending) : [{ ...s, ask: null }];
}

// The keys that act on a session, from the board, the archive or its details, allowed where the page allows them.
function cardKey(s, c, ch) {
  const gate = (action, then) => (c.can?.[action] === true ? then() : [toast(s, typeof c.can?.[action] === "string" ? c.can[action] : "Not for this session.", "yellow")]);
  const path = (action) => `/api/card/${c.id}/${action}`;
  const confirm = (text, fx) => [{ ...s, ask: { text: `${text} y/n`, keys: { y: fx } } }];
  if (ch === "a") return gate("open", () => [s, [{ attach: c.id }]]);
  if (ch === "o") return gate("open", () => write(s, { post: path("open"), done: "Opened in Terminal." }, "Opening Terminal…"));
  if (ch === "m") return gate("send", () => [{ ...s, prompt: promptOf(`Message to ${c.name}`, "", { post: path("send"), field: "text", multiline: true, pending: "Sending…", done: "Sent." }) }]);
  if (ch === "i") return gate("interrupt", () => confirm(`Interrupt ${c.name}?`, { post: path("interrupt"), pending: "Interrupting…", done: "Interrupted." }));
  if (ch === "R") return gate("rename", () => [{ ...s, prompt: promptOf("Rename to", c.name, { post: path("rename"), field: "name", pending: "Renaming…", done: "Renamed." }) }]);
  if (ch === "A") return c.archived ? [toast(s, "Already archived.")] : gate("archive", () => confirm(`Archive ${c.name}?`, { post: path("archive"), pending: "Archiving…", done: "Archived." }));
  if (ch === "u") return c.archived ? gate("archive", () => write(s, { post: path("unarchive"), done: "Unarchived." }, "Unarchiving…")) : [toast(s, "It is not archived.")];
  if (ch === "s") return write(s, { post: path("summarize"), done: "Summarizing; the card updates when it is done." }, "Asking for a summary…");
  return [s];
}

function boardMove(s, move) {
  const cols = columnsOf(s);
  const at = boardPick(s, cols);
  if (!at) return s;
  const select = (c) => ({ ...s, sel: { ...s.sel, board: c.id } });
  // Left and right go to the nearest column with cards, at the same row or its last.
  if (move === "left" || move === "right") {
    const col = move === "right" ? cols.slice(at.ci + 1).find((x) => x.cards.length) : cols.slice(0, at.ci).findLast((x) => x.cards.length);
    return select(col ? col.cards[Math.min(at.ri, col.cards.length - 1)] : at.c);
  }
  // Side by side, up and down stay in a column; listed, they run on through the next.
  const list = s.size.cols >= WIDE ? cols[at.ci].cards : cols.flatMap((col) => col.cards);
  return select(list[clamp(list.indexOf(at.c) + stepBy(move, 5), 0, list.length - 1)]);
}
function listMove(s, view, list, move) {
  const item = list[clamp(list.indexOf(pickIn(list, s.sel[view])) + stepBy(move, 5), 0, list.length - 1)];
  return item ? { ...s, sel: { ...s.sel, [view]: item.id } } : s;
}
function scrolled(s, view, move) {
  const page = s.size.rows - (view === "daily" ? 3 : 2);
  const max = Math.max(0, docOf(s, view).length - page);
  return { ...s, scroll: { ...s.scroll, [view]: clamp((s.scroll[view] ?? 0) + stepBy(move, page), 0, max) } };
}

const VIEW_KEYS = {
  board(s, k, ch) {
    const move = moveOf(k);
    if (move) return [boardMove(s, move)];
    const at = boardPick(s);
    if (!at) return [s];
    return k.name === "enter" ? [openDetail(s, at.c.id)] : cardKey(s, at.c, ch);
  },
  prs(s, k, ch) {
    const list = prSections(s).flatMap((sec) => sec.items);
    const move = moveOf(k);
    if (move) return [listMove(s, "prs", list, move)];
    const pr = pickIn(list, s.sel.prs);
    if (!pr) return [s];
    if (k.name === "enter") return [s, [{ browse: pr.url }]];
    if (ch !== "s") return [s];
    const c = cardsOf(s).find((x) => workedOn(x, pr));
    return [c ? openDetail(s, c.id) : toast(s, "No session on the board worked on it.")];
  },
  archived(s, k, ch) {
    const list = archivedOf(s);
    const move = moveOf(k);
    if (move) return [listMove(s, "archived", list, move)];
    const c = pickIn(list, s.sel.archived);
    if (!c) return [s];
    return k.name === "enter" ? [openDetail(s, c.id)] : cardKey(s, c, ch);
  },
  daily(s, k, ch) {
    const move = moveOf(k);
    if (move === "left" || move === "right") {
      const days = digestDays(s);
      const day = days[clamp(days.indexOf(shownDay(s)) + (move === "left" ? 1 : -1), 0, days.length - 1)];
      return [{ ...s, day, scroll: { ...s.scroll, daily: 0 } }];
    }
    if (move) return [scrolled(s, "daily", move)];
    if (ch !== "u") return [s];
    const day = shownDay(s);
    const keys = Object.fromEntries(DIGESTS.map(([kind, label]) => [kind[0], { post: `/api/digest/${kind}`, body: { day }, pending: `Asking for the ${label} digest…`, done: `Writing the ${label} digest; it shows here when it is done.` }]));
    return [{ ...s, ask: { text: `Update ${dayName(day, s.now)}: r the repository, n Notion or s Slack digest? Any other key cancels.`, keys } }];
  },
  journal(s, k) {
    const move = moveOf(k);
    return [move ? scrolled(s, "journal", move) : s];
  },
};

// Lines the open session's Summary or Conversation scrolls over: the screen less the header, its title block and footer.
const detailRows = (s) => s.size.rows - 5;
function detailKey(s, k, ch) {
  const d = s.detail;
  if (k.name === "escape" || ch === "q") return [{ ...s, detail: null }];
  const move = moveOf(k);
  if (move === "left" || move === "right" || k.name === "tab" || k.name === "backtab") {
    const i = TABS.findIndex(([t]) => t === d.tab) + (move === "left" || k.name === "backtab" ? -1 : 1);
    return [{ ...s, detail: { ...d, tab: TABS[(i + TABS.length) % TABS.length][0], scroll: 0, pick: 0, follow: true } }];
  }
  const c = detailCard(s);
  if (!c) return [s];
  const page = detailRows(s);
  if (d.tab === "context") {
    const list = c.context ?? [];
    if (move) return [{ ...s, detail: { ...d, pick: clamp(d.pick + stepBy(move, 5), 0, Math.max(0, list.length - 1)) } }];
    if (k.name === "enter") return list[d.pick]?.url ? [s, [{ browse: list[d.pick].url }]] : [s];
  } else {
    if (move) {
      // The conversation follows new steps until scrolled up, and again once scrolled back to its end.
      const max = Math.max(0, detailBody(s, c).length - page);
      const scroll = clamp((d.tab === "conversation" && d.follow ? max : Math.min(d.scroll, max)) + stepBy(move, page), 0, max);
      return [{ ...s, detail: { ...d, scroll, follow: scroll >= max } }];
    }
    if (k.name === "enter") return cardKey(s, c, "a");
  }
  return cardKey(s, c, ch);
}

// ---- Drawing: lines of [text, style] spans, each fitted to the width
export function view(s) {
  const height = s.size.rows - 2;
  const body = s.help ? docLines(HELP, s.size.cols) : s.detail ? detailLines(s, height) : VIEW_LINES[s.view](s, height);
  return [headerLine(s), ...Array.from({ length: height }, (_, i) => body[i] ?? []), footerLine(s)].map((line) => fit(line, s.size.cols));
}

function headerLine(s) {
  const cards = cardsOf(s);
  const live = cards.filter((c) => !c.archived);
  const counts = s.board ? { board: live.length, prs: s.board.prs?.open, archived: cards.length - live.length } : {};
  const asks = { board: live.filter((c) => colOf(c) === "needs-input").length, prs: s.board?.prs?.needsYou };
  const tabs = VIEWS.flatMap(([key, label], i) => [
    [` ${i + 1} ${label}${counts[key] == null ? "" : ` ${counts[key]}`} `, key === s.view ? "inverse bold" : ""],
    [asks[key] ? `${asks[key]}!` : "", "bold yellow"],
    [" ", ""],
  ]);
  const right = s.offline ? [`board unreachable: ${s.offline}`, "red"] : s.filter ? [`filter: ${s.filter}`, "yellow"] : s.board ? [`updated ${dur(s.now - s.board.at)} ago`, "gray"] : ["connecting…", "gray"];
  return spansWidth(tabs) + spansWidth([right]) < s.size.cols ? spread(tabs, [right], s.size.cols) : tabs;
}

const HINTS = {
  board: [["↑↓←→", "move"], ["enter", "open"], ["a", "attach"], ["m", "message"], ["n", "new"], ["/", "filter"], ["?", "keys"], ["q", "quit"]],
  prs: [["↑↓", "move"], ["enter", "GitHub"], ["s", "its session"], ["r", "read again"], ["/", "filter"], ["?", "keys"], ["q", "quit"]],
  archived: [["↑↓", "move"], ["enter", "open"], ["u", "unarchive"], ["/", "filter"], ["?", "keys"], ["q", "quit"]],
  daily: [["←→", "day"], ["↑↓", "scroll"], ["u", "update"], ["?", "keys"], ["q", "quit"]],
  journal: [["↑↓", "scroll"], ["?", "keys"], ["q", "quit"]],
  detail: [["←→", "tabs"], ["enter", "attach"], ["m", "message"], ["i", "interrupt"], ["s", "summarize"], ["?", "keys"], ["esc", "back"]],
  context: [["←→", "tabs"], ["↑↓", "move"], ["enter", "open link"], ["a", "attach"], ["?", "keys"], ["esc", "back"]],
  help: [["any key", "close"]],
};
function footerLine(s) {
  if (s.prompt) return promptLine(s.prompt, s.size.cols);
  if (s.ask) return [[s.ask.text, "bold yellow"]];
  if (s.toast && (s.toast.sticky || s.now - s.toast.at < TOAST_MS)) return [[s.toast.text, s.toast.style]];
  const hints = s.help ? "help" : s.detail ? (s.detail.tab === "context" ? "context" : "detail") : s.view;
  return HINTS[hints].flatMap(([key, what]) => [[key, "bold"], [` ${what}   `, "gray"]]);
}

// The prompt with the cursor drawn as a block; when the text is wider than the line, its start gives way.
function promptLine(p, cols) {
  const g = graphemes(p.value).map((x) => (x === "\n" ? "↵" : x));
  const label = `${p.label}: `;
  const room = cols - width(label) - 2;
  let start = p.at;
  let used = 0;
  while (start > 0 && used + width(g[start - 1]) <= room) used += width(g[--start]);
  return [[label, "bold"], [start ? "…" : "", "gray"], [g.slice(start, p.at).join(""), ""], [g[p.at] ?? " ", "inverse"], [g.slice(p.at + 1).join(""), ""]];
}

// Items stacked with a blank line after each, starting late enough to show item `sel` whole. The first line is kept
// for saying more are above, so stacks side by side line up.
function stack(items, sel, height) {
  const all = items.flatMap((lines) => [...lines, []]);
  if (all.length < height) return [[], ...all];
  const h = (i) => items[i].length + 1;
  const room = height - 2;
  const at = clamp(sel, 0, items.length - 1);
  let first = at;
  let last = at;
  let used = h(at);
  while (first > 0 && used + h(first - 1) <= room) used += h(--first);
  while (last < items.length - 1 && used + h(last + 1) <= room) used += h(++last);
  return [[[first ? "↑ more" : "", "gray"]], ...items.slice(first, last + 1).flatMap((lines) => [...lines, []]), [[last < items.length - 1 ? "↓ more" : "", "gray"]]];
}
// Entries under their headings, stacked to show the selected one: [[heading lines, [[lines, selected], …]], …].
function stackGroups(groups, height) {
  const entries = groups.flatMap(([head, list]) => [[head, false], ...list]);
  return stack(entries.map(([lines]) => lines), Math.max(0, entries.findIndex(([, on]) => on)), height);
}

// A card: its name, chips and age; its group and tags; then what it asks, or what it is doing, or where it stands.
// Done cards keep one line of status.
function cardLines(s, c, w, bar) {
  const [mark, markStyle] = markOf(c);
  const inner = w - 2;
  const at = c.updatedAt ?? c.startedAt;
  const done = colOf(c) === "done";
  const chips = [c.failed && ["failed", "red"], c.ending && [ENDINGS[c.ending.kind] ?? c.ending.kind, "red"], RESTING[c.column] && [c.column, RESTING[c.column]]].filter(Boolean);
  const title = spread([[mark, markStyle], [" ", ""], [c.name, "bold"]], [...chips.map(([t, style]) => [` ${t}`, style]), [at ? ` ${dur(s.now - at)}` : "", "gray"]], inner);
  const meta = done ? "" : [c.group, ...(c.tags ?? []).map((t) => `#${t}`), c.progress && `${c.progress.done}/${c.progress.total} tasks`].filter(Boolean).join(" · ");
  const needs = needsOf(c);
  const doing = c.column === "working" && c.detail;
  const text = doing || c.status || c.goal;
  const body = needs.length
    ? clip(`${needs[0]}${needs.length > 1 ? ` (+${needs.length - 1} more)` : ""}`, inner - 2, 3).map((l, i) => [[i ? "  " : "! ", "bold yellow"], [l, "yellow"]])
    : text
      ? clip(text, inner, done ? 1 : 2).map((l) => [[l, doing ? "" : "gray"]])
      : [];
  return barred([title, ...(meta ? [[[meta, "gray"]]] : []), ...body], bar);
}

function boardLines(s, height) {
  if (!s.board) return notice(s.offline ? "The board is not answering; trying again." : "Loading…");
  const cols = columnsOf(s);
  const at = boardPick(s, cols);
  if (!at) return notice(s.filter ? "No session matches the filter; Esc clears it." : "No sessions yet; n starts one.");
  return s.size.cols >= WIDE ? sideBySide(s, cols, at, height) : listed(s, cols, at, height);
}
// The columns side by side, each scrolled on its own.
function sideBySide(s, cols, at, height) {
  const gap = 2;
  const w = Math.floor((s.size.cols - gap * (cols.length - 1)) / cols.length);
  const blocks = cols.map((col, ci) => {
    const cards = col.cards.map((c, ri) => cardLines(s, c, w, ci === at.ci && ri === at.ri ? col.color : null));
    return [heading(col.label, col.color, col.cards.length), [["─".repeat(w), "gray"]], ...stack(cards, ci === at.ci ? at.ri : 0, height - 2)];
  });
  return Array.from({ length: height }, (_, i) => blocks.flatMap((block, ci) => [...fit(block[i] ?? [], w), [ci < blocks.length - 1 ? " ".repeat(gap) : "", ""]]));
}
// In a narrow terminal, the columns one under another.
function listed(s, cols, at, height) {
  const groups = cols.map((col, ci) => [[heading(col.label, col.color, col.cards.length)], col.cards.map((c, ri) => {
    const on = ci === at.ci && ri === at.ri;
    return [cardLines(s, c, s.size.cols, on ? col.color : null), on];
  })]);
  return stackGroups(groups, height);
}

function prLines(s, pr, bar) {
  const since = pr.status === "waiting" ? `waiting ${dur(s.now - pr.waitingSince)}` : `opened ${dur(s.now - pr.createdAt)} ago`;
  const parent = s.prs.prs.find((x) => x.repo === pr.repo && x.head === pr.base);
  const chips = [
    CHECKS[pr.checks],
    ...pr.reviews.map((r) => {
      const [sign, style] = REVIEWS[r.state] ?? ["·", "gray"];
      return [`${sign} ${r.who}`, style];
    }),
    ...pr.requested.map((who) => [`○ ${who}`, "gray"]),
    pr.botThreads > 0 && [`${pr.botThreads} bot thread${pr.botThreads === 1 ? "" : "s"}`, "gray"],
    pr.stacked && [parent ? `on #${parent.number}` : `onto ${pr.base}`, "gray"],
    [`+${pr.additions} −${pr.deletions}`, "gray"],
    ...cardsOf(s).filter((c) => workedOn(c, pr)).map((c) => {
      const [mark, style] = markOf(c);
      return [`${mark} ${c.name}`, style];
    }),
  ].filter(Boolean);
  return barred([
    spread([[`${pr.repo.split("/")[1]}#${pr.number} `, "gray"], [pr.title, "bold"]], [[` ${since}`, "gray"]], s.size.cols - 2),
    ...pr.why.map((why) => [[why, pr.status === "needs-you" ? "yellow" : "gray"]]),
    chips.flatMap(([text, style], i) => [[i ? " · " : "", "gray"], [text, style]]),
  ], bar);
}
function prsLines(s, height) {
  if (!s.prs) return notice("Reading your pull requests from GitHub…");
  const p = s.prs;
  const top = [
    ...notice(`${p.total} open${p.at ? ` · read from GitHub ${dur(s.now - p.at)} ago as ${p.viewer}` : ""}${p.reading ? " · reading…" : ""}`),
    ...(p.error ? notice(`Could not read them: ${p.error}`, "red") : []),
  ];
  const secs = prSections(s);
  const pick = pickIn(secs.flatMap((sec) => sec.items), s.sel.prs);
  const groups = secs.map((sec) => [[heading(sec.label, sec.color, sec.items.length)], sec.items.map((pr) => [prLines(s, pr, pr === pick ? sec.color : null), pr === pick])]);
  return [...top, ...stackGroups(groups, height - top.length)];
}

function archivedLines(s, height) {
  if (!s.board) return notice("Loading…");
  const list = archivedOf(s);
  if (!list.length) return notice(s.filter ? "No archived session matches the filter; Esc clears it." : "Nothing archived yet.");
  const pick = pickIn(list, s.sel.archived);
  const days = Map.groupBy(list, (c) => (c.archivedAt ? dayKey(c.archivedAt) : ""));
  const groups = [...days].map(([key, cards]) => [[[[key ? dayName(key, s.now) : "Date unknown", "bold"]]], cards.map((c) => [archivedRow(s, c, c === pick), c === pick])]);
  return stackGroups(groups, height);
}
// An archived session: when it was archived, its name and outcome, then where it ended.
function archivedRow(s, c, on) {
  const [mark, markStyle] = markOf(c);
  const time = c.archivedAt ? new Date(c.archivedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const outcome = c.outcome && c.outcome.key !== "none" ? [[` ${c.outcome.label}`, "cyan"]] : [];
  return barred([
    spread([[time.padEnd(9), "gray"], [mark, markStyle], [" ", ""], [c.name, "bold"]], outcome, s.size.cols - 2),
    [[" ".repeat(11), ""], [c.status ?? c.goal ?? "", "gray"]],
  ], on ? "yellow" : null);
}

// Blocks of text, [kind, text, extra, bullet], as lines with a one-column margin. A heading's extra is a note beside
// it; a bullet's is its style.
const DOC_STYLES = { b: "bold", dim: "gray", bad: "red" };
function docLines(blocks, cols) {
  const w = Math.max(10, cols - 2);
  return blocks.flatMap(([kind, text, extra, bullet = "•"]) => {
    if (kind === "h") return [[], [[" ", ""], [text, "bold underline"], [extra ? `  ${extra}` : "", "gray"]]];
    if (kind === "sub") return [[], ...wrap(text, w).map((l) => [[" ", ""], [l, "bold"]])];
    if (kind === "li") return wrap(text, w - 4).map((l, i) => [[i ? "    " : `  ${bullet} `, "gray"], [l, extra ?? ""]]);
    return wrap(text, w).map((l) => [[" ", ""], [l, DOC_STYLES[kind] ?? ""]]);
  });
}
const tidy = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
// Markdown as blocks: headings and lines that are wholly bold become subheadings, list items bullets, the rest paragraphs.
function mdBlocks(md) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push(["p", para.join(" ")]);
    para = [];
  };
  for (const raw of String(md ?? "").split("\n")) {
    const item = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    const text = tidy(item ? item[1] : raw).trim();
    if (!text) flush();
    else if (/^\s*#{1,6}\s/.test(raw) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(raw)) {
      flush();
      blocks.push(["sub", text.replace(/^#+\s*/, "")]);
    } else if (item) {
      flush();
      blocks.push(["li", text]);
    } else para.push(text);
  }
  flush();
  return blocks;
}

function summaryBlocks(s, c) {
  const sum = c.summary ?? {};
  const meta = c.summaryMeta ?? {};
  const needs = needsOf(c);
  const tasks = s.detail.data?.tasks ?? [];
  const list = (title, items, style) => (items?.length ? [["h", title], ...items.map((x) => ["li", x, style])] : []);
  return [
    ...(needs.length ? [["h", "Needs you", c.waitingSince ? `waiting ${dur(s.now - c.waitingSince)}` : ""], ...needs.map((x) => ["li", x, "yellow"])] : []),
    ...(c.ending ? [["bad", `${ENDINGS[c.ending.kind] ?? c.ending.kind}: ${c.ending.text}`]] : []),
    ...(c.column === "working" && c.detail ? [["h", "Doing now"], ["p", c.detail]] : []),
    ...(c.status ? [["h", "Where it stands", meta.pending ? "summarizing…" : meta.at ? `summarized ${dur(s.now - meta.at)} ago` : ""], ["p", c.status]] : []),
    ...(meta.error && !c.summary ? [["bad", `The summary failed: ${meta.error}`]] : []),
    ...(c.goal ? [["h", "Goal"], ["p", c.goal]] : []),
    ...list("Done", sum.done),
    ...list("Next", sum.next),
    ...list("Concerns", concernsOf(c), "yellow"),
    ...(c.result ? [["h", "Result"], ...mdBlocks(c.result)] : []),
    ...(tasks.length
      ? [["h", "Tasks", `${tasks.filter((t) => t.status === "completed").length} of ${tasks.length} done`], ...tasks.map((t) => ["li", t.subject, t.status === "completed" ? "gray" : "", TASK_MARKS[t.status] ?? "·"])]
      : []),
    ...(c.intent ? [["h", "Original ask"], ...mdBlocks(c.intent.length > 1200 ? `${c.intent.slice(0, 1200)}…` : c.intent)] : []),
    ["h", c.agent === "codex" ? "Codex thread" : "Claude Code session"],
    ["dim", c.sessionId ?? c.id],
  ];
}

const firstLine = (t) => String(t ?? "").trim().split("\n")[0];
const toolArg = (input) => firstLine(input?.description ?? input?.command ?? input?.file_path ?? input?.pattern ?? input?.query ?? input?.url ?? input?.prompt ?? JSON.stringify(input ?? {}));
// One conversation step as the session's own terminal shows it, in short.
function stepLines(st, w) {
  const text = String(st.text ?? "").slice(0, 6000);
  const block = (lead, style, max) => clip(text, w - width(lead), max).map((l, i) => [[i ? " ".repeat(width(lead)) : lead, style], [l, style]]);
  if (st.kind === "user") return [[], ...block("› ", "bold", 12)];
  if (st.kind === "text") return [[], ...block("", "", 200)];
  if (st.kind === "thinking") return block("", "gray italic", 3);
  if (st.kind === "tool") return [[["▸ ", "gray"], [st.name ?? "tool", "bold"], [` ${toolArg(st.input)}`, "gray"]]];
  if (st.kind === "result") return [[["  ⎿ ", "gray"], [firstLine(text) || "(no output)", st.error ? "red" : "gray"]]];
  return [[["— ", "gray"], [firstLine(text), "gray"]]];
}
// Only the last steps are drawn, so a long session redraws as fast as a short one.
const SHOWN_STEPS = 300;
function conversationLines(d, cols) {
  if (!d.steps.length) return notice(d.next == null ? "Loading the conversation…" : "No conversation yet.");
  const hidden = d.steps.length - SHOWN_STEPS;
  const earlier = hidden > 0 ? [[[`${hidden} earlier steps are on the page's Conversation tab.`, "gray"]]] : [];
  return [...earlier, ...d.steps.slice(-SHOWN_STEPS).flatMap((st) => stepLines(st, Math.max(10, cols - 2)))].map((line) => [[" ", ""], ...line]);
}
const detailBody = (s, c) => (s.detail.tab === "summary" ? docLines(summaryBlocks(s, c), s.size.cols) : conversationLines(s.detail, s.size.cols));

function contextLines(c, pick, height) {
  const list = c.context ?? [];
  if (!list.length) return notice("Nothing yet: the Linear, Notion and Slack pages, pull requests and artifacts it touches show here.");
  const items = list.map((x, i) => barred([
    [[KINDS[x.kind] ?? "Link", "gray"], [" ", ""], [x.id ?? "", "bold"], [x.untitled || !x.title ? "" : `  ${x.title}`, ""], [x.status ? `  ${x.status}` : "", "cyan"]],
    [[x.url ?? "", "gray"]],
  ], i === pick ? "yellow" : null));
  return stack(items, pick, height);
}

function detailLines(s, height) {
  const d = s.detail;
  const c = detailCard(s);
  if (!c) return notice("Loading…");
  const [mark, markStyle] = markOf(c);
  const [, label, color] = COLS.find(([key]) => key === colOf(c));
  const where = c.archived ? ["archived", "gray"] : RESTING[c.column] ? [c.column, RESTING[c.column]] : [label, color];
  const at = c.updatedAt ?? c.startedAt;
  const head = [
    spread([[` ${mark}`, markStyle], [" ", ""], [c.name, "bold"], ["  ", ""], where], [[`${c.id} `, "gray"]], s.size.cols),
    [[` ${[home(c.cwd), c.branch, c.model, c.tokens && `${tokens(c.tokens)} tokens`, at && `active ${dur(s.now - at)} ago`].filter(Boolean).join(" · ")}`, "gray"]],
    [[" ", ""], ...TABS.flatMap(([tab, name]) => [[` ${name} `, tab === d.tab ? "inverse bold" : "gray"], [" ", ""]])],
  ];
  const room = height - head.length;
  if (d.tab === "context") return [...head, ...contextLines(c, d.pick, room)];
  const body = detailBody(s, c);
  const max = Math.max(0, body.length - room);
  const top = d.tab === "conversation" && d.follow ? max : Math.min(d.scroll, max);
  return [...head, ...body.slice(top, top + room)];
}

function dailyBlocks(s, day) {
  const g = s.digest;
  if (!g) return [];
  return DIGESTS.flatMap(([kind, label]) => {
    const d = g.days[day]?.[kind];
    const run = g.running?.[kind];
    const state = run ? (run.day === day ? `updating… ${dur(s.now - run.startedAt)}` : `busy with ${dayName(run.day, s.now)}`) : d?.at ? `written ${dur(s.now - d.at)} ago` : "";
    const failedLast = d?.error && !(d.at > d.errorAt);
    const item = (it) => ["li", [it.text, it.prs?.length ? it.prs.map((n) => `#${n}`).join(" ") : "", it.where].filter(Boolean).join(" · ")];
    return [
      ["h", kind === "repo" ? `${label} ${g.repo}` : label, state],
      ...(failedLast ? [["bad", `The last update failed ${dur(s.now - d.errorAt)} ago: ${d.error}`]] : []),
      ...(d?.at
        ? [["b", d.headline], ...d.sections.flatMap((sec) => [["sub", sec.title], ...sec.items.map(item)]), ...(d.gaps?.length ? [["dim", `Not reached: ${d.gaps.join("; ")}`]] : [])]
        : [["dim", "No digest for this day yet; u writes one."]]),
    ];
  });
}
function journalBlocks(s) {
  const j = s.journal;
  if (!j) return [];
  const sum = j.summary;
  const failedLast = sum?.error && !(sum.at > sum.errorAt);
  return [
    ["h", "Where things stand", sum?.at ? `written ${dur(s.now - sum.at)} ago` : ""],
    ...(failedLast ? [["bad", `The last summary failed: ${sum.error}`]] : []),
    ...(sum?.headline ? [["b", sum.headline], ...mdBlocks(sum.text)] : [["dim", "No summary yet; the page's Journal tab writes one."]]),
    ...HORIZONS.flatMap(([h, label]) => {
      const items = j.items.filter((it) => it.horizon === h && !it.done);
      return [["h", label, String(items.length)], ...(items.length ? items.map((it) => ["li", it.text]) : [["dim", "Nothing here."]])];
    }),
    ...(j.notes?.length ? [["h", "Notes"], ...j.notes.map((n) => ["li", n.text])] : []),
  ];
}
const docOf = (s, view) => docLines(view === "daily" ? dailyBlocks(s, shownDay(s)) : journalBlocks(s), s.size.cols);

function dailyLines(s, height) {
  if (!s.digest) return notice("Loading…");
  const day = shownDay(s);
  const days = digestDays(s);
  const nav = [[days.at(-1) === day ? "   " : " ← ", "gray"], [dayName(day, s.now), "bold"], [`  ${day}`, "gray"], [days[0] === day ? "" : "  →", "gray"]];
  const doc = docOf(s, "daily");
  const top = Math.min(s.scroll.daily ?? 0, Math.max(0, doc.length - height + 1));
  return [nav, ...doc.slice(top, top + height - 1)];
}
function journalLines(s, height) {
  if (!s.journal) return notice("Loading…");
  const doc = docOf(s, "journal");
  const top = Math.min(s.scroll.journal ?? 0, Math.max(0, doc.length - height));
  return doc.slice(top, top + height);
}

const VIEW_LINES = { board: boardLines, prs: prsLines, archived: archivedLines, daily: dailyLines, journal: journalLines };

const HELP = [
  ["h", "Everywhere"],
  ["li", "1 to 5, or Tab outside a session, switch views; arrows or h j k l move, g and G go to the ends, PgUp and PgDn page"],
  ["li", "/ filters the board, PRs and archive (Esc clears it), r reads everything again, n starts a Claude session and N a Codex one, Ctrl+Z suspends, q quits"],
  ["h", "A session, on the board, in the archive or open"],
  ["li", "Enter opens it; Enter again, or a, attaches: the session takes this terminal, and the board comes back when you leave it"],
  ["li", "In Claude Code, ← on an empty prompt opens its agent view; exit that to come back. The session keeps running"],
  ["li", "m message, i interrupt, s summarize, R rename, A archive, u unarchive, o open in a Terminal window"],
  ["li", "Open, ← and → switch Summary, Conversation and Context; Enter on a link opens it; Esc goes back"],
  ["h", "PRs and Daily"],
  ["li", "PRs: Enter opens it on GitHub, s opens the session that worked on it, r reads GitHub again"],
  ["li", "Daily: ← and → change the day, u updates one of its digests"],
];

// ---- Running it
const PATHS = {
  board: () => "/api/board",
  prs: () => "/api/prs",
  digest: () => "/api/digest",
  journal: () => "/api/journal",
  detail: ({ id }) => `/api/card/${id}`,
  conversation: ({ id, from }) => `/api/card/${id}/conversation${from == null ? "" : `?from=${encodeURIComponent(from)}`}`,
};

export async function runTui({ url, cwd = process.cwd(), input = process.stdin, output = process.stdout, color = !process.env.NO_COLOR }) {
  const screen = createScreen(output, input);
  const readKeys = createKeyReader();
  const reading = new Set();
  let state = initial({ cwd, size: screen.size() });
  let away = false; // a session has the terminal
  let drawing = null;
  let quit;
  const done = new Promise((resolve) => (quit = resolve));

  const draw = () => {
    drawing ??= setImmediate(() => {
      drawing = null;
      if (!away) screen.draw(view(state).map((line) => ansi(line, color)));
    });
  };
  const dispatch = (action) => {
    const next = reduce(state, action);
    state = next.state;
    for (const fx of next.effects) perform(fx);
    draw();
  };
  const reason = (e) => e.cause?.code ?? e.message;
  const call = async (path, init = {}) => {
    const r = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(init.method ? 600_000 : 30_000), ...init });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok && body.ok !== false, status: r.status, body };
  };
  const failure = (e) => ({ ok: false, body: { message: reason(e) } });

  async function perform(fx) {
    if (fx.get) {
      const key = keyOf(fx);
      if (reading.has(key)) return;
      reading.add(key);
      const res = await call(PATHS[fx.get](fx)).catch(failure);
      reading.delete(key);
      const { get: what, id, from } = fx;
      dispatch(res.ok ? { type: "loaded", what, id, from, data: res.body } : { type: "failed", what, id, status: res.status, error: res.body.message ?? res.body.error ?? `HTTP ${res.status}` });
    } else if (fx.post) {
      const res = await call(fx.post, { method: "POST", headers: WRITE_HEADERS, body: JSON.stringify(fx.body ?? {}) }).catch(failure);
      dispatch({ type: "posted", fx, ok: res.ok, res: res.body });
    } else if (fx.attach) await attach(fx.attach);
    else if (fx.browse) execFile("open", [fx.browse], () => {});
    else if (fx.suspend) suspend();
    else if (fx.quit) quit();
  }

  // The session takes the terminal; the board steps aside until its program exits.
  async function attach(id) {
    const res = await call(`/api/card/${id}/attach`).catch(failure);
    if (!res.ok) return dispatch({ type: "posted", fx: {}, ok: false, res: res.body });
    away = true;
    input.off("data", onData);
    screen.leave();
    // Ctrl+C reaches the whole foreground process group, and it is the session's.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    const code = await new Promise((resolve) => {
      const child = spawn(res.body.argv[0], res.body.argv.slice(1), { cwd: res.body.cwd ?? undefined, stdio: "inherit" });
      child.on("error", (e) => {
        output.write(`${e.message}\n`);
        resolve(1);
      });
      child.on("exit", (exitCode) => resolve(exitCode ?? 1));
    });
    // What a session that failed printed stays on screen until read.
    if (code !== 0) {
      output.write("\nPress Enter to go back to the board.");
      input.resume();
      await new Promise((resolve) => input.once("data", resolve));
    }
    process.off("SIGINT", ignore);
    screen.enter();
    input.on("data", onData);
    away = false;
    dispatch({ type: "returned" });
  }

  function suspend() {
    screen.leave();
    process.once("SIGCONT", () => {
      screen.enter();
      dispatch({ type: "returned" });
    });
    process.kill(process.pid, "SIGTSTP");
  }

  const onData = (chunk) => {
    for (const key of readKeys(chunk)) dispatch({ type: "key", key });
  };
  const onResize = () => {
    if (!away) screen.clear();
    dispatch({ type: "resize", size: screen.size() });
  };
  // A crash must not leave the terminal in raw mode on the alternate screen.
  const onFatal = (e) => {
    screen.leave();
    console.error(e);
    process.exit(1);
  };
  input.setEncoding("utf8");
  screen.enter();
  input.on("data", onData);
  output.on("resize", onResize);
  process.on("uncaughtException", onFatal);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), 1000);
  dispatch({ type: "tick", now: Date.now() });
  await done;
  clearInterval(timer);
  input.off("data", onData);
  output.off("resize", onResize);
  process.off("uncaughtException", onFatal);
  process.off("SIGTERM", quit);
  process.off("SIGHUP", quit);
  screen.leave();
}
