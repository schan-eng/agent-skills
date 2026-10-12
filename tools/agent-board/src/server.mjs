#!/usr/bin/env node
// Kanban board over `claude agents`: one card per session, columns by job state.
// Reads ~/.claude/{jobs,teams,tasks,projects} read-only. Binds to 127.0.0.1 only.
import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { collect, extract, resultText, sourceOfUrl, sourcesInText, touchesContext } from "./context.mjs";
import { readSteps, textOf, typed } from "./conversation.mjs";
import { agentView, attach, codexResume, codexView, sleep } from "./pty.mjs";
import { codexShort, createCodexAgents } from "./codex-agents.mjs";
import { createDigests, validDay } from "./digest.mjs";
import { createJournal } from "./journal.mjs";
import { CACHE, DATA, RUN_DIR } from "./paths.mjs";
import { createPrs } from "./prs.mjs";
import { accept, refuse } from "./ws.mjs";
import { cleanEnv, createGrouper, createRunner, createSummarizer, jsonStore } from "./summarize.mjs";

const HOME = homedir();
const CLAUDE = join(HOME, ".claude");
const PORT = Number(process.env.AGENT_BOARD_PORT ?? 4747);
const HERE = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR_RE = /\/\.claude\/projects\/[^/]+\/memory\//;
const TURNS_KEPT = 6;
// Built-in commands that configure the session rather than ask for work.
const LOCAL_COMMANDS = new Set([
  "add-dir", "agents", "bashes", "clear", "color", "compact", "config", "context", "cost", "doctor", "effort", "exit",
  "export", "fast", "feedback", "help", "hooks", "ide", "init", "login", "logout", "mcp", "memory", "model", "output-style",
  "permissions", "plugin", "reload-plugins", "rename", "resume", "status", "statusline", "terminal-setup", "theme", "todos", "usage", "vim",
]);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const TICKET_RE = /\b[a-z]{2,6}-\d{2,6}\b/gi;
// Archiving deletes the session from `claude agents` and keeps a record (archive.json) to show and restore it
// from. A session that cannot be deleted safely stays listed, marked by this name prefix.
const ARCHIVED_PREFIX = "[archived] ";
// `claude agents` reports status "waiting" while a permission prompt or question is on screen.
const WAITING = "It is waiting on a permission prompt or a question; answer it in the Terminal tab.";
// Session options the board can set, kept as `--flag value` pairs in the job's respawnFlags.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// "default" is not in `claude --help`, but Claude writes it into respawnFlags itself.
const MODES = ["default", "manual", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"];
const SETTINGS = [
  ["model", "--model", (v) => /^[a-z0-9][\w.:[\]-]{0,79}$/i.test(v)],
  ["effort", "--effort", (v) => EFFORTS.includes(v)],
  ["permissionMode", "--permission-mode", (v) => MODES.includes(v)],
  ["agent", "--agent", (v) => /^\w[\w:.-]{0,79}$/.test(v)],
];

// Which engine each kind of model call runs on, switched from the page. Codex runs on the ChatGPT plan.
const ENGINES = ["claude", "codex"];
const settingsStore = jsonStore(join(DATA, "settings.json"));
let settings = { engines: { cards: "claude", brief: "codex", daily: "codex" } };
const CODEX_MODEL = process.env.AGENT_BOARD_CODEX_MODEL ?? "gpt-6-astra";
const runner = createRunner({
  runDir: RUN_DIR,
  engine: () => settings.engines.cards,
  codexModel: CODEX_MODEL,
  enabled: process.env.AGENT_BOARD_SUMMARIZE !== "0",
  model: process.env.AGENT_BOARD_MODEL ?? "sonnet",
  effort: process.env.AGENT_BOARD_EFFORT ?? "medium",
  budgetUsd: Number(process.env.AGENT_BOARD_BUDGET_USD ?? 0.25),
});
const summarizer = createSummarizer({ store: jsonStore(join(CACHE, "summaries.json")), runner });
const grouper = createGrouper({ store: jsonStore(join(CACHE, "groups.json")), runner });
// A brief reads Linear, Slack and Notion with tools, so it gets its own model call and a larger budget than a card.
const journal = createJournal({
  file: join(DATA, "journal.json"),
  model: process.env.AGENT_BOARD_JOURNAL_MODEL ?? "sonnet",
  effort: process.env.AGENT_BOARD_JOURNAL_EFFORT ?? "medium",
  budgetUsd: Number(process.env.AGENT_BOARD_JOURNAL_BUDGET_USD ?? 1.5),
  engine: () => settings.engines.brief,
  codexModel: CODEX_MODEL,
  runDir: RUN_DIR,
});
// The Daily tab's repository digest runs on the `daily` engine; Notion's and Slack's on Claude, whose plugins they read.
const digests = createDigests({
  file: join(CACHE, "digests.json"),
  repo: process.env.AGENT_BOARD_DIGEST_REPO ?? "UsableMachines/mono",
  engine: () => settings.engines.daily,
  model: process.env.AGENT_BOARD_DIGEST_MODEL ?? "sonnet",
  effort: process.env.AGENT_BOARD_DIGEST_EFFORT ?? "medium",
  budgetUsd: Number(process.env.AGENT_BOARD_DIGEST_BUDGET_USD ?? 1.5),
  codexModel: CODEX_MODEL,
  runDir: RUN_DIR,
  toolsDir: () => toolsDir(),
  autoHour: Number(process.env.AGENT_BOARD_DIGEST_HOUR ?? 7),
});
const prs = createPrs();
// Keeps the known engines from a saved file, so a bad or partial one leaves the defaults.
const enginesOf = (next, prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, ENGINES.includes(next?.[k]) ? next[k] : v]));
// Tags are the user's own data, so they live at the top of the data folder rather than in the disposable cache.
const tagStore = jsonStore(join(DATA, "tags.json"));
let tags = {};
const archiveStore = jsonStore(join(DATA, "archive.json"));
let archive = {}; // sessionId -> { short, sessionId, cwd, name, topic, outcome?, archivedAt, job: its state.json when archived }
// Codex keeps an archived thread itself; the board keeps what it knew when archiving: threadId -> { topic, archivedAt, outcome? }.
const codexArchiveStore = jsonStore(join(DATA, "codex-archive.json"));
let codexArchive = {};

// How an archived session ended. A person can set one; otherwise it follows the pull requests the session opened or updated.
const OUTCOMES = { none: "No status", done: "Done", merged: "PR merged", open: "PR open", closed: "PR closed", abandoned: "Abandoned", superseded: "Superseded" };
// Pull request states from `gh`: merged and closed are final, and anything else is checked again after a while.
const ghStore = jsonStore(join(CACHE, "gh-states.json"));
let ghStates = {}; // lookup key -> { value: { id, state } | null, at }
const ghLoading = new Set();
const GH_RECHECK_MS = 15 * 60_000;
function ghLookup(key, args, cwd, parse) {
  const known = ghStates[key];
  const final = ["MERGED", "CLOSED"].includes(known?.value?.state);
  if ((!known || (!final && Date.now() - known.at > GH_RECHECK_MS)) && !ghLoading.has(key) && ghLoading.size < 3) {
    ghLoading.add(key);
    execFile("gh", args, { cwd, timeout: 20_000 }, (err, out) => {
      ghLoading.delete(key);
      let value = null;
      try {
        value = err ? null : parse(JSON.parse(out));
      } catch {}
      ghStates = { ...ghStates, [key]: { value, at: Date.now() } };
      ghStore.save(ghStates);
    });
  }
  return known?.value ?? null;
}
const PR_ID_RE = /^[\w.-]+\/[\w.-]+#\d+$/;
const prOfUrl = (v) => ({ id: v.url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)?.slice(1).join("#") ?? `#${v.number}`, state: v.state ?? null });
const prState = (id) => (PR_ID_RE.test(id) ? ghLookup(`pr:${id}`, ["pr", "view", id.split("#")[1], "--repo", id.split("#")[0], "--json", "number,state,url"], undefined, prOfUrl) : null);
// The pull request for the branch a session worked on: its recorded worktree branch, or the branch its own worktree has
// checked out. A session in the main checkout is skipped, since that checkout's branch is not its own.
function branchPr(record) {
  const branch = record?.job?.worktreeBranch;
  const cwd = record?.cwd;
  if (!cwd || (!branch && !cwd.includes("/.claude/worktrees/"))) return null;
  return branch
    ? ghLookup(`branch:${cwd}@${branch}`, ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,url"], cwd, (v) => (v[0] ? prOfUrl(v[0]) : null))
    : ghLookup(`head:${cwd}`, ["pr", "view", "--json", "number,state,url"], cwd, prOfUrl);
}
function outcomeOf(record, context) {
  if (OUTCOMES[record?.outcome]) return { key: record.outcome, label: OUTCOMES[record.outcome], auto: false };
  const made = context.filter((s) => s.kind === "pr" && s.produced).map((s) => ({ id: s.id, state: prState(s.id)?.state ?? s.status?.toUpperCase() ?? null }));
  const prs = [...new Map([...made, branchPr(record)].filter((p) => p?.state).map((p) => [p.id, p])).values()];
  const states = prs.map((p) => p.state);
  const key = states.includes("OPEN") ? "open" : states.includes("MERGED") ? "merged" : states.length ? "closed" : "none";
  return { key, label: OUTCOMES[key], auto: true, detail: prs.map((p) => `${p.id} ${p.state.toLowerCase()}`).join(", ") };
}
// Pins are links the person attached to a group or a session: { id, at, source, group: { id, name, sessionIds } | null, session }.
const pinStore = jsonStore(join(DATA, "context.json"));
let pins = [];
// Detected context a person removed from a group's Specification list, as { id, at, group, key: "kind:id" }.
let hides = [];
// The logging hook appends each Notion, Linear, Slack and Artifact call here with its full result.
const CONTEXT_LOG = join(DATA, "context-log.jsonl");

const readJson = async (p) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
};

