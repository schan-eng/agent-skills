#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
if [ "$root" != "$HOME/.agents" ]; then
  printf 'Clone this repository at %s/.agents before running setup.\n' "$HOME" >&2
  exit 1
fi

mkdir -p "$HOME/.config/opencode/commands" "$HOME/.config/opencode/plugin"

for source in "$root"/opencode/commands/*.md; do
  name=$(basename "$source")
  ln -sfn "../../../.agents/opencode/commands/$name" "$HOME/.config/opencode/commands/$name"
done

ln -sfn "../../../.agents/opencode/plugin/agent-hooks.ts" "$HOME/.config/opencode/plugin/agent-hooks.ts"

chmod +x "$root/setup.sh" "$root/hooks/agent_activity.py"

printf 'OpenCode adapters linked. Restart OpenCode to reload them.\n'
