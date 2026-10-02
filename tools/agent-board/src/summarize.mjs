// Model-written status cards and session groups via `claude -p` or `codex exec`, cached on disk by their exact
// input so a restart, or transcript noise that changes nothing the model sees, never pays twice.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { callCodex } from "./codex.mjs";

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "status", "done", "next", "concerns", "needsYou"],
  properties: {
    goal: { type: "string" },
    status: { type: "string" },
    done: { type: "array", items: { type: "string" } },
    next: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
    needsYou: { type: "array", items: { type: "string" } },
  },
};

const SUMMARY_SYSTEM = `You write the status card for one Claude Code session on a kanban board. The reader supervises many sessions at once and must understand each card in seconds.

Write in plain, everyday English that someone outside the project could follow. Say what is happening and why it matters, not how the code works. If a word only makes sense to a programmer, replace it; avoid code names, file paths, commands, and tool names, and when a technical term is unavoidable, say what it means in a few words. Keep a PR or ticket number only when the reader needs it to act, in parentheses at the end. Each item is one short sentence, at most 20 words. Plain text, no markdown.

Use only facts stated in the excerpt. Never invent work, risks, or requests. The excerpt shows only the latest turns: earlier work is simply not shown, so never report it as missing, unanswered, or a concern.

- goal: what the session is trying to achieve right now, in at most 15 words. Later user prompts override earlier ones; a short follow-up ("go with X") refines the goal before it.
- status: one sentence, at most 30 words, on where the session stands now: its outcome, or its latest intermediate result if unfinished. If it is still working, do not say so, since the board shows that; otherwise end with why it stopped: it finished what was asked, is waiting on something other than the reader (say what), hit an error, was interrupted, or was cut off. If it stopped to ask the reader something, leave that out entirely: the board shows needsYou beside the status. Take the reason from "How the latest turn ended" and the messages; never guess one.
- done: what has been accomplished, at most 5, oldest first.
- next: remaining steps the assistant or user explicitly stated, at most 5. Empty if none were stated.
- concerns: at most 4 of: risks, things not yet checked, failures, errors, and anything the reader may not know happened (choices made without asking, changes from what was asked, actions with outside effects such as publishing, pushing, or deleting). Empty if none.
- needsYou: only what the session is explicitly waiting on the reader for: a question it asked, a decision, an approval, access, or something it asked them to review. Optional offers do not count. Empty if nothing is waiting.`;

const GROUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "summary", "sessionIds"],
        properties: { name: { type: "string" }, summary: { type: "string" }, sessionIds: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

const GROUP_SYSTEM = `You sort Claude Code sessions into project groups on a kanban board, so the reader sees related work together.

- Put sessions in the same group when they serve the same project, initiative, or ticket, or work on the same subject: two sessions about model pricing belong together even without a shared ticket. Shared ticket IDs and worktree names are strong signals; working in the same repository is not.
- Name each group after its subject in 2 to 4 plain words, Title Case, taken from the goals: never a bare ticket ID, branch, worktree, or session name. Name the project, not the activity ("Software Factory", not "Research"). Add the ticket ID in parentheses when the group has one, e.g. "Hatchet Upgrade (ENG-12294)".
- Give each group a summary: one plain-English sentence, at most 30 words, on how its sessions work together, not a list of their topics. Say which session's research or decision another builds on, reviews, or continues, e.g. "Three research sessions feed findings into the design session, which the build session is now implementing." For a group of one session, say what it covers. No code names or file paths.
- "Shared context" lists the documents, tickets, threads, and pull requests a session shares with other sessions, and whether it wrote or read each. Sessions that share context usually belong together, and one session writing what another read is a hand-off: name it in the summary.
- Session names are generated from each session's first prompt and may be out of date; trust the goal over the name.
- Keep the previous group names and memberships unless a session clearly belongs elsewhere.
- When a user tag fits a group, use the tag as that group's name.
- A session related to no other session gets its own group.
- List every session ID exactly once.`;

// Session identity inherited when the board runs inside a Claude session; it must not leak into
// the model calls or the sessions the board starts.
const SESSION_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_AGENT",
  "CLAUDE_CODE_SESSION_ATTENDED",
];
// Bump when that prompt or schema changes, so cached cards or groups are rewritten.
const SUMMARY_VERSION = 6;
const GROUP_VERSION = 5;
const CONCURRENCY = 2;
const CALL_TIMEOUT_MS = 120_000;
const WORKING_REFRESH_MS = 30 * 60_000;
const REGROUP_MS = 10 * 60_000;
const RETRY_AFTER_ERROR_MS = 10 * 60_000;

