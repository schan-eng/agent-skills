// Terminal connections to background sessions: `claude attach` or `codex resume` under script(1), which supplies the
// pty, so the board needs no native module. Closing a connection leaves the session running.
import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const REPLAY_CAP = 2 << 20;
const FULL_CLEAR = "\x1b[2J";
const QUIET_MS = 600;
const SETTLE_MS = 1200;
const READY_TIMEOUT_MS = 12_000;

const stripAnsi = (s) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]|\x1b[=>]/g, "");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? "" : out.trim())));
const clampSize = ({ cols, rows }) => ({ cols: Math.min(400, Math.max(40, cols | 0)), rows: Math.min(200, Math.max(10, rows | 0)) });

// `short` must already be validated as a session id: it is part of a shell command line.
export const attach = (short, size, env) => open(`claude attach ${short}`, size, env);
// Claude Code's agent view: every background session, any of which it can open and leave again.
export const agentView = (size, env, cwd) => open("claude agents", size, env, cwd);
// Codex's agent view and one Codex session, both on Codex's shared app-server daemon. Its update prompt would cover
// the screen on every start, so these terminals skip the check.
export const codexView = (size, env, cwd) => open("codex agents -c check_for_update_on_startup=false", size, env, cwd);
// `threadId` must already be validated as a UUID: it is part of a shell command line.
export const codexResume = (threadId, size, env, cwd) => open(`codex resume -c check_for_update_on_startup=false --remote unix:// ${threadId}`, size, env, cwd);

function open(command, size, env, cwd) {
  let { cols, rows } = clampSize(size);
  // script needs a real pipe on stdin (it rejects Node's socket pairs), hence the cat.
  const child = spawn("sh", ["-c", `cat | script -q /dev/null sh -c 'stty cols ${cols} rows ${rows} 2>/dev/null; exec ${command}'`], {
    cwd,
    env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const decoder = new StringDecoder("utf8");
  const listeners = new Set();
  let replay = "";
  let lastOutputAt = 0;
  let exited = false;
  const done = new Promise((resolve) => child.on("exit", () => { exited = true; resolve(); }));
  done.then(() => listeners.forEach((fn) => fn(null)));
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    const text = decoder.write(chunk);
    if (!text) return;
    lastOutputAt = Date.now();
    // A full clear starts a new screen, so a late viewer only needs what came after the last one.
    const clear = text.lastIndexOf(FULL_CLEAR);
    replay = clear >= 0 ? text.slice(clear) : `${replay}${text}`;
    if (replay.length > REPLAY_CAP) replay = replay.slice(-REPLAY_CAP);
    listeners.forEach((fn) => fn(text));
  });

  // The pty belongs to the attach client, the one process in the tree with a terminal; the kernel
  // signals it on a size change.
  let tty = null;
  const ttyOf = async () => {
    if (tty) return tty;
    for (const pid of await descendants(child.pid)) {
      const name = await run("ps", ["-o", "tty=", "-p", pid]);
      if (name && name !== "??") return (tty = `/dev/${name}`);
    }
    return null;
  };
  // Resizes run one at a time toward the latest size asked for, so overlapping ones cannot leave a stale size.
  let wanted = { cols, rows };
  let resizing = null;
  const applySizes = async () => {
    while (!exited && (wanted.cols !== cols || wanted.rows !== rows)) {
      const s = wanted;
      const path = await ttyOf();
      if (!path || !(await new Promise((resolve) => execFile("stty", ["-f", path, "cols", String(s.cols), "rows", String(s.rows)], (err) => resolve(!err))))) return false;
      ({ cols, rows } = s);
    }
    return true;
  };

  return {
    get size() { return { cols, rows }; },
    get exited() { return exited; },
    done,
    screen: () => replay,
    write: (data) => { if (!exited) child.stdin.write(data); },
    onData(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // Resolves with the screen text once the session's frame has drawn, or null. A working session's
    // spinner never goes quiet, so the prompt box having been up a while also counts.
    async ready() {
      let promptAt = null;
      for (const until = Date.now() + READY_TIMEOUT_MS; Date.now() < until && !exited; await sleep(150)) {
        const text = stripAnsi(replay);
        if (!text.includes("❯")) continue;
        promptAt ??= Date.now();
        if (Date.now() - lastOutputAt >= QUIET_MS || Date.now() - promptAt >= SETTLE_MS) return text;
      }
      return null;
    },
    // Resolves once the pty has the latest size asked for, or false if it could not be set.
    resize(next) {
      wanted = clampSize(next);
      resizing ??= applySizes().finally(() => (resizing = null));
      return resizing;
    },
    // script does not exit on stdin EOF, and the attach client runs in its own session, so every
    // process in the tree is signalled.
    async close() {
      if (exited) return;
      for (const pid of await descendants(child.pid)) try { process.kill(Number(pid), "SIGTERM"); } catch {}
      child.kill("SIGTERM");
      await Promise.race([done, sleep(3000)]);
    },
  };
}

async function descendants(pid) {
  const kids = (await run("pgrep", ["-P", String(pid)])).split("\n").filter(Boolean);
  return [...kids, ...(await Promise.all(kids.map(descendants))).flat()];
}
