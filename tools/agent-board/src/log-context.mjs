// PostToolUse hook: appends what a Notion, Linear, Slack or Artifact call touched to context-log.jsonl, with titles
// from its full result, and kept after Claude Code deletes old conversations. It never blocks or fails the call.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extract, resultText } from "./context.mjs";
import { DATA } from "./paths.mjs";

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const h = JSON.parse(raw);
  const { sources, learned } = extract(h.tool_name, h.tool_input ?? {}, resultText(h.tool_response));
  if (h.session_id && (sources.length || learned)) {
    await mkdir(DATA, { recursive: true });
    await appendFile(join(DATA, "context-log.jsonl"), `${JSON.stringify({ sessionId: h.session_id, toolUseId: h.tool_use_id ?? null, at: new Date().toISOString(), tool: h.tool_name, sources, learned })}\n`);
  }
} catch {}