const worktreeOf = (cwd) => cwd?.match(/\/\.claude\/worktrees\/([^/]+)/)?.[1] ?? null;
const ticketsOf = (...texts) => [...new Set(texts.filter(Boolean).flatMap((t) => t.match(TICKET_RE) ?? []).map((t) => t.toUpperCase()))];
// Trimmed, at most 40 chars, at most 8, deduped case-insensitively keeping the first spelling.
const cleanTags = (v) => {
  if (!Array.isArray(v)) return null;
  const seen = new Map();
  for (const t of v) {
    const tag = typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
    if (tag && tag.length <= 40 && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  return [...seen.values()].slice(0, 8);
};

async function setTags(sessionId, next) {
  const { [sessionId]: _, ...others } = tags;
  tags = next.length ? { ...others, [sessionId]: next } : others;
  await tagStore.save(tags);
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

const cli = (args, { cwd, timeout = 30_000 } = {}) =>
  new Promise((resolve) => {
    execFile("claude", args, { cwd, timeout, env: cleanEnv(), maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stripAnsi(`${stdout}${stderr}`).trim() });
    });
  });

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

// A .command file handed to `open` needs no Automation permission; AppleScript blocks on a macOS consent prompt.
async function openTerminal(short, command) {
  const file = join(RUN_DIR, `open-${short}.command`);
  await fs.writeFile(file, `#!/bin/zsh -l\n${command}\n`);
  await fs.chmod(file, 0o700);
  return new Promise((resolve) =>
    execFile("open", ["-a", "Terminal", file], { timeout: 15_000 }, (err, out, errOut) => resolve({ ok: !err, out: `${errOut}${out}`.trim() || "Opened in Terminal." })),
  );
}

const clip = (s, n) =>
  !s || s.length <= n ? s : `${s.slice(0, Math.floor(n * 0.7))}\n…[${s.length - n} chars cut]…\n${s.slice(-Math.floor(n * 0.3))}`;

const listAgents = () =>
  new Promise((resolve) => {
    execFile("claude", ["agents", "--json", "--all"], { timeout: 15000, maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve({ error: String(err.message ?? err), agents: [] });
      try {
        resolve({ agents: JSON.parse(out).filter((a) => !a.cwd?.startsWith(RUN_DIR)) });
      } catch (e) {
        resolve({ error: `unparseable claude agents output: ${e.message}`, agents: [] });
      }
    });
  });

// A busy process is working whatever the records say. An idle one reports its last turn through the
// job's state.json, since `claude agents` keeps saying "working" after a local command such as /rename.
// An interrupt leaves state.json at "working"; the transcript's end of the last turn says it is over.
const column = (a, job, end) => {
  if (a.status === "busy") return "working";
  if (a.status === "waiting") return "needs-input";
  if (a.state === "stopped") return "stopped";
  const s = (job?.state ?? a.state ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (s === "working") return end?.kind === "interrupted" ? "done" : "working";
  if (s === "blocked" || s === "needsinput") return "needs-input";
  if (s === "done") return "done";
  if (s === "failed" || s === "stopped") return "stopped";
  return "interactive";
};

// Each value is true, or the reason the action is unavailable; the server re-checks before acting.
const ALL_ACTIONS = ["send", "interrupt", "terminal", "settings", "rename", "archive", "open", "stop", "respawn", "remove"];
const only = (allowed, why) => Object.fromEntries(ALL_ACTIONS.map((k) => [k, allowed.includes(k) || why]));

function capabilities(a, job) {
  if (a.away) return only(["archive", "remove"], "Archived and out of the agent view; unarchive it to continue.");
  if (a.kind !== "background") return only([], "This session is open in a terminal; use that terminal.");
  const live = Boolean(a.pid);
  // Passive watchers (e.g. an artifact watch) are drainable; real tasks would die with the process.
  const inFlight = live ? Math.max(0, (job?.inFlight?.tasks ?? 0) - (job?.inFlight?.drainableMonitors ?? 0)) + (job?.inFlight?.queued ?? 0) : 0;
  // Renaming, changing settings, archiving, and restarting all stop the process first.
  const midTurn = a.status === "busy" || a.status === "waiting";
  const restart = midTurn
    ? "The session is mid-turn; wait until it finishes."
    : inFlight
      ? `${inFlight} background task${inFlight > 1 ? "s are" : " is"} still running; stopping now would kill ${inFlight > 1 ? "them" : "it"}.`
      : true;
  return {
    // A running session is typed into; a stopped one is resumed with the message.
    send: a.status === "waiting" ? WAITING : true,
    interrupt: midTurn || "Nothing to interrupt: the session is not mid-turn.",
    terminal: live || "Not running. Send a message or Restart to start it.",
    settings: live ? restart : true,
    rename: live ? restart : true,
    archive: restart,
    open: true,
    stop: live ? true : "Not running.",
    respawn: restart,
    remove: a.status === "busy" ? "The session is mid-turn; stop it first." : true,
  };
}

const settingsOf = (flags = []) =>
  Object.fromEntries(SETTINGS.map(([key, flag]) => [key, flags.includes(flag) ? flags[flags.indexOf(flag) + 1] ?? "" : ""]));

// Empty or missing values mean "use the default"; anything else must pass its check.
function parseSettings(body) {
  const values = {};
  for (const [key, , ok] of SETTINGS) {
    const v = typeof body[key] === "string" ? body[key].trim() : "";
    if (v && !ok(v)) return { error: `Unsupported ${key}: ${v}` };
    values[key] = v;
  }
  return { values };
}

const settingFlags = (values) => SETTINGS.flatMap(([key, flag]) => (values[key] ? [flag, values[key]] : []));
const withSettings = (flags, values) => {
  const owned = new Set(SETTINGS.map(([, flag]) => flag));
  const kept = flags.filter((f, i) => !owned.has(f) && !owned.has(flags[i - 1]));
  return [...kept, ...settingFlags(values)];
};

const projectDir = (cwd) => join(CLAUDE, "projects", cwd.replace(/[/.]/g, "-"));
const transcriptPath = (a, job) => job?.linkScanPath ?? join(projectDir(job?.worktreePath ?? a.cwd), `${a.sessionId}.jsonl`);
// Claude Code deletes conversations idle past `cleanupPeriodDays` (30 by default), so the board keeps its own copy
// of each archived one; a session out of the agent view is read from that copy.
const SAVED_DIR = join(DATA, "archive");
const savedConversation = (sessionId) => join(SAVED_DIR, sessionId, "conversation.jsonl");
const conversationPath = (a, job) => (a.away ? savedConversation(a.sessionId) : transcriptPath(a, job));
const exists = (p) => fs.access(p).then(() => true, () => false);

// A prompt asks for work: typed by a person, and not a command that only configures the session.
function promptText(rec) {
  const t = typed(rec);
  return t && !LOCAL_COMMANDS.has(t.command) ? t.text : null;
}

// Claude Code's own records (an API error, the placeholder a local command leaves) are not the session's words.
const replyText = (rec) =>
  rec.type === "assistant" && !rec.isSidechain && rec.message?.model !== "<synthetic>"
    ? (rec.message?.content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim()
    : "";

// Where a record leaves its turn: ended on a message (null), unfinished, interrupted, or on an API error;
// undefined when the record says nothing about it.
const UNFINISHED = { kind: "unfinished" };
function endOf(rec) {
  if (rec.isSidechain) return undefined;
  const c = rec.message?.content;
  if (rec.type === "assistant") {
    if (rec.isApiErrorMessage) return { kind: "error", text: textOf(c).replace(/^API Error:\s*/, "") };
    if (rec.message?.model === "<synthetic>") return undefined;
    const last = (c ?? []).filter((p) => (p?.type === "text" && p.text.trim()) || p?.type === "tool_use" || p?.type === "thinking").at(-1);
    return last && (last.type === "text" ? null : UNFINISHED);
  }
  if (Array.isArray(c) && c.some((p) => p?.type === "tool_result")) return UNFINISHED;
  return textOf(c).startsWith("[Request interrupted") ? { kind: "interrupted" } : undefined;
}

// Building means changing code, or checking, committing, or shipping it; everything else a session does
// (reading, searching, writing notes or scratch scripts) is research.
const DOC_RE = /\.(md|mdx|txt)$/i;
const SCRATCH_RE = /^(\/private)?\/tmp\/|\/\.claude\/(jobs|projects|research)\//;
const BUILD_CMD_RE =
  /\b(git\s+(commit|push|rebase|merge|cherry-pick)|gh\s+(pr\s+(create|merge|edit|ready)|stack)|(yarn|npm|pnpm)\b[^|;&\n]*\s(test|build|typecheck|lint|format)\b|vitest|pytest|tsc|oxlint|oxfmt|prisma\s+(migrate|generate|db\s+push)|turbo|node\s+--check|cargo\s+(build|test|check)|go\s+(build|test|vet)|docker\s+(buildx?|compose\s+build))\b/;
function builds({ name, input = {} }) {
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
    const fp = String(input.file_path ?? input.notebook_path ?? "");
    return !DOC_RE.test(fp) && !SCRATCH_RE.test(fp);
  }
  if (name === "Bash") return BUILD_CMD_RE.test(String(input.command ?? ""));
  if (name === "Agent" || name === "Task") return /implement|mechanic|\bfix|\bbuild/i.test(`${input.subagent_type ?? ""} ${input.description ?? ""}`);
  return false;
}
// The latest turn that used a tool decides, so a fresh prompt does not flip a building session before it acts.
const phaseOf = (turns) => (turns.findLast((t) => t.tools)?.build ? "build" : "research");

// Transcript scan is cached by size so polling a finished session costs a stat.
const scanCache = new Map();
async function scanTranscript(path) {
  let size;
  try {
    size = (await fs.stat(path)).size;
  } catch {
    return { size: 0, docs: [], plan: null, turns: [], model: null, events: [], learned: [] };
  }
  const hit = scanCache.get(path);
  if (hit?.size === size) return hit.value;
  const docs = new Map();
  let plan = null;
  let model = null;
  const turns = [];
  // Outside context as events ({ id, at, sources }), from context tool calls once their results arrive and from links in prompts.
  const events = [];
  const learned = [];
  const pending = new Map();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"subtype":"away_summary"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // A recap is Claude Code's own one-line account of where the session stands, written while it sits idle.
    if (rec.subtype === "away_summary") {
      if (turns.length && typeof rec.content === "string") turns.at(-1).recap = { text: rec.content.replace(/\s*\(disable recaps in \/config\)\s*$/, ""), at: rec.timestamp ?? null };
      continue;
    }
    const prompt = promptText(rec);
    if (prompt) {
      turns.push({ prompt, promptAt: rec.timestamp ?? null, reply: null, replyAt: null, end: UNFINISHED, recap: null, tools: 0, build: false });
      if (turns.length > TURNS_KEPT) turns.shift();
      const linked = sourcesInText(prompt);
      if (linked.length) events.push({ id: rec.uuid, at: rec.timestamp ?? null, sources: linked });
      continue;
    }
    if (rec.type === "assistant" && rec.message?.model && rec.message.model !== "<synthetic>") model = rec.message.model;
    const reply = replyText(rec);
    if (reply && turns.length) Object.assign(turns.at(-1), { reply, replyAt: rec.timestamp ?? null });
    const end = endOf(rec);
    if (end !== undefined && turns.length) turns.at(-1).end = end;
    for (const part of rec?.message?.content ?? []) {
      const use = part?.type === "tool_result" && pending.get(part.tool_use_id);
      if (use) {
        pending.delete(use.id);
        const r = part.is_error ? null : extract(use.name, use.input, resultText(part.content));
        if (r?.sources.length) events.push({ id: use.id, at: rec.timestamp ?? null, sources: r.sources });
        if (r?.learned) learned.push(r.learned);
        continue;
      }
      if (part?.type !== "tool_use") continue;
      if (touchesContext(part)) pending.set(part.id, part);
      const turn = !rec.isSidechain && turns.at(-1);
      if (turn) Object.assign(turn, { tools: turn.tools + 1, build: turn.build || builds(part) });
      const fp = part.input?.file_path;
      if ((part.name === "Write" || part.name === "Edit") && typeof fp === "string" && fp.endsWith(".md") && !MEMORY_DIR_RE.test(fp)) {
        docs.set(fp, rec.timestamp ?? null);
      }
      if (part.name === "ExitPlanMode" && typeof part.input?.plan === "string") plan = part.input.plan;
    }
  }
  const value = { size, docs: [...docs].map(([path, at]) => ({ path, at })).reverse(), plan, turns, model, events, learned };
  scanCache.set(path, { size, value });
  return value;
}

async function readTasks(short) {
  const dir = join(CLAUDE, "tasks", `session-${short}`);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks = await Promise.all(names.map((n) => readJson(join(dir, n))));
  return tasks.filter(Boolean).map((t) => ({
    subject: t.subject ?? t.title ?? t.content ?? "(untitled)",
    status: t.status ?? "pending",
    owner: t.owner ?? null,
  }));
}

async function readTeam(short) {
  const cfg = await readJson(join(CLAUDE, "teams", `session-${short}`, "config.json"));
  return (cfg?.members ?? [])
    .filter((m) => m.agentType !== "team-lead")
    .map((m) => ({ name: m.name, agentType: m.agentType, model: m.model ?? null, prompt: m.prompt ?? "" }));
}

async function readTimeline(short) {
  try {
    const lines = (await fs.readFile(join(CLAUDE, "jobs", short, "timeline.jsonl"), "utf8")).trim().split("\n");
    return lines
      .slice(-40)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

async function gather(a) {
  const short = a.id ?? a.sessionId.slice(0, 8);
  const job = a.away ? archive[a.sessionId].job : await readJson(join(CLAUDE, "jobs", short, "state.json"));
  const [tasks, team, scan] = await Promise.all([readTasks(short), readTeam(short), scanTranscript(conversationPath(a, job))]);
  // `fan` also lists the session's shell commands; only agents belong on the card.
  const fan = (job?.fan ?? []).filter((f) => f.kind === "agent");
  const fullName = job?.name ?? a.name ?? short;
  const prefixed = fullName.startsWith(ARCHIVED_PREFIX);
  const name = prefixed ? fullName.slice(ARCHIVED_PREFIX.length) : fullName;
  const archived = prefixed || Boolean(archive[a.sessionId]);
  const saved = archive[a.sessionId] ? await exists(savedConversation(a.sessionId)) : null;
  const col = column(a, job, scan.turns.at(-1)?.end);
  const g = { a, short, job, fan, tasks, team, scan, col, name, archived, saved, ending: endingOf(a, col, scan.turns.at(-1)) };
  return { ...g, input: scan.turns.length ? summaryInput(g) : null };
}

// Why a turn that is not running ended early, read from the transcript so it is stated, not guessed.
function endingOf(a, col, turn) {
  const end = turn?.end;
  if (col === "working" || a.status === "waiting" || !end) return null;
  if (end.kind === "error") return { kind: "error", text: `Stopped on an error: ${end.text}` };
  if (end.kind === "interrupted") return { kind: "interrupted", text: "Interrupted before it finished its reply." };
  // `unfinished` covers a turn stopped before its first record as well as one stopped mid-step.
  return a.pid ? null : { kind: "cut-off", text: "Cut off mid-step: its process ended before the turn finished." };
}

const endLine = ({ a, col, ending }) =>
  col === "working"
    ? "It is still working on this turn."
    : a.status === "waiting"
      ? "It is paused on a permission prompt until the reader approves or denies a step."
      : ending?.text ?? (col === "stopped" ? "Its process was stopped after it ended its turn." : "It ended its turn normally, with the final message below.");

// A recap counts only when nothing the session said came after it.
const recapOf = (turn) => (turn?.recap && (!turn.replyAt || turn.recap.at >= turn.replyAt) ? turn.recap.text : null);

function summaryInput(g) {
  const { a, job, fan, tasks, scan, col, name } = g;
  const lines = [
    `Session: ${name}`,
    `State: ${col}`,
    `How the latest turn ended: ${endLine(g)}`,
    `Directory: ${job?.worktreePath ?? a.cwd}${job?.worktreeBranch ? ` (branch ${job.worktreeBranch})` : ""}`,
  ];
  if (col === "working" && job?.detail) lines.push(`The session's live status line: ${clip(job.detail, 300)}`);
  if (job?.intent) lines.push("", "Original ask:", clip(job.intent, 800));
  lines.push("", "Recent user prompts, oldest first:", ...scan.turns.map((t, i) => `${i + 1}. ${clip(t.prompt, 1000)}`));
  const replies = scan.turns.filter((t) => t.reply).slice(-2);
  if (replies.length) {
    lines.push("", "Assistant's final message of each recent turn, oldest first:");
    for (const t of replies) lines.push(`--- reply to: ${clip(t.prompt, 120)}`, clip(t.reply, 3000));
  }
  if (tasks.length) lines.push("", "Task list:", ...tasks.map((t) => `- [${t.status}] ${t.subject}`));
  if (fan.length) lines.push("", "Sub-agents:", ...fan.map((f) => `- ${f.doneAt || col !== "working" ? "finished" : "running"}: ${f.label}`));
  const recap = recapOf(scan.turns.at(-1));
  if (recap) lines.push("", "The session's own recap, written after its latest message:", clip(recap, 600));
  return lines.join("\n");
}

const requestSummary = (g, force = false) => {
  if (g.input) summarizer.request(g.a.sessionId, { working: g.col === "working", input: g.input, force });
};

// Context two or more sessions touched is named for each, with whether it wrote or read it, so groups follow hand-offs.
function groupRequest(cards) {
  const touched = cards.flatMap((c) => c.context.map((s) => s.key)).reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
  const shares = (c) =>
    c.context
      .filter((s) => touched.get(s.key) > 1)
      .toSorted((x, y) => touched.get(y.key) - touched.get(x.key) || x.key.localeCompare(y.key))
      .slice(0, 6)
      .map((s) => `${s.produced ? "wrote" : "read"} "${s.kind === "linear-issue" ? `${s.id} ` : ""}${s.title ?? s.id}"`);
  return cards
    .filter((c) => c.goal || c.intent)
    .map((c) => {
      const worktree = worktreeOf(c.cwd);
      return {
        id: c.id,
        name: c.name,
        goal: c.goal,
        ask: c.intent && c.intent !== c.goal ? c.intent.slice(0, 200) : null,
        worktree,
        tickets: ticketsOf(c.name, c.branch, worktree, c.goal, c.intent?.slice(0, 300)),
        tags: c.tags,
        shares: shares(c),
      };
    })
    .sort((x, y) => x.id.localeCompare(y.id));
}

// The hook's events by session, read as the log grows.
const logged = { offset: 0, bySession: new Map() };
async function readContextLog() {
  let size;
  try {
    size = (await fs.stat(CONTEXT_LOG)).size;
  } catch {
    return;
  }
  if (size < logged.offset) Object.assign(logged, { offset: 0, bySession: new Map() });
  if (size === logged.offset) return;
  const fh = await fs.open(CONTEXT_LOG);
  try {
    const buf = Buffer.alloc(size - logged.offset);
    await fh.read(buf, 0, buf.length, logged.offset);
    const end = buf.lastIndexOf(10) + 1;
    logged.offset += end;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof e?.sessionId !== "string" || !Array.isArray(e.sources)) continue;
      if (!logged.bySession.has(e.sessionId)) logged.bySession.set(e.sessionId, []);
      logged.bySession.get(e.sessionId).push({ id: e.toolUseId ?? null, at: e.at ?? null, sources: e.sources, learned: e.learned ?? null });
    }
  } finally {
    await fh.close();
  }
}

// A session's sources. The hook's copy of a call replaces the transcript's, since it has the full result; logged
// calls the transcript lacks are added, and unnamed ones only when the transcript has none.
function collected(sessionId, scanned) {
  const logs = logged.bySession.get(sessionId) ?? [];
  const byId = new Map(logs.filter((e) => e.id).map((e) => [e.id, e]));
  const seen = new Set(scanned.map((e) => e.id));
  const events = [...scanned.map((e) => byId.get(e.id) ?? e), ...logs.filter((e) => (e.id ? !seen.has(e.id) : !seen.size))];
  return collect(events.toSorted((x, y) => String(x.at).localeCompare(String(y.at))));
}
const sourcesOf = (sessionId, scanned) =>
  collected(sessionId, scanned).map((s) => describe(fill(s))).toSorted((x, y) => String(y.lastAt).localeCompare(String(x.lastAt)));

// What each source is best known by across sessions: one session's call names what another only linked, and the
// newest status seen anywhere is the current one.
let known = new Map();
function knownOf(lists) {
  const m = new Map();
  for (const s of lists.flat()) {
    const b = m.get(s.key) ?? {};
    const newer = s.statusAt && !(b.statusAt > s.statusAt);
    m.set(s.key, { title: b.title ?? s.title, url: b.url ?? s.url, status: newer ? s.status : b.status, statusAt: newer ? s.statusAt : b.statusAt });
  }
  return m;
}
function fill(s) {
  const k = known.get(s.key ?? `${s.kind}:${s.id}`);
  if (!k) return s;
  const newer = k.statusAt && !(s.statusAt >= k.statusAt);
  return { ...s, title: s.title ?? k.title, url: s.url ?? k.url, ...(newer ? { status: k.status, statusAt: k.statusAt } : {}) };
}

// Channel names, and the most common Slack domain and Linear workspace, from every session's results.
let facts = { channels: {}, slackDomain: null, linearWorkspace: null };
function factsOf(gathered) {
  const all = [...gathered.flatMap((g) => g.scan.learned), ...[...logged.bySession.values()].flat().map((e) => e.learned)].filter(Boolean);
  const top = (key) => [...all.reduce((m, l) => (l[key] ? m.set(l[key], (m.get(l[key]) ?? 0) + 1) : m), new Map())].toSorted((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  return { channels: Object.assign({}, ...all.map((l) => l.channels)), slackDomain: top("slackDomain"), linearWorkspace: top("linearWorkspace") };
}

// Fills in the link a source's own calls did not carry, and a stand-in title marked `untitled`.
function describe(s) {
  if (s.kind === "slack-thread" || s.kind === "slack-channel") {
    const [ch, ts] = s.id.split("/");
    const where = /^[DUW]/.test(ch) ? "Slack DM" : facts.channels[ch] ? `#${facts.channels[ch]}` : "Slack channel";
    const day = ts ? new Date(Number(ts) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
    const url = s.url ?? (facts.slackDomain ? `https://${facts.slackDomain}.slack.com/archives/${ch}${ts ? `/p${ts.replace(".", "")}` : ""}` : null);
    return { ...s, title: s.title ?? (day ? `${where} thread, ${day}` : where), url, untitled: !s.title };
  }
  const url = s.url ?? (s.kind === "notion" ? `https://www.notion.so/${s.id}` : s.kind === "linear-issue" && facts.linearWorkspace ? `https://linear.app/${facts.linearWorkspace}/issue/${s.id}` : null);
  const untitled = { notion: "Notion page", artifact: `Artifact ${s.id.slice(0, 6)}`, pr: s.id.split("/").pop(), link: url && new URL(url).hostname };
  return { ...s, title: s.title ?? untitled[s.kind] ?? s.id, url, untitled: !s.title };
}

const groupOf = (g) => typeof g?.id === "string" && g.id
  ? { id: g.id.slice(0, 80), name: String(g.name ?? g.id).slice(0, 80), sessionIds: (Array.isArray(g.sessionIds) ? g.sessionIds : []).filter((x) => /^[0-9a-f]{8}$/.test(x)).slice(0, 100) }
  : null;

function hideOf(body) {
  const group = groupOf(body?.group);
  const key = typeof body?.key === "string" && /^[a-z-]+:[^\n]{1,400}$/.test(body.key) ? body.key : null;
  return group && key ? { id: randomUUID(), at: new Date().toISOString(), group, key } : null;
}

// A Linear issue given by its ID becomes its link, once some session has shown the workspace's name.
const ISSUE_RE = /^[A-Za-z]+-\d+$/;
const issueLink = (id) => (facts.linearWorkspace ? `https://linear.app/${facts.linearWorkspace}/issue/${id.toUpperCase()}` : null);

function pinOf(body) {
  const raw = typeof body?.url === "string" ? body.url.trim() : "";
  const link = ISSUE_RE.test(raw) ? issueLink(raw) ?? "" : raw;
  if (!/^https?:\/\/\S+$/.test(link) || link.length > 2000) return null;
  const group = groupOf(body.group);
  const session = typeof body.session === "string" && /^[0-9a-f-]{36}$/.test(body.session) ? body.session : null;
  if (!group === !session) return null;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 160) : undefined;
  const source = sourceOfUrl(link, "pinned") ?? { kind: "link", id: link, role: "pinned", url: link };
  return { id: randomUUID(), at: new Date().toISOString(), group, session, source: { ...source, title } };
}

function toCard({ a, short, job, fan, tasks, team, scan, col, input, name, archived, saved, ending }) {
  const last = scan.turns.at(-1);
  const waiting = a.status === "waiting";
  // A reply only counts as the session's standing word once the turn has ended.
  const finalReply = col === "working" || waiting ? null : last?.reply ?? null;
  const { summary, ...summaryMeta } = summarizer.get(a.sessionId, input);
  const context = sourcesOf(a.sessionId, scan.events);
  return {
    id: short,
    agent: "claude",
    name,
    archived,
    away: Boolean(a.away),
    sessionId: a.sessionId,
    column: col,
    state: a.state ?? job?.state ?? a.status ?? null,
    detail: job?.detail ?? null,
    intent: job?.intent ?? null,
    result: job?.output?.result ?? null,
    tokens: job?.tokens ?? null,
    cwd: job?.worktreePath ?? a.cwd,
    branch: job?.worktreeBranch ?? null,
    startedAt: a.startedAt ?? (job?.createdAt ? Date.parse(job.createdAt) : null),
    updatedAt: job?.updatedAt ? Date.parse(job.updatedAt) : last?.replyAt ? Date.parse(last.replyAt) : null,
    links: (job?.children ?? []).filter((c) => c.href).map((c) => ({ title: c.title ?? c.id, href: c.href })),
    // A finished job's fan keeps doneAt=0, so only a working session has running agents.
    agents: { running: col === "working" ? fan.filter((f) => !f.doneAt).length : 0, total: fan.length },
    team: team.map(({ name }) => ({ name })),
    progress: tasks.length ? { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length } : null,
    goal: summary?.goal ?? clip(last?.prompt, 160) ?? null,
    status: summary?.status ?? ending?.text ?? recapOf(last),
    phase: phaseOf(scan.turns),
    ending,
    summary,
    summaryMeta,
    blocker: waiting ? WAITING : finalReply?.match(/^needs input:\s*(.+)$/im)?.[1] ?? (col === "needs-input" ? job?.detail ?? null : null),
    failed: finalReply?.match(/^failed:\s*(.+)$/im)?.[1] ?? null,
    waitingSince: finalReply && last.replyAt ? Date.parse(last.replyAt) : null,
    tags: tags[a.sessionId] ?? [],
    // An archived session keeps the topic it had when archived, since the grouper only groups live ones.
    group: archive[a.sessionId]?.topic ?? grouper.get(short),
    live: Boolean(a.pid),
    background: a.kind === "background",
    model: scan.model,
    waiting,
    settings: settingsOf(job?.respawnFlags),
    archivedAt: archive[a.sessionId]?.archivedAt ?? null,
    saved,
    can: capabilities(a, job),
    context,
    outcome: archived ? outcomeOf(archive[a.sessionId], context) : null,
  };
}

// An archived session deleted from `claude agents` is still shown, from its record.
const awayAgent = (r) => ({ id: r.short, sessionId: r.sessionId, kind: "background", cwd: r.cwd, name: r.name, state: r.job?.state ?? null, away: true });

// What a session gets when a setting is left at default, for the settings forms.
const defaultSettings = async () => {
  const s = (await readJson(join(CLAUDE, "settings.json"))) ?? {};
  return { model: s.model ?? "", effort: s.effortLevel ?? "", permissionMode: s.permissions?.defaultMode ?? "", agent: s.agent ?? "" };
};

// Codex sessions: threads on Codex's shared daemon, shown beside Claude's sessions with the same card fields.
const codex = createCodexAgents();
const CODEX_ELSEWHERE = "Codex manages this itself: use the Terminal tab or `codex agents`.";
const CODEX_ARCHIVED = "Archived in Codex; unarchive it to continue.";
const CODEX_STATES = { notLoaded: "not loaded", idle: "idle", active: "working", systemError: "error" };
const trimmed = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function codexSummaryInput(t, f) {
  const ended = f.column === "working"
    ? "It is still working on this turn."
    : f.waiting
      ? "It is paused until the reader approves a step or answers a question."
      : f.column === "stopped"
        ? "Codex reported a system error."
        : "It ended its turn normally, with the final message below.";
  const lines = [
    `Session: ${t.name ?? trimmed(t.preview, 80)} (a Codex session)`,
    `State: ${f.column}`,
    `How the latest turn ended: ${ended}`,
    `Directory: ${t.cwd}${t.gitInfo?.branch ? ` (branch ${t.gitInfo.branch})` : ""}`,
    "",
    "Recent user prompts, oldest first:",
    ...f.prompts.slice(-8).map((p, i) => `${i + 1}. ${clip(p, 1000)}`),
  ];
  const replies = f.replies.slice(-2);
  if (replies.length) lines.push("", "Assistant's final message of each recent turn, oldest first:", ...replies.map((r) => clip(r, 3000)));
  return lines.join("\n");
}

const codexInput = (t, f) => (f.prompts.length ? codexSummaryInput(t, f) : null);

// As for a Claude session, each value is true or why the action is unavailable. The daemon has no call that unloads a
// thread, so there is nothing to stop or restart, and settings change only as a turn starts.
function codexCapabilities(t, f) {
  if (t.archived) return only(["archive", "remove"], CODEX_ARCHIVED);
  const mid = f.column === "working" || f.waiting;
  const idle = mid ? "Codex is mid-turn; interrupt it or wait until it finishes." : true;
  return {
    ...only(["rename", "open", "terminal"], CODEX_ELSEWHERE),
    send: f.waiting ? f.blocker : true,
    interrupt: mid || "Nothing to interrupt: Codex is not mid-turn.",
    archive: idle,
    remove: idle,
  };
}

function codexCard(t, f, input) {
  const short = codexShort(t.id);
  const { summary, ...summaryMeta } = summarizer.get(t.id, input);
  const record = codexArchive[t.id];
  return {
    id: short,
    agent: "codex",
    name: t.name ?? trimmed(t.preview?.split("\n")[0], 80) ?? short,
    archived: t.archived,
    // Out of `codex agents` too, as an archived Claude session is out of the agent view.
    away: t.archived,
    sessionId: t.id,
    column: f.column,
    state: f.waiting ? "waiting" : CODEX_STATES[t.status?.type] ?? null,
    detail: null,
    intent: null,
    result: null,
    tokens: null,
    cwd: t.cwd,
    branch: t.gitInfo?.branch ?? null,
    startedAt: t.createdAt * 1000,
    updatedAt: t.updatedAt * 1000,
    links: [],
    agents: { running: 0, total: 0 },
    team: [],
    progress: null,
    goal: summary?.goal ?? trimmed(f.prompts.at(-1), 160) ?? null,
    status: summary?.status ?? trimmed(f.replies.at(-1), 300) ?? null,
    phase: f.phase,
    ending: f.column === "stopped" ? { kind: "error", text: "Codex reported a system error." } : null,
    summary,
    summaryMeta,
    blocker: f.blocker,
    failed: null,
    waitingSince: null,
    tags: tags[t.id] ?? [],
    group: record?.topic ?? grouper.get(short),
    live: t.status?.type === "active" || t.status?.type === "idle",
    background: true,
    model: t.model ?? null,
    waiting: f.waiting,
    settings: {},
    // Archiving leaves the thread's updatedAt alone, so a thread archived outside the board shows its last change.
    archivedAt: t.archived ? record?.archivedAt ?? t.updatedAt * 1000 : null,
    saved: null,
    can: codexCapabilities(t, f),
    context: [],
    outcome: t.archived ? outcomeOf({ ...record, cwd: t.cwd }, []) : null,
  };
}

async function codexCards() {
  const { threads, error } = await codex.threads();
  const cards = await Promise.all(
    threads.map(async (t) => {
      const f = await codex.facts(t);
      const input = codexInput(t, f);
      if (input) summarizer.request(t.id, { working: f.column === "working", input });
      return codexCard(t, f, input);
    }),
  );
  return { cards, error };
}

async function board() {
  const [{ agents, error }, , codexed] = await Promise.all([listAgents(), readContextLog(), codexCards()]);
  const codexIds = new Set(codexed.cards.map((c) => c.id));
  // A terminal connection outliving its session's process would show the agent view instead.
  for (const short of views.keys()) if (short !== AGENT_VIEW && short !== CODEX_VIEW && !codexIds.has(short) && !error && !agents.some((a) => (a.id ?? a.sessionId.slice(0, 8)) === short && a.pid)) closeView(short);
  const listed = new Set(agents.map((a) => a.sessionId));
  const away = Object.values(archive).filter((r) => !listed.has(r.sessionId)).map(awayAgent);
  const gathered = await Promise.all([...agents, ...away].map(gather));
  facts = factsOf(gathered);
  known = knownOf(gathered.map((g) => collected(g.a.sessionId, g.scan.events)));
  // An archived session's conversation no longer changes, so its card is written once; it is left out of grouping.
  for (const g of gathered) requestSummary(g);
  const cards = [...gathered.map(toCard), ...codexed.cards].sort((x, y) => (y.updatedAt ?? y.startedAt ?? 0) - (x.updatedAt ?? x.startedAt ?? 0));
  grouper.request(groupRequest(cards.filter((c) => !c.archived)));
  const dirCounts = gathered.map((g) => g.job?.cwd ?? g.a.cwd).reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map());
  const dirs = [...dirCounts].toSorted((x, y) => y[1] - x[1]).map(([d]) => d);
  return { error: [error, codexed.error].filter(Boolean).join(" · ") || null, cards, dirs, defaults: await defaultSettings(), engines: settings.engines, summaries: runner.stats, grouping: grouper.pending(), groupSummaries: grouper.summaries(), outcomes: OUTCOMES, pins: pins.map((p) => ({ ...p, source: describe(fill(p.source)) })), hides, linearWorkspace: facts.linearWorkspace ?? null, prs: prs.counts(), at: Date.now() };
}

async function waitFor(check, timeoutMs) {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 500))) {
    const hit = await check();
    if (hit) return hit;
  }
  return null;
}

