import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { backAt, relay, RESTORE, withoutQueries } from "../src/relay.mjs";
import { accept } from "../src/ws.mjs";

test("backAt finds Ctrl+\\ and Ctrl+Z however the terminal sends them, and nothing else", () => {
  const found = (s) => backAt(s) && s.slice(backAt(s).at, backAt(s).end);
  assert.equal(found("ab\x1cyz"), "\x1c");
  assert.equal(found("\x1a"), "\x1a");
  // The kitty keyboard protocol, with Caps Lock on, with alternate keys, and xterm's modifyOtherKeys.
  for (const seq of ["\x1b[92;5u", "\x1b[92;69u", "\x1b[92:124;5u", "\x1b[122;5u", "\x1b[27;5;92~"]) assert.equal(found(`x${seq}y`), seq);
  // A release, Ctrl+Shift+\ and a plain backslash are typing.
  for (const s of ["\x1b[92;5:3u", "\x1b[92;6u", "\\", "\x1b[27;6;92~"]) assert.equal(backAt(s), null);
});

test("withoutQueries keeps what a replay draws and drops the questions it asked the terminal", () => {
  const replay = "\x1b[?2004h\x1b[>7u\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x07\x1b[?u\x1b[c\x1b[>0q\x1b]7501;?\x07\x1b[?2026$p\x1b[16t\x1b[1;1Hscreen";
  assert.equal(withoutQueries(replay), "\x1b[?2004h\x1b[>7u\x1b[1;1Hscreen");
});

class Output extends EventEmitter {
  columns = 100;
  rows = 30;
  text = "";
  write(s) {
    this.text += s;
    return true;
  }
}
const until = async (check) => {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
  assert.fail("timed out");
};

test("relay shows the shared terminal and sends it what is typed, until the key back or its exit", async (t) => {
  const server = createServer();
  const sockets = new Set();
  const asked = [];
  const got = [];
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    asked.push([req.url, req.headers.origin]);
    const ws = accept(req, socket, head);
    ws.send(JSON.stringify({ size: { cols: 100, rows: 30 } }));
    ws.send(JSON.stringify({ data: "replayed\x1b[c", replay: true }));
    ws.onmessage = (text) => {
      const m = JSON.parse(text);
      got.push(m);
      ws.send(JSON.stringify(m.data === "bye" ? { exit: true } : { data: `live-${m.data}\x1b[c` }));
    };
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const input = new EventEmitter();
  const output = new Output();
  const back = relay({ url, path: "/api/agent-view/term?agent=codex", input, output, size: { cols: 100, rows: 30 } });
  // What is typed before the connection opens waits for it.
  input.emit("data", "early");
  await until(() => output.text.includes("live-early"));
  assert.ok(output.text.includes("replayed") && !output.text.includes("replayed\x1b[c"));
  assert.ok(output.text.includes("live-early\x1b[c"));
  output.emit("resize");
  input.emit("data", "ab\x1cq");
  assert.deepEqual(await back, { why: "back", rest: "q" });
  await until(() => got.length === 3);
  assert.deepEqual(got, [{ data: "early" }, { cols: 100, rows: 30 }, { data: "ab" }]);
  assert.deepEqual(asked, [["/api/agent-view/term?agent=codex&cols=100&rows=30", url]]);
  assert.ok(output.text.endsWith(RESTORE));
  assert.equal(input.listenerCount("data"), 0);

  const exited = relay({ url, path: "/api/card/aaaa0001/term", input, output, size: { cols: 100, rows: 30 } });
  input.emit("data", "bye");
  assert.deepEqual(await exited, { why: "exit" });
});

test("relay says so when the board refuses or cannot be reached", async () => {
  const input = new EventEmitter();
  const output = new Output();
  const r = await relay({ url: "http://127.0.0.1:9", path: "/api/agent-view/term", input, output, size: { cols: 100, rows: 30 } });
  assert.equal(r.why, "lost");
  assert.ok(output.text.endsWith(RESTORE));
});
