import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Plugin } from "@opencode-ai/plugin";

const execFile = promisify(execFileCallback);
const runtime = join(homedir(), ".agents", "hooks", "agent_activity.py");
const automaticReviewMarker = "[agent-hooks:auto-review]";

type EditedFile = {
  lineCount: number;
  path: string;
};

type Pending = {
  anchor?: string;
  files: string[];
  total: number;
};

type PrCheck = {
  reason: string;
  status: "allow" | "deny" | "unchecked";
};

type ReviewState = {
  intent: Pending;
  simplify: Pending;
  skills: Set<string>;
};

function stringArgument(args: unknown, names: string[]): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const values = args as Record<string, unknown>;
  for (const name of names) {
    const value = values[name];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function editedLineCount(args: unknown): number {
  const patch = stringArgument(args, ["patchText", "patch", "newString", "new_string", "content"]);
  return Math.max(1, patch?.split("\n").length ?? 1);
}

function patchEdits(patch: string): EditedFile[] {
  const matches = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)];
  return matches.flatMap((match, index) => {
    const path = match[1];
    if (!path) {
      return [];
    }
    const sectionStart = match.index + match[0].length;
    const sectionEnd = matches[index + 1]?.index ?? patch.length;
    const lineCount = patch
      .slice(sectionStart, sectionEnd)
      .split("\n")
      .filter((line) => line.startsWith("+") || line.startsWith("-")).length;
    return [{ lineCount: Math.max(1, lineCount), path }];
  });
}

function editedFiles(tool: string, args: unknown): EditedFile[] {
  if (!/(?:apply_patch|edit|write)/i.test(tool)) {
    return [];
  }
  const directPath = stringArgument(args, ["filePath", "file_path", "path"]);
  if (directPath) {
    return [{ lineCount: editedLineCount(args), path: directPath }];
  }
  const patch = stringArgument(args, ["patchText", "patch"]);
  return patch ? patchEdits(patch) : [];
}

function mightMutatePullRequest(command: string): boolean {
  return /\bgh\b[\s\S]*\bpr\s+(?:create|edit)\b/.test(command);
}

function reviewInstruction(intent: Pending, simplify: Pending): string {
  const tier = simplify.total <= 40 && simplify.files.length < 3 ? "micro" : "full";
  return [
    "Run the automatic post-implementation checks for the previous turn's edits. Do not perform unrelated work.",
    `Intent-check files: ${JSON.stringify(intent.files)}. Use ${intent.anchor ?? "the session scratchpad"} as the session anchor.`,
    `Simplify files: ${JSON.stringify(simplify.files)}. Use the ${tier} tier (~${simplify.total} changed lines).`,
    "Load and apply the intent-check and simplify skills; if either skill is unavailable, perform that check directly.",
  ].join("\n");
}

async function bestEffort(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    console.warn(`agent hooks: ${error instanceof Error ? error.message : error}`);
  }
}

