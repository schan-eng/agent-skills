// Codex sessions on the board: threads on Codex's shared app-server daemon, the one `codex agents` and the Codex app use.
// A thread runs in the daemon whether or not anything watches it, so the board lists, messages, interrupts, renames,
// archives and deletes threads over its control socket, and approvals are answered in a Codex terminal (`codex resume --remote`).
import { homedir } from "node:os";
import { join } from "node:path";
import { connectUnix } from "./ws.mjs";

const CODEX_SOCKET = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
const CALL_TIMEOUT_MS = 20_000;
const LIST_TTL_MS = 3000;
const RECENT_MS = 7 * 86_400_000;
const MAX_ITEMS = 150;
// Threads Claude Code's Codex plugin starts for its own sessions are part of those sessions, not cards of their own.
const HIDDEN_ORIGINATORS = new Set(["Claude Code"]);
const WAITING = { waitingOnApproval: "Waiting for your approval. Answer it in the Terminal tab.", waitingOnUserInput: "Waiting for your answer. Reply in the Terminal tab." };

// The board keys cards by 8 hex characters. A Codex id is time-ordered, so its head repeats for threads started within
// about a minute of each other; its tail is random.
export const codexShort = (id) => id.replace(/-/g, "").slice(-8);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One JSON-RPC connection, opened on first use and again after it drops.
function daemon(socketPath) {
  let conn = null;
  let next = 1;
  const request = (c, method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => (c.pending.delete(id), reject(new Error(`Codex ${method} timed out`))), CALL_TIMEOUT_MS);
      c.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      c.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  const open = () =>
    (conn ??= (async () => {
      const ws = await connectUnix(socketPath);
      const c = { ws, pending: new Map() };
      ws.onmessage = (text) => {
        let m;
        try {
          m = JSON.parse(text);
        } catch {
          return;
        }
        // Requests from the daemon, such as an approval, are left for a Codex terminal to answer.
        if (m.method || !c.pending.has(m.id)) return;
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
        else p.resolve(m.result);
      };
      ws.onclose = () => {
        conn = null;
        for (const p of c.pending.values()) p.reject(new Error("The Codex daemon closed the connection."));
      };
      await request(c, "initialize", { clientInfo: { name: "agent-board", version: "1" } });
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
      return c;
    })().catch((e) => {
      conn = null;
      throw e;
    }));
  return { call: async (method, params = {}) => request(await open(), method, params) };
}

