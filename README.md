# Personal Agent Configuration

Canonical, agent-neutral skills and hook logic shared by coding-agent clients.

## Layout

- `skills/`: Agent Skills-compatible personal skills.
- `hooks/`: Python standard-library runtime plus tests.
- `opencode/commands/`: OpenCode slash-command adapters for explicit skills.
- `opencode/plugin/`: OpenCode hook adapter plus tests.
- `tools/agent-board/`: a local kanban board over Claude Code and Codex sessions; see its README.

`setup.sh` links OpenCode commands and the hook plugin into its config
directory. Claude-specific adapters and settings remain versioned separately
in `~/.claude`; that repository links its skill entries here.

## Verify

```bash
npm install
npm run setup
npm run typecheck
npm test
```

Restart OpenCode after changing commands or plugins. Restart each consuming
agent after changing shared skills.
