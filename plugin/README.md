# Pocket Terminal on OpenClaw

The OpenClaw side of Pocket Terminal. The OpenClaw main agent is the orchestrator and calls these tools:

- `terminal_scan` (10-K + financials), `terminal_spawn` (wave 1: one sub-agent per 10-K excerpt),
  `terminal_expand` (wave 2: one sub-agent per connected company it chose) and `terminal_news` (one
  sub-agent per company's latest 8-K/6-K), then `terminal_profiles` and `terminal_resolve`
  (profiles and unmasking anonymous parties), then it writes the final answer.
- `terminal_whatif`: a what-if question about the mapped company, one sub-agent per company on the map.
- `terminal_named` (who names the company), `terminal_changes` (what changed this year) and
  `terminal_earnings` (KPIs from the latest earnings release).
- `terminal_commodity`: map a commodity's value chain instead of a company.
- `terminal_indexshock`: one what-if across an index, sector map or ETF.

Every step streams to the page the plugin serves on the Gateway at `/terminal/`. It runs on a
standard, unpatched OpenClaw release (npm `openclaw@2026.11.6`), isolated from `~/.openclaw`.

## Run it

```bash
plugin/run-gateway.sh          # foreground Gateway on 127.0.0.1:19789
plugin/use-model.sh kimi       # switch model (kimi | deepseek) for the agent AND the sub-agents; restarts the Gateway in the background
```

- Page: http://127.0.0.1:19789/terminal/ (no token: the route is `auth: "plugin"`, loopback only).
- Ask from the page: `GET /terminal/api/ask?q=NVDA` starts a session and runs a real OpenClaw agent
  turn (`plugin/oc agent --agent main --session-id pt-<ts> -m "Map NVDA (NVIDIA)"`) as a child process.
  409 while a session is running.
- What-if from the page: `GET /terminal/api/ask?q=What%20if%20Taiwan%20is%20blockaded%3F&mode=whatif`
  continues the last map session (same event list and file; after a restart it reloads the newest
  map from `runs/`). 400 if nothing has been mapped.
- Financials: `GET /terminal/api/financials?ticker=AMD` (SEC companyfacts, us-gaap or ifrs-full, no LLM).
- Ask from the chat: `plugin/oc dashboard` (Control UI with a one-time sign-in link; don't pass
  `--yes`) and type "map NVDA". The tools start their own session (`source: "chat"`); it ends after
  wave 2, without a captured reply.
- CLI: `plugin/oc agent --agent main --session-id demo -m "Map NVDA"`.
- Standalone, no OpenClaw: `node server.mjs` (port 4790) runs the same flow scripted; bot events
  carry `scripted: true`.

Model choice lives in `.state/model` (default `kimi`): `kimi` = Kimi K3.1 Pro on Cerebras for both
the agent and the sub-agents, reasoning effort low; `deepseek` = `deepseek/deepseek-flash` for the
agent and `PT_PROVIDER=deepseek` (thinking disabled) for the sub-agents.

## Layout

| Path | What it is |
| --- | --- |
| `extension/` | The OpenClaw plugin package: `index.js` (plain ESM, no build), `openclaw.plugin.json`, `skills/pocket-terminal/SKILL.md` |
| `config/openclaw.json5` | Merged into the Gateway's config: DeepSeek and Cerebras providers, only the `terminal_*` tools exposed, no bootstrap, cron and mDNS off, port 19789 |
| `workspace-files/` | Short AGENTS/SOUL/IDENTITY/USER files copied into the agent workspace on every start (replaces OpenClaw's first-run bootstrap) |
| `oc` | The OpenClaw CLI with this setup's environment. Use it for every `openclaw` command here |
| `run-gateway.sh` | First run: installs OpenClaw, merges the config, links the plugin. Every start: sets the model, refreshes the workspace files, starts the Gateway |
| `use-model.sh` | `kimi` or `deepseek`, then restarts the Gateway |
| `.runtime/` | `openclaw@2026.11.6` from npm |
| `.state/` | This Gateway's home, state, config, sessions, workspace, logs, token and model choice |

`oc` sets `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` to `.state/`, the port to
19789 (`POCKET_PORT` overrides it), picks a Node that OpenClaw accepts (24.16+ or 26.1+, from `POCKET_NODE` or your PATH),
sets `PT_PROVIDER` from `.state/model`, and loads `CEREBRAS_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`, `SEC_USER_AGENT` and `POCKET_NODE` from the repo `.env` (or `POCKET_ENV_FILE`),
then from each file in `POCKET_EXTRA_ENV`, without printing them. Values already in the environment win.

## Notes

- The plugin imports `engine/http.mjs` and `engine/run.mjs` by absolute path (`POCKET_ENGINE_DIR`)
  through a `data:` module. OpenClaw's loader otherwise copies whatever a plugin imports into a temp
  folder, and the engine's `web/` and `runs/` paths would break.
- Restart the Gateway after editing the engine or the plugin (`plugin/use-model.sh <current model>`
  does stop + start). `web/` files are read per request and need no restart.
- The plugin package lives in `extension/`, apart from `.runtime/`. Linking a folder that holds
  OpenClaw's own bundled plugins makes the Gateway refuse to start.
- To stop it: `kill $(lsof -iTCP:19789 -sTCP:LISTEN -t)`.