const hash = (s) => createHash("sha1").update(s).digest("hex");

export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_ENV.includes(k)));

export function jsonStore(file) {
  let writing = Promise.resolve();
  return {
    load: () => fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({})),
    save(value) {
      const snapshot = JSON.stringify(value);
      writing = writing
        .then(() => fs.mkdir(dirname(file), { recursive: true }))
        .then(() => fs.writeFile(`${file}.tmp`, snapshot))
        .then(() => fs.rename(`${file}.tmp`, file))
        .catch(() => {});
      return writing;
    },
  };
}

function callModel(input, { cwd, model, effort, budgetUsd, schema, system }) {
  const args = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--system-prompt", system,
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--tools", "",
    "--max-budget-usd", String(budgetUsd),
  ];
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CALL_TIMEOUT_MS);
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
        return resolve({ error: `claude -p exited ${code}: ${(err || out).slice(0, 300)}` });
      }
      if (res.is_error || !res.structured_output) return resolve({ error: String(res.result ?? res.subtype ?? "no structured output").slice(0, 300), costUsd: res.total_cost_usd ?? 0 });
      resolve({ output: res.structured_output, costUsd: res.total_cost_usd ?? 0, modelId: Object.keys(res.modelUsage ?? {}).join("+") });
    });
    child.stdin.end(input);
  });
}

