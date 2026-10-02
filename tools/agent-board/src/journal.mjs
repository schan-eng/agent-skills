// The Journal tab: to-dos by horizon, notes, and a brief of where things stand, enriched from Linear, Slack and Notion.
// Kept at the top of the data folder, like tags, since it is the person's own data rather than a cache.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { callCodex } from "./codex.mjs";
import { cleanEnv, jsonStore } from "./summarize.mjs";

const HORIZONS = ["today", "week", "later"];
const ITEM_MAX = 2000;
const NOTE_MAX = 10_000;
const TIMEOUT_MS = 6 * 60_000;
const HTTP_RE = /^https?:\/\/\S+$/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// The read-only tools a Codex brief may call, keyed by server name in the Codex config; its other servers are switched off.
const CODEX_TOOLS = { linear: ["get_issue", "list_issues", "list_comments"], notion: ["notion-fetch", "notion-search"] };
// Read-only lookups only; dontAsk denies anything else without asking.
const TOOLS = [
  "mcp__plugin_linear_linear__get_issue",
  "mcp__plugin_linear_linear__list_issues",
  "mcp__plugin_linear_linear__list_comments",
  "mcp__plugin_Notion_notion__notion-fetch",
  "mcp__plugin_Notion_notion__notion-search",
  "mcp__plugin_slack_slack__slack_search_public_and_private",
  "mcp__plugin_slack_slack__slack_read_thread",
  "mcp__plugin_slack_slack__slack_read_user_profile",
];

const SYSTEM = `You write the user's personal status brief for the Journal tab of their agent board. They read it to see where things stand and to plan the day and the week.

The input gives the time, their to-dos by horizon (Today, This week, Later) with ids, their recent notes, and their Claude Code sessions from the board.

Gather context with the read-only Linear, Slack and Notion tools, at most 15 tool calls in all:
- Linear: issues assigned to the user and updated in the last 7 days, and any issue ID named in the to-dos or notes.
- Slack: messages from the last 2 days that mention the user or were sent to them, and threads linked in the to-dos or notes. Paraphrase; never quote a Slack message. Link its permalink.
- Notion: pages linked in the to-dos or notes. Read only the part that matters.
When a source's tools are missing or fail, skip it and name it in gaps.

Write:
- headline: one sentence, the most useful thing to know right now.
- summary: Markdown under 250 words in plain English, with the sections "Now" (what the sessions are doing and what waits on the user), "Goals" (progress on today's and this week's to-dos), "Around you" (what changed in Linear, Slack and Notion that concerns them) and "Next" (one to three things to do next). Name tickets, pull requests and people. State only what you saw.
- items: for each to-do where you found something relevant, up to 3 context entries: a label under 80 characters, the url, and a status such as "In Review" or "merged". Leave out to-dos with nothing found.
- suggestions: up to 5 new to-dos the user does not have yet, each grounded in something you found, such as a review request, a question to answer, or a ticket assigned to them. Give each a horizon, one line on why, and its url.
- gaps: the sources you could not reach.`;

const CONTEXT = { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string" }, url: { type: "string" }, status: { type: "string" } } };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "items", "suggestions", "gaps"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "context"], properties: { id: { type: "string" }, context: { type: "array", items: CONTEXT } } } },
    suggestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "horizon"], properties: { text: { type: "string" }, horizon: { enum: HORIZONS }, why: { type: "string" }, url: { type: "string" } } } },
    gaps: { type: "array", items: { type: "string" } },
  },
};

const clean = (s, max) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null);
const link = (u) => (typeof u === "string" && HTTP_RE.test(u) ? u : undefined);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
// Weeks start on Monday.
const startOfWeek = (d) => startOfDay(d) - ((d.getDay() + 6) % 7) * 86_400_000;

