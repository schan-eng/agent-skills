// Where the board keeps its data: the person's own records at the top, and what it can rebuild under cache/. Kept out
// of the code so a checkout never holds transcripts, notes, or Slack and Notion digests.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DATA = resolve(process.env.AGENT_BOARD_HOME ?? join(homedir(), ".agent-board"));
export const CACHE = join(DATA, "cache");
// The working folder of the board's own model calls, which the board leaves off its cards.
export const RUN_DIR = join(CACHE, "run");