const findAgent = async (short) => (await listAgents()).agents.find((x) => (x.id ?? x.sessionId.slice(0, 8)) === short) ?? null;

// Resuming a live session starts a copy, so a stopped session is resumed with the message, and a running one
// has it typed into its terminal.
async function resumeWith(g, text) {
  const r = await cli(["--bg", "--resume", g.a.sessionId, "--", text], { cwd: g.job?.cwd ?? g.a.cwd });
  const started = r.out.match(/backgrounded · ([0-9a-f]{8})/)?.[1];
  if (!r.ok || !started || started === g.short) return r.ok ? { ok: true, out: "Sent: the session was resumed with your message." } : r;
  await cli(["rm", started]);
  return { ok: false, out: `Claude started a separate copy (${started}) instead of resuming this session, so the copy was removed. Try again.` };
}

// The browser's terminal panes: one shared connection per session, closed a while after its last viewer leaves,
// plus the board-wide agent view under its own key, kept longer so closing its dock does not reset it.
const views = new Map(); // short or AGENT_VIEW -> { term, sizes: viewer id -> { cols, rows }, idle }
const VIEW_IDLE_MS = 30_000;
const AGENT_VIEW = "agents";
const CODEX_VIEW = "codex-agents";
const AGENT_VIEW_IDLE_MS = 10 * 60_000;
function openView(short, size, spawnTerm = (s) => attach(short, s, cleanEnv())) {
  const open = views.get(short);
  if (open && !open.term.exited) return open;
  const v = { term: spawnTerm(size), sizes: new Map(), idle: null };
  views.set(short, v);
  v.term.done.then(() => views.get(short) === v && views.delete(short));
  return v;
}
// Viewers of a view the board closes are not told the process exited, so their panes reconnect.
async function closeView(short) {
  const v = views.get(short);
  views.delete(short);
  if (!v) return;
  clearTimeout(v.idle);
  v.closed = true;
  await v.term.close();
}