export default (async ({ client, directory }) => {
  const stateDirectory = join(directory, ".claude");
  const reviewSessions = new Map<string, ReviewState>();
  const retryBlockedSessions = new Set<string>();
  const suppressedSessions = new Set<string>();

  async function execute<T>(arguments_: string[]): Promise<T> {
    const { stdout } = await execFile("python3", [runtime, ...arguments_], { cwd: directory });
    return JSON.parse(stdout) as T;
  }

  async function getPending(kind: "intent" | "simplify", sessionID: string, consume = false) {
    return execute<Pending>([
      "pending",
      "--state-dir",
      stateDirectory,
      "--kind",
      kind,
      "--session-id",
      sessionID,
      ...(consume ? ["--consume"] : []),
    ]);
  }

  async function recordSkill(sessionID: string, skill: string) {
    await execute<{ recorded: boolean }>([
      "record-skill",
      "--state-dir",
      stateDirectory,
      "--session-id",
      sessionID,
      "--mode",
      "model",
      "--skill",
      skill,
      "--platform",
      "opencode",
    ]);
  }

  async function claimPending(sessionID: string): Promise<[Pending, Pending]> {
    return Promise.all([
      getPending("intent", sessionID, true),
      getPending("simplify", sessionID, true),
    ]);
  }

  async function trackFiles(sessionID: string, files: EditedFile[]) {
    await Promise.all(
      files.map((file) =>
        bestEffort(() =>
          execute<{ tracked: boolean }>([
            "track-edit",
            "--state-dir",
            stateDirectory,
            "--session-id",
            sessionID,
            "--path",
            file.path,
            "--line-count",
            String(file.lineCount),
          ])
        )
      )
    );
  }

  async function restorePending(sessionID: string, intent: Pending, simplify: Pending) {
    const lineCount = Math.max(
      1,
      Math.ceil(simplify.total / Math.max(simplify.files.length, 1))
    );
    const paths = [...new Set([...intent.files, ...simplify.files])];
    await trackFiles(
      sessionID,
      paths.map((path) => ({ lineCount, path }))
    );
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!/bash|shell/i.test(input.tool)) {
        return;
      }
      const command = stringArgument(output.args, ["command"]);
      if (!command || !mightMutatePullRequest(command)) {
        return;
      }
      let result: PrCheck;
      try {
        result = await execute<PrCheck>([
          "check-pr-body",
          "--state-dir",
          stateDirectory,
          "--session-id",
          input.sessionID,
          "--command",
          command,
        ]);
      } catch (error) {
        throw new Error(
          `Skill report validation failed: ${error instanceof Error ? error.message : error}`
        );
      }
      if (result.status !== "allow") {
        throw new Error(result.reason);
      }
    },
    "tool.execute.after": async (input) => {
      const skill = stringArgument(input.args, ["skill", "name"]);
      if (/skill/i.test(input.tool) && skill) {
        await bestEffort(() => recordSkill(input.sessionID, skill));
        if (skill === "intent-check" || skill === "simplify") {
          suppressedSessions.add(input.sessionID);
          reviewSessions.get(input.sessionID)?.skills.add(skill);
        }
      }
      if (!suppressedSessions.has(input.sessionID)) {
        await trackFiles(input.sessionID, editedFiles(input.tool, input.args));
      }
    },
    "chat.message": async (input, output) => {
      const review = reviewSessions.get(input.sessionID);
      if (!review) {
        return;
      }
      const isAutomaticReview = output.parts.some(
        (part) =>
          part.type === "text" &&
          part.synthetic === true &&
          part.text.includes(automaticReviewMarker)
      );
      if (isAutomaticReview) {
        return;
      }
      reviewSessions.delete(input.sessionID);
      suppressedSessions.delete(input.sessionID);
      retryBlockedSessions.delete(input.sessionID);
      await restorePending(input.sessionID, review.intent, review.simplify);
    },
    event: async ({ event }) => {
      if (event.type === "session.error") {
        const sessionID = event.properties.sessionID;
        const review = sessionID ? reviewSessions.get(sessionID) : undefined;
        if (sessionID && review) {
          reviewSessions.delete(sessionID);
          suppressedSessions.delete(sessionID);
          retryBlockedSessions.add(sessionID);
          await restorePending(sessionID, review.intent, review.simplify);
        }
        return;
      }
      if (event.type !== "session.idle") {
        return;
      }
      await bestEffort(() =>
        execute<{ report: string | null }>([
          "render",
          "--state-dir",
          stateDirectory,
          "--session-id",
          event.properties.sessionID,
        ])
      );
      const sessionID = event.properties.sessionID;
      const review = reviewSessions.get(sessionID);
      if (review) {
        reviewSessions.delete(sessionID);
        suppressedSessions.delete(sessionID);
        if (!review.skills.has("intent-check") || !review.skills.has("simplify")) {
          await restorePending(sessionID, review.intent, review.simplify);
          console.warn("agent hooks: automatic review ended before both checks ran; pending edits restored");
        }
        return;
      }
      if (suppressedSessions.delete(sessionID) || retryBlockedSessions.delete(sessionID)) {
        return;
      }
      let intent: Pending;
      let simplify: Pending;
      try {
        [intent, simplify] = await claimPending(sessionID);
      } catch (error) {
        console.warn(`agent hooks: ${error instanceof Error ? error.message : error}`);
        return;
      }
      if (intent.files.length === 0 && simplify.files.length === 0) {
        return;
      }
      reviewSessions.set(sessionID, { intent, simplify, skills: new Set() });
      suppressedSessions.add(sessionID);
      try {
        await client.session.promptAsync({
          path: { id: sessionID },
          query: { directory },
          body: {
            parts: [
              {
                synthetic: true,
                text: `${automaticReviewMarker}\n${reviewInstruction(intent, simplify)}\nYou must invoke both named skills before completing this review turn.`,
                type: "text",
              },
            ],
          },
          throwOnError: true,
        });
      } catch (error) {
        reviewSessions.delete(sessionID);
        suppressedSessions.delete(sessionID);
        await restorePending(sessionID, intent, simplify);
        console.warn(
          `agent hooks: failed to schedule post-implementation checks: ${error instanceof Error ? error.message : error}`
        );
      }
    },
  };
}) satisfies Plugin;
