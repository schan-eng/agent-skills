# agent-board

A local kanban board over your Claude Code and Codex sessions, at <http://127.0.0.1:4747>.

- **Board**: one card per Claude Code background session and Codex thread, in columns
  (Specification, Researching, Building, Needs input, Done) and project lanes. Cards carry a
  model-written summary, the Linear, Notion, Slack, pull-request and artifact context each session
  touched, and links you pin.
- **Drawer**: a session's conversation, summary, spec, progress, team, context and a live terminal.
  From it you can message, interrupt, rename, archive, restart or delete the session, or open it in
  Terminal.
- **Archived**: a timeline of archived sessions with an outcome for each, restorable with their
  conversations.
- **Journal**: to-dos by horizon, notes, and a summary of where things stand from Linear, Slack and
  Notion.
- **Daily**: per-day digests of what merged into a repository's main branch, what changed in Notion
  and what happened in Slack. Yesterday's are written each morning; any recent day can be updated.
- **Agent view**: `claude agents` or `codex agents` in a docked terminal, and a dialog that starts
  either kind of session.

It needs no packages: just Node and the CLIs it drives.

## Requirements

- macOS (it opens Terminal and uses `lsof`), and Node 24 or later.
- Claude Code (`claude`), signed in.
- Optional: Codex (`codex`), for Codex cards and the Codex engine; `gh`, signed in, for the Daily
  repository digest and pull-request outcomes.
- For the Journal summary and the Daily Notion and Slack digests: the Linear, Notion and Slack Claude
  Code plugins. Plugins enabled in a project's `.claude/settings.json` load only in that project, so
  the board runs those calls in the folder where most sessions run, or in `AGENT_BOARD_JOURNAL_CWD`.

## Install

From this folder:

```bash
node bin/agent-board.mjs install   # links ~/.local/bin/agent-board here, migrates old data
agent-board start
agent-board open
```

`install` copies data from `~/.claude/tools/agent-board`, where the board lived before it was a
package, and never overwrites. Run it again from another checkout to point the command there, then
`agent-board restart`.

The **Context** column and context chips come from a Claude Code hook. Add it to
`~/.claude/settings.json`:

```json
"PostToolUse": [
  {
    "matcher": "mcp__.*([Nn]otion|[Ll]inear|[Ss]lack).*|Artifact",
    "hooks": [{ "type": "command", "command": "node ~/.local/bin/agent-board log-context 2>/dev/null || true" }]
  }
]
```

Sessions pick up hook changes when they start.

Start the board from a real terminal. A board started inside a sandboxed agent session inherits that
sandbox, and so do the sessions and model calls it starts.

## Commands

| Command | What it does |
| --- | --- |
| `agent-board start` | Starts the board in the background, logging to the data folder. |
| `agent-board stop` | Stops it, including one started by hand. |
| `agent-board restart` | Stops it, then starts this checkout's code. |
| `agent-board status` | Says whether it runs, with its code and data folders. |
| `agent-board logs [-f]` | Shows the end of its log; `-f` follows it. |
| `agent-board open` | Opens the board in the browser. |
| `agent-board run` | Runs it in the foreground. |
| `agent-board install` | Links `~/.local/bin/agent-board` to this checkout and migrates old data. |
| `agent-board migrate [--from DIR]` | Copies data from DIR without overwriting; merges the context log. |
| `agent-board log-context` | The PostToolUse hook above; reads the hook event on stdin. |

## Data

Everything the board keeps lives in `~/.agent-board` (set `AGENT_BOARD_HOME` to move it), never in
the checkout, because it holds transcripts and summaries of Slack, Notion and Linear.

| Path | Holds |
| --- | --- |
| `settings.json` | Which engine each kind of model call uses. |
| `tags.json`, `context.json` | Your tags, and the links you pinned or hid. |
| `archive.json`, `archive/` | Archived sessions, with copies of their conversations. |
| `codex-archive.json` | What the board knew about Codex threads it archived. |
| `journal.json` | To-dos, notes and the last summary. |
| `context-log.jsonl` | What the hook saw sessions touch. For Slack, only links and channels. |
| `board.log` | The server's log; `board.prev.log` once it passes 5 MB. |
| `cache/` | Card summaries, groups, pull-request states and Daily digests, all rebuildable. |

## Configuration

Model calls run on Claude through `claude -p`, or on Codex through `codex exec`, which the ChatGPT plan
pays for. `settings.json` picks the engine for card summaries and groups (`cards`), the Journal
summary (`brief`) and the Daily repository digest (`daily`); the Journal and Daily tabs have pickers
for theirs. The Daily Notion and Slack digests always run on Claude.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_BOARD_HOME` | `~/.agent-board` | The data folder. |
| `AGENT_BOARD_PORT` | `4747` | The port, on 127.0.0.1 only. |
| `AGENT_BOARD_SUMMARIZE` | on | `0` turns off every model call. |
| `AGENT_BOARD_MODEL`, `AGENT_BOARD_EFFORT`, `AGENT_BOARD_BUDGET_USD` | `sonnet`, `medium`, `0.25` | Card summaries and groups on Claude. |
| `AGENT_BOARD_CODEX_MODEL` | `gpt-6-astra` | Every call on Codex. |
| `AGENT_BOARD_JOURNAL_MODEL`, `_EFFORT`, `_BUDGET_USD` | `sonnet`, `medium`, `1.5` | The Journal summary on Claude. |
| `AGENT_BOARD_JOURNAL_CWD` | the busiest session folder | Where calls that use the Linear, Notion and Slack plugins run. |
| `AGENT_BOARD_DIGEST_REPO` | `UsableMachines/mono` | The repository the Daily tab digests. |
| `AGENT_BOARD_DIGEST_MODEL`, `_EFFORT`, `_BUDGET_USD` | `sonnet`, `medium`, `1.5` | Daily digests on Claude. |
| `AGENT_BOARD_DIGEST_HOUR` | `7` | The local hour from which yesterday's digests are written. |

## Security

The server listens on 127.0.0.1 and answers only requests whose Host is `127.0.0.1:<port>` or
`localhost:<port>`, so a page using DNS rebinding cannot read it. Every write needs the header
`x-agent-board: 1`, which forces a CORS preflight the server never approves, so no other site can
trigger a paid call or change a session. Terminals use WebSockets, which must come from the board's own
origin. Summaries paraphrase Slack and never quote it.

## Troubleshooting

- **A digest or the Journal says no Notion or Slack tools were available**: those plugins are enabled
  for a project, and the call ran elsewhere. Set `AGENT_BOARD_JOURNAL_CWD` to that project's folder.
- **Codex runs see no Notion tools**: Codex's own Notion login expired or was revoked; run
  `codex mcp login notion`.
- **The board does not start**: `agent-board logs` shows why; `agent-board status` shows what holds
  the port.

## Development

```bash
npm test
```

`src/server.mjs` is the HTTP and WebSocket server; `src/index.html` is the whole page. Beside them:
`codex-agents.mjs` reads Codex threads from its app-server daemon, `codex.mjs` and `summarize.mjs`
make model calls, `journal.mjs` and `digest.mjs` back the Journal and Daily tabs, `context.mjs` and
`conversation.mjs` read transcripts, `pty.mjs` and `ws.mjs` carry the terminals, and `paths.mjs`
places the data folder.