// Dialogs draw their "Esc to cancel" footer where the prompt box usually sits, at the bottom of the screen.
const showsDialog = (screen) => /Esctocancel|Wouldyouliketoproceed/.test(screen.replace(/\s+/g, "").slice(-500));

// Messages use a private connection, never the shared pane, which may have been switched to the agent view.
async function typeLive(g, keys, { intoDialog = false } = {}) {
  const term = attach(g.short, views.get(g.short)?.term.size ?? { cols: 200, rows: 50 }, cleanEnv());
  try {
    const screen = await term.ready();
    if (!screen) return { ok: false, out: "Could not connect to the session's terminal." };
    if (!intoDialog && showsDialog(screen)) return { status: 409, ok: false, out: WAITING };
    for (const k of keys) typeof k === "number" ? await sleep(k) : term.write(k);
    await sleep(800);
    return { ok: true, out: "" };
  } finally {
    await term.close();
  }
}

const fileSize = (p) => fs.stat(p).then((st) => st.size, () => 0);

async function deliver(g, text) {
  if (!g.a.pid) return resumeWith(g, text);
  const busy = g.a.status === "busy";
  const path = transcriptPath(g.a, g.job);
  const before = await fileSize(path);
  // A bracketed paste keeps line breaks as text instead of pressing Enter at each one.
  const r = await typeLive(g, [`\x1b[200~${text}\x1b[201~`, 400, "\r"]);
  if (!r.ok) return r;
  if (busy) return { ok: true, out: "Queued: the session reads it as soon as it can, as if typed in its terminal." };
  const picked = await waitFor(async () => (await fileSize(path)) > before || (await findAgent(g.short))?.status === "busy", 10_000);
  return picked ? { ok: true, out: "Sent." } : { ok: false, out: "The session did not pick the message up within 10s; check the Terminal tab." };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// `claude agents` drops the pid before the process exits; resuming in that gap forks a copy of the session.
async function stopProcess(g) {
  if (!g.a.pid) return { ok: true, out: "" };
  await closeView(g.short);
  const stop = await cli(["stop", g.short]);
  if (!stop.ok) return { ok: false, out: `Stopping the session failed: ${stop.out}` };
  return (await waitFor(async () => !alive(g.a.pid), 15_000)) ? { ok: true, out: "" } : { ok: false, out: "The session did not stop within 15s." };
}

const jobFile = (short) => join(CLAUDE, "jobs", short, "state.json");

// Only while no process runs: a live one may write its own copy of the record over this.
async function writeJob(short, patch) {
  const job = await readJson(jobFile(short));
  if (!job) return false;
  await fs.writeFile(`${jobFile(short)}.board-tmp`, JSON.stringify({ ...job, ...patch(job) }, null, 2));
  await fs.rename(`${jobFile(short)}.board-tmp`, jobFile(short));
  return true;
}

// The name `claude agents` shows, and the --name the next wake applies.
const namePatch = (name) => (job) => {
  const flags = job.respawnFlags ?? [];
  const at = flags.indexOf("--name");
  return { name, nameSource: "user", respawnFlags: at >= 0 ? flags.toSpliced(at + 1, 1, name) : [...flags, "--name", name] };
};

// No command renames a background session reliably: after a turnless resume the job record stops following
// /rename. So the board writes the name itself while no process runs.
async function setName(g, name, { restart }) {
  const stopped = await stopProcess(g);
  if (!stopped.ok) return stopped;
  if (!(await writeJob(g.short, namePatch(name)))) return { ok: false, out: "This session has no job record to rename." };
  if (!restart) return { ok: true, out: "" };
  const r = await cli(["respawn", g.short]);
  return r.ok ? { ok: true, out: "" } : { ok: false, out: `Renamed, but restarting the session failed: ${r.out}` };
}

const saveArchive = async (next) => {
  archive = next;
  await archiveStore.save(archive);
};
const saveCodexArchive = async (next) => {
  codexArchive = next;
  await codexArchiveStore.save(codexArchive);
};
const withoutRecord = (records, sessionId) => Object.fromEntries(Object.entries(records).filter(([id]) => id !== sessionId));

// The conversation file and, beside it, the folder of its subagents' transcripts.
async function saveConversation(src, sessionId) {
  const dest = join(SAVED_DIR, sessionId);
  await fs.mkdir(dest, { recursive: true });
  await fs.copyFile(src, join(dest, "conversation.jsonl"));
  const extra = src.replace(/\.jsonl$/, "");
  if (await isDir(extra)) await fs.cp(extra, join(dest, "files"), { recursive: true, force: true });
}

// The copy and the record are saved before the delete, so a failure part-way never loses the session.
async function archiveSession(g) {
  if (g.a.away) return { status: 409, ok: false, out: "Already archived." };
  const stopped = await stopProcess(g);
  if (!stopped.ok) return stopped;
  const job = await readJson(jobFile(g.short));
  if (!job) return { ok: false, out: "This session has no job record to archive." };
  try {
    await saveConversation(transcriptPath(g.a, job), g.a.sessionId);
  } catch (e) {
    return { ok: false, out: `Not archived: copying its conversation failed, so it could not be resumed later (${e.message}).` };
  }
  const { worktreePath, worktreeBranch } = job;
  const record = { short: g.short, sessionId: g.a.sessionId, cwd: worktreePath ?? job.cwd ?? g.a.cwd, name: g.name, topic: grouper.get(g.short), job };
  await saveArchive({ ...archive, [g.a.sessionId]: { ...record, archivedAt: archive[g.a.sessionId]?.archivedAt ?? Date.now() } });
  // `claude rm` also deletes a worktree the session created, with its branch; unlinked first, both stay on disk.
  if (worktreePath) await writeJob(g.short, () => ({ worktreePath: null, worktreeBranch: null }));
  const rm = await cli(["rm", g.short]);
  if (rm.ok) return { ok: true, out: `Archived and removed from the agent view.${worktreePath ? ` Its worktree stays at ${worktreePath}.` : ""}` };
  await writeJob(g.short, (j) => ({ ...namePatch(`${ARCHIVED_PREFIX}${g.name}`)(j), ...(worktreePath ? { worktreePath, worktreeBranch } : {}) }));
  return { ok: true, out: `Archived, but it stays in the agent view, marked [archived]: claude rm refused (${rm.out}).` };
}

// A deleted worktree falls back to its repository; any other folder to its nearest surviving parent.
async function fallbackDir(p) {
  const repo = p.split("/.claude/worktrees/")[0];
  if (repo !== p && (await isDir(repo))) return repo;
  for (let d = dirname(p); d !== dirname(d); d = dirname(d)) if (await isDir(d)) return d;
  return HOME;
}

// A resume looks for the conversation in the project of the folder it runs in. It goes there from Claude's own
// copy while that exists, otherwise from the board's.
async function putBack(record, cwd) {
  const target = join(projectDir(cwd), `${record.sessionId}.jsonl`);
  if (await exists(target)) return true;
  const original = transcriptPath({ sessionId: record.sessionId, cwd: record.cwd }, record.job);
  const src = (await exists(original)) ? original : savedConversation(record.sessionId);
  if (!(await exists(src))) return false;
  await fs.mkdir(projectDir(cwd), { recursive: true });
  await fs.copyFile(src, target);
  const extra = src === original ? original.replace(/\.jsonl$/, "") : join(SAVED_DIR, record.sessionId, "files");
  if (await isDir(extra)) await fs.cp(extra, join(projectDir(cwd), record.sessionId), { recursive: true, force: false });
  return true;
}

// A resume needs a prompt; /rename is a local command, so this wakes the session without a model call.
async function restore(record) {
  const { short, sessionId, name, job } = record;
  // A worktree session is resumed inside its worktree, where its conversation is filed.
  const home = job.worktreePath ?? job.cwd ?? record.cwd;
  const cwd = (await isDir(home)) ? home : await fallbackDir(home);
  if (!(await putBack(record, cwd))) return { ok: false, out: "Its conversation file is gone, and the board has no copy of it." };
  // Its saved options (model, effort, permission mode) come back with it; --name on a resume started copies in testing.
  const flags = job.respawnFlags ?? [];
  const at = flags.indexOf("--name");
  const r = await cli(["--bg", "--resume", sessionId, ...(at >= 0 ? flags.toSpliced(at, 2) : flags), "--", `/rename ${name}`], { cwd });
  const started = r.out.match(/backgrounded · ([0-9a-f]{8})/)?.[1];
  if (!r.ok || !started) return { ok: false, out: r.out || "claude --bg printed no session id." };
  if (started !== short) {
    await cli(["rm", started]);
    return { ok: false, out: `Claude started a separate copy (${started}) instead of restoring this session, so the copy was removed.` };
  }
  const back = await waitFor(() => findAgent(short), 15_000);
  if (back) await stopProcess({ short, a: back });
  // The new job record starts from the /rename; give it back the ask the session started from.
  await writeJob(short, (j) => ({ ...namePatch(name)(j), intent: job.intent ?? j.intent }));
  return { ok: true, out: cwd === home ? "" : ` Its folder ${home} is gone, so it now runs in ${cwd}.` };
}

async function unarchiveSession(g) {
  if (!g.archived) return { status: 409, ok: false, out: "Not archived." };
  const r = g.a.away ? await restore(archive[g.a.sessionId]) : await setName(g, g.name, { restart: Boolean(g.a.pid) });
  if (!r.ok) return r;
  await saveArchive(withoutRecord(archive, g.a.sessionId));
  await fs.rm(join(SAVED_DIR, g.a.sessionId), { recursive: true, force: true });
  return { ok: true, out: g.a.away ? `Unarchived: back in the agent view, stopped and ready to continue.${r.out}` : "Unarchived." };
}

const nameOf = (body) => (typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 80) : "");
// A message's text, or "" when it is empty or too long.
const messageOf = (body) => {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  return text.length <= 20_000 ? text : "";
};
const BAD_MESSAGE = { status: 400, ok: false, out: "Write a message of up to 20,000 characters." };
const NO_NAME = { status: 400, ok: false, out: "Give the session a name." };