// One call path for cards and groups, so spend and failures land in one set of stats. `engine()` is read per call, so
// switching it applies to the next card without a restart.
export function createRunner({ runDir, model, effort, budgetUsd, enabled, engine, codexModel }) {
  const stats = { enabled, model, calls: 0, errors: 0, spentUsd: 0 };
  const run = async (label, input, schema, system) => {
    stats.calls += 1;
    const started = Date.now();
    const r = engine() === "codex"
      ? await callCodex(`${system}\n\n${input}`, { cwd: runDir, env: cleanEnv(), model: codexModel, effort, schema, timeoutMs: CALL_TIMEOUT_MS })
      : await callModel(input, { cwd: runDir, model, effort, budgetUsd, schema, system });
    stats.spentUsd += r.costUsd ?? 0;
    if (r.error) stats.errors += 1;
    console.log(
      `${label} ${r.error ? `FAILED ${r.error}` : `ok ${r.modelId}`} $${(r.costUsd ?? 0).toFixed(4)} ${input.length} chars ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return r;
  };
  return { run, stats, enabled, key: `${model}/${effort}` };
}

export function createSummarizer({ store, runner }) {
  const key = `${runner.key}/v${SUMMARY_VERSION}`;
  let cache = {};
  const queue = new Map(); // sessionId -> { hash, input }, insertion-ordered
  const running = new Set();
  const ready = store.load().then((c) => (cache = c));

  const due = (entry, inputHash, working, now) => {
    if (!entry || entry.key !== key) return true;
    if (entry.error) return now - entry.at >= RETRY_AFTER_ERROR_MS;
    if (entry.hash === inputHash) return false;
    return !working || now - entry.at >= WORKING_REFRESH_MS;
  };

  function pump() {
    while (running.size < CONCURRENCY && queue.size) {
      const [sessionId, job] = queue.entries().next().value;
      queue.delete(sessionId);
      running.add(sessionId);
      runner.run(`summary ${sessionId.slice(0, 8)}`, job.input, SUMMARY_SCHEMA, SUMMARY_SYSTEM).then((r) => {
        running.delete(sessionId);
        cache[sessionId] = r.output
          ? { key, hash: job.hash, at: Date.now(), summary: r.output, costUsd: r.costUsd }
          : { ...cache[sessionId], key, hash: job.hash, at: Date.now(), error: r.error };
        store.save(cache);
        pump();
      });
    }
  }

  return {
    ready,
    // `force` skips the due check; a session already queued just gets its input replaced.
    request(sessionId, { working, input, force = false }) {
      if (!runner.enabled || running.has(sessionId)) return;
      const h = hash(input);
      if (!queue.has(sessionId) && !force && !due(cache[sessionId], h, working, Date.now())) return;
      queue.set(sessionId, { hash: h, input });
      pump();
    },
    get(sessionId, input) {
      const e = cache[sessionId];
      return {
        summary: e?.summary ?? null,
        at: e?.at ?? null,
        costUsd: e?.costUsd ?? null,
        error: e?.error ?? null,
        pending: running.has(sessionId) || queue.has(sessionId),
        stale: Boolean(e?.summary) && e.hash !== hash(input ?? ""),
      };
    },
  };
}

// sessions: [{ id, name, goal, ask, worktree, tickets, tags }], id being the 8-char session id.
function groupInput(sessions, previous) {
  const lines = sessions.map((s) =>
    [
      `- ${s.id}: ${s.name}`,
      s.goal && `goal: ${s.goal}`,
      s.ask && `original ask: ${s.ask}`,
      s.worktree && `worktree: ${s.worktree}`,
      s.tickets.length && `tickets: ${s.tickets.join(", ")}`,
      s.tags.length && `user tags: ${s.tags.join(", ")}`,
      s.shares.length && `shared context: ${s.shares.join("; ")}`,
      previous[s.id] && `previous group: ${previous[s.id]}`,
    ]
      .filter(Boolean)
      .join(" | "),
  );
  return ["Sessions:", ...lines].join("\n");
}

export function createGrouper({ store, runner }) {
  const key = `${runner.key}/g${GROUP_VERSION}`;
  let state = { assign: {}, summaries: {}, basis: null, at: 0, error: null };
  let running = false;
  // After a prompt change the old assignments still steer the next call, so groups keep their names.
  const ready = store.load().then((s) => {
    if (s.key === key) state = { ...state, ...s };
    else if (s.assign) state = { ...state, assign: s.assign };
  });

  const due = (sessions, basis, now) => {
    if (state.error && now - state.at < RETRY_AFTER_ERROR_MS) return false;
    if (sessions.some((s) => !(s.id in state.assign))) return true;
    return basis !== state.basis && now - state.at >= REGROUP_MS;
  };

  return {
    ready,
    request(sessions) {
      if (!runner.enabled || running || !sessions.length) return;
      // The basis leaves out previous assignments, or every regroup would invalidate itself.
      const basis = hash(JSON.stringify(sessions));
      if (!due(sessions, basis, Date.now())) return;
      running = true;
      const ids = new Set(sessions.map((s) => s.id));
      runner.run(`groups ${sessions.length}`, groupInput(sessions, state.assign), GROUP_SCHEMA, GROUP_SYSTEM).then((r) => {
        running = false;
        if (!r.output) {
          state = { ...state, at: Date.now(), error: r.error };
        } else {
          const fresh = Object.fromEntries(r.output.groups.flatMap((g) => g.sessionIds.map((id) => [id, g.name.trim()])));
          // Every requested id gets an entry, even one the model left out, so it never re-triggers a call.
          const assign = Object.fromEntries([...ids].map((id) => [id, fresh[id] ?? state.assign[id] ?? null]));
          const summaries = Object.fromEntries(r.output.groups.map((g) => [g.name.trim().toLowerCase(), g.summary.trim()]));
          state = { key, assign, summaries, basis, at: Date.now(), error: null };
        }
        store.save(state);
      });
    },
    get: (id) => state.assign[id] ?? null,
    // Keyed by lowercased group name, which is also how the page names a lane.
    summaries: () => state.summaries,
    pending: () => running,
  };
}
