import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { codexShort } from "../src/codex-agents.mjs";
import { strictSchema } from "../src/codex.mjs";
import { sourceOfUrl, sourcesInText } from "../src/context.mjs";
import { dayOf, validDay } from "../src/digest.mjs";

test("validDay takes today and the 29 days before it, and nothing else", () => {
  const now = new Date(2026, 9, 2, 9, 30);
  assert.equal(validDay("2026-10-02", now), true);
  assert.equal(validDay("2026-09-03", now), true);
  assert.equal(validDay("2026-09-02", now), false);
  assert.equal(validDay("2026-10-03", now), false);
  assert.equal(validDay("2026-02-30", now), false);
  assert.equal(validDay("2026-9-30", now), false);
  assert.equal(validDay(undefined, now), false);
});

test("dayOf is the local calendar date", () => {
  assert.equal(dayOf(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("strictSchema makes optional properties required but nullable, and types bare string enums", () => {
  const s = strictSchema({
    type: "object",
    required: ["a"],
    properties: {
      a: { type: "string" },
      b: { enum: ["x", "y"] },
      c: { type: "array", items: { type: "object", properties: { d: { type: "number" } } } },
    },
  });
  assert.deepEqual(s.required, ["a", "b", "c"]);
  assert.deepEqual(s.properties.a, { type: "string" });
  assert.deepEqual(s.properties.b, { anyOf: [{ enum: ["x", "y"], type: "string" }, { type: "null" }] });
  assert.deepEqual(s.properties.c.anyOf[0].items.required, ["d"]);
  assert.deepEqual(s.properties.c.anyOf[0].items.properties.d, { anyOf: [{ type: "number" }, { type: "null" }] });
});

test("codexShort is the random tail of a time-ordered thread id", () => {
  assert.equal(codexShort("01a0f4c0-01ea-7ff2-aa9a-2c68c0122ad1"), "c0122ad1");
});

test("sourceOfUrl recognizes each kind of link the board tracks", () => {
  const kind = (u) => {
    const s = sourceOfUrl(u);
    return s && `${s.kind} ${s.id}`;
  };
  assert.equal(kind("https://linear.app/acme/issue/abc-12/some-title"), "linear-issue ABC-12");
  assert.equal(kind("https://github.com/acme/app/pull/42/files"), "pr acme/app#42");
  assert.equal(kind("https://www.notion.so/Plan-0123456789abcdef0123456789abcdef"), "notion 0123456789abcdef0123456789abcdef");
  assert.equal(kind("https://acme.slack.com/archives/C0123ABCD/p1790923215969409"), "slack-thread C0123ABCD/1790923215.969409");
  assert.equal(kind("https://acme.slack.com/archives/C0123ABCD"), "slack-channel C0123ABCD");
  assert.equal(kind("https://claude.ai/code/artifact/AbCdEfGh1234"), "artifact AbCdEfGh1234");
  assert.equal(kind("https://example.com/page"), null);
});

test("sourcesInText drops trailing punctuation and repeats", () => {
  const found = sourcesInText("See https://github.com/acme/app/pull/42, then https://github.com/acme/app/pull/42.");
  assert.deepEqual(found.map((s) => s.id), ["acme/app#42"]);
});

test("the page's scripts compile", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) new vm.Script(code);
});