const ACTIONS = {
  send: async (g, body) => {
    const text = messageOf(body);
    return text ? deliver(g, text) : BAD_MESSAGE;
  },
  rename: async (g, body) => {
    const name = nameOf(body);
    if (!name) return NO_NAME;
    const r = await setName(g, `${g.archived ? ARCHIVED_PREFIX : ""}${name}`, { restart: Boolean(g.a.pid) });
    return r.ok ? { ok: true, out: "Renamed." } : r;
  },
  // Esc, as in the terminal: it stops the turn, and on a prompt it cancels the prompt.
  interrupt: async (g) => {
    const r = await typeLive(g, ["\x1b"], { intoDialog: true });
    return r.ok ? { ok: true, out: "Interrupted." } : r;
  },
  // Saved into the session's startup flags, which every later wake applies; a running session is restarted.
  settings: async (g, body) => {
    const { values, error } = parseSettings(body);
    if (error) return { status: 400, ok: false, out: error };
    const stopped = await stopProcess(g);
    if (!stopped.ok) return stopped;
    if (!(await writeJob(g.short, (job) => ({ respawnFlags: withSettings(job.respawnFlags ?? [], values) })))) {
      return { ok: false, out: "This session has no job record to change." };
    }
    if (!g.a.pid) return { ok: true, out: "Saved. They apply when the session next runs." };
    const r = await cli(["respawn", g.short]);
    return r.ok ? { ok: true, out: "Saved, and the session was restarted with them." } : { ok: false, out: `Saved, but restarting the session failed: ${r.out}` };
  },
  archive: archiveSession,
  unarchive: unarchiveSession,
  stop: async (g) => {
    await closeView(g.short);
    return cli(["stop", g.short]);
  },
  respawn: async (g) => {
    await closeView(g.short);
    return cli(["respawn", g.short]);
  },
  // An archived session already out of the agent view is only forgotten; its conversation file stays on disk.
  remove: async (g) => {
    await closeView(g.short);
    const r = g.a.away ? { ok: true, out: "Forgotten, with the board's copy of its conversation." } : await cli(["rm", g.short]);
    if (!r.ok) return r;
    if (tags[g.a.sessionId]) await setTags(g.a.sessionId, []);
    if (archive[g.a.sessionId]) await saveArchive(withoutRecord(archive, g.a.sessionId));
    await fs.rm(join(SAVED_DIR, g.a.sessionId), { recursive: true, force: true });
    return r;
  },
  open: (g) => openTerminal(g.short, inShell(attachArgs(g))),
};
// What joining a session runs, in Terminal or in the TUI: a running session is attached to, and one without a process
// is resumed interactively in its folder.
const attachArgs = (g) => (g.a.pid ? { cwd: null, argv: ["claude", "attach", g.short] } : { cwd: g.job?.cwd ?? g.a.cwd, argv: ["claude", "--resume", g.a.sessionId] });
const codexAttachArgs = (t) => ({ cwd: t.cwd, argv: ["codex", "resume", "-c", "check_for_update_on_startup=false", "--remote", "unix://", t.id] });
const inShell = ({ cwd, argv }) => `${cwd ? `cd ${shellQuote(cwd)} && ` : ""}${argv.map(shellQuote).join(" ")}`;
const acting = new Set();

