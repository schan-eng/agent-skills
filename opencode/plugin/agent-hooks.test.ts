import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import agentHooks from "./agent-hooks.ts";

const runtime = join(homedir(), ".agents", "hooks", "agent_activity.py");

function pending(
  stateDirectory: string,
  kind: "intent" | "simplify",
  sessionID: string,
  consume = false
) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        runtime,
        "pending",
        "--state-dir",
        stateDirectory,
        "--kind",
        kind,
        "--session-id",
        sessionID,
        ...(consume ? ["--consume"] : []),
      ],
      { encoding: "utf-8" }
    )
  ) as { anchor?: string; files: string[]; total: number };
}

function clearPending(stateDirectory: string, sessionID: string) {
  pending(stateDirectory, "intent", sessionID, true);
  pending(stateDirectory, "simplify", sessionID, true);
}

test("tracks multi-file patches including deletions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hooks-plugin-"));
  const stateDirectory = join(directory, ".claude");
  const sessionID = "patch-session";
  try {
    const hooks = await agentHooks({ directory } as never);
    const after = hooks["tool.execute.after"];
    assert.ok(after);

    await after({
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/updated.ts",
          "@@",
          "-old",
          "+new",
          "*** Delete File: src/deleted.ts",
          "*** End Patch",
        ].join("\n"),
      },
      callID: "call",
      sessionID,
      tool: "apply_patch",
    });

    assert.deepEqual(pending(stateDirectory, "simplify", sessionID), {
      files: ["src/deleted.ts", "src/updated.ts"],
      total: 3,
    });

  } finally {
    clearPending(stateDirectory, sessionID);
    await rm(directory, { force: true, recursive: true });
  }
});

test("records skills, renders reports, and permits metadata-only PR edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hooks-plugin-"));
  const stateDirectory = join(directory, ".claude");
  const sessionID = "report-session";
  try {
    const hooks = await agentHooks({ directory } as never);
    const after = hooks["tool.execute.after"];
    const before = hooks["tool.execute.before"];
    const onEvent = hooks.event;
    assert.ok(after);
    assert.ok(before);
    assert.ok(onEvent);

    await after({ args: { name: "simplify" }, callID: "skill", sessionID, tool: "skill" });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    const report = await readFile(
      join(directory, ".claude", "artifacts", `skill-report-${sessionID}.md`),
      "utf-8"
    );
    assert.match(report, /`simplify`/);
    assert.match(report, /agent-invoked/);

    await before(
      { callID: "edit", sessionID, tool: "bash" },
      { args: { command: "cd repo && gh -R org/repo pr edit 123 --add-reviewer alice" } }
    );
    await assert.rejects(() =>
      before(
        { callID: "create", sessionID, tool: "bash" },
        { args: { command: "cd repo && env GH_TOKEN=x gh pr create --body 'missing report'" } }
      )
    );
    await assert.rejects(() =>
      before(
        { callID: "stdin", sessionID, tool: "bash" },
        { args: { command: "gh pr create --body-file - < body.md" } }
      )
    );
  } finally {
    clearPending(stateDirectory, sessionID);
    await rm(directory, { force: true, recursive: true });
  }
});

test("schedules idle checks once and suppresses edits from the review turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hooks-plugin-"));
  const stateDirectory = join(directory, ".claude");
  const sessionID = "idle-session";
  const prompts: unknown[] = [];
  try {
    const hooks = await agentHooks({
      client: {
        session: {
          promptAsync: async (options: unknown) => {
            prompts.push(options);
          },
        },
      },
      directory,
    } as never);
    const after = hooks["tool.execute.after"];
    const message = hooks["chat.message"];
    const onEvent = hooks.event;
    assert.ok(after);
    assert.ok(message);
    assert.ok(onEvent);

    await after({
      args: { filePath: "src/initial.ts", newString: "changed" },
      callID: "initial",
      sessionID,
      tool: "edit",
    });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    assert.equal(prompts.length, 1);
    assert.match(JSON.stringify(prompts[0]), /src\/initial\.ts/);
    assert.match(JSON.stringify(prompts[0]), /"synthetic":true/);
    const automaticPrompt = prompts[0] as { body: { parts: unknown[] } };
    await message(
      { sessionID } as never,
      { message: { id: "automatic-message" }, parts: automaticPrompt.body.parts } as never
    );

    await after({
      args: { name: "intent-check" },
      callID: "intent-skill",
      sessionID,
      tool: "skill",
    });
    await after({
      args: { name: "simplify" },
      callID: "simplify-skill",
      sessionID,
      tool: "skill",
    });

    await after({
      args: { filePath: "src/from-review.ts", newString: "simplified" },
      callID: "review-edit",
      sessionID,
      tool: "edit",
    });
    assert.deepEqual(pending(stateDirectory, "simplify", sessionID), {
      files: [],
      total: 0,
    });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    assert.equal(prompts.length, 1);
  } finally {
    clearPending(stateDirectory, sessionID);
    await rm(directory, { force: true, recursive: true });
  }
});

