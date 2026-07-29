# Agent Hooks

`agent_activity.py` owns the platform-neutral activity ledger, edit tracking,
skill-report rendering, and PR-body validation used by personal coding-agent
integrations.

Adapters translate each client's hook payload into this runtime. The activity
state location is an adapter choice: the Claude and OpenCode adapters both use
`<project>/.claude` by default so one session report works with the existing
PR-body convention. Set an adapter-specific state directory when a project
uses a different convention.

Pending edit and intent-anchor files live in the system temporary directory,
namespaced by state directory and session ID so concurrent projects cannot
consume each other's work.

OpenCode has no blocking end-of-turn hook. When a session becomes idle, its
adapter renders the report and schedules a synthetic intent/simplify turn. A
next-message injection remains as a fallback for edits recovered after a
restart. Claude retains its immediate stop-hook gate.

The canonical runtime, skills, and OpenCode plugin live in this `~/.agents`
repository. Client-specific directories contain adapters only.
