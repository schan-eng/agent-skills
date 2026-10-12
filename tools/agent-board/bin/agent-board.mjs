#!/usr/bin/env node
// agent-board: runs the board's server in the background and wires it into this machine. `agent-board help` lists the
// commands. The board is found by the port it listens on, so one started by hand is managed the same way.
import { execFile, spawn } from "node:child_process";
import { constants, openSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DATA } from "../src/paths.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "src", "server.mjs");
const PORT = Number(process.env.AGENT_BOARD_PORT ?? 4747);
const BOARD_URL = `http://127.0.0.1:${PORT}`;
const LOG = join(DATA, "board.log");
const LOG_MAX = 5 << 20;
const LINK = join(homedir(), ".local", "bin", "agent-board");
// Where the board's code and data lived together before it became a package.
const LEGACY = join(homedir(), ".claude", "tools", "agent-board");
// Code in the legacy folder, which a migration leaves behind; everything else there is data.
const CODE_RE = /\.(mjs|html)$/;

const run = promisify(execFile);
const say = (s) => console.log(s);
const fail = (s) => {
  console.error(s);
  process.exit(1);
};
const exists = (p) => fs.access(p).then(() => true, () => false);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await wait(250)) if (await check()) return true;
  return false;
}

// The process listening on the board's port, whatever started it. netstat reads the kernel's socket table, where lsof
// can hang for good on a process it cannot inspect. Its rows end in `name:pid` after the state column.
async function listener() {
  const { stdout } = await run("netstat", ["-anv", "-p", "tcp"], { timeout: 10_000 }).catch((e) => fail(`netstat failed: ${e.message}`));
  const row = stdout.split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f[5] === "LISTEN" && f[3]?.endsWith(`.${PORT}`));
  const pid = Number(row?.slice(6).find((f) => /:\d+$/.test(f))?.split(":").at(-1)) || null;
  if (!pid) return null;
  const ps = (field) => run("ps", ["-p", String(pid), "-o", `${field}=`]).then(({ stdout }) => stdout.trim(), () => "");
  const [command, pgid] = await Promise.all([ps("command"), ps("pgid")]);
  return { pid, command, pgid: Number(pgid), board: /server\.mjs/.test(command) };
}

async function start() {
  const now = await listener();
  if (now?.board) return say(`Already running at ${BOARD_URL} (pid ${now.pid}).`);
  if (now) fail(`Port ${PORT} is taken by pid ${now.pid}: ${now.command}`);
  await fs.mkdir(DATA, { recursive: true });
  const size = await fs.stat(LOG).then((s) => s.size, () => 0);
  if (size > LOG_MAX) await fs.rename(LOG, join(DATA, "board.prev.log"));
  const out = openSync(LOG, "a");
  // Its own session, so closing the terminal that started it leaves it running.
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (await until(async () => exited() || (await listener())?.board, 20_000) && !exited()) return say(`Started at ${BOARD_URL} (pid ${child.pid}). Log: ${LOG}`);
  const tail = (await fs.readFile(LOG, "utf8").catch(() => "")).trim().split("\n").slice(-15).join("\n");
  fail(`The board did not start${exited() ? "; it exited" : " within 20 seconds"}. Last lines of ${LOG}:\n${tail}`);
}

async function stop() {
  const now = await listener();
  if (!now) return say("Not running.");
  if (!now.board) fail(`Port ${PORT} is held by something else, pid ${now.pid}: ${now.command}`);
  // A board this command started leads its own process group, which takes its terminals and model calls with it.
  const target = now.pgid === now.pid ? -now.pid : now.pid;
  const gone = async () => !(await listener());
  process.kill(target, "SIGTERM");
  if (!(await until(gone, 10_000))) {
    process.kill(target, "SIGKILL");
    await until(gone, 5_000);
  }
  say(`Stopped (pid ${now.pid}).`);
}

async function status() {
  const now = await listener();
  say(now?.board ? `Running at ${BOARD_URL} (pid ${now.pid}): ${now.command}` : now ? `Not running; port ${PORT} is held by pid ${now.pid}: ${now.command}` : "Not running.");
  say(`Code: ${ROOT}\nData: ${DATA}`);
}

