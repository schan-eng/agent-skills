import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accept, connectUnix } from "../src/ws.mjs";

// The board's WebSocket server and its Unix-socket client, the one it uses for Codex's daemon, talking to each other.
test("messages round-trip between connectUnix and accept, at every frame-length size", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ab-ws-"));
  const path = join(dir, "s.sock");
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const ws = accept(req, socket, head);
    ws.onmessage = (text) => ws.send(`${text.length}:${text.slice(0, 3)}`);
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const ws = await connectUnix(path);
  const reply = () => new Promise((resolve) => (ws.onmessage = resolve));
  for (const size of [5, 300, 70_000]) {
    ws.send("a".repeat(size));
    assert.equal(await reply(), `${size}:${"a".repeat(Math.min(size, 3))}`);
  }
  const closed = new Promise((resolve) => (ws.onclose = resolve));
  ws.close();
  await closed;
});

test("connectUnix rejects when nothing listens", async () => {
  await assert.rejects(connectUnix(join(tmpdir(), "ab-ws-missing.sock")));
});