const textOf = (content) => (content ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim();
const cap = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

// A thread item as the Conversation tab's steps: user, text, thinking, tool with its result, or note.
function stepsOf({ item, startedAtMs, completedAtMs }) {
  const at = new Date(completedAtMs ?? startedAtMs ?? Date.now()).toISOString();
  const tool = (name, input, text, error = false) => [
    { kind: "tool", at, id: item.id, name, input },
    ...(text == null ? [] : [{ kind: "result", at, id: item.id, text: cap(text, 8000), error }]),
  ];
  switch (item.type) {
    case "userMessage":
      return [{ kind: "user", at, text: cap(textOf(item.content), 20_000) }];
    case "agentMessage":
      return item.text?.trim() ? [{ kind: "text", at, text: cap(item.text, 20_000) }] : [];
    case "reasoning": {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter((s) => typeof s === "string").join("\n").trim();
      return text ? [{ kind: "thinking", at, text: cap(text, 8000) }] : [];
    }
    case "plan":
      return [{ kind: "note", at, text: cap(`Plan: ${item.text}`, 4000) }];
    case "commandExecution":
      return tool("Shell", { command: item.command }, item.aggregatedOutput ?? "", item.exitCode != null && item.exitCode !== 0);
    case "fileChange":
      return tool("Edit", { files: (item.changes ?? []).map((c) => c.path).filter(Boolean) }, item.status ?? "");
    case "mcpToolCall":
      return tool(`${item.server}.${item.tool}`, item.arguments ?? {}, JSON.stringify(item.error ?? item.result ?? "").slice(0, 8000), Boolean(item.error));
    case "webSearch":
      return tool("WebSearch", { query: item.query }, null);
    case "contextCompaction":
      return [{ kind: "note", at, text: "Conversation compacted" }];
    default:
      return [];
  }
}

// Whether the session's recent work changed files, which is how the board tells building from researching.
const edited = (entries) => entries.some((e) => e.item.type === "fileChange");

export function createCodexAgents() {
  const rpc = daemon(CODEX_SOCKET);
  let listed = { at: 0, threads: [], error: null };
  let listing = null;
  // After the board changes a thread, the next listing reads its new status.
  const stale = () => (listed = { ...listed, at: 0 });
  const history = new Map(); // threadId -> { updatedAt, entries }, oldest first

  // Archived threads are all shown, for the Archived tab; live ones only while recent.
  const shown = (t, now) =>
    !t.ephemeral && !t.parentThreadId && !HIDDEN_ORIGINATORS.has(t.originator) && (t.archived || t.status?.type === "active" || now - t.updatedAt * 1000 < RECENT_MS);
  // Listing is cached briefly, since every board poll asks and the call takes a few hundred milliseconds.
  async function threads({ fresh = false } = {}) {
    if (fresh) await listing;
    if (!fresh && Date.now() - listed.at < LIST_TTL_MS) return listed;
    if (fresh) listing = null;
    listing ??= Promise.all([false, true].map((archived) => rpc.call("thread/list", { limit: 50, sortKey: "updated_at", archived }).then((r) => r.data.map((t) => ({ ...t, archived })))))
      .then((pages) => ({ at: Date.now(), threads: pages.flat().filter((t) => shown(t, Date.now())), error: null }))
      .catch((e) => ({ at: Date.now(), threads: listed.threads, error: `Codex: ${e.message}` }))
      .then((l) => ((listed = l), (listing = null), l));
    return listing;
  }

  // The latest items of a thread, fetched again only after the thread changes.
  async function entries(t) {
    const h = history.get(t.id);
    if (h && h.updatedAt === t.updatedAt) return h.entries;
    const r = await rpc.call("thread/items/list", { threadId: t.id, sortDirection: "desc", limit: MAX_ITEMS });
    const fresh = r.data.toReversed();
    history.set(t.id, { updatedAt: t.updatedAt, entries: fresh });
    return fresh;
  }

  // A thread started a moment ago may be missing from the cached list, so a miss lists again once.
  const pick = (l, short) => l.threads.find((t) => codexShort(t.id) === short);
  const find = async (short) => pick(await threads(), short) ?? pick(await threads({ fresh: true }), short) ?? null;
  const activeTurn = async (threadId) => {
    const r = await rpc.call("thread/turns/list", { threadId, limit: 1, itemsView: "notLoaded" });
    const turn = r.data[0];
    return turn?.status === "inProgress" ? turn.id : null;
  };
  const input = (text) => [{ type: "text", text, text_elements: [] }];
  const change = async (method, params) => {
    await rpc.call(method, params);
    stale();
  };

  return {
    threads,
    find,
    // What the board shows and summarizes for one thread.
    async facts(t) {
      const list = await entries(t).catch(() => history.get(t.id)?.entries ?? []);
      const prompts = list.filter((e) => e.item.type === "userMessage").map((e) => textOf(e.item.content)).filter(Boolean);
      // Codex marks each turn's closing message; its progress notes along the way are not the session's word.
      const messages = list.filter((e) => e.item.type === "agentMessage" && e.item.text?.trim());
      const finals = messages.filter((e) => e.item.phase === "final_answer");
      const replies = (finals.length ? finals : messages).map((e) => e.item.text);
      const flag = t.status?.type === "active" ? (t.status.activeFlags ?? []).find((f) => WAITING[f]) : null;
      const column = flag ? "needs-input" : t.status?.type === "active" ? "working" : t.status?.type === "systemError" ? "stopped" : "done";
      return { prompts, replies, column, waiting: Boolean(flag), blocker: flag ? WAITING[flag] : null, phase: edited(list) ? "build" : "research" };
    },
    // Steps after the item `from`, or the latest ones with `reset` when `from` is gone or absent.
    async steps(t, from) {
      const list = await entries(t);
      const at = from ? list.findIndex((e) => e.item.id === from) : -1;
      const reset = at < 0;
      return { next: list.at(-1)?.item.id ?? from ?? null, reset, steps: list.slice(reset ? 0 : at + 1).flatMap(stepsOf) };
    },
    // A running turn is steered; otherwise the thread is loaded and a new turn starts. The board then lets go of the
    // thread, so its approvals wait for a Codex terminal instead of for the board.
    async send(threadId, text) {
      const turnId = await activeTurn(threadId);
      if (turnId) {
        await rpc.call("turn/steer", { threadId, expectedTurnId: turnId, input: input(text) });
        return "Added to the running turn.";
      }
      await rpc.call("thread/resume", { threadId, excludeTurns: true });
      await rpc.call("turn/start", { threadId, input: input(text) });
      await rpc.call("thread/unsubscribe", { threadId });
      stale();
      return "Sent. Codex is working on it.";
    },
    async interrupt(threadId) {
      const turnId = await activeTurn(threadId);
      if (!turnId) return null;
      await rpc.call("turn/interrupt", { threadId, turnId });
      stale();
      return turnId;
    },
    async start({ cwd, prompt, name }) {
      const { thread } = await rpc.call("thread/start", { cwd });
      if (name) await rpc.call("thread/name/set", { threadId: thread.id, name });
      await rpc.call("turn/start", { threadId: thread.id, input: input(prompt) });
      await rpc.call("thread/unsubscribe", { threadId: thread.id });
      stale();
      return thread;
    },
    // Codex refuses to rename an archived thread, and archiving takes it out of `codex agents`.
    rename: (threadId, name) => change("thread/name/set", { threadId, name }),
    archive: (threadId) => change("thread/archive", { threadId }),
    unarchive: (threadId) => change("thread/unarchive", { threadId }),
    async remove(threadId) {
      await change("thread/delete", { threadId });
      history.delete(threadId);
    },
    isThreadId: (id) => UUID_RE.test(id),
  };
}
