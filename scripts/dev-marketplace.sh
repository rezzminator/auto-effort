#!/usr/bin/env bash
# Builds a local directory marketplace from this checkout and prints the commands that install it.
# It writes only to the directory it builds (default ~/.local/share/auto-effort-control-dev) and never touches Claude Code's own config.
# Run it again after a change to refresh the copy, then `/reload-plugins` in an open chat.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-$HOME/.local/share/auto-effort-control-dev}"
version=$(node -p 'require(process.argv[1]).version' "$here/plugins/auto-effort-control/.claude-plugin/plugin.json")
rm -rf "$dest/plugins/auto-effort-control"
mkdir -p "$dest/.claude-plugin" "$dest/plugins"
cp -R "$here/plugins/auto-effort-control" "$dest/plugins/auto-effort-control"
cat > "$dest/.claude-plugin/marketplace.json" <<JSON
{
  "name": "auto-effort-control-dev",
  "description": "Local install of auto-effort-control from a checkout.",
  "owner": { "name": "local" },
  "plugins": [
    {
      "name": "auto-effort-control",
      "source": "./plugins/auto-effort-control",
      "description": "Automatic reasoning effort for the main chat and its sub-agents.",
      "version": "$version"
    }
  ]
}
JSON
echo "built $dest (auto-effort-control $version)"
echo "  claude plugin marketplace add $dest"
echo "  claude plugin install auto-effort-control@auto-effort-control-dev"
echo "  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude"
