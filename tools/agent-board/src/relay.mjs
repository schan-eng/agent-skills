// Hands this terminal, still on the board's alternate screen, to one of the board's shared terminals (an agent view or
// a session) until Ctrl+\ or Ctrl+Z comes back to the board, or its program exits.

// Ctrl+\ (the detach key of dtach and abduco) and Ctrl+Z, as typed, and as the kitty keyboard protocol and xterm's
// modifyOtherKeys send them once a program asks for those.
const BACK = /\x1c|\x1a|\x1b\[(?:92|122)(?::\d*)*;(\d+)(?::1)?u|\x1b\[27;(\d+);(?:92|122)~/g;
// Ctrl and no other modifier; Caps Lock and Num Lock add to the modifier number too.
const ctrlOnly = (mods) => ((Number(mods) - 1) & ~(64 | 128)) === 4;
// Where in typed input the first key back to the board is, or null.
export function backAt(chunk) {
  for (const m of chunk.matchAll(BACK)) {
    const mods = m[1] ?? m[2];
    if (mods == null || ctrlOnly(mods)) return { at: m.index, end: m.index + m[0].length };
  }
  return null;
}

// A replay's queries were answered when the screen was first drawn; asked again, the answers would reach the program as
// typing. Device attributes, version, cursor position and status, keyboard flags, modes, window sizes, colors, termcaps.
const QUERIES = /\x1b\[(?:[>=]?0?c|>0?q|\??[56]n|\?u|\??[\d;]*\$p|1[1-9]t|2[01]t)|\x1b\][\d;]*;\?(?:\x07|\x1b\\)|\x1bP\+q[^\x1b]*\x1b\\/g;
export const withoutQueries = (s) => s.replace(QUERIES, "");

// The board's screen made ready for a program: whole, cleared, wrapping, with a cursor.
const TAKE = "\x1b[?2026l\x1b[0m\x1b[H\x1b[2J\x1b[?7h\x1b[?25h";
// What a program may have switched on, switched off again: synchronized output, keyboard protocols, mouse and focus
// reports, color scheme reports, application cursor keys and keypad, origin mode, a scroll region, and colors.
export const RESTORE = "\x1b[?2026l\x1b[<99u\x1b[>4;0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2031l\x1b[?1l\x1b>\x1b[?6l\x1b[r\x1b[0m";

// Relays `path`, a terminal WebSocket on the board at `url`, until it ends. Resolves with why: "back" with what was typed
// after the key back, "exit", "error" with the board's message, or "lost".
export function relay({ url, path, input, output, size }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}${path}${path.includes("?") ? "&" : "?"}cols=${size.cols}&rows=${size.rows}`, {
      headers: { origin: new URL(url).origin },
    });
    // Keys typed while it connects wait for it.
    const queued = [];
    const send = (msg) => (ws.readyState === WebSocket.OPEN ? ws.send(JSON.stringify(msg)) : queued.push(msg));
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      input.off("data", onInput);
      output.off("resize", onResize);
      ws.close();
      output.write(RESTORE);
      resolve(result);
    };
    const onInput = (chunk) => {
      const back = backAt(chunk);
      if (!back) return send({ data: chunk });
      if (back.at) send({ data: chunk.slice(0, back.at) });
      finish({ why: "back", rest: chunk.slice(back.end) });
    };
    const onResize = () => send({ cols: output.columns, rows: output.rows });
    ws.onopen = () => queued.splice(0).forEach(send);
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (typeof m.data === "string") output.write(m.replay ? withoutQueries(m.data) : m.data);
      if (m.exit) finish({ why: "exit" });
      if (m.error) finish({ why: "error", message: String(m.error) });
    };
    ws.onerror = (e) => finish({ why: "lost", message: e.message });
    ws.onclose = () => finish({ why: "lost" });
    output.write(TAKE);
    input.on("data", onInput);
    output.on("resize", onResize);
  });
}
