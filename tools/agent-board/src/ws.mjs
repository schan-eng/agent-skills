// The WebSocket server the board's terminals need (RFC 6455): text messages both ways, no extensions.
// Browsers pool WebSockets apart from their six HTTP connections per host, so open terminals cannot starve the page.
// The same framing also makes a client, for Codex's app-server daemon, which speaks WebSocket on a Unix socket.
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 1 << 20;
// A viewer this far behind, such as a frozen background tab, is dropped; its page reconnects when it wakes.
const MAX_BUFFERED = 8 << 20;
// The daemon's own limit on one message, which a long thread's history can approach.
const MAX_CLIENT_MESSAGE = 16 << 20;

export const refuse = (socket, code, reason) => socket.end(`HTTP/1.1 ${code} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);

// A client masks what it sends; a server never does.
const frame = (op, payload, masked) => {
  const n = payload.length;
  const size = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const head = Buffer.alloc(size + (masked ? 4 : 0));
  head[0] = 0x80 | op;
  if (n < 126) {
    head[1] = n;
  } else if (n < 65536) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  if (!masked) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const mask = randomBytes(4);
  mask.copy(head, size);
  const body = Buffer.from(payload);
  for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, body]);
};

// Frames one side of an open connection. The caller sets `onmessage(text)` and `onclose()` before its next await.
function wire(socket, { client, maxMessage }) {
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let parts = [];
  let closed = false;
  const write = (op, payload) => {
    if (closed) return;
    if (socket.writableLength > MAX_BUFFERED) return socket.destroy();
    socket.write(frame(op, payload, client));
  };
  const close = (code = 1000) => {
    write(0x8, Buffer.from([code >> 8, code & 255]));
    closed = true;
    socket.end();
  };
  const ws = { send: (text) => write(0x1, Buffer.from(text)), close, onmessage: null, onclose: null };
  const parse = () => {
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = Boolean(buf[1] & 0x80);
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      // Browsers always mask what they send, and a server never does.
      if (masked === client) return close(1002);
      if (len + parts.reduce((n, p) => n + p.length, 0) > maxMessage) return close(1009);
      const start = at + (masked ? 4 : 0);
      if (buf.length < start + len) return;
      const payload = Buffer.from(buf.subarray(start, start + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[at + (i & 3)];
      buf = buf.subarray(start + len);
      if (op === 0x8) return close();
      if (op === 0x9) write(0xa, payload);
      if (op >= 0x8) continue;
      parts.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(parts).toString("utf8");
      parts = [];
      ws.onmessage?.(text);
    }
  };
  socket.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    parse();
  });
  socket.on("close", () => {
    closed = true;
    ws.onclose?.();
  });
  socket.on("error", () => {});
  return ws;
}

// Completes an upgrade request's handshake.
export function accept(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" || !key) {
    refuse(socket, 400, "Bad Request");
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
  const ws = wire(socket, { client: false, maxMessage: MAX_MESSAGE });
  if (head?.length) socket.unshift(head);
  return ws;
}

// Opens a WebSocket over the Unix socket at `path`; rejects when the server refuses the upgrade or does not answer.
export function connectUnix(path, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path });
    const key = randomBytes(16).toString("base64");
    let reply = Buffer.alloc(0);
    const fail = (e) => {
      socket.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error(`no WebSocket upgrade from ${path} in ${timeoutMs}ms`)), timeoutMs);
    socket.once("error", (e) => (clearTimeout(timer), reject(e)));
    socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    const onData = (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      const head = reply.subarray(0, end).toString("latin1");
      const accepted = head.match(/^sec-websocket-accept:\s*(\S+)/im)?.[1];
      if (!/^HTTP\/1\.1 101 /.test(head) || accepted !== createHash("sha1").update(key + GUID).digest("base64")) return fail(new Error(`WebSocket upgrade refused: ${head.split("\r\n")[0]}`));
      const ws = wire(socket, { client: true, maxMessage: MAX_CLIENT_MESSAGE });
      const rest = reply.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(ws);
    };
    socket.on("data", onData);
  });
}