const isDir = (p) => p.startsWith("/") && fs.stat(p).then((st) => st.isDirectory(), () => false);

const KIND_LABELS = { notion: "Notion page", "linear-issue": "Linear issue", "linear-project": "Linear project", "linear-doc": "Linear document", "slack-thread": "Slack thread", "slack-channel": "Slack channel", pr: "Pull request", artifact: "Artifact" };

// What a new session starts from besides its prompt: a Linear issue, and context lines that are each a link, a Linear
// issue ID, or a file or folder on this machine. Links are pinned to the session; files outside its folder are added to it.
async function attachmentsOf(body) {
  const lines = [body.issue, ...(Array.isArray(body.context) ? body.context : [])].filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  if (lines.length > 30) return { error: "Attach at most 30 links, issues or files." };
  const items = [];
  for (const line of lines) {
    if (ISSUE_RE.test(line)) {
      const id = line.toUpperCase();
      const url = issueLink(id);
      items.push({ text: `Linear issue ${id}${url ? `: ${url}` : ""}`, pin: url, issue: id });
    } else if (/^https?:\/\/\S+$/.test(line)) {
      const s = sourceOfUrl(line);
      items.push({ text: `${KIND_LABELS[s?.kind] ?? "Link"}: ${line}`, pin: line, issue: s?.kind === "linear-issue" ? s.id : null });
    } else {
      const path = line.replace(/^~(?=\/)/, homedir());
      const st = path.startsWith("/") ? await fs.stat(path).catch(() => null) : null;
      if (!st) return { error: `Not a link, a Linear issue ID, or a file on this machine: ${line}` };
      items.push({ text: `${st.isDirectory() ? "Folder" : "File"}: ${path}`, dir: st.isDirectory() ? path : dirname(path) });
    }
  }
  return { items: [...new Map(items.map((i) => [i.text, i])).values()] };
}

async function putTags(req, res, sessionId) {
  let next;
  try {
    next = cleanTags(JSON.parse(await readBody(req)).tags);
  } catch {
    next = null;
  }
  if (!next) return send(res, 400, { error: "expected {\"tags\": [string]}" });
  await setTags(sessionId, next);
  return send(res, 200, { tags: next });
}

// Sets or clears an archived session's status; `record` is null for a session that is not archived.
async function putOutcome(req, res, record, save) {
  const outcome = (await jsonBody(req))?.outcome;
  if (outcome !== null && !OUTCOMES[outcome]) return send(res, 400, { ok: false, message: `expected {"outcome": one of ${Object.keys(OUTCOMES).join(", ")}, or null to follow its pull requests}` });
  if (!record) return send(res, 409, { ok: false, message: "Only a session the board archived keeps a status." });
  await save({ ...record, outcome: outcome ?? undefined });
  return send(res, 200, { ok: true });
}

// What the board does to a Codex thread, resolving { ok, out, status? } as ACTIONS do.
const CODEX_ACTIONS = {
  send: async (t, body) => {
    const text = messageOf(body);
    return text ? { ok: true, out: await codex.send(t.id, text) } : BAD_MESSAGE;
  },
  interrupt: async (t) => ((await codex.interrupt(t.id)) ? { ok: true, out: "Interrupted." } : { status: 409, ok: false, out: "Nothing to interrupt: Codex is not mid-turn." }),
  rename: async (t, body) => {
    const name = nameOf(body);
    if (!name) return NO_NAME;
    await codex.rename(t.id, name);
    return { ok: true, out: "Renamed." };
  },
  archive: async (t, _body, card) => {
    if (t.archived) return { status: 409, ok: false, out: "Already archived." };
    await closeView(card.id);
    await codex.archive(t.id);
    await saveCodexArchive({ ...codexArchive, [t.id]: { topic: card.group, archivedAt: Date.now() } });
    return { ok: true, out: "Archived, and out of codex agents." };
  },
  unarchive: async (t) => {
    if (!t.archived) return { status: 409, ok: false, out: "Not archived." };
    await codex.unarchive(t.id);
    await saveCodexArchive(withoutRecord(codexArchive, t.id));
    return { ok: true, out: "Unarchived: back in codex agents." };
  },
  remove: async (t, _body, card) => {
    await closeView(card.id);
    await codex.remove(t.id);
    if (tags[t.id]) await setTags(t.id, []);
    if (codexArchive[t.id]) await saveCodexArchive(withoutRecord(codexArchive, t.id));
    return { ok: true, out: "Deleted from Codex." };
  },
  open: (t, _body, card) => openTerminal(card.id, inShell(codexAttachArgs(t))),
};

