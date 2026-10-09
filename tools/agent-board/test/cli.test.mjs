import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const CLI = fileURLToPath(new URL("../bin/agent-board.mjs", import.meta.url));
const has = (p) => stat(p).then(() => true, () => false);
const line = (at, tool) => JSON.stringify({ sessionId: "s1", at, tool, sources: [] });

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "ab-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "data");
  // A free port, so the board on the usual one never answers for these runs.
  const env = { ...process.env, AGENT_BOARD_HOME: home, AGENT_BOARD_PORT: "47998" };
  const cli = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { env }).then((r) => r.stdout);
  return { root, home, cli };
}

test("migrate copies data but not code, and never overwrites", async (t) => {
  const { root, home, cli } = await sandbox(t);
  const legacy = join(root, "legacy");
  await mkdir(join(legacy, ".cache", "run"), { recursive: true });
  await mkdir(join(legacy, "archive", "s1"), { recursive: true });
  await Promise.all([
    writeFile(join(legacy, "server.mjs"), "// code"),
    writeFile(join(legacy, "index.html"), "<html>"),
    writeFile(join(legacy, "tags.json"), '{"s1":["old"]}'),
    writeFile(join(legacy, ".cache", "summaries.json"), "{}"),
    writeFile(join(legacy, ".cache", "run", "call.json"), "{}"),
    writeFile(join(legacy, "archive", "s1", "conversation.jsonl"), "{}\n"),
    writeFile(join(legacy, "context-log.jsonl"), `${line("2026-10-01T10:00:00Z", "a")}\n`),
  ]);

  await cli("migrate", "--from", legacy);
  assert.equal(await readFile(join(home, "tags.json"), "utf8"), '{"s1":["old"]}');
  assert.ok(await has(join(home, "cache", "summaries.json")));
  assert.ok(await has(join(home, "archive", "s1", "conversation.jsonl")));
  assert.ok(!(await has(join(home, "server.mjs"))));
  assert.ok(!(await has(join(home, "index.html"))));
  assert.ok(!(await has(join(home, "cache", "run", "call.json"))));

  // The new hook appended a line, the old one too; a second run keeps the data folder's files and merges the log.
  await writeFile(join(home, "tags.json"), '{"s1":["new"]}');
  await writeFile(join(home, "context-log.jsonl"), `${line("2026-10-01T10:00:00Z", "a")}\n${line("2026-10-01T12:00:00Z", "c")}\n`);
  await writeFile(join(legacy, "context-log.jsonl"), `${line("2026-10-01T10:00:00Z", "a")}\n${line("2026-10-01T11:00:00Z", "b")}\n`);
  const out = await cli("migrate", "--from", legacy);
  assert.match(out, /archive\/ \(merged\)/);
  assert.match(out, /kept the existing tags\.json/);
  assert.equal(await readFile(join(home, "tags.json"), "utf8"), '{"s1":["new"]}');
  const tools = (await readFile(join(home, "context-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).tool);
  assert.deepEqual(tools, ["a", "b", "c"]);
});

test("status reports the data folder and that nothing runs on a free port", async (t) => {
  const { home, cli } = await sandbox(t);
  const out = await cli("status");
  assert.match(out, /^Not running\./);
  assert.ok(out.includes(`Data: ${home}`));
});

test("status names the process holding the port when it is not the board", async (t) => {
  const { cli } = await sandbox(t);
  const server = createServer().listen(47998, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  assert.match(await cli("status"), new RegExp(`^Not running; port 47998 is held by pid ${process.pid}: `));
});

test("log-context writes what a hook event touched into the data folder", async (t) => {
  const { home } = await sandbox(t);
  const event = {
    session_id: "s1",
    tool_name: "mcp__plugin_linear_linear__get_issue",
    tool_input: { id: "ABC-12" },
    tool_response: JSON.stringify({ identifier: "ABC-12", title: "Example", url: "https://linear.app/acme/issue/ABC-12/example" }),
  };
  await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, "log-context"], { env: { ...process.env, AGENT_BOARD_HOME: home } }, (e) => (e ? reject(e) : resolve()));
    child.stdin.end(JSON.stringify(event));
  });
  const [entry] = (await readFile(join(home, "context-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(entry.sessionId, "s1");
  assert.deepEqual(entry.sources.map((s) => `${s.kind} ${s.id}`), ["linear-issue ABC-12"]);
});
