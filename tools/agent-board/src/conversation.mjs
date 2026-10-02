// A session's transcript read as the steps its terminal shows: prompts, replies, tool calls and their results.
import { promises as fs } from "node:fs";

const FIRST_READ = 4 << 20; // a first read starts this far before the end
const MAX_STEPS = 500;
const NOISE_RE = /^(<local-command|<bash-|<task-notification>|<teammate-message|Another Claude session sent a message|\[Request interrupted|Caveat:)/;

const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…[${(s.length - n).toLocaleString()} more characters]` : s);
export const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "").trim();
const resultText = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p?.type === "text" ? p.text : p?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n") : "";
// Long fields are cut so one Write of a big file cannot swamp the page.
const capInput = (input) => JSON.parse(JSON.stringify(input ?? {}, (_, v) => (typeof v === "string" ? cap(v, 4000) : v)));

// What a person typed: not hook feedback, skill bodies, tool results, or injected notices. `command` names a slash command.
export function typed(rec) {
  if (rec.type !== "user" || rec.isMeta || rec.isSidechain || (rec.origin && rec.origin.kind !== "human")) return null;
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some((p) => p?.type === "tool_result")) return null;
  const text = textOf(c);
  const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (cmd) {
    const command = cmd[1].trim();
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return { text: `/${command}${args ? ` ${args}` : ""}`, command };
  }
  return !text || NOISE_RE.test(text) ? null : { text };
}

function noteOf(rec) {
  const text = textOf(rec.message?.content);
  if (text.startsWith("[Request interrupted")) return "Interrupted";
  if (rec.origin?.kind === "task-notification" || text.startsWith("<task-notification>")) {
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    return `Background task update${summary ? `: ${cap(summary, 300)}` : ""}`;
  }
  if (text.startsWith("Another Claude session sent a message") || text.startsWith("<teammate-message")) return "Message from another session";
  return null;
}

function stepsOf(rec) {
  if (rec.isSidechain) return [];
  const at = rec.timestamp ?? null;
  if (rec.type === "system" && rec.subtype === "compact_boundary") return [{ kind: "note", at, text: "Conversation compacted" }];
  if (rec.type === "assistant") {
    // A local command such as /rename records this placeholder; the terminal never shows it.
    if (rec.message?.model === "<synthetic>" && textOf(rec.message.content) === "No response requested.") return [];
    return (rec.message?.content ?? []).flatMap((p) => {
      if (p?.type === "text" && p.text.trim()) return [{ kind: "text", at, text: cap(p.text, 20_000) }];
      if (p?.type === "thinking" && p.thinking?.trim()) return [{ kind: "thinking", at, text: cap(p.thinking, 8000) }];
      if (p?.type === "tool_use") return [{ kind: "tool", at, id: p.id, name: p.name, input: capInput(p.input) }];
      return [];
    });
  }
  if (rec.type !== "user") return [];
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some((p) => p?.type === "tool_result")) {
    return c.filter((p) => p?.type === "tool_result").map((p) => ({ kind: "result", at, id: p.tool_use_id, text: cap(resultText(p.content), 8000), error: Boolean(p.is_error) }));
  }
  const t = typed(rec);
  if (t) return [{ kind: "user", at, text: cap(t.text, 20_000) }];
  const note = rec.isMeta ? null : noteOf(rec);
  return note ? [{ kind: "note", at, text: note }] : [];
}

// Steps written since byte offset `from`; without a valid offset, the last MAX_STEPS and `reset: true`.
// `next` is the offset to pass back: it stops at the last complete line, since the writer may be mid-line.
export async function readSteps(path, from) {
  let fh;
  try {
    fh = await fs.open(path);
  } catch {
    return { next: 0, reset: true, steps: [] };
  }
  try {
    const { size } = await fh.stat();
    const reset = !(Number.isInteger(from) && from >= 0 && from <= size);
    const start = reset ? Math.max(0, size - FIRST_READ) : from;
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const head = reset && start > 0 ? buf.indexOf(10) + 1 : 0;
    const tail = Math.max(head, buf.lastIndexOf(10) + 1);
    const steps = [];
    for (const line of buf.subarray(head, tail).toString("utf8").split("\n")) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      steps.push(...stepsOf(rec));
    }
    return { next: start + tail, reset, steps: reset ? steps.slice(-MAX_STEPS) : steps };
  } finally {
    await fh.close();
  }
}
