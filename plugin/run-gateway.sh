#!/usr/bin/env bash
# Starts a STANDARD OpenClaw Gateway (npm openclaw@2026.11.6, unpatched) with the Pocket Terminal
# plugin on http://127.0.0.1:19789. Everything lives under plugin/: the runtime in .runtime/, and
# home, state, config, sessions, workspace and the Gateway token in .state/. It never reads or
# writes ~/.openclaw and runs alongside a default OpenClaw Gateway on 18789.
#
#   plugin/run-gateway.sh            # foreground; page at http://127.0.0.1:19789/terminal/
#   POCKET_PORT=19989 plugin/run-gateway.sh
#
# First run installs OpenClaw, merges config/openclaw.json5 (Kimi K3.1 Pro on Cerebras) and links the
# plugin package in plugin/extension (kept apart from .runtime: OpenClaw rejects a plugin folder that
# contains its own runtime's bundled plugins). Edit config/openclaw.json5 and it is merged again on the next start. Engine edits need a restart.
set -euo pipefail
PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC="$PLUGIN/oc"
STATE="$PLUGIN/.state"
PORT="${POCKET_PORT:-19789}"
OPENCLAW_VERSION="2026.11.6"

if [ ! -f "$PLUGIN/.runtime/node_modules/openclaw/openclaw.mjs" ]; then
  echo "Installing openclaw@$OPENCLAW_VERSION into plugin/.runtime ..."
  NODE_DIR=""
  [ -n "${POCKET_NODE:-}" ] && NODE_DIR="$(dirname "$POCKET_NODE")"
  [ -x "$NODE_DIR/npm" ] || NODE_DIR="$(dirname "$(command -v node)")"
  mkdir -p "$PLUGIN/.runtime"
  [ -f "$PLUGIN/.runtime/package.json" ] || echo '{"name":"pocket-terminal-openclaw-runtime","private":true}' > "$PLUGIN/.runtime/package.json"
  (cd "$PLUGIN/.runtime" && PATH="$NODE_DIR:$PATH" npm install "openclaw@$OPENCLAW_VERSION" --no-audit --no-fund)
fi

mkdir -p "$STATE"
if [ ! -f "$STATE/.config-merged" ] || [ "$PLUGIN/config/openclaw.json5" -nt "$STATE/.config-merged" ]; then
  "$OC" config patch --file "$PLUGIN/config/openclaw.json5"
  "$OC" config set agents.defaults.workspace "$STATE/workspace"
  [ "$PORT" = "19789" ] || "$OC" config set gateway.port "$PORT"
  touch "$STATE/.config-merged"
fi
# plugin/use-model.sh writes kimi|deepseek to .state/model; the agent's primary model follows it on every start
MODEL_CHOICE="$(cat "$STATE/model" 2>/dev/null || echo kimi)"
case "$MODEL_CHOICE" in
  deepseek) MODEL_REF="deepseek/deepseek-flash" ;;
  *) MODEL_REF="cerebras/moonshotai-kimi-k3.1-pro-trial" ;;
esac
[ "$("$OC" config get agents.defaults.model.primary 2>/dev/null | tr -d '"[:space:]')" = "$MODEL_REF" ] || "$OC" config set agents.defaults.model.primary "$MODEL_REF" >/dev/null
echo "model: $MODEL_CHOICE ($MODEL_REF)"
# Our own short persona files instead of OpenClaw's first-run "getting to know you" bootstrap.
mkdir -p "$STATE/workspace" "$STATE/workspace-seed-backup"
[ -f "$STATE/workspace/BOOTSTRAP.md" ] && mv "$STATE/workspace/BOOTSTRAP.md" "$STATE/workspace-seed-backup/"
cp "$PLUGIN"/workspace-files/*.md "$STATE/workspace/"
if [ ! -f "$STATE/.plugin-linked" ]; then
  # --force only skips the interactive "local path, outside ClawHub review" prompt.
  "$OC" plugins install --link "$PLUGIN/extension" --accept-capabilities --force || true
  "$OC" plugins inspect pocket-terminal >/dev/null && touch "$STATE/.plugin-linked"
fi

echo "Pocket Terminal Gateway (standard OpenClaw $OPENCLAW_VERSION): http://127.0.0.1:$PORT/terminal/"
exec "$OC" gateway --port "$PORT" "$@"