// A Codex card's routes: what Codex has a counterpart for, with the rest left to Codex itself.
async function codexRoute(req, res, t, action, url) {
  const f = await codex.facts(t);
  const input = codexInput(t, f);
  const card = codexCard(t, f, input);
  if (!action) return send(res, 200, { ...card, plan: null, docs: [], tasks: [], team: [], timeline: [], fan: [] });
  if (action === "conversation") return send(res, 200, await codex.steps(t, url.searchParams.get("from")));
  if (action === "attach") return card.can.open === true ? send(res, 200, codexAttachArgs(t)) : send(res, 409, { ok: false, message: card.can.open });
  if (action === "file") return send(res, ...(await markdownFile(t.cwd, url.searchParams.get("path"))));
  if (action === "tags" || action === "outcome") {
    if (req.method !== "PUT") return send(res, 405, { error: "PUT only" });
    if (action === "tags") return await putTags(req, res, t.id);
    return await putOutcome(req, res, t.archived ? codexArchive[t.id] ?? {} : null, (r) => saveCodexArchive({ ...codexArchive, [t.id]: r }));
  }
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (action === "summarize") {
    if (input) summarizer.request(t.id, { working: card.column === "working", input, force: true });
    return send(res, 202, { queued: Boolean(input) });
  }
  if (!CODEX_ACTIONS[action]) return send(res, 409, { ok: false, message: CODEX_ELSEWHERE });
  const allowed = card.can[action === "unarchive" ? "archive" : action];
  if (allowed !== true) return send(res, 409, { ok: false, message: allowed });
  if (acting.has(card.id)) return send(res, 409, { ok: false, message: "Another action on this session is still running." });
  const body = await jsonBody(req);
  if (!body) return send(res, 400, { ok: false, message: "expected a JSON object" });
  acting.add(card.id);
  try {
    const r = await CODEX_ACTIONS[action](t, body, card);
    return send(res, r.status ?? (r.ok ? 200 : 502), { ok: r.ok, message: r.out.slice(-2000) });
  } catch (e) {
    return send(res, 502, { ok: false, message: `Codex: ${String(e.message ?? e)}` });
  } finally {
    acting.delete(card.id);
  }
}

async function tagAndPin(sessionId, next, links) {
  if (next.length) await setTags(sessionId, next);
  if (!links.length) return;
  pins = [...pins, ...links.map((i) => pinOf({ url: i.pin, session: sessionId })).filter(Boolean)];
  await pinStore.save({ pins, hides });
}

// A Codex session starts on Codex's daemon with the user's Codex defaults, in the folder given.
async function startCodex(body, { cwd, prompt, name, items }) {
  if (body.worktree === true || (Array.isArray(body.addDirs) && body.addDirs.length)) {
    return { status: 400, ok: false, out: "A Codex session starts in the chosen folder: no worktree or extra folders." };
  }
  let thread;
  try {
    thread = await codex.start({ cwd, prompt, name });
  } catch (e) {
    return { ok: false, out: `Codex: ${String(e.message ?? e)}` };
  }
  await tagAndPin(thread.id, cleanTags(body.tags ?? []) ?? [], items.filter((i) => i.pin));
  return { ok: true, id: codexShort(thread.id), out: `Started Codex session ${codexShort(thread.id)}.` };
}

async function startSession(body) {
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const { items, error: attachError } = await attachmentsOf(body);
  if (attachError) return { status: 400, ok: false, out: attachError };
  const issue = items.find((i) => i.issue)?.issue;
  // An issue alone is enough to start from.
  const asked = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const lead = asked || (issue ? `Work on Linear issue ${issue}. Read it and the context below first.` : "");
  if (!lead || lead.length > 20_000) return { status: 400, ok: false, out: "Write a prompt of up to 20,000 characters, or give a Linear issue." };
  const prompt = items.length ? `${lead}\n\nContext:\n${items.map((i) => `- ${i.text}`).join("\n")}` : lead;
  if (!(await isDir(cwd))) return { status: 400, ok: false, out: `No such directory: ${cwd || "(empty)"}` };
  const name = nameOf(body);
  if (body.cli === "codex") return startCodex(body, { cwd, prompt, name, items });
  const { values, error } = parseSettings(body);
  if (error) return { status: 400, ok: false, out: error };
  const addDirs = Array.isArray(body.addDirs) ? body.addDirs.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim()) : [];
  for (const d of addDirs) if (!(await isDir(d))) return { status: 400, ok: false, out: `No such directory: ${d}` };
  // A worktree moves the session out of cwd, so an attached file there is added too.
  const inside = (d) => body.worktree !== true && (d === cwd || d.startsWith(`${cwd}/`));
  for (const i of items) if (i.dir && !inside(i.dir) && !addDirs.includes(i.dir)) addDirs.push(i.dir);
  const flags = [
    ...settingFlags(values),
    ...(name ? ["--name", name] : []),
    ...(body.worktree === true ? ["--worktree"] : []),
    ...(addDirs.length ? ["--add-dir", ...addDirs] : []),
  ];
  const r = await cli(["--bg", ...flags, "--", prompt], { cwd });
  const short = r.out.match(/backgrounded · ([0-9a-f]{8})/)?.[1];
  if (!short) return { ok: false, out: r.out || "claude --bg printed no session id." };
  const next = cleanTags(body.tags ?? []) ?? [];
  const links = items.filter((i) => i.pin);
  const a = next.length || links.length ? await waitFor(() => findAgent(short), 10_000) : null;
  if (a) await tagAndPin(a.sessionId, next, links);
  const late = (next.length || links.length) && !a ? " It did not appear in time to be tagged or to get its links pinned." : "";
  return { ok: true, id: short, out: `Started ${short}.${late}` };
}

async function find(short) {
  const record = Object.values(archive).find((r) => r.short === short);
  const a = (await findAgent(short)) ?? (record ? awayAgent(record) : null);
  return a ? gather(a) : null;
}

async function detail(g) {
  const docs = await Promise.all(
    g.scan.docs.slice(0, 8).map(async (d) => {
      try {
        return { ...d, content: await fs.readFile(d.path, "utf8") };
      } catch {
        return { ...d, content: null };
      }
    }),
  );
  return { ...toCard(g), plan: g.scan.plan, docs, tasks: g.tasks, team: g.team, timeline: await readTimeline(g.short), fan: g.fan };
}

const readBody = (req, limit = 10_000) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

const jsonBody = (req) =>
  readBody(req, 40_000)
    .then((b) => JSON.parse(b || "{}"))
    .then((v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null))
    .catch(() => null);

// Sessions dispatched from the agent view start in its directory, so it runs in the repository most sessions use.
async function busiestDir() {
  const { agents } = await listAgents();
  const counts = agents.map((a) => a.cwd?.split("/.claude/worktrees/")[0]).filter(Boolean).reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map());
  return [...counts].toSorted((x, y) => y[1] - x[1])[0]?.[0] ?? HOME;
}
// Where a Claude call with Linear, Notion or Slack tools runs: those plugins are enabled per project.
const toolsDir = async () => process.env.AGENT_BOARD_JOURNAL_CWD ?? (await busiestDir());

// A shared terminal takes the smallest of its viewers' sizes, as tmux does. Each pane is told the size it got and sizes
// its grid to match, so none keeps stale rows outside what the session draws.
const fitView = async (v) => {
  const all = [...v.sizes.values()];
  if (!all.length) return;
  await v.term.resize({ cols: Math.min(...all.map((s) => s.cols)), rows: Math.min(...all.map((s) => s.rows)) });
  const msg = JSON.stringify({ size: v.term.size });
  for (const ws of v.sizes.keys()) ws.send(msg);
};

// One WebSocket per pane: output goes down as {data}, the terminal's size as {size}, then {exit} if the process ends by
// itself; keys ({data}) and the room the pane has ({cols, rows}) come up. A refusal is {error} before the socket closes.
async function terminal(req, socket, head, url, { key, allowed = true, idleMs = VIEW_IDLE_MS, spawnTerm }) {
  const size = { cols: Number(url.searchParams.get("cols")) || 120, rows: Number(url.searchParams.get("rows")) || 40 };
  if (allowed === true && url.searchParams.get("fresh") === "1") await closeView(key);
  const ws = accept(req, socket, head);
  if (!ws) return;
  const out = (msg) => ws.send(JSON.stringify(msg));
  if (allowed !== true) {
    out({ error: allowed });
    return ws.close();
  }
  const v = openView(key, size, spawnTerm);
  clearTimeout(v.idle);
  v.sizes.set(ws, size);
  const end = () => {
    if (!v.closed) out({ exit: true });
    ws.close();
  };
  out({ size: v.term.size });
  if (v.term.screen()) out({ data: v.term.screen(), replay: true });
  const off = v.term.onData((data) => (data == null ? end() : out({ data })));
  if (v.term.exited) end();
  else fitView(v);
  ws.onmessage = (text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m?.data === "string") v.term.write(m.data);
    else if (Number.isInteger(m?.cols) && Number.isInteger(m?.rows)) {
      v.sizes.set(ws, { cols: m.cols, rows: m.rows });
      fitView(v);
    }
  };
  ws.onclose = () => {
    off();
    v.sizes.delete(ws);
    if (v.sizes.size) fitView(v);
    else v.idle = setTimeout(() => views.get(key) === v && !v.sizes.size && closeView(key), idleMs);
  };
}

// A Markdown file a session printed, for the Terminal tab's preview. Relative paths resolve against the session's
// folder, and only a Markdown file under the home folder, after symlinks, is served.
const MD_RE = /\.(md|markdown|mdx)$/i;
const MD_MAX = 2 << 20;
async function markdownFile(dir, raw) {
  const asked = String(raw ?? "").trim().replace(/^~(?=\/)/, HOME);
  if (!MD_RE.test(asked)) return [400, { error: "expected ?path= naming a Markdown file" }];
  const [real, home] = await Promise.all([fs.realpath(resolve(dir, asked)).catch(() => null), fs.realpath(HOME)]);
  const st = real?.startsWith(`${home}/`) && MD_RE.test(real) ? await fs.stat(real) : null;
  if (!st?.isFile()) return [404, { error: `No Markdown file at ${raw} in your home folder.` }];
  if (st.size > MD_MAX) return [413, { error: `${real} is over 2 MB.` }];
  return [200, { path: real, text: await fs.readFile(real, "utf8"), mtime: st.mtimeMs }];
}

