// Terminal plumbing for the TUI: display widths, lines of styled spans fitted to a width, ANSI output, key parsing, and
// a screen that rewrites only the lines that changed. A line is a list of [text, style] spans, style as "bold yellow".

const SEGMENTER = new Intl.Segmenter();
const VS16 = String.fromCodePoint(0xfe0f);
const WIDE = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd]];

export const graphemes = (s) => Array.from(SEGMENTER.segment(s), (x) => x.segment);
// Emoji drawn as pictures and East Asian wide characters take two columns; marks take none.
function graphemeWidth(g) {
  if (/^\p{M}+$/u.test(g)) return 0;
  if (/\p{Emoji_Presentation}/u.test(g) || (g.includes(VS16) && /\p{Extended_Pictographic}/u.test(g))) return 2;
  const cp = g.codePointAt(0);
  return WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}
export const width = (s) => graphemes(s).reduce((w, g) => w + graphemeWidth(g), 0);

// Text from sessions, GitHub and Slack reaches the terminal, so control and format characters, escapes among them, never do.
export const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "");

// Cuts text to at most `cols` columns, ending in an ellipsis when anything was cut.
export function cut(s, cols) {
  if (width(s) <= cols) return s;
  if (cols <= 0) return "";
  let out = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const w = graphemeWidth(g);
    if (used + w > cols - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

// A line fitted to exactly `cols` columns: cut where it reaches the edge, then padded.
export function fit(spans, cols) {
  const out = [];
  let left = cols;
  for (const [text, style = ""] of spans) {
    const t = clean(text);
    const shown = cut(t, left);
    if (shown) out.push([shown, style]);
    left -= width(shown);
    if (shown !== t) break;
  }
  return left > 0 ? [...out, [" ".repeat(left), ""]] : out;
}

// Splits text into pieces at most `cols` wide, each holding at least one grapheme.
function split(s, cols) {
  const pieces = [];
  let piece = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const w = graphemeWidth(g);
    if (piece && used + w > cols) {
      pieces.push(piece);
      piece = "";
      used = 0;
    }
    piece += g;
    used += w;
  }
  return [...pieces, piece];
}

// Word-wraps text to lines of at most `cols` columns, keeping its line breaks; a word wider than a line is split.
export function wrap(text, cols) {
  const max = Math.max(1, cols);
  return String(text ?? "").split(/\r?\n/).flatMap((para) => {
    const lines = [];
    let line = "";
    let used = 0;
    for (const word of clean(para).split(" ").filter(Boolean)) {
      const w = width(word);
      if (line && used + 1 + w <= max) {
        line += ` ${word}`;
        used += 1 + w;
        continue;
      }
      if (line) lines.push(line);
      const pieces = w > max ? split(word, max) : [word];
      lines.push(...pieces.slice(0, -1));
      line = pieces.at(-1);
      used = width(line);
    }
    return [...lines, line];
  });
}

const CODES = { bold: "1", dim: "2", italic: "3", underline: "4", inverse: "7", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", gray: "90", claude: "38;5;173", codex: "38;5;75" };
const COLORS = new Set(["red", "green", "yellow", "blue", "magenta", "cyan", "gray", "claude", "codex"]);
// Without color (NO_COLOR), grey text is shown dim and other colors are dropped.
export function ansi(spans, color = true) {
  return spans
    .map(([text, style]) => {
      const codes = (style ? style.split(" ") : []).map((n) => (color || !COLORS.has(n) ? CODES[n] : n === "gray" ? CODES.dim : null)).filter(Boolean);
      return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
    })
    .join("");
}

const FINAL = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab" };
const TILDE = { 1: "home", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };
// "[A", "[1;5A" (with a modifier), "[5~" or "OA": the key, whatever modifier was held.
const sequenceName = (seq) => (seq.at(-1) === "~" ? TILDE[parseInt(seq.slice(1), 10)] : FINAL[seq.at(-1)]) ?? "unknown";
const firstGrapheme = (s) => SEGMENTER.segment(s)[Symbol.iterator]().next().value.segment;

const NAMED = { "\x1b": "escape", "\r": "enter", "\n": "enter", "\x7f": "backspace", "\b": "backspace", "\t": "tab" };
// The key at the start of raw input, and how many characters it took.
function keyAt(rest) {
  const seq = rest.match(/^\x1b(\[[0-9;]*[@-~]|O[A-Za-z])/);
  if (seq) return [{ name: sequenceName(seq[1]) }, seq[0].length];
  const meta = rest.match(/^\x1b([^\x1b\[O\p{Cc}])/u);
  if (meta) return [{ name: "meta", ch: meta[1] }, meta[0].length];
  if (rest.startsWith("\r\n")) return [{ name: "enter" }, 2];
  const code = rest.charCodeAt(0);
  if (NAMED[rest[0]]) return [{ name: NAMED[rest[0]] }, 1];
  if (code < 0x20) return [{ name: "ctrl", ch: String.fromCharCode(code + 96) }, 1];
  const g = firstGrapheme(rest);
  return [{ name: "char", ch: g }, g.length];
}

// The keys in raw input: named keys, `ctrl` or `meta` with their letter, or `char` with the character typed.
export function keysOf(chunk) {
  const keys = [];
  for (let i = 0; i < chunk.length; ) {
    const [key, used] = keyAt(chunk.slice(i));
    keys.push(key);
    i += used;
  }
  return keys;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Reads raw input as keys, keeping a bracketed paste whole as one `paste` key even when it spans chunks.
export function createKeyReader() {
  let paste = null;
  return (chunk) => {
    const keys = [];
    let rest = chunk;
    while (rest) {
      if (paste !== null) {
        const end = rest.indexOf(PASTE_END);
        if (end < 0) {
          paste += rest;
          break;
        }
        keys.push({ name: "paste", text: paste + rest.slice(0, end) });
        paste = null;
        rest = rest.slice(end + PASTE_END.length);
        continue;
      }
      const start = rest.indexOf(PASTE_START);
      keys.push(...keysOf(start < 0 ? rest : rest.slice(0, start)));
      if (start < 0) break;
      paste = "";
      rest = rest.slice(start + PASTE_START.length);
    }
    return keys;
  };
}

// The alternate screen, without line wrap so a mis-measured line is clipped rather than spilling onto the next.
export function createScreen(out = process.stdout, input = process.stdin) {
  let shown = [];
  let active = false;
  return {
    size: () => ({ cols: out.columns || 80, rows: out.rows || 24 }),
    enter() {
      if (active) return;
      active = true;
      shown = [];
      input.setRawMode?.(true);
      input.resume();
      out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J");
    },
    leave() {
      if (!active) return;
      active = false;
      out.write("\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l");
      input.setRawMode?.(false);
      input.pause();
    },
    // Lines arrive as ANSI strings fitted to the width; changed ones are rewritten in one synchronized update.
    draw(lines) {
      const changed = lines.map((line, i) => (line === shown[i] ? "" : `\x1b[${i + 1};1H\x1b[2K${line}`)).join("");
      const gone = shown.slice(lines.length).map((_, i) => `\x1b[${lines.length + i + 1};1H\x1b[2K`).join("");
      shown = lines;
      if (changed || gone) out.write(`\x1b[?2026h${changed}${gone}\x1b[?2026l`);
    },
    clear() {
      shown = [];
      out.write("\x1b[2J");
    },
  };
}
