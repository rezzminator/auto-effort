#!/usr/bin/env bash
# Builds a local directory marketplace from this checkout and prints the commands that install it.
# It writes only to the directory it builds (default ~/.local/share/auto-effort-dev) and never touches Claude Code's own config.
# Run it again after a change to refresh the copy, then `/reload-plugins` in an open chat.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-$HOME/.local/share/auto-effort-dev}"
version=$(node -p 'require(process.argv[1]).version' "$here/plugins/auto-effort/.claude-plugin/plugin.json")
rm -rf "$dest/plugins/auto-effort"
mkdir -p "$dest/.claude-plugin" "$dest/plugins"
cp -R "$here/plugins/auto-effort" "$dest/plugins/auto-effort"
cat > "$dest/.claude-plugin/marketplace.json" <<JSON
{
  "name": "auto-effort-dev",
  "description": "Local install of auto-effort from a checkout.",
  "owner": { "name": "local" },
  "plugins": [
    {
      "name": "auto-effort",
      "source": "./plugins/auto-effort",
      "description": "Automatic reasoning effort for the Claude Code main chat.",
      "version": "$version"
    }
  ]
}
JSON
echo "built $dest (auto-effort $version)"
echo "  claude plugin marketplace add $dest"
echo "  claude plugin install auto-effort@auto-effort-dev"
echo "  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude"