async function journalRoute(req, res, path) {
  if (path === "/api/journal") return send(res, 200, journal.get());
  if (path === "/api/journal/summarize") {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    if (!runner.enabled) return send(res, 409, { ok: false, message: "Model calls are off (AGENT_BOARD_SUMMARIZE=0)." });
    const started = journal.summarize({ cwd: await toolsDir(), cards: (await board()).cards });
    return send(res, started ? 202 : 409, { ok: started, message: started ? "Summarizing." : "A summary is already running." });
  }
  const [, kind, id] = path.match(/^\/api\/journal\/(items|notes)(?:\/([0-9a-f-]{36}))?$/) ?? [];
  if (!kind) return send(res, 404, { error: "not found" });
  const items = kind === "items";
  if (!id) {
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const made = await (items ? journal.addItem : journal.addNote)(await jsonBody(req));
    return made ? send(res, 200, { ok: true, [items ? "item" : "note"]: made }) : send(res, 400, { ok: false, message: items ? 'expected {"text", "horizon": "today" | "week" | "later"}' : 'expected {"text"}' });
  }
  if (req.method === "DELETE") {
    const gone = await (items ? journal.removeItem : journal.removeNote)(id);
    return send(res, gone ? 200 : 404, { ok: gone });
  }
  if (items && req.method === "PUT") {
    const next = await journal.updateItem(id, await jsonBody(req));
    return next ? send(res, 200, { ok: true, item: next }) : send(res, 400, { ok: false, message: 'expected an existing item and {"text"?, "horizon"?, "done"?}' });
  }
  return send(res, 405, { error: items ? "PUT or DELETE" : "DELETE only" });
}

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

await fs.mkdir(RUN_DIR, { recursive: true });
let savedPins;
let savedSettings;
[tags, archive, codexArchive, savedPins, ghStates, savedSettings] = await Promise.all([tagStore.load(), archiveStore.load(), codexArchiveStore.load(), pinStore.load(), ghStore.load(), settingsStore.load(), summarizer.ready, grouper.ready, journal.ready, digests.ready]);
settings = { engines: enginesOf(savedSettings.engines, settings.engines) };
pins = Array.isArray(savedPins.pins) ? savedPins.pins : [];
hides = Array.isArray(savedPins.hides) ? savedPins.hides : [];
// Sessions archived before the board kept copies get one now, while Claude's own still exists.
for (const r of Object.values(archive)) {
  if (await exists(savedConversation(r.sessionId))) continue;
  await saveConversation(transcriptPath({ sessionId: r.sessionId, cwd: r.cwd }, r.job), r.sessionId).catch((e) => console.error(`No copy of ${r.short}'s conversation: ${e.message}`));
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // The Host check stops DNS-rebinding pages reading transcripts; the custom header forces a CORS
  // preflight this server never approves, so no other site can edit tags or trigger paid calls.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: "forbidden host" });
  if (req.method !== "GET" && req.headers["x-agent-board"] !== "1") return send(res, 403, { error: "missing x-agent-board header" });
  try {
    if (url.pathname === "/") return send(res, 200, await fs.readFile(join(HERE, "index.html"), "utf8"), "text/html; charset=utf-8");
    // A page polls the board every few seconds, which keeps its PR list fresh only while someone is looking.
    if (url.pathname === "/api/board") {
      prs.fresh();
      return send(res, 200, await board());
    }
    if (url.pathname === "/api/prs") {
      if (req.method === "POST") await prs.refresh();
      else prs.fresh();
      return send(res, 200, prs.get());
    }
    if (url.pathname.startsWith("/api/journal")) return await journalRoute(req, res, url.pathname);
    if (url.pathname === "/api/digest") return send(res, 200, digests.get());
    const digestKind = url.pathname.match(/^\/api\/digest\/(repo|notion|slack)$/)?.[1];
    if (digestKind) {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      if (!runner.enabled) return send(res, 409, { ok: false, message: "Model calls are off (AGENT_BOARD_SUMMARIZE=0)." });
      const day = (await jsonBody(req))?.day;
      if (!validDay(day)) return send(res, 400, { ok: false, message: 'expected {"day": "YYYY-MM-DD"}, today or one of the 29 days before' });
      const started = digests.run(digestKind, day);
      return send(res, started ? 202 : 409, { ok: started, message: started ? "Writing the digest." : "That digest is already being written." });
    }
    if (url.pathname === "/api/settings" && req.method === "PUT") {
      const next = (await jsonBody(req))?.engines;
      if (!next || !Object.entries(next).every(([k, v]) => k in settings.engines && ENGINES.includes(v))) {
        return send(res, 400, { ok: false, message: `expected {"engines": {${Object.keys(settings.engines).map((k) => `"${k}"?`).join(", ")}}}, each one of ${ENGINES.join(", ")}` });
      }
      settings = { engines: { ...settings.engines, ...next } };
      await settingsStore.save(settings);
      return send(res, 200, { ok: true, settings });
    }
    if (url.pathname === "/api/pins" && req.method === "POST") {
      const pin = pinOf(await jsonBody(req));
      if (!pin) return send(res, 400, { ok: false, message: 'expected {"url": "https://…", "title"?, and "group": {"id", "name", "sessionIds"} or "session": sessionId}' });
      pins = [...pins, pin];
      // Pinning a link a person had removed from the group brings it back.
      if (pin.group) hides = hides.filter((h) => !(h.group.id === pin.group.id && h.key === `${pin.source.kind}:${pin.source.id}`));
      await pinStore.save({ pins, hides });
      return send(res, 200, { ok: true, pin });
    }
    const pinPath = url.pathname.match(/^\/api\/pins\/([0-9a-f-]{36})$/);
    if (pinPath) {
      if (req.method !== "DELETE") return send(res, 405, { error: "DELETE only" });
      pins = pins.filter((p) => p.id !== pinPath[1]);
      await pinStore.save({ pins, hides });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/hides" && req.method === "POST") {
      const hide = hideOf(await jsonBody(req));
      if (!hide) return send(res, 400, { ok: false, message: 'expected {"key": "kind:id", "group": {"id", "name", "sessionIds"}}' });
      hides = [...hides, hide];
      await pinStore.save({ pins, hides });
      return send(res, 200, { ok: true, hide });
    }
    const hidePath = url.pathname.match(/^\/api\/hides\/([0-9a-f-]{36})$/);
    if (hidePath) {
      if (req.method !== "DELETE") return send(res, 405, { error: "DELETE only" });
      hides = hides.filter((h) => h.id !== hidePath[1]);
      await pinStore.save({ pins, hides });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      const body = await jsonBody(req);
      if (!body) return send(res, 400, { ok: false, message: "expected a JSON object" });
      const r = await startSession(body);
      return send(res, r.status ?? (r.ok ? 200 : 502), { ok: r.ok, id: r.id ?? null, message: r.out.slice(-2000) });
    }
    const m = url.pathname.match(/^\/api\/card\/([0-9a-f]{8})(?:\/(summarize|tags|conversation|send|interrupt|settings|rename|archive|unarchive|stop|respawn|remove|open|attach|outcome|file))?$/);
    if (m) {
      const g = await find(m[1]);
      if (!g) {
        const t = await codex.find(m[1]);
        return t ? await codexRoute(req, res, t, m[2], url) : send(res, 404, { error: "no such session" });
      }
      if (!m[2]) return send(res, 200, await detail(g));
      if (m[2] === "file") return send(res, ...(await markdownFile(g.job?.worktreePath ?? g.job?.cwd ?? g.a.cwd, url.searchParams.get("path"))));
      if (m[2] === "conversation") {
        const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : null;
        return send(res, 200, await readSteps(conversationPath(g.a, g.job), from));
      }
      if (m[2] === "attach") {
        const allowed = capabilities(g.a, g.job).open;
        return allowed === true ? send(res, 200, attachArgs(g)) : send(res, 409, { ok: false, message: allowed });
      }
      if (ACTIONS[m[2]]) {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        const allowed = capabilities(g.a, g.job)[m[2] === "unarchive" ? "archive" : m[2]];
        if (allowed !== true) return send(res, 409, { ok: false, message: allowed });
        if (acting.has(g.short)) return send(res, 409, { ok: false, message: "Another action on this session is still running." });
        const body = await jsonBody(req);
        if (!body) return send(res, 400, { ok: false, message: "expected a JSON object" });
        acting.add(g.short);
        try {
          const r = await ACTIONS[m[2]](g, body);
          return send(res, r.status ?? (r.ok ? 200 : 502), { ok: r.ok, message: r.out.slice(-2000) });
        } finally {
          acting.delete(g.short);
        }
      }
      if (m[2] === "summarize") {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        requestSummary(g, true);
        return send(res, 202, { queued: true });
      }
      if (req.method !== "PUT") return send(res, 405, { error: "PUT only" });
      if (m[2] === "outcome") return await putOutcome(req, res, archive[g.a.sessionId] ?? null, (r) => saveArchive({ ...archive, [g.a.sessionId]: r }));
      return await putTags(req, res, g.a.sessionId);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e?.stack ?? e) });
  }
});
// A page cannot set headers on a WebSocket, but the browser always sends the page's origin, which stands in for x-agent-board.
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
server.on("upgrade", async (req, socket, head) => {
  socket.on("error", () => {});
  const url = new URL(req.url, "http://localhost");
  if (!ALLOWED_HOSTS.has(req.headers.host) || !ALLOWED_ORIGINS.has(req.headers.origin)) return refuse(socket, 403, "Forbidden");
  try {
    if (url.pathname === "/api/agent-view/term") {
      const cwd = await busiestDir();
      const view = url.searchParams.get("agent") === "codex" ? { key: CODEX_VIEW, spawn: codexView } : { key: AGENT_VIEW, spawn: agentView };
      return await terminal(req, socket, head, url, { key: view.key, idleMs: AGENT_VIEW_IDLE_MS, spawnTerm: (size) => view.spawn(size, cleanEnv(), cwd) });
    }
    const id = url.pathname.match(/^\/api\/card\/([0-9a-f]{8})\/term$/)?.[1];
    const g = id && (await find(id));
    const t = id && !g && (await codex.find(id));
    if (t && codex.isThreadId(t.id)) return await terminal(req, socket, head, url, { key: id, allowed: t.archived ? CODEX_ARCHIVED : true, spawnTerm: (size) => codexResume(t.id, size, cleanEnv(), HOME) });
    if (!g) return refuse(socket, 404, "Not Found");
    await terminal(req, socket, head, url, { key: g.short, allowed: capabilities(g.a, g.job).terminal });
  } catch (e) {
    console.error(`terminal: ${e?.stack ?? e}`);
    socket.destroy();
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`agent board: http://127.0.0.1:${PORT}`));
// Yesterday's digests are written once each morning, so they wait for the reader instead of the reverse.
if (runner.enabled) {
  digests.tick();
  setInterval(() => digests.tick(), 10 * 60_000).unref();
}
