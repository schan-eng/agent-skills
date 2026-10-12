// The board in a terminal, on the same server as the page. `reduce` and `view` are pure: a key or a server reply goes
// in, and the next state, with the reads and writes it calls for, comes out. `runTui` performs those and draws.
import { execFile, spawn } from "node:child_process";
import { relay } from "./relay.mjs";
import { ansi, clean, createKeyReader, createScreen, cut, fit, graphemes, width, wrap } from "./term.mjs";

const VIEWS = [["board", "Board"], ["prs", "PRs"], ["archived", "Archived"], ["daily", "Daily"], ["journal", "Journal"]];
const COLS = [["researching", "Researching", "cyan"], ["building", "Building", "blue"], ["needs-input", "Needs input", "yellow"], ["done", "Done", "green"]];
const PR_SECTIONS = [["needs-you", "Needs you", "yellow"], ["waiting", "Waiting for review", "blue"], ["approved", "Approved", "green"], ["draft", "Draft", "gray"]];
const DIGESTS = [["repo", "Repository"], ["notion", "Notion"], ["slack", "Slack"]];
const HORIZONS = [["today", "Today"], ["week", "This week"], ["later", "Later"]];
// An open session's tabs. Codex keeps no gathered context, plan, task list or team for the last four to show.
const TABS = [["summary", "Summary"], ["conversation", "Conversation"], ["context", "Context"], ["spec", "Spec"], ["progress", "Progress"], ["team", "Team"]];
const tabsOf = (c) => (c?.agent === "codex" ? TABS.slice(0, 2) : TABS);
const JOURNAL_TABS = [["todos", "To-dos"], ["brief", "Brief"], ["notes", "Notes"]];
const MARKS = { claude: ["●", "claude"], codex: ["◆", "codex"] };
const AGENT_NAMES = { claude: "Claude", codex: "Codex" };
// What c shows in turn: every session, Claude's only, Codex's only.
const AGENTS = [null, "claude", "codex"];
// Claude Code's and Codex's own lists of their sessions, as the page's dock shows them, by the keys that open them.
const AGENT_VIEWS = {
  v: { relay: "/api/agent-view/term", label: "Claude's agent view" },
  V: { relay: "/api/agent-view/term?agent=codex", label: "Codex's agent view" },
};
const RESTING = { stopped: "red", interactive: "magenta" };
const ENDINGS = { error: "error", interrupted: "interrupted", "cut-off": "cut off" };
const KINDS = { pr: "PR", "linear-issue": "Linear", "linear-project": "Linear project", "linear-doc": "Linear doc", notion: "Notion", "slack-thread": "Slack", "slack-channel": "Slack", artifact: "Artifact" };
const REVIEWS = { APPROVED: ["✓", "green"], CHANGES_REQUESTED: ["✗", "red"], COMMENTED: ["~", "gray"], DISMISSED: ["–", "gray"] };
const CHECKS = { pass: ["✓ checks", "green"], fail: ["✗ checks", "red"], pending: ["● checks", "yellow"] };
const TASK_MARKS = { completed: "✓", in_progress: "▸", pending: "○" };
// The page's session settings (index.html): what its forms offer besides the default.
const MODELS = ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["manual", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"];
const FILTERED = new Set(["board", "prs", "archived", "journal"]);
// From this many columns the board's columns sit side by side; narrower, they are listed one under another.
const WIDE = 100;
const TOAST_MS = 6000;
// The most of one document, plan or prompt that is drawn, so a long one redraws as fast as a short one.
const DOC_MAX = 20_000;
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
// The pull request a sync is for: one the session made, else the one it touched last.
function prOf(c) {
  const p = (c.context ?? []).filter((x) => x.kind === "pr").toSorted((x, y) => (y.produced > 0) - (x.produced > 0) || String(y.lastAt ?? "").localeCompare(String(x.lastAt ?? "")))[0];
  return p ? p.url ?? `https://github.com/${p.id.replace("#", "/pull/")}` : "";
}
// The page's lanes: a tagged card sits in each tag's lane, an untagged one in its group's; alphabetical, Ungrouped last.
function lanesOf(cards) {
  const lanes = new Map();
  for (const c of cards) {
    const keys = c.tags?.length ? c.tags.map((t) => [t, true]) : [[c.group ?? "Ungrouped", false]];
    for (const [name, fromTag] of keys) {
      const id = name.toLowerCase();
      const lane = lanes.get(id) ?? { id, name, cards: [] };
      lanes.set(id, { ...lane, name: fromTag ? name : lane.name, cards: [...lane.cards, c] });
    }
  }
  return [...lanes.values()].toSorted((x, y) => (x.id === "ungrouped") - (y.id === "ungrouped") || x.name.localeCompare(y.name, undefined, { sensitivity: "base", numeric: true }));
}

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
const dayStart = (t) => dateOf(dayKey(t)).getTime();
const weekStart = (t) => dayStart(t) - ((new Date(t).getDay() + 6) % 7) * 86_400_000;
const daysAgo = (key, now) => Math.round((dateOf(dayKey(now)) - dateOf(key)) / 86_400_000);
const dayName = (key, now) => ["Today", "Yesterday"][daysAgo(key, now)] ?? dateOf(key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const timeOf = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const matches = (filter, ...texts) => !filter || texts.join(" ").toLowerCase().includes(filter.toLowerCase());
const csv = (v) => String(v ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const capped = (text) => (text.length > DOC_MAX ? `${text.slice(0, DOC_MAX)}\n\n…` : text);
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const spansWidth = (spans) => spans.reduce((n, [t]) => n + width(clean(t)), 0);
// Left spans, then right spans against the right edge; the left ones are cut when both do not fit.
function spread(left, right, cols) {
  const room = cols - spansWidth(left) - spansWidth(right);
  return room > 0 ? [...left, [" ".repeat(room), ""], ...right] : [...fit(left, Math.max(0, cols - spansWidth(right) - 1)), [" ", ""], ...right];
}
// Left spans, and as many of the right ones as fit beside them, in order.
function beside(left, right, cols) {
  for (let n = right.length; n > 0; n--) if (spansWidth(left) + spansWidth(right.slice(0, n)) < cols) return spread(left, right.slice(0, n), cols);
  return left;
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
const cardText = (c) => [c.agent, c.name, c.id, c.group, c.status, c.goal, c.branch, c.cwd, c.outcome?.label, ...(c.tags ?? []), ...(c.context ?? []).flatMap((x) => [x.id, x.title])];
const shownAgent = (s, c) => !s.agent || (c.agent ?? "claude") === s.agent;
const liveCards = (s) => cardsOf(s).filter((c) => !c.archived && shownAgent(s, c));
// The lane picked while it still has sessions; otherwise the board shows them all.
const laneOf = (s, lanes = lanesOf(liveCards(s))) => lanes.find((l) => l.id === s.lane) ?? null;
function columnsOf(s, lane = laneOf(s)) {
  const cards = (lane?.cards ?? liveCards(s)).filter((c) => matches(s.filter, ...cardText(c)));
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
const archivedOf = (s) => cardsOf(s).filter((c) => c.archived && shownAgent(s, c) && matches(s.filter, ...cardText(c))).toSorted((x, y) => (y.archivedAt ?? 0) - (x.archivedAt ?? 0));
function prSections(s) {
  const prs = (s.prs?.prs ?? []).filter((p) => matches(s.filter, p.repo, `#${p.number}`, p.title, p.head, ...p.requested, ...p.reviews.map((r) => r.who)));
  return PR_SECTIONS.map(([key, label, color]) => ({ label, color, items: prs.filter((p) => p.status === key) }));
}
// In a list the selection is an id; when that item is gone, the first one is selected.
const pickIn = (list, id) => list.find((x) => x.id === id) ?? list[0] ?? null;
// The open session: its full detail once read, else its card.
const detailCard = (s) => s.detail.data ?? cardsOf(s).find((c) => c.id === s.detail.id) ?? null;
// The tab shown: the one picked, when the session has it.
const tabOf = (s, c) => (tabsOf(c).some(([t]) => t === s.detail.tab) ? s.detail.tab : "summary");
const daysBack = (now, n) => {
  const d = new Date(now);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n));
};
// The last week and every day with a digest, newest first; until one is picked, the newest with a digest is shown.
const digestDays = (s) => [...new Set([...Array.from({ length: 7 }, (_, n) => daysBack(s.now, n)), ...Object.keys(s.digest?.days ?? {})])].toSorted().toReversed();
const shownDay = (s) => s.day ?? Object.keys(s.digest?.days ?? {}).toSorted().at(-1) ?? dayKey(s.now);
// The Journal's to-dos by horizon, as the page lists them: open ones oldest first, then the ones done lately. A done
// one stays for its horizon's span: today under Today, this week under the others.
function todosOf(s) {
  const items = (s.journal?.items ?? []).filter((it) => matches(s.filter, it.text));
  return HORIZONS.map(([h, label]) => {
    const mine = items.filter((it) => it.horizon === h);
    const since = h === "today" ? dayStart(s.now) : weekStart(s.now);
    const open = mine.filter((it) => !it.done).toSorted((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0));
    const recent = mine.filter((it) => it.done && it.doneAt >= since).toSorted((x, y) => y.doneAt - x.doneAt);
    return { label, items: [...open, ...recent], done: recent.length, earlier: mine.length - open.length - recent.length };
  });
}
const suggestionsOf = (s) => (s.journal?.summary?.suggestions ?? []).map((x, i) => ({ ...x, id: `suggestion:${i}`, index: i }));
const notesOf = (s) => (s.journal?.notes ?? []).filter((n) => matches(s.filter, n.text));
// What ↑ and ↓ pick on the Journal: to-dos, then the brief's suggested ones; or notes.
const journalPicks = (s) => (s.journalTab === "notes" ? notesOf(s) : s.journalTab === "todos" ? [...todosOf(s).flatMap((g) => g.items), ...suggestionsOf(s)] : []);
// The open session's links: the ones pinned to it, then the ones it touched.
const contextRows = (s, c) => [...(s.board?.pins ?? []).filter((p) => p.session === c.sessionId).map((p) => ({ ...p.source, pin: p })), ...(c.context ?? [])];

// ---- State
export const initial = ({ now = Date.now(), cwd = "", size = { cols: 80, rows: 24 } } = {}) => ({
  now, cwd, size, view: "board", board: null, prs: null, digest: null, journal: null, offline: null, polled: {}, sel: {}, scroll: {},
  day: null, filter: "", agent: null, lane: null, journalTab: "todos", detail: null, prompt: null, ask: null, form: null, toast: null, help: null,
});

const keyOf = (fx) => (fx.id ? `${fx.get}:${fx.id}` : fx.get);
// What the screen is drawn from: the board always, and the open view's or session's own reads.
function reads(s) {
  if (!s.detail) return [{ get: "board" }, ...(VIEW_READS[s.view] ? [{ get: VIEW_READS[s.view] }] : [])];
  const { id, tab, next } = s.detail;
  return [{ get: "board" }, { get: "detail", id }, ...(tab === "conversation" ? [{ get: "conversation", id, from: next }] : [])];
}

// The next state and effects: { get } reads, { write } writes, { relay } and { resume } hand the terminal over, and
// { browse }, { suspend } and { quit }. Every read the screen needs and has not had for its interval is asked for.
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
  if (a.type === "returned") {
    // Back from a terminal or a suspend, everything is read again.
    const next = { ...s, polled: {} };
    return [a.note ? toast(next, a.note, "yellow") : next];
  }
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
// A write, with its pending note on the bottom line until its answer replaces it.
const write = (s, fx) => [toast(s, fx.pending ?? "Working…", "", true), [fx]];

function posted(s, { fx, ok, res }) {
  // A form stays open, with what was typed, until what it sent goes through.
  const form = fx.form ? { form: ok || !s.form ? null : { ...s.form, sending: false } } : {};
  const next = toast(
    { ...s, ...form, polled: {}, ...(ok && fx.into ? { [fx.into]: res } : {}), ...(ok && fx.close ? { detail: null } : {}) },
    ok ? fx.done ?? res.message ?? "Done." : res.message || res.error || "That did not work.",
    ok ? "green" : "red",
  );
  return [ok && fx.write === "/api/sessions" && res.id ? openDetail(next, res.id) : next];
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
// A prompt on the bottom line to type into, and a question there that y answers.
const prompt = (s, label, value, then) => [{ ...s, prompt: promptOf(label, value, then) }];
const confirm = (s, text, fx) => [{ ...s, ask: { text: `${text} y/n`, keys: { y: fx } } }];

function onKey(s, k) {
  const ch = k.name === "char" ? k.ch : null;
  if (k.name === "ctrl" && k.ch === "c") {
    if (!s.prompt && !s.ask && !s.form && s.help == null) return [s, [{ quit: true }]];
    return [{ ...s, prompt: null, ask: null, form: null, help: null, ...(s.prompt?.then.live ? { filter: "" } : {}) }];
  }
  if (s.prompt) return promptKey(s, k);
  if (s.ask) return askKey(s, k);
  if (s.form) return formKey(s, k);
  if (s.help != null) return helpKey(s, k);
  if (k.name === "ctrl" && k.ch === "z") return [s, [{ suspend: true }]];
  if (ch === "?") return [{ ...s, help: 0 }];
  const n = Number(ch);
  if (n >= 1 && n <= VIEWS.length) return [{ ...s, view: VIEWS[n - 1][0], filter: "", detail: null }];
  if (ch === "n" || ch === "N") return [newSession(s, ch === "N" ? "codex" : "claude")];
  if (ch === "v" || ch === "V") return [s, [AGENT_VIEWS[ch]]];
  if (ch === "r") {
    if (s.view !== "prs" || s.detail) return [{ ...s, polled: {} }];
    return write(s, { write: "/api/prs", into: "prs", pending: "Reading your pull requests from GitHub…", done: "Read your pull requests from GitHub." });
  }
  if (s.detail) return detailKey(s, k, ch);
  if (ch === "q") return [s, [{ quit: true }]];
  if (k.name === "tab" || k.name === "backtab") {
    const i = VIEWS.findIndex(([v]) => v === s.view) + (k.name === "tab" ? 1 : -1);
    return [{ ...s, view: VIEWS[(i + VIEWS.length) % VIEWS.length][0], filter: "" }];
  }
  if (ch === "c") return [{ ...s, agent: AGENTS[(AGENTS.indexOf(s.agent) + 1) % AGENTS.length] }];
  if (ch === "/" && FILTERED.has(s.view)) return prompt(s, "Filter", s.filter, { live: "filter" });
  if (k.name === "escape") return [{ ...s, filter: "" }];
  return VIEW_KEYS[s.view](s, k, ch);
}

function helpKey(s, k) {
  const move = moveOf(k);
  if (!move || move === "left" || move === "right") return [{ ...s, help: null }];
  const page = s.size.rows - 2;
  return [{ ...s, help: clamp(s.help + stepBy(move, page), 0, Math.max(0, docLines(HELP, s.size.cols).length - page)) }];
}

const wordStart = (g, at) => {
  let i = at;
  while (i > 0 && g[i - 1] === " ") i--;
  while (i > 0 && g[i - 1] !== " ") i--;
  return i;
};
// Pasted text without control characters; line breaks stay only where the text is sent on with them.
const pasted = (text, multiline) => {
  const t = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[^\P{Cc}\n]|\p{Cf}/gu, "");
  return multiline ? t : t.replace(/\n+/g, " ");
};
// Typing into { value, at }, a prompt or a form's field; its cursor `at` counts graphemes.
function edit(p, k, multiline) {
  const g = graphemes(p.value);
  const { at } = p;
  const to = (parts, cursor) => ({ ...p, value: parts.flat().join(""), at: cursor });
  const ctrl = k.name === "ctrl" ? k.ch : null;
  if (k.name === "char" || k.name === "paste") {
    const add = graphemes(k.name === "char" ? k.ch : pasted(k.text, multiline));
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
  const edited = edit(p, k, p.then.multiline);
  return [{ ...s, prompt: edited, ...(live ? { [live]: edited.value } : {}) }];
}

function submit(s, p) {
  const text = p.value.trim();
  const then = p.then;
  if (then.live || (!text && !then.optional)) return [s];
  // A pin asks for its link, then for a title.
  if (then.pin) return prompt(s, "Its title (optional)", "", { write: "/api/pins", body: { url: text, session: then.pin }, field: "title", optional: true, pending: "Pinning…", done: "Pinned." });
  return write(s, defined({ write: then.write, method: then.method, body: { ...then.body, [then.field]: then.csv ? csv(text) : text }, pending: then.pending, done: then.done }));
}

function askKey(s, k) {
  const fx = k.name === "char" ? s.ask.keys[k.ch.toLowerCase()] : undefined;
  return fx ? write({ ...s, ask: null }, fx) : [{ ...s, ask: null }];
}

// ---- Forms: fields edited in place, Tab or ↑↓ between them, Enter sends. A field is text, a combo (typed, or ←→
// through its choices), a choice (←→) or a toggle (Space).
const field = (key, label, kind, value, extra = {}) => ({ key, label, kind, value, at: graphemes(String(value)).length, ...extra });
const byDefault = (s, key) => `default${s.board?.defaults?.[key] ? ` (${s.board.defaults[key]})` : ""}`;
// Model, effort, permission mode and agent, each empty for the default.
function settingFields(s, v = {}) {
  const choice = (key, label, list) => {
    const choices = ["", ...new Set([...list, ...(v[key] ? [v[key]] : [])])];
    return field(key, label, "choice", v[key] ?? "", { choices, labels: choices.map((x) => x || byDefault(s, key)) });
  };
  return [
    field("model", "Model", "combo", v.model ?? "", { choices: ["", ...MODELS], hint: byDefault(s, "model") }),
    choice("effort", "Effort", EFFORTS),
    choice("permissionMode", "Permissions", MODES),
    field("agent", "Agent", "text", v.agent ?? "", { hint: byDefault(s, "agent") }),
  ];
}
// A new session, as the page's dialog starts one; in a lane, it is tagged with the lane's name.
function newSession(s, cli) {
  const lane = laneOf(s);
  const dirs = [...new Set([s.cwd, ...(s.board?.dirs ?? [])].filter(Boolean))];
  const claudeOnly = [field("worktree", "Worktree", "toggle", false, { hint: "start in a new git worktree" }), field("addDirs", "Extra folders", "text", "", { hint: "comma-separated" }), ...settingFields(s)];
  return {
    ...s,
    form: {
      title: "New session", build: "session", write: "/api/sessions", pending: "Starting…", focus: "prompt",
      fields: [
        field("cli", "Agent", "choice", cli, { choices: ["claude", "codex"], labels: ["Claude Code", "Codex, with your Codex settings"] }),
        field("prompt", "Prompt", "text", "", { multiline: true, hint: "what it should do; optional with a Linear issue" }),
        field("cwd", "Folder", "combo", dirs[0] ?? "", { choices: dirs }),
        field("name", "Name", "text", "", { hint: "optional" }),
        field("tags", "Tags", "text", lane && lane.id !== "ungrouped" ? lane.name : "", { hint: "comma-separated" }),
        field("issue", "Linear issue", "text", "", { hint: "an ID such as EVE-291, or its link" }),
        field("context", "Context", "text", "", { hint: "links, issue IDs or file paths, with spaces between" }),
        ...claudeOnly.map((x) => ({ ...x, claude: true })),
      ],
    },
  };
}
const settingsForm = (s, c) => ({
  ...s,
  form: {
    title: `Settings of ${c.name}`, build: "settings", write: `/api/card/${c.id}/settings`, pending: "Saving the settings…", focus: "model",
    note: c.live ? "Saving restarts the running session to apply them." : "They apply when the session next runs.",
    fields: settingFields(s, c.settings),
  },
});
function outcomeForm(s, c) {
  const outcomes = Object.entries(s.board?.outcomes ?? {});
  const choices = ["", ...outcomes.map(([key]) => key)];
  const labels = [`Automatic${c.outcome.auto ? ` (${c.outcome.label})` : ""}`, ...outcomes.map(([, label]) => label)];
  return {
    ...s,
    form: {
      title: `Status of ${c.name}`, build: "outcome", write: `/api/card/${c.id}/outcome`, method: "PUT", pending: "Saving the status…", done: "Saved.", focus: "outcome",
      note: "Automatic follows its pull requests.",
      fields: [field("outcome", "Status", "choice", c.outcome.auto ? "" : c.outcome.key, { choices, labels })],
    },
  };
}
const words = (v) => String(v ?? "").split(/[\s,]+/).filter(Boolean);
// What each form sends, from its fields' values.
const BUILDERS = {
  session(v) {
    const body = { cli: v.cli, prompt: v.prompt.trim(), cwd: v.cwd.trim(), name: v.name.trim(), tags: csv(v.tags), issue: v.issue.trim(), context: words(v.context) };
    return v.cli === "codex" ? body : { ...body, worktree: v.worktree, addDirs: csv(v.addDirs), ...BUILDERS.settings(v) };
  },
  settings: (v) => ({ model: v.model.trim(), effort: v.effort, permissionMode: v.permissionMode, agent: v.agent.trim() }),
  outcome: (v) => ({ outcome: v.outcome || null }),
};
const valuesOf = (f) => Object.fromEntries(f.fields.map((x) => [x.key, x.value]));
// A Codex session's form leaves out what only Claude Code takes.
const shownFields = (f) => f.fields.filter((x) => !x.claude || valuesOf(f).cli !== "codex");

function formKey(s, k) {
  const f = s.form;
  const fields = shownFields(f);
  const i = Math.max(0, fields.findIndex((x) => x.key === f.focus));
  const x = fields[i];
  const set = (patch) => [{ ...s, form: { ...f, fields: f.fields.map((y) => (y.key === x.key ? { ...y, ...patch } : y)) } }];
  if (k.name === "escape") return [{ ...s, form: null }];
  if (k.name === "enter") return sendForm(s);
  const by = { tab: 1, down: 1, backtab: -1, up: -1 }[k.name];
  if (by) return [{ ...s, form: { ...f, focus: fields[(i + by + fields.length) % fields.length].key } }];
  const space = k.name === "char" && k.ch === " ";
  const turn = { left: -1, right: 1 }[k.name] ?? (space && (x.kind === "choice" || x.kind === "toggle") ? 1 : 0);
  if (x.kind === "toggle") return turn ? set({ value: !x.value }) : [s];
  if (x.kind === "choice" || (x.kind === "combo" && turn)) {
    if (!turn) return [s];
    const value = x.choices[(x.choices.indexOf(x.value) + turn + x.choices.length) % x.choices.length];
    return set({ value, at: graphemes(value).length });
  }
  return set(edit(x, k, x.multiline));
}

function sendForm(s) {
  const f = s.form;
  if (f.sending) return [s];
  const body = BUILDERS[f.build](valuesOf(f));
  const missing = f.build === "session" && (!body.prompt && !body.issue ? "Say what it should do, or give a Linear issue." : !body.cwd ? "Say which folder it runs in." : null);
  if (missing) return [toast(s, missing, "yellow")];
  return write({ ...s, form: { ...f, sending: true } }, defined({ write: f.write, method: f.method, body, pending: f.pending, done: f.done, form: true }));
}

// ---- The keys that act on a session, from the board, the archive, the PRs or its details, where the page allows them
const removeQuestion = (c) =>
  c.agent === "codex"
    ? `Delete ${c.name} and its conversation from Codex? It cannot be brought back.`
    : c.away
      ? `Forget ${c.name}? The board's copy of its conversation goes too, so it can no longer be unarchived.`
      : `Delete ${c.name}? This removes the session, and its worktree when that is safe.`;

function cardKey(s, c, ch) {
  const gate = (action, then) => (c.can?.[action] === true ? then() : [toast(s, typeof c.can?.[action] === "string" ? c.can[action] : "Not for this session.", "yellow")]);
  const act = (action, pending, extra = {}) => ({ write: `/api/card/${c.id}/${action}`, pending, ...extra });
  // A running session is joined in the board's shared terminal for it; one without a process is resumed here.
  if (ch === "a") return c.can?.terminal === true ? [s, [{ relay: `/api/card/${c.id}/term`, label: `${c.name}'s terminal` }]] : gate("open", () => [s, [{ resume: c.id }]]);
  if (ch === "o") return gate("open", () => write(s, act("open", "Opening Terminal…", { done: "Opened in Terminal." })));
  if (ch === "m") return gate("send", () => prompt(s, `Message to ${c.name}`, "", { write: `/api/card/${c.id}/send`, field: "text", multiline: true, pending: "Sending…", done: "Sent." }));
  if (ch === "i") return gate("interrupt", () => confirm(s, `Interrupt ${c.name}?`, act("interrupt", "Interrupting…", { done: "Interrupted." })));
  if (ch === "s") return write(s, act("summarize", "Asking for a summary…", { done: "Summarizing; the card updates when it is done." }));
  if (ch === "R") return gate("rename", () => prompt(s, "Rename to", c.name, { write: `/api/card/${c.id}/rename`, field: "name", pending: "Renaming…", done: "Renamed." }));
  if (ch === "t") return prompt(s, "Tags, comma-separated", (c.tags ?? []).join(", "), { write: `/api/card/${c.id}/tags`, method: "PUT", field: "tags", csv: true, optional: true, pending: "Saving the tags…", done: "Tags saved." });
  if (ch === "e") return gate("settings", () => [settingsForm(s, c)]);
  if (ch === "p") {
    // The sync is a Claude Code skill typed into the session, which lists the updates and asks there before writing.
    const pr = prOf(c);
    if (c.away || c.agent === "codex" || !(c.branch || pr)) return [toast(s, "Syncing a PR is for a Claude Code session on a branch or with a pull request.", "yellow")];
    const text = `/pr-status-sync ${pr}`.trim();
    return gate("send", () => confirm(s, `Run ${text} in ${c.name}? It lists the Linear and Notion updates and asks before writing.`, act("send", "Sending…", { body: { text }, done: `Sent ${text}.` })));
  }
  if (ch === "A") {
    if (!c.archived) return gate("archive", () => confirm(s, `Archive ${c.name}?`, act("archive", "Archiving…", { done: "Archived." })));
    if (c.away) return [toast(s, "Already archived, and out of the agent view.")];
    return gate("archive", () => confirm(s, `Take ${c.name} out of the agent view? It stays in the archive, and u brings it back.`, act("archive", "Taking it out of the agent view…")));
  }
  if (ch === "u") return c.archived ? gate("archive", () => write(s, act("unarchive", "Unarchiving…", { done: "Unarchived." }))) : [toast(s, "It is not archived.")];
  // Codex keeps a thread loaded with no call to unload it, so there is no process to stop or restart.
  if ((ch === "S" || ch === "X") && c.agent === "codex") return [toast(s, "A Codex session has no process of its own to stop or restart.", "yellow")];
  if (ch === "S") {
    const stop = act("stop", "Stopping…");
    return gate("stop", () => (c.column === "working" ? confirm(s, `${c.name} is mid-turn. Stop it anyway?`, stop) : write(s, stop)));
  }
  if (ch === "X") return gate("respawn", () => write(s, act("respawn", "Restarting…")));
  if (ch === "D") return gate("remove", () => confirm(s, removeQuestion(c), act("remove", "Deleting…", { close: true })));
  if (ch === "O") return c.outcome && c.archivedAt ? [outcomeForm(s, c)] : [toast(s, "Only an archived session keeps a status.")];
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
// All, then each lane, round again; a lane that emptied counts as All.
function laneStep(s, by) {
  const ids = [null, ...lanesOf(liveCards(s)).map((l) => l.id)];
  return { ...s, lane: ids[(Math.max(0, ids.indexOf(s.lane)) + by + ids.length) % ids.length] };
}
function listMove(s, view, list, move) {
  const item = list[clamp(list.indexOf(pickIn(list, s.sel[view])) + stepBy(move, 5), 0, list.length - 1)];
  return item ? { ...s, sel: { ...s.sel, [view]: item.id } } : s;
}
// A document under a line of its own (Daily's days, the Journal's tabs), scrolled a line or a page.
function scrolled(s, view, move) {
  const page = s.size.rows - 3;
  const max = Math.max(0, docOf(s, view).length - page);
  return { ...s, scroll: { ...s.scroll, [view]: clamp((s.scroll[view] ?? 0) + stepBy(move, page), 0, max) } };
}
// Which engine writes the repository digest or the Journal's brief: Claude or Codex.
function switchEngine(s, kind, what) {
  const next = (s.board?.engines?.[kind] ?? "codex") === "codex" ? "claude" : "codex";
  return write(s, { write: "/api/settings", method: "PUT", body: { engines: { [kind]: next } }, pending: "Switching…", done: `${AGENT_NAMES[next]} writes ${what} now.` });
}

const VIEW_KEYS = {
  board(s, k, ch) {
    const move = moveOf(k);
    if (move) return [boardMove(s, move)];
    if (ch === "[" || ch === "]") return [laneStep(s, ch === "]" ? 1 : -1)];
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
    if (ch !== "s" && ch !== "a") return [s];
    const c = cardsOf(s).find((x) => workedOn(x, pr));
    if (!c) return [toast(s, "No session on the board worked on it.")];
    return ch === "s" ? [openDetail(s, c.id)] : cardKey(s, c, "a");
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
    if (ch === "E") return switchEngine(s, "daily", "the repository digest");
    if (ch !== "u") return [s];
    const day = shownDay(s);
    const keys = Object.fromEntries(DIGESTS.map(([kind, label]) => [kind[0], { write: `/api/digest/${kind}`, body: { day }, pending: `Asking for the ${label} digest…`, done: `Writing the ${label} digest; it shows here when it is done.` }]));
    return [{ ...s, ask: { text: `Update ${dayName(day, s.now)}: r the repository, n Notion or s Slack digest? Any other key cancels.`, keys } }];
  },
  journal(s, k, ch) {
    const move = moveOf(k);
    if (move === "left" || move === "right") {
      const i = JOURNAL_TABS.findIndex(([t]) => t === s.journalTab) + (move === "left" ? -1 : 1);
      return [{ ...s, journalTab: JOURNAL_TABS[(i + JOURNAL_TABS.length) % JOURNAL_TABS.length][0] }];
    }
    if (ch === "s") return write(s, { write: "/api/journal/summarize", pending: "Asking for a brief…", done: "Writing the brief; it shows on the Brief tab when it is done." });
    if (ch === "E") return switchEngine(s, "brief", "the brief");
    if (s.journalTab === "brief") return [move ? scrolled(s, "journal", move) : s];
    const list = journalPicks(s);
    if (move) return [listMove(s, "journal", list, move)];
    const pick = pickIn(list, s.sel.journal);
    if (s.journalTab === "notes") {
      if (ch === "a") return prompt(s, "New note", "", { write: "/api/journal/notes", field: "text", multiline: true, pending: "Saving the note…", done: "Noted." });
      return pick && ch === "d" ? confirm(s, "Delete this note?", { write: `/api/journal/notes/${pick.id}`, method: "DELETE", pending: "Deleting…", done: "Deleted." }) : [s];
    }
    const [horizon, label] = HORIZONS.find(([h]) => h === pick?.horizon) ?? HORIZONS[0];
    if (ch === "a") return prompt(s, `Add to ${label}`, "", { write: "/api/journal/items", body: { horizon }, field: "text", pending: "Adding…", done: "Added." });
    if (!pick) return [s];
    if (pick.id.startsWith("suggestion:")) {
      if (ch !== "+" && k.name !== "enter") return [s];
      return write(s, { write: "/api/journal/items", body: { text: pick.url ? `${pick.text} ${pick.url}` : pick.text, horizon: pick.horizon, suggestion: pick.index }, pending: "Adding…", done: "Added." });
    }
    const path = `/api/journal/items/${pick.id}`;
    if (k.name === "enter" || ch === "e") return prompt(s, "Edit", pick.text, { write: path, method: "PUT", field: "text", pending: "Saving…", done: "Saved." });
    if (ch === " " || ch === "x") return write(s, { write: path, method: "PUT", body: { done: !pick.done }, pending: pick.done ? "Opening it again…" : "Checking it off…" });
    if (ch === "<" || ch === ">") {
      const to = HORIZONS[HORIZONS.findIndex(([h]) => h === pick.horizon) + (ch === ">" ? 1 : -1)];
      return to ? write(s, { write: path, method: "PUT", body: { horizon: to[0] }, pending: `Moving it to ${to[1]}…` }) : [s];
    }
    if (ch === "d") return confirm(s, `Delete "${cut(clean(pick.text), 40)}"?`, { write: path, method: "DELETE", pending: "Deleting…", done: "Deleted." });
    return [s];
  },
};

// Lines an open session's tab scrolls over: the screen less the header, its title block and footer.
const detailRows = (s) => s.size.rows - 5;
function detailKey(s, k, ch) {
  const d = s.detail;
  if (k.name === "escape" || ch === "q") return [{ ...s, detail: null }];
  const c = detailCard(s);
  const tabs = tabsOf(c);
  const tab = tabOf(s, c);
  const move = moveOf(k);
  if (move === "left" || move === "right" || k.name === "tab" || k.name === "backtab") {
    const i = tabs.findIndex(([t]) => t === tab) + (move === "left" || k.name === "backtab" ? -1 : 1);
    return [{ ...s, detail: { ...d, tab: tabs[(i + tabs.length) % tabs.length][0], scroll: 0, pick: 0, follow: true } }];
  }
  if (!c) return [s];
  if (tab === "context") {
    const list = contextRows(s, c);
    const row = list[d.pick];
    if (move) return [{ ...s, detail: { ...d, pick: clamp(d.pick + stepBy(move, 5), 0, Math.max(0, list.length - 1)) } }];
    if (k.name === "enter") return row?.url ? [s, [{ browse: row.url }]] : [s];
    if (ch === "+") return prompt(s, "Pin a link to this session", "", { pin: c.sessionId });
    if (ch === "x") return row?.pin ? write(s, { write: `/api/pins/${row.pin.id}`, method: "DELETE", pending: "Unpinning…", done: "Unpinned." }) : [toast(s, "Only a pinned link comes off; + pins one.")];
  } else {
    if (move) {
      // The conversation follows new steps until scrolled up, and again once scrolled back to its end.
      const page = detailRows(s);
      const max = Math.max(0, detailBody(s, c, tab).length - page);
      const scroll = clamp((tab === "conversation" && d.follow ? max : Math.min(d.scroll, max)) + stepBy(move, page), 0, max);
      return [{ ...s, detail: { ...d, scroll, follow: scroll >= max } }];
    }
    if (k.name === "enter") return cardKey(s, c, "a");
  }
  return cardKey(s, c, ch);
}

// ---- Drawing: lines of [text, style] spans, each fitted to the width
export function view(s) {
  const height = s.size.rows - 2;
  const body = s.help != null ? docLines(HELP, s.size.cols).slice(s.help) : s.form ? formLines(s, height) : s.detail ? detailLines(s, height) : VIEW_LINES[s.view](s, height);
  return [headerLine(s), ...Array.from({ length: height }, (_, i) => body[i] ?? []), footerLine(s)].map((line) => fit(line, s.size.cols));
}

function headerLine(s) {
  const cards = cardsOf(s).filter((c) => shownAgent(s, c));
  const live = cards.filter((c) => !c.archived);
  const counts = s.board ? { board: live.length, prs: s.board.prs?.open, archived: cards.length - live.length } : {};
  const asks = { board: live.filter((c) => colOf(c) === "needs-input").length, prs: s.board?.prs?.needsYou };
  const tabs = VIEWS.flatMap(([key, label], i) => [
    [` ${i + 1} ${label}${counts[key] == null ? "" : ` ${counts[key]}`} `, key === s.view ? "inverse bold" : ""],
    [asks[key] ? `${asks[key]}!` : "", "bold yellow"],
    [" ", ""],
  ]);
  const right = [
    s.offline && [`board unreachable: ${s.offline}  `, "red"],
    s.agent && [`${MARKS[s.agent][0]} ${AGENT_NAMES[s.agent]} only  `, MARKS[s.agent][1]],
    s.filter && [`filter: ${s.filter}  `, "yellow"],
    !s.offline && (s.board ? [`updated ${dur(s.now - s.board.at)} ago`, "gray"] : ["connecting…", "gray"]),
  ].filter(Boolean);
  return beside(tabs, right, s.size.cols);
}

const HINTS = {
  board: [["↑↓←→", "move"], ["enter", "open"], ["a", "attach"], ["v V", "agent views"], ["c", "Claude/Codex"], ["[ ]", "lanes"], ["n", "new"], ["?", "keys"], ["q", "quit"]],
  prs: [["↑↓", "move"], ["enter", "GitHub"], ["s", "its session"], ["a", "attach"], ["r", "read again"], ["/", "filter"], ["?", "keys"], ["q", "quit"]],
  archived: [["↑↓", "move"], ["enter", "open"], ["u", "unarchive"], ["O", "status"], ["D", "delete"], ["c", "Claude/Codex"], ["?", "keys"], ["q", "quit"]],
  daily: [["←→", "day"], ["↑↓", "scroll"], ["u", "update"], ["E", "engine"], ["?", "keys"], ["q", "quit"]],
  journal: [["←→", "tabs"], ["↑↓", "move"], ["a", "add"], ["enter", "edit"], ["space", "done"], ["< >", "move it"], ["d", "delete"], ["?", "keys"]],
  brief: [["←→", "tabs"], ["↑↓", "scroll"], ["s", "write it"], ["E", "engine"], ["?", "keys"], ["q", "quit"]],
  notes: [["←→", "tabs"], ["↑↓", "move"], ["a", "write one"], ["d", "delete"], ["?", "keys"], ["q", "quit"]],
  detail: [["←→", "tabs"], ["enter", "attach"], ["m", "message"], ["i", "interrupt"], ["s", "summarize"], ["?", "keys"], ["esc", "back"]],
  context: [["←→", "tabs"], ["↑↓", "move"], ["enter", "open link"], ["+", "pin"], ["x", "unpin"], ["?", "keys"], ["esc", "back"]],
  form: [["tab ↑↓", "fields"], ["←→", "choose"], ["space", "toggle"], ["enter", "send"], ["esc", "cancel"]],
  help: [["↑↓", "scroll"], ["any other key", "close"]],
};
function hintsOf(s) {
  if (s.help != null) return "help";
  if (s.form) return "form";
  if (s.detail) return tabOf(s, detailCard(s)) === "context" ? "context" : "detail";
  return s.view === "journal" && s.journalTab !== "todos" ? s.journalTab : s.view;
}
function footerLine(s) {
  if (s.prompt) return promptLine(s.prompt, s.size.cols);
  if (s.ask) return [[s.ask.text, "bold yellow"]];
  if (s.toast && (s.toast.sticky || s.now - s.toast.at < TOAST_MS)) return [[s.toast.text, s.toast.style]];
  return HINTS[hintsOf(s)].flatMap(([key, what]) => [[key, "bold"], [` ${what}   `, "gray"]]);
}

// Text with the cursor drawn as a block; when it is wider than `room`, its start gives way.
function cursorSpans(value, at, room) {
  const g = graphemes(value).map((x) => (x === "\n" ? "↵" : x));
  let start = at;
  let used = 0;
  while (start > 0 && used + width(g[start - 1]) <= room - 2) used += width(g[--start]);
  return [[start ? "…" : "", "gray"], [g.slice(start, at).join(""), ""], [g[at] ?? " ", "inverse"], [g.slice(at + 1).join(""), ""]];
}
function promptLine(p, cols) {
  const label = `${p.label}: `;
  return [[label, "bold"], ...cursorSpans(p.value, p.at, cols - width(label))];
}

function formLines(s, height) {
  const f = s.form;
  const fields = shownFields(f);
  const labelWidth = Math.max(...fields.map((x) => width(x.label))) + 2;
  const room = s.size.cols - labelWidth - 4;
  const value = (x, on) => {
    if (x.kind === "toggle") return [[x.value ? "[x] " : "[ ] ", on ? "bold" : ""], [x.hint ?? "", "gray"]];
    if (x.kind === "choice") {
      const label = x.labels?.[x.choices.indexOf(x.value)] ?? x.value;
      return on ? [["‹ ", "gray"], [label, "bold"], [" ›", "gray"]] : [[label, ""]];
    }
    if (on) return [...cursorSpans(x.value, x.at, room), [x.value ? "" : ` ${x.hint ?? ""}`, "gray"], [x.kind === "combo" ? "  ←→ for others" : "", "gray"]];
    return x.value ? [[x.value.replaceAll("\n", "↵"), ""]] : [[x.hint ?? "", "gray"]];
  };
  const lines = [
    [[` ${f.title}`, "bold"]],
    [],
    ...fields.map((x) => {
      const on = x.key === f.focus;
      return [[on ? "▌" : " ", "yellow"], [` ${x.label}${" ".repeat(labelWidth - width(x.label))}`, on ? "bold" : "gray"], ...value(x, on)];
    }),
    [],
    ...(f.note ? notice(f.note) : []),
  ];
  // A form taller than the screen scrolls to keep the field being typed in on it.
  const at = fields.findIndex((x) => x.key === f.focus) + 2;
  return lines.slice(clamp(at - height + 2, 0, Math.max(0, lines.length - height)));
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
  const concerns = concernsOf(c).length;
  const chips = [
    c.failed && ["failed", "red"],
    c.ending && [ENDINGS[c.ending.kind] ?? c.ending.kind, "red"],
    RESTING[c.column] && [c.column, RESTING[c.column]],
    concerns && !done && [`⚠${concerns}`, "yellow"],
  ].filter(Boolean);
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
  const lanes = lanesOf(liveCards(s));
  const lane = laneOf(s, lanes);
  const summary = lane && s.board.groupSummaries?.[lane.id];
  const top = [
    ...(s.board.error ? notice(s.board.error, "red") : []),
    ...(lanes.length > 1 || lane ? [laneStrip(s, lanes, lane)] : []),
    ...(summary ? notice(summary) : []),
  ];
  const cols = columnsOf(s, lane);
  const at = boardPick(s, cols);
  const room = height - top.length;
  if (!at) return [...top, ...notice(s.filter ? "No session matches the filter; Esc clears it." : s.agent || lane ? "No sessions here; c and [ ] show others." : "No sessions yet; n starts one.")];
  return [...top, ...(s.size.cols >= WIDE ? sideBySide(s, cols, at, room) : listed(s, cols, at, room))];
}
// All, then each lane with its sessions and asks; lanes before the picked one give way when they do not all fit.
function laneStrip(s, lanes, lane) {
  const chip = (l) => {
    const asks = l.cards.filter((c) => colOf(c) === "needs-input").length;
    return [[` ${l.name} ${l.cards.length} `, l === lane || (!lane && !l.id) ? "inverse bold" : ""], [asks ? `${asks}! ` : " ", "bold yellow"]];
  };
  const chips = [{ id: null, name: "All", cards: liveCards(s) }, ...lanes].map(chip);
  const sel = lane ? lanes.indexOf(lane) + 1 : 0;
  let first = 0;
  while (first < sel && spansWidth(chips.slice(first, sel + 1).flat()) + 2 > s.size.cols) first++;
  return [[first ? "‹ " : "  ", "gray"], ...chips.slice(first).flat()];
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
  if (!list.length) return notice(s.filter ? "No archived session matches the filter; Esc clears it." : s.agent ? "Nothing archived here; c shows others." : "Nothing archived yet.");
  const pick = pickIn(list, s.sel.archived);
  const days = Map.groupBy(list, (c) => (c.archivedAt ? dayKey(c.archivedAt) : ""));
  const groups = [...days].map(([key, cards]) => [[[[key ? dayName(key, s.now) : "Date unknown", "bold"]]], cards.map((c) => [archivedRow(s, c, c === pick), c === pick])]);
  return stackGroups(groups, height);
}
// An archived session: when it was archived, its name, what it still holds to and its status, then where it ended.
function archivedRow(s, c, on) {
  const [mark, markStyle] = markOf(c);
  const chips = [
    !c.saved && c.agent !== "codex" && [" not resumable after cleanup", "red"],
    !c.away && [" still in the agent view", "gray"],
    c.outcome && c.outcome.key !== "none" && [` ${c.outcome.label}`, "cyan"],
  ].filter(Boolean);
  return barred([
    spread([[(c.archivedAt ? timeOf(c.archivedAt) : "").padEnd(9), "gray"], [mark, markStyle], [" ", ""], [c.name, "bold"]], chips, s.size.cols - 2),
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
// Markdown as blocks: headings and lines that are wholly bold become subheadings, list items bullets (an indented line
// after one continues it), the rest paragraphs.
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
    const last = blocks.at(-1);
    if (!text) flush();
    else if (!item && !para.length && /^\s/.test(raw) && last?.[0] === "li") last[1] = `${last[1]} ${text}`;
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
  const list = (title, items, style) => (items?.length ? [["h", title], ...items.map((x) => ["li", x, style])] : []);
  const summarized = meta.pending ? "summarizing…" : meta.at ? [`summarized ${dur(s.now - meta.at)} ago`, meta.costUsd && `$${meta.costUsd.toFixed(4)}`, meta.stale && "it has moved on since"].filter(Boolean).join(" · ") : "s asks for a summary";
  const settings = c.background && !c.away && c.agent !== "codex" && c.settings;
  const tags = [...(c.tags ?? []).map((t) => `#${t}`), c.group && `auto group: ${c.group}`].filter(Boolean);
  return [
    ...(needs.length ? [["h", "Needs you", c.waitingSince ? `waiting ${dur(s.now - c.waitingSince)}` : ""], ...needs.map((x) => ["li", x, "yellow"])] : []),
    ...(c.ending ? [["bad", `${ENDINGS[c.ending.kind] ?? c.ending.kind}: ${c.ending.text}`]] : []),
    ...(c.column === "working" && c.detail ? [["h", "Doing now"], ["p", c.detail]] : []),
    ["h", "Where it stands", summarized],
    ...(meta.error ? [["bad", `The last summary failed: ${meta.error}`]] : []),
    c.status ? ["p", c.status] : ["dim", "No summary yet."],
    ...((sum.goal ?? c.goal) ? [["h", "Goal"], ["p", sum.goal ?? c.goal]] : []),
    ...list("Concerns", concernsOf(c), "yellow"),
    ...list("Done", sum.done),
    ...list("Next", sum.next),
    ...(settings
      ? [["h", "Settings", "e changes them"], ["p", [["model", "Model"], ["effort", "Effort"], ["permissionMode", "Permissions"], ["agent", "Agent"]].map(([key, label]) => `${label} ${settings[key] || byDefault(s, key)}`).concat(c.model ? [`last reply from ${c.model}`] : []).join(" · ")]]
      : []),
    ["h", "Tags", "t changes them"],
    tags.length ? ["p", tags.join("  ")] : ["dim", "None."],
    ...(c.away && c.agent !== "codex" ? [["dim", `Out of the agent view: u unarchives it, or by hand: cd ${home(c.cwd)} && claude --resume ${c.sessionId}`]] : []),
    ["h", c.agent === "codex" ? "Codex thread" : "Claude Code session"],
    ["dim", c.sessionId ?? c.id],
  ];
}
// The page's Spec, Progress and Team tabs, from the session's full detail.
function specBlocks(d) {
  return [
    ...(d.result ? [["h", "Result"], ...mdBlocks(capped(d.result))] : []),
    ...(d.plan ? [["h", "Approved plan"], ...mdBlocks(capped(d.plan))] : []),
    ["h", "Markdown written by this session"],
    ...(d.docs?.length ? d.docs.flatMap((doc) => [["sub", home(doc.path)], ...(doc.content == null ? [["dim", "No longer on disk."]] : mdBlocks(capped(doc.content)))]) : [["dim", "None."]]),
    ...(d.links?.length ? [["h", "Artifacts"], ...d.links.map((l) => ["li", `${l.title} (${l.href})`])] : []),
    ["h", "Original ask"],
    ...(d.intent ? mdBlocks(capped(d.intent)) : [["dim", "An interactive session has no recorded ask."]]),
  ];
}
function progressBlocks(d, now) {
  const tasks = d.tasks ?? [];
  return [
    ["h", "Tasks", tasks.length ? `${tasks.filter((t) => t.status === "completed").length} of ${tasks.length} done` : ""],
    ...(tasks.length ? tasks.map((t) => ["li", [t.subject, t.owner].filter(Boolean).join(" · "), t.status === "completed" ? "gray" : "", TASK_MARKS[t.status] ?? "·"]) : [["dim", "No task list."]]),
    ...(d.fan?.length ? [["h", "Sub-agents"], ...d.fan.map((f) => ["li", f.label, f.doneAt ? "gray" : "", f.doneAt ? "✓" : "▸"])] : []),
    ["h", "Timeline"],
    ...(d.timeline?.length
      ? d.timeline.flatMap((e) => [["sub", `${dayName(dayKey(e.at), now)} ${timeOf(e.at)} · ${e.state}`], ...mdBlocks(capped(e.text || e.detail || ""))])
      : [["dim", "No timeline: an interactive session keeps none."]]),
  ];
}
const teamBlocks = (d) =>
  d.team?.length ? d.team.flatMap((m) => [["h", m.name, [m.agentType, m.model].filter(Boolean).join(" · ")], ...mdBlocks(capped(m.prompt ?? ""))]) : [["dim", "No agent team in this session."]];

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
const TAB_BLOCKS = { spec: specBlocks, progress: progressBlocks, team: teamBlocks };
function detailBody(s, c, tab) {
  if (tab === "summary") return docLines(summaryBlocks(s, c), s.size.cols);
  if (tab === "conversation") return conversationLines(s.detail, s.size.cols);
  return s.detail.data ? docLines(TAB_BLOCKS[tab](s.detail.data, s.now), s.size.cols) : notice("Loading…");
}

// What the session did with a link, or that it was pinned.
const roleOf = (s, x) =>
  x.pin
    ? `pinned ${dur(s.now - Date.parse(x.pin.at))} ago`
    : [x.produced && `wrote it ${x.produced}×`, x.used && `read it ${x.used}×`, x.linked && "you linked it", x.lastAt && `last ${dur(s.now - Date.parse(x.lastAt))} ago`].filter(Boolean).join(" · ");
function contextLines(s, c, pick, height) {
  const list = contextRows(s, c);
  if (!list.length) return notice("Nothing yet: the Linear, Notion and Slack pages, pull requests and artifacts it touches show here, and + pins one.");
  const items = list.map((x, i) => barred([
    [[x.pin ? "Pinned " : "", "cyan"], [KINDS[x.kind] ?? "Link", "gray"], [" ", ""], [x.id ?? "", "bold"], [x.untitled || !x.title ? "" : `  ${x.title}`, ""], [x.status ? `  ${x.status}` : "", "cyan"]],
    [[roleOf(s, x), "gray"]],
    [[x.url ?? "", "gray"]],
  ], i === pick ? "yellow" : null));
  return stack(items, pick, height);
}

function detailLines(s, height) {
  const d = s.detail;
  const c = detailCard(s);
  if (!c) return notice("Loading…");
  const tab = tabOf(s, c);
  const [mark, markStyle] = markOf(c);
  const [, label, color] = COLS.find(([key]) => key === colOf(c));
  const where = c.archived ? ["archived", "gray"] : RESTING[c.column] ? [c.column, RESTING[c.column]] : [label, color];
  const at = c.updatedAt ?? c.startedAt;
  const head = [
    spread([[` ${mark}`, markStyle], [" ", ""], [c.name, "bold"], ["  ", ""], where], [[`${c.id} `, "gray"]], s.size.cols),
    [[` ${[home(c.cwd), c.branch, c.model, c.tokens && `${tokens(c.tokens)} tokens`, at && `active ${dur(s.now - at)} ago`].filter(Boolean).join(" · ")}`, "gray"]],
    [[" ", ""], ...tabsOf(c).flatMap(([t, name]) => [[` ${name} `, t === tab ? "inverse bold" : "gray"], [" ", ""]])],
  ];
  const room = height - head.length;
  if (tab === "context") return [...head, ...contextLines(s, c, d.pick, room)];
  const body = detailBody(s, c, tab);
  const max = Math.max(0, body.length - room);
  const top = tab === "conversation" && d.follow ? max : Math.min(d.scroll, max);
  return [...head, ...body.slice(top, top + room)];
}

const engineOf = (x) => (x.engine === "codex" ? `Codex ${x.model}` : x.model ? `Claude ${x.model} · $${(x.costUsd ?? 0).toFixed(2)}` : "");
function dailyBlocks(s, day) {
  const g = s.digest;
  if (!g) return [];
  return DIGESTS.flatMap(([kind, label]) => {
    const d = g.days[day]?.[kind];
    const run = g.running?.[kind];
    const state = run
      ? run.day === day ? `updating… ${dur(s.now - run.startedAt)}` : `busy with ${dayName(run.day, s.now)}`
      : d?.at ? [`written ${dur(s.now - d.at)} ago`, d.seconds && `${d.seconds}s`, engineOf(d)].filter(Boolean).join(" · ") : "";
    const failedLast = d?.error && !(d.at > d.errorAt);
    const item = (it) => ["li", [it.text, it.prs?.length ? it.prs.map((n) => `#${n}`).join(" ") : "", it.where].filter(Boolean).join(" · ")];
    const merged = d?.prs?.length
      ? [["sub", `${d.prs.length} pull request${d.prs.length === 1 ? "" : "s"} merged`], ...d.prs.toReversed().map((p) => ["li", `#${p.number} ${p.title} · ${p.author} · +${p.additions} −${p.deletions}`, "gray"])]
      : [];
    return [
      ["h", kind === "repo" ? `${label} ${g.repo}` : label, state],
      ...(failedLast ? [["bad", `The last update failed ${dur(s.now - d.errorAt)} ago: ${d.error}`]] : []),
      ...(d?.at
        ? [["b", d.headline], ...d.sections.flatMap((sec) => [["sub", sec.title], ...sec.items.map(item)]), ...merged, ...(d.gaps?.length ? [["dim", `Not reached: ${d.gaps.join("; ")}`]] : [])]
        : [["dim", "No digest for this day yet; u writes one."]]),
    ];
  });
}
// Codex's own MCP settings have Linear and Notion but no Slack.
const briefSources = (engine) => (engine === "codex" ? "Linear and Notion" : "Linear, Slack and Notion");
function briefBlocks(s) {
  const j = s.journal;
  if (!j) return [];
  const sum = j.summary;
  const state = sum?.at ? [`written ${dur(s.now - sum.at)} ago`, sum.seconds && `${sum.seconds}s`, engineOf(sum)].filter(Boolean).join(" · ") : "";
  const failedLast = sum?.error && !(sum.at > sum.errorAt);
  return [
    ["h", "State of things", state],
    ...(failedLast ? [["bad", `The last brief failed ${dur(s.now - sum.errorAt)} ago: ${sum.error}`]] : []),
    ...(sum?.text
      ? [...(sum.headline ? [["b", sum.headline]] : []), ...mdBlocks(sum.text)]
      : [["dim", `No brief yet; s writes one from the board, your to-dos and notes, and what changed in ${briefSources(s.board?.engines?.brief ?? "codex")}.`]]),
    ...(sum?.suggestions?.length ? [["h", "Suggested to-dos", "the To-dos tab adds them"], ...sum.suggestions.map((x) => ["li", [x.text, x.why].filter(Boolean).join(" — ")])] : []),
    ...(sum?.gaps?.length ? [["dim", `Not reached: ${sum.gaps.join("; ")}`]] : []),
  ];
}
const docOf = (s, view) => docLines(view === "daily" ? dailyBlocks(s, shownDay(s)) : briefBlocks(s), s.size.cols);

function dailyLines(s, height) {
  if (!s.digest) return notice("Loading…");
  const day = shownDay(s);
  const days = digestDays(s);
  const engine = AGENT_NAMES[s.board?.engines?.daily ?? "codex"];
  const nav = beside(
    [[days.at(-1) === day ? "   " : " ← ", "gray"], [dayName(day, s.now), "bold"], [`  ${day}`, "gray"], [days[0] === day ? "" : "  →", "gray"]],
    [[`repository digest on ${engine}, E switches · yesterday's are written after ${s.digest.autoHour}:00 `, "gray"]],
    s.size.cols,
  );
  const doc = docOf(s, "daily");
  const top = Math.min(s.scroll.daily ?? 0, Math.max(0, doc.length - height + 1));
  return [nav, ...doc.slice(top, top + height - 1)];
}

function todoLines(s, it, on) {
  const carried = !it.done && it.horizon === "today" && it.createdAt < dayStart(s.now);
  const since = carried ? `  since ${new Date(it.createdAt).toLocaleDateString(undefined, { weekday: "short" })}` : "";
  return barred([
    ...clip(it.text, s.size.cols - 6 - width(since), 3).map((l, i) => [[i ? "  " : it.done ? "✓ " : "○ ", it.done ? "green" : "gray"], [l, it.done ? "gray" : ""], [i ? "" : since, "gray"]]),
    ...(it.context?.length ? [[["  ", ""], [it.context.map((x) => [x.label, x.status].filter(Boolean).join(" · ")).join("   "), "gray"]]] : []),
  ], on ? "yellow" : null);
}
const suggestionLines = (s, x, on) => barred([
  ...clip(x.text, s.size.cols - 6, 2).map((l, i) => [[i ? "  " : "+ ", "cyan"], [l, ""]]),
  ...(x.why ? [[["  ", ""], [x.why, "gray"]]] : []),
], on ? "yellow" : null);
const noteLines = (s, n, on) => barred([
  [[n.createdAt ? timeOf(n.createdAt) : "", "gray"]],
  ...clip(tidy(n.text), s.size.cols - 4, 8).map((l) => [[l, ""]]),
], on ? "yellow" : null);
function journalLines(s, height) {
  if (!s.journal) return notice("Loading…");
  const run = s.journal.running;
  const state = run
    ? [`writing the brief on ${AGENT_NAMES[run.engine] ?? "Claude"}… ${dur(s.now - run.startedAt)} `, "yellow"]
    : [`brief on ${AGENT_NAMES[s.board?.engines?.brief ?? "codex"]}: s writes it, E switches `, "gray"];
  const tabs = beside([[" ", ""], ...JOURNAL_TABS.flatMap(([t, name]) => [[` ${name} `, t === s.journalTab ? "inverse bold" : "gray"], [" ", ""]])], [state], s.size.cols);
  const room = height - 1;
  if (s.journalTab === "brief") {
    const doc = docOf(s, "journal");
    const top = Math.min(s.scroll.journal ?? 0, Math.max(0, doc.length - room));
    return [tabs, ...doc.slice(top, top + room)];
  }
  const pick = pickIn(journalPicks(s), s.sel.journal);
  const on = (x) => x.id === pick?.id;
  if (s.journalTab === "notes") {
    const notes = notesOf(s);
    if (!notes.length) return [tabs, ...notice(s.filter ? "No note matches the filter; Esc clears it." : "No notes yet; a writes one.")];
    const days = Map.groupBy(notes, (n) => (n.createdAt ? dayKey(n.createdAt) : ""));
    return [tabs, ...stackGroups([...days].map(([key, list]) => [[[[key ? dayName(key, s.now) : "Date unknown", "bold"]]], list.map((n) => [noteLines(s, n, on(n)), on(n)])]), room)];
  }
  const groups = todosOf(s).map((g) => [
    [heading(g.label, "", `${g.done}/${g.items.length} done${g.earlier ? ` · ${g.earlier} done earlier` : ""}`), ...(g.items.length ? [] : notice("Nothing here; a adds one."))],
    g.items.map((it) => [todoLines(s, it, on(it)), on(it)]),
  ]);
  const suggestions = suggestionsOf(s);
  const suggested = suggestions.length ? [[[heading("Suggested by the brief", "", "Enter adds one")], suggestions.map((x) => [suggestionLines(s, x, on(x)), on(x)])]] : [];
  return [tabs, ...stackGroups([...groups, ...suggested], room)];
}

const VIEW_LINES = { board: boardLines, prs: prsLines, archived: archivedLines, daily: dailyLines, journal: journalLines };

const HELP = [
  ["h", "Everywhere"],
  ["li", "1 to 5, or Tab, switch views; arrows or h j k l move, g and G go to the ends, PgUp and PgDn page"],
  ["li", "v opens Claude Code's agent view and V Codex's, in this terminal; Ctrl+\\ or Ctrl+Z there comes back to the board"],
  ["li", "c shows every session, then Claude's only, then Codex's only"],
  ["li", "n starts a Claude session and N a Codex one; / filters (Esc clears it); r reads everything again; Ctrl+Z suspends; q quits"],
  ["h", "Board"],
  ["li", "[ and ] go through the lanes, the groups the page puts sessions in; Enter opens a session"],
  ["h", "A session, on the board, in the archive or open"],
  ["li", "a attaches: the session takes this terminal until Ctrl+\\, and one that is not running is resumed here instead"],
  ["li", "m message, i interrupt, s summarize, R rename, t tags, e settings, p sync its PR, o open in a Terminal window"],
  ["li", "A archive, u unarchive, S stop, X restart, D delete; archived, A takes it out of the agent view and O sets its status"],
  ["li", "Open: ← and → switch tabs; on Context, Enter opens a link, + pins one and x unpins it; Esc goes back"],
  ["h", "PRs, Daily and Journal"],
  ["li", "PRs: Enter opens it on GitHub, s opens the session that worked on it, a attaches to that session, r reads GitHub again"],
  ["li", "Daily: ← and → change the day, u updates one of its digests, E switches the repository digest between Claude and Codex"],
  ["li", "Journal: ← and → switch To-dos, Brief and Notes; a adds, Enter edits, Space checks off, < and > move to another horizon, d deletes, Enter on a suggestion adds it; s writes the brief, E switches its engine"],
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
  let away = false; // another program has the terminal
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
    } else if (fx.write) {
      const method = fx.method ?? "POST";
      const res = await call(fx.write, { method, headers: WRITE_HEADERS, ...(method === "DELETE" ? {} : { body: JSON.stringify(fx.body ?? {}) }) }).catch(failure);
      dispatch({ type: "posted", fx, ok: res.ok, res: res.body });
    } else if (fx.relay) await hand(fx);
    else if (fx.resume) await resume(fx.resume);
    else if (fx.browse) execFile("open", [fx.browse], () => {});
    else if (fx.suspend) suspend();
    else if (fx.quit) quit();
  }

  // One of the board's shared terminals takes this one until the key back to the board, or until its program exits.
  async function hand({ relay: path, label }) {
    away = true;
    input.off("data", onData);
    const r = await relay({ url, path, input, output, size: screen.size() });
    screen.leave();
    screen.enter();
    input.on("data", onData);
    away = false;
    const note = { exit: `${label} closed.`, error: r.message, lost: `The connection to ${label} closed${r.message ? `: ${r.message}` : "."}` }[r.why];
    dispatch({ type: "returned", note });
    if (r.rest) onData(r.rest);
  }

  // A session without a process is resumed in this terminal; the board steps aside until it exits.
  async function resume(id) {
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
