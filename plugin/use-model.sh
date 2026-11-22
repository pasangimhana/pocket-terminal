#!/usr/bin/env bash
# Switches the model for BOTH the OpenClaw orchestrator agent and the engine's sub-agents, then restarts
# the Pocket Terminal Gateway in the background (log: plugin/.state/gateway.log).
#   plugin/use-model.sh kimi        # Kimi K3.1 Pro on Cerebras, reasoning effort low (the hackathon model)
#   plugin/use-model.sh deepseek    # DeepSeek Flash (testing)
set -euo pipefail
PLUGIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$PLUGIN/.state"
PORT="${POCKET_PORT:-19789}"
case "${1:-}" in
  kimi) REF="cerebras/moonshotai-kimi-k3.1-pro-trial" ;;
  deepseek) REF="deepseek/deepseek-flash" ;;
  *) echo "usage: $0 kimi|deepseek" >&2; exit 2 ;;
esac
mkdir -p "$STATE"

# stop the running Gateway (only ours: the one listening on our port)
PID="$(lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$PID" ]; then
  kill -TERM $PID
  for _ in $(seq 1 30); do lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 1; done
fi

echo "$1" > "$STATE/model"   # run-gateway.sh sets the agent's primary model from this; plugin/oc sets PT_PROVIDER
echo "model: $1 ($REF); engine PT_PROVIDER follows it"

nohup "$PLUGIN/run-gateway.sh" > "$STATE/gateway.log" 2>&1 &
for _ in $(seq 1 60); do grep -q "\] ready\|Gateway failed" "$STATE/gateway.log" 2>/dev/null && break; sleep 1; done
if grep -q "\] ready" "$STATE/gateway.log"; then
  echo "Gateway up: http://127.0.0.1:$PORT/terminal/ (pid $(lsof -iTCP:"$PORT" -sTCP:LISTEN -t))"
else
  echo "Gateway did not report ready; see $STATE/gateway.log" >&2; exit 1
fi
