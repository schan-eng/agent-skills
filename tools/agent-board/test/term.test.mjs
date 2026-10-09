import assert from "node:assert/strict";
import { test } from "node:test";
import { ansi, clean, createKeyReader, fit, keysOf, width, wrap } from "../src/term.mjs";

const ACUTE = String.fromCodePoint(0x301);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const lineWidth = (spans) => spans.reduce((n, [t]) => n + width(t), 0);

test("width counts East Asian characters and emoji as two columns and combining marks as none", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("日本"), 4);
  assert.equal(width("👍🏽"), 2);
  assert.equal(width(`e${ACUTE}`), 1);
  assert.equal(width("●◆✓…"), 4);
});

test("fit makes a line exactly as wide as asked, cutting once with an ellipsis", () => {
  assert.deepEqual(fit([["日本語テキスト", "bold"], ["tail", ""]], 6), [["日本…", "bold"], [" ", ""]]);
  assert.deepEqual(fit([["ab", "x"]], 4), [["ab", "x"], ["  ", ""]]);
  assert.equal(lineWidth(fit([["a\x1b[31mb\tc", ""]], 10)), 10);
});

test("wrap breaks at spaces, splits words wider than a line, and keeps line breaks", () => {
  assert.deepEqual(wrap("aaaa bbbbbbbbbbbb 日本語日本語 c\n\nd", 5), ["aaaa", "bbbbb", "bbbbb", "bb", "日本", "語日", "本語", "c", "", "d"]);
  assert.deepEqual(wrap("xyz", 0), ["x", "y", "z"]);
});

test("clean keeps escape sequences and invisible characters out of the terminal", () => {
  assert.equal(clean(`a\x1b[31mred${ZERO_WIDTH_SPACE}b\tc\nd`), "a[31mredb c d");
});

test("keysOf names keys whatever modifier was held, and keeps typed characters whole", () => {
  const named = keysOf("\x1b[A\x1b[1;5B\x1bOC\x1b[5~a\r\n\x03\x1bx👍🏽\x7f\t\x1b[Z\x1b").map((k) => (k.ch ? `${k.name}:${k.ch}` : k.name));
  assert.deepEqual(named, ["up", "down", "right", "pageup", "char:a", "enter", "ctrl:c", "meta:x", "char:👍🏽", "backspace", "tab", "backtab", "escape"]);
});

test("a bracketed paste is one key, even across chunks", () => {
  const read = createKeyReader();
  assert.deepEqual([...read("x\x1b[200~line1\nli"), ...read("ne2\x1b[201~y")], [{ name: "char", ch: "x" }, { name: "paste", text: "line1\nline2" }, { name: "char", ch: "y" }]);
});

test("ansi styles spans; without color it keeps bold and the like, and shows grey as dim", () => {
  assert.equal(ansi([["x", "bold yellow"], ["y", ""]]), "\x1b[1;33mx\x1b[0my");
  assert.equal(ansi([["x", "bold gray"], ["y", "claude"]], false), "\x1b[1;2mx\x1b[0my");
});