// Links the command into ~/.local/bin, pointing at this checkout, and brings over data from the legacy folder.
async function install() {
  const target = join(ROOT, "bin", "agent-board.mjs");
  const current = await fs.readlink(LINK).catch((e) => (e.code === "ENOENT" ? null : fail(e.code === "EINVAL" ? `${LINK} exists and is not a link; move it aside first.` : e.message)));
  await fs.chmod(target, 0o755);
  if (current === target) say(`${LINK} already points here.`);
  else {
    await fs.mkdir(dirname(LINK), { recursive: true });
    await fs.rm(LINK, { force: true });
    await fs.symlink(target, LINK);
    say(`Linked ${LINK} -> ${target}${current ? ` (was ${current})` : ""}.`);
  }
  if (!(process.env.PATH ?? "").split(":").includes(dirname(LINK))) say(`Add ${dirname(LINK)} to PATH to run agent-board by name.`);
  if (await exists(LEGACY)) await migrate(LEGACY);
  const settings = await fs.readFile(join(homedir(), ".claude", "settings.json"), "utf8").catch(() => "");
  if (!settings.includes("agent-board log-context")) say(`Point the Claude Code context hook at: node ${LINK} log-context 2>/dev/null || true`);
  const now = await listener();
  if (now?.board && !now.command.includes(SERVER)) say("A board from another checkout is running; agent-board restart switches to this one.");
}

// Copies data from the folder the board used to share with its code. It never overwrites, and the context log, which
// both the old and new hook append to, is merged by line.
async function migrate(from) {
  if (!(await exists(from))) return say(`Nothing to migrate: ${from} does not exist.`);
  const [src, dest] = await Promise.all([fs.realpath(from), fs.mkdir(DATA, { recursive: true }).then(() => fs.realpath(DATA))]);
  if (src === dest) fail(`${from} is the data folder.`);
  // The cache's run folder only ever holds a model call in progress, so it is not data.
  const runDir = join(src, ".cache", "run");
  const copied = [];
  const kept = [];
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const name = entry.name;
    if (CODE_RE.test(name)) continue;
    const source = join(src, name);
    const target = join(dest, name === ".cache" ? "cache" : name);
    if (entry.isDirectory()) {
      const merged = await exists(target);
      await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false, filter: (p) => p !== runDir && !p.startsWith(`${runDir}/`) });
      copied.push(`${name}/${merged ? " (merged)" : ""}`);
    } else if (!(await exists(target))) {
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      copied.push(name);
    } else if (name.endsWith(".jsonl")) {
      await fs.writeFile(target, mergedLog(await fs.readFile(source, "utf8"), await fs.readFile(target, "utf8")));
      copied.push(`${name} (merged)`);
    } else kept.push(name);
  }
  say(`Migrated ${from} -> ${DATA}: ${copied.join(", ") || "nothing new"}${kept.length ? `; kept the existing ${kept.join(", ")}` : ""}.`);
}

// Both logs' lines once each, in time order.
function mergedLog(a, b) {
  const at = (line) => {
    try {
      return JSON.parse(line).at ?? "";
    } catch {
      return "";
    }
  };
  const lines = [...new Set(`${a}\n${b}`.split("\n").filter(Boolean))];
  return `${lines.toSorted((x, y) => at(x).localeCompare(at(y))).join("\n")}\n`;
}

// The board in this terminal, on the running board, which it starts first when there is none.
async function tui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`The terminal board needs a terminal.\n\n${HELP}`);
  if (!(await listener())?.board) await start();
  const { runTui } = await import("../src/tui.mjs");
  await runTui({ url: BOARD_URL });
  process.exit(0);
}

const HELP = `agent-board: a local kanban board over Claude Code and Codex sessions (${BOARD_URL}).

  tui                The board in this terminal, starting it first if needed. The default in a terminal.
  start              Start the board in the background.
  stop               Stop it.
  restart            Stop it, then start this checkout's code.
  status             Say whether it runs, and where its code and data are.
  logs [-f]          Show the end of its log; -f follows it.
  open               Open the board in the browser.
  run                Run it in the foreground.
  install            Link ~/.local/bin/agent-board to this checkout and migrate data from ${LEGACY}.
  migrate [--from D] Copy data from D (default ${LEGACY}) without overwriting.
  log-context        The Claude Code PostToolUse hook: reads its event on stdin.

Data: ${DATA} (set AGENT_BOARD_HOME to move it). Port: ${PORT} (AGENT_BOARD_PORT).`;

const [command = process.stdin.isTTY && process.stdout.isTTY ? "tui" : "help", ...args] = process.argv.slice(2);
const COMMANDS = {
  tui,
  start,
  stop,
  restart: async () => (await stop(), start()),
  status,
  logs: () => spawn("tail", ["-n", "60", ...(args.includes("-f") ? ["-f"] : []), LOG], { stdio: "inherit" }),
  open: () => run("open", [BOARD_URL]),
  run: () => import("../src/server.mjs"),
  install,
  migrate: () => migrate(args.includes("--from") ? args[args.indexOf("--from") + 1] : LEGACY),
  "log-context": () => import("../src/log-context.mjs"),
  help: () => say(HELP),
};
if (!COMMANDS[command]) fail(`Unknown command: ${command}\n\n${HELP}`);
await COMMANDS[command]();