test("restores pending edits when an automatic review omits a required skill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hooks-plugin-"));
  const stateDirectory = join(directory, ".claude");
  const sessionID = "incomplete-review-session";
  try {
    const hooks = await agentHooks({
      client: { session: { promptAsync: async () => undefined } },
      directory,
    } as never);
    const after = hooks["tool.execute.after"];
    const onEvent = hooks.event;
    assert.ok(after);
    assert.ok(onEvent);

    await after({
      args: { filePath: "src/incomplete.ts", newString: "changed" },
      callID: "initial",
      sessionID,
      tool: "edit",
    });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    await after({
      args: { name: "intent-check" },
      callID: "intent-only",
      sessionID,
      tool: "skill",
    });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    assert.deepEqual(pending(stateDirectory, "simplify", sessionID).files, [
      "src/incomplete.ts",
    ]);
  } finally {
    clearPending(stateDirectory, sessionID);
    await rm(directory, { force: true, recursive: true });
  }
});

test("restores claimed edits and tracks work after a user interrupts automatic review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hooks-plugin-"));
  const stateDirectory = join(directory, ".claude");
  const sessionID = "interrupted-review-session";
  try {
    const hooks = await agentHooks({
      client: { session: { promptAsync: async () => undefined } },
      directory,
    } as never);
    const after = hooks["tool.execute.after"];
    const message = hooks["chat.message"];
    const onEvent = hooks.event;
    assert.ok(after);
    assert.ok(message);
    assert.ok(onEvent);

    await after({
      args: { filePath: "src/original.ts", newString: "changed" },
      callID: "initial",
      sessionID,
      tool: "edit",
    });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    await message(
      { sessionID } as never,
      {
        message: { id: "user-message" },
        parts: [{ synthetic: false, text: "new request", type: "text" }],
      } as never
    );
    await after({
      args: { filePath: "src/new-request.ts", newString: "changed" },
      callID: "new-work",
      sessionID,
      tool: "edit",
    });
    assert.deepEqual(pending(stateDirectory, "simplify", sessionID).files, [
      "src/new-request.ts",
      "src/original.ts",
    ]);
  } finally {
    clearPending(stateDirectory, sessionID);
    await rm(directory, { force: true, recursive: true });
  }
});

test("restores pending edits when idle check scheduling fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hooks-plugin-"));
  const stateDirectory = join(directory, ".claude");
  const sessionID = "failed-idle-session";
  try {
    const hooks = await agentHooks({
      client: {
        session: {
          promptAsync: async () => {
            throw new Error("offline");
          },
        },
      },
      directory,
    } as never);
    const after = hooks["tool.execute.after"];
    const onEvent = hooks.event;
    assert.ok(after);
    assert.ok(onEvent);

    await after({
      args: { filePath: "src/retry.ts", newString: "changed" },
      callID: "initial",
      sessionID,
      tool: "edit",
    });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    assert.deepEqual(pending(stateDirectory, "simplify", sessionID).files, ["src/retry.ts"]);
  } finally {
    clearPending(stateDirectory, sessionID);
    await rm(directory, { force: true, recursive: true });
  }
});

test("restores pending edits when the automatic review session errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-hooks-plugin-"));
  const stateDirectory = join(directory, ".claude");
  const sessionID = "errored-review-session";
  try {
    const hooks = await agentHooks({
      client: { session: { promptAsync: async () => undefined } },
      directory,
    } as never);
    const after = hooks["tool.execute.after"];
    const onEvent = hooks.event;
    assert.ok(after);
    assert.ok(onEvent);

    await after({
      args: { filePath: "src/errored.ts", newString: "changed" },
      callID: "initial",
      sessionID,
      tool: "edit",
    });
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    await onEvent({ event: { properties: { sessionID }, type: "session.error" } } as never);
    await onEvent({ event: { properties: { sessionID }, type: "session.idle" } } as never);
    assert.deepEqual(pending(stateDirectory, "simplify", sessionID).files, ["src/errored.ts"]);
  } finally {
    clearPending(stateDirectory, sessionID);
    await rm(directory, { force: true, recursive: true });
  }
});
