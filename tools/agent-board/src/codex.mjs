// Model calls through `codex exec`, the board's Codex engine. Codex runs on the ChatGPT plan, so a call costs no dollars,
// and it reaches Linear and Notion through the MCP servers in the user's own Codex config.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Codex's structured output is strict: every property is required and every enum is typed. An optional property
// becomes a required one that may be null, which the callers' cleaners already drop.
export function strictSchema(s) {
  if (!s || typeof s !== "object") return s;
  const out = { ...s };
  if (s.items) out.items = strictSchema(s.items);
  if (s.enum && !s.type && s.enum.every((v) => typeof v === "string")) out.type = "string";
  if (s.properties) {
    const required = new Set(s.required ?? []);
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, required.has(k) ? strictSchema(v) : { anyOf: [strictSchema(v), { type: "null" }] }]));
    out.required = Object.keys(s.properties);
  }
  return out;
}

// Codex does not ask before an MCP call in exec mode, so every server is switched off except the tools `allow` names.
// Plugins go too: their servers are not in config.toml, so a per-server override fails there ("invalid transport").
const NO_PLUGINS = ["-c", "features.plugins=false"];
async function mcpFlags(allow) {
  const { stdout } = await promisify(execFile)("codex", ["mcp", "list", "--json", ...NO_PLUGINS], { timeout: 30_000 });
  return [
    ...NO_PLUGINS,
    ...JSON.parse(stdout).flatMap(({ name }) =>
      allow[name] ? ["-c", `mcp_servers.${name}.enabled_tools=${JSON.stringify(allow[name])}`] : ["-c", `mcp_servers.${name}.enabled=false`],
    ),
  ];
}

const failure = (text) => {
  const plain = text.replace(ANSI_RE, "");
  return plain.match(/"message":\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? plain.trim().split("\n").at(-1) ?? "no output";
};

// Runs one read-only `codex exec` in `cwd` and resolves { output, costUsd: 0, modelId } or { error }.
export async function callCodex(prompt, { cwd, env, model, effort, schema, timeoutMs, allow = {} }) {
  const base = join(cwd, `codex-${randomUUID()}`);
  try {
    await fs.writeFile(`${base}.schema.json`, JSON.stringify(strictSchema(schema)));
    const args = [
      "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-C", cwd,
      "-m", model, "-c", `model_reasoning_effort="${effort}"`, ...(await mcpFlags(allow)),
      "--output-schema", `${base}.schema.json`, "-o", `${base}.out.json`, "-",
    ];
    const { code, log } = await new Promise((resolve) => {
      const child = spawn("codex", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let log = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, log: String(e.message ?? e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, log });
      });
      child.stdin.end(prompt);
    });
    if (code === null) return { error: `Timed out after ${Math.round(timeoutMs / 60_000)} minutes.` };
    if (code !== 0) return { error: `codex exec exited ${code}: ${failure(log).slice(0, 300)}` };
    return { output: JSON.parse(await fs.readFile(`${base}.out.json`, "utf8")), costUsd: 0, modelId: `codex ${model}` };
  } catch (e) {
    return { error: `codex: ${String(e.message ?? e).slice(0, 300)}` };
  } finally {
    await Promise.all([fs.rm(`${base}.schema.json`, { force: true }), fs.rm(`${base}.out.json`, { force: true })]);
  }
}