function inputOf({ items, notes }, cards, now) {
  const dayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const todo = (it) => `- [${it.done ? "x" : " "}] (${it.id}) ${it.text}${it.done ? ` (done ${new Date(it.doneAt).toLocaleString()})` : ""}`;
  const group = (h, since) => items.filter((it) => it.horizon === h && (!it.done || it.doneAt >= since)).map(todo).join("\n") || "(none)";
  const refs = (c) => [...new Set((c.context ?? []).filter((s) => s.kind === "linear-issue" || s.kind === "pr" || s.kind === "notion").map((s) => s.id))].slice(0, 6).join(", ");
  const session = (c) => {
    const needs = [c.blocker, ...(c.summary?.needsYou ?? [])].filter(Boolean);
    return `- ${c.name}${c.group ? ` [${c.group}]` : ""}: ${c.column}${needs.length ? `, needs the user: ${needs.join("; ")}` : ""}. ${c.status ?? c.goal ?? ""}${refs(c) ? ` (refs: ${refs(c)})` : ""}`;
  };
  const recent = notes.filter((n) => n.createdAt >= now.getTime() - 7 * 86_400_000).slice(0, 30);
  return [
    `Now: ${now.toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
    `\nTo-dos, Today:\n${group("today", dayStart)}`,
    `\nTo-dos, This week:\n${group("week", weekStart)}`,
    `\nTo-dos, Later:\n${group("later", Infinity)}`,
    `\nNotes from the last 7 days, newest first:\n${recent.map((n) => `- ${new Date(n.createdAt).toLocaleString()}: ${n.text.slice(0, 600)}`).join("\n") || "(none)"}`,
    `\nSessions on the board:\n${cards.filter((c) => !c.archived).slice(0, 40).map(session).join("\n") || "(none)"}`,
  ].join("\n");
}

// One `claude -p` call that may use only the read-only MCP tools named, resolving { output, costUsd } or { error }.
export function runClaude(input, { system, schema, tools, cwd, model, effort, budgetUsd, timeoutMs }) {
  const args = [
    "-p", "--model", model, "--effort", effort,
    "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--append-system-prompt", system,
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
    ...(tools.length ? ["--tools", "ToolSearch", "--allowedTools", ["ToolSearch", ...tools].join(",")] : ["--tools", ""]),
    "--max-budget-usd", String(budgetUsd),
  ];
  // With the claude.ai connectors on, a headless run drops the Linear and Notion plugin servers as their duplicates and
  // the connectors as the plugins' duplicates, leaving neither; with them off, the plugins load.
  const env = { ...cleanEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: String(e.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return resolve({ error: code === null ? `Timed out after ${Math.round(timeoutMs / 60_000)} minutes.` : `claude -p exited ${code}: ${(err || out).replace(ANSI_RE, "").trim().slice(0, 300)}` });
      }
      if (res.is_error || !res.structured_output) return resolve({ error: String(res.result ?? res.subtype ?? "no structured output").slice(0, 300), costUsd: res.total_cost_usd ?? 0 });
      resolve({ output: res.structured_output, costUsd: res.total_cost_usd ?? 0 });
    });
    child.stdin.end(input);
  });
}

export function createJournal({ file, model, effort, budgetUsd, engine, codexModel, runDir }) {
  const store = jsonStore(file);
  let state = { items: [], notes: [], summary: null };
  let running = null;
  const save = (next) => ((state = next), store.save(state));
  const item = (id) => state.items.find((it) => it.id === id);

  return {
    ready: store.load().then((v) => {
      state = { items: Array.isArray(v.items) ? v.items : [], notes: Array.isArray(v.notes) ? v.notes : [], summary: v.summary ?? null };
    }),
    get: () => ({ ...state, running }),

    async addItem(body) {
      const text = clean(body?.text, ITEM_MAX);
      if (!text || !HORIZONS.includes(body.horizon)) return null;
      const now = Date.now();
      const it = { id: randomUUID(), text, horizon: body.horizon, done: false, doneAt: null, createdAt: now, updatedAt: now, context: [] };
      // Adding a suggested to-do takes it off the suggestion list.
      const summary = Number.isInteger(body.suggestion) && state.summary?.suggestions
        ? { ...state.summary, suggestions: state.summary.suggestions.filter((_, i) => i !== body.suggestion) }
        : state.summary;
      await save({ ...state, items: [...state.items, it], summary });
      return it;
    },
    async updateItem(id, body) {
      const it = item(id);
      if (!it || !body) return null;
      const text = body.text === undefined ? it.text : clean(body.text, ITEM_MAX);
      const horizon = body.horizon === undefined ? it.horizon : body.horizon;
      if (!text || !HORIZONS.includes(horizon)) return null;
      const done = body.done === undefined ? it.done : body.done === true;
      const next = { ...it, text, horizon, done, doneAt: done ? (it.done ? it.doneAt : Date.now()) : null, updatedAt: Date.now() };
      await save({ ...state, items: state.items.map((x) => (x.id === id ? next : x)) });
      return next;
    },
    async removeItem(id) {
      if (!item(id)) return false;
      await save({ ...state, items: state.items.filter((x) => x.id !== id) });
      return true;
    },
    async addNote(body) {
      const text = clean(body?.text, NOTE_MAX);
      if (!text) return null;
      const note = { id: randomUUID(), text, createdAt: Date.now() };
      await save({ ...state, notes: [note, ...state.notes] });
      return note;
    },
    async removeNote(id) {
      if (!state.notes.some((n) => n.id === id)) return false;
      await save({ ...state, notes: state.notes.filter((n) => n.id !== id) });
      return true;
    },

    // Starts a brief unless one is running; the page polls for the result.
    summarize({ cwd, cards }) {
      if (running) return false;
      const now = new Date();
      const eng = engine();
      running = { startedAt: now.getTime(), engine: eng };
      const input = inputOf(state, cards, now);
      const call = eng === "codex"
        ? callCodex(`${SYSTEM}\n\n${input}`, { cwd: runDir, env: cleanEnv(), model: codexModel, effort, schema: SCHEMA, timeoutMs: TIMEOUT_MS, allow: CODEX_TOOLS })
        : runClaude(input, { system: SYSTEM, schema: SCHEMA, tools: TOOLS, cwd, model, effort, budgetUsd, timeoutMs: TIMEOUT_MS });
      call
        .then(async (r) => {
          const at = Date.now();
          const seconds = Math.round((at - now.getTime()) / 1000);
          console.log(`journal brief ${eng} ${r.error ? `FAILED ${r.error}` : "ok"} $${(r.costUsd ?? 0).toFixed(4)} ${seconds}s`);
          if (r.error) return save({ ...state, summary: { ...state.summary, error: r.error, errorAt: at } });
          const o = r.output;
          const found = new Map(o.items.map((x) => [x.id, x.context.slice(0, 3).map((c) => ({ label: c.label.slice(0, 120), url: link(c.url), status: clean(c.status, 40) ?? undefined }))]));
          const summary = {
            headline: clean(o.headline, 300),
            text: clean(o.summary, 6000),
            suggestions: o.suggestions.slice(0, 5).map((s) => ({ text: s.text.slice(0, ITEM_MAX), horizon: s.horizon, why: clean(s.why, 300) ?? undefined, url: link(s.url) })),
            gaps: o.gaps.map((g) => g.slice(0, 200)),
            at, seconds, costUsd: r.costUsd, engine: eng, model: eng === "codex" ? codexModel : model,
          };
          await save({ ...state, summary, items: state.items.map((it) => ({ ...it, context: found.get(it.id) ?? [] })) });
        })
        .finally(() => (running = null));
      return true;
    },
  };
}
