# Pocket Terminal

A pocket Bloomberg terminal built by an agent swarm. Type a ticker. An OpenClaw main agent running Kimi K3.1 Pro on Cerebras reads the company's annual report, starts one sub-agent per section at once, follows the network into its suppliers', customers' and rivals' filings, and draws the whole supply-chain graph live. Ask a what-if ("What if Taiwan is blockaded?") and one agent per company on the map answers at the same time.

Every node on the graph is backed by a quote from an SEC filing.

Built for the Cerebras x Moonshot AI x OpenClaw hackathon, November 2026 (#KimiOnCerebras). The main agent runs on a standard OpenClaw Gateway; the page is a plugin route at `/terminal`. It also runs standalone, scripted, with no OpenClaw.

## What you can do

- Type a ticker to get its supply-chain map: suppliers, customers, competitors, partners, products and risks.
- Type a commodity (Copper, Crude, Lithium, and more) to get its value chain, shipping chokepoints, production by country and trade flows.
- Type an index to map it: S&P 500, Nasdaq-100, Dow 30, sector maps (Semiconductors, Energy, Banks) or an ETF look-through (SMH, XLE, URA and others), with bottlenecks and index-wide what-ifs.
- Ask what-ifs. Impact spreads in shock rings from the hit company outward, with an approximate dollar impact.
- Run extra agent streams on a mapped company: who names you (every annual report that mentions it), what changed this year (10-K against last year's), and earnings (KPIs from the latest press release).
- Investigate any company on the map (button in its card; wave 17): agents read the filings that name it, other filers' reports and 8-Ks, its own annual report, Wikipedia and recent headlines, then one agent synthesises what it is, how it ties to the root and who else is connected. Private names and unnamed parties (Customer A) get the same treatment.
- News per company in its card, each headline tagged good, bad or neutral with a kind and a one-line reason, plus a red-flag filter (lawsuits, probes, recalls, breaches, restatements, layoffs). Google News, Yahoo and recent 8-K items; titles and links only, cached an hour.
- Hop along the chain: open a connected company's card and press Focus (or Map, for a private company such as Carl Zeiss). The map on screen pauses, the new map shows its core (the annual report, financials, price) first, and a trail at the top (NVDA › TSM › ASML) takes you back to any earlier map at once, with a Resume button for one that was paused. While a map is idle the next likely hop is read in the background (`PT_NO_PREFETCH=1` turns that off).
- Open data panels: insider trades (Form 4), institutional holders (13F), government contracts, macro, patents, Korean filings (Samsung, SK hynix) and TSMC monthly revenue.
- Compare two companies, see hidden links, see an earnings ripple across peers, keep a watchlist, export an analyst note (PNG or printable page), and fold every saved run into one shared memory graph.

## How it works

The OpenClaw main agent is the orchestrator. It calls `terminal_*` tools, and each tool starts a wave of sub-agents in one burst of streaming calls. All agents share one queue wait, then decode together. Sub-agents stream one JSON line per finding (company, relationship, verbatim quote), and the page draws each line as it arrives.

| Wave | Tool | What runs |
|---|---|---|
| 1 | `terminal_scan`, `terminal_spawn` | Fetch the 10-K and financials, then one agent per 10-K excerpt (about 32) |
| 2 | `terminal_expand` | One agent per connected company the main agent picked, each reading its own annual report |
| 3 | `terminal_news` | One agent per company reads its latest 8-K or 6-K: headline and sentiment |
| 4 | `terminal_whatif` | One agent per company on the map judges the question; results light up the graph |
| 5 | `terminal_profiles` | One agent per company builds a profile from its annual report |
| 6-9 | `terminal_resolve` | Unmask anonymous parties ("Customer A"): propose, validate, fill in, confirm |
| 11 | `terminal_named` | Who names you: one agent per annual report that mentions the company |
| 12 | `terminal_changes` | What changed: this year's 10-K against last year's |
| 13 | `terminal_earnings` | KPIs and guidance from the latest earnings release |
| 14 | `terminal_commodity` | A commodity's value chain, from annual reports that mention it |
| 16 | `terminal_indexshock` | One what-if across every member of an index, sector map or ETF |

Financials and peer tables come straight from SEC XBRL, with no model involved. The skill that tells the main agent how to drive the tools is `plugin/extension/skills/pocket-terminal/SKILL.md`.

## Quick start

You need Node 22 or newer for standalone mode. OpenClaw needs Node 24.16 up to 25 (not 25), or 26.1 and newer. Set `POCKET_NODE` in `.env` if the Node on your PATH is the wrong one.

```bash
git clone <this repo> && cd pocket-terminal
cp .env.example .env
# edit .env: set CEREBRAS_API_KEY and SEC_USER_AGENT ("Your Name you@example.com")
plugin/run-gateway.sh
```

The first run installs `openclaw@2026.11.6` into `plugin/.runtime`, merges the config and links the plugin. It never touches `~/.openclaw`; its state lives in `plugin/.state`. Then open http://127.0.0.1:19789/terminal/ and type a ticker.

## Standalone mode (no OpenClaw)

```bash
node server.mjs          # http://127.0.0.1:4790/ ; PORT=5000 node server.mjs to change it
```

This runs the same engine with a scripted session (scan, wave 1, then the 12 most mentioned companies) instead of an OpenClaw agent. Events from it are marked `scripted`. It needs only `CEREBRAS_API_KEY` and `SEC_USER_AGENT`.

## Replaying the sample runs

Four saved Kimi runs are kept in `runs/` (see `bench-results.md` for which is which). Replay one without any API key:

```
http://127.0.0.1:4790/?replay=NVDA-cerebras-2026-11-22T18-11-47.json
```

On the Gateway, use `http://127.0.0.1:19789/terminal/?replay=<file>`. Other files in `runs/` are ignored by git. `node record/record.mjs <run file>` records a replay to MP4 (needs `npm install`, Chrome and ffmpeg).

## Switching models

```bash
plugin/use-model.sh kimi        # Kimi K3.1 Pro on Cerebras, the default
plugin/use-model.sh deepseek    # DeepSeek Flash, for cheap testing (needs DEEPSEEK_API_KEY)
```

This sets the model for the main agent and the sub-agents together, then restarts the Gateway in the background.

## API keys

Put keys in `.env` (gitignored). Variables already set in your environment win. `POCKET_EXTRA_ENV` can point at other env files (colon-separated) so keys can stay where they already are.

| Variable | Needed for | Required |
|---|---|---|
| `CEREBRAS_API_KEY` | Kimi K3.1 Pro on Cerebras, all agents | Yes |
| `SEC_USER_AGENT` | SEC EDGAR asks for "Name email". A placeholder is used if unset | Recommended |
| `DEEPSEEK_API_KEY` | DeepSeek provider for testing | No |
| `OPENROUTER_API_KEY` | Kimi on GPU hosts, for the GPU-side benchmark | No |
| `EIA_API_KEY` | Oil and gas inventories | No |
| `NASS_API_KEY` | USDA crop reports | No |
| `PATENTSVIEW_API_KEY` | Not needed: patents come from Google Patents (PatentsView's API was retired in 2026) | No |
| `DART_API_KEY` | Korean filings (without it, a public disclosure page and Yahoo are used) | No |
| `COMTRADE_API_KEY` | Full UN Comtrade (the capped public preview works without) | No |
| `FRED_API_KEY` | FRED API (CSV works without) | No |

A feature whose key is missing says which variable to add instead of failing. `.env.example` lists every variable, including `PT_PROVIDER`, `PT_MODEL`, `PT_EFFORT`, `POCKET_NODE` and `POCKET_PORT`.

## Data sources

- SEC EDGAR: filings, XBRL company facts, full-text search, Form 4, 13F data sets, N-PORT (ETF holdings)
- Yahoo Finance chart endpoint: prices, futures and correlations
- USGS: mineral production by country
- UN Comtrade: trade flows
- USASpending: government contracts
- FRED: macro series
- EIA: oil and gas inventories
- USDA NASS: crop reports
- Google Patents: patents and technology overlap
- OpenDART: Korean filings
- Wikipedia: S&P 500, Nasdaq-100 and Dow member lists

## Benchmarks

Generation on Cerebras runs at about 380 to 500 tokens per second per agent, against 156 tok/s on the fastest GPU host measured. Wall-clock time is dominated by the shared trial queue, not generation: a 340 second map spent about 18 seconds generating. Per-wave tables are in [bench-results.md](bench-results.md); regenerate them with `python3 bench.py runs/<file>.json`.

## Project layout

| Path | What it is |
|---|---|
| `server.mjs` | Standalone scripted server |
| `engine/` | The engine: `run.mjs` (sessions and waves), `streams.mjs` (extra waves), `http.mjs` (routes), `llm.mjs` (providers), `sec.mjs`, `env.mjs`, `memory.mjs`, `watch.mjs` |
| `engine/sources/` | Data sources: SEC extras, holdings, keyed APIs, world data |
| `plugin/` | The OpenClaw side: tools, skill, config, scripts. See `plugin/README.md` |
| `web/` | The page: plain HTML, CSS and JS, no build step |
| `runs/` | Saved runs; four samples are kept in git |
| `record/` | Playwright script that records a replay to MP4 |
| `bench.py`, `journey.py` | Benchmark and timing scripts |

## Limitations

- Kimi K3.1 Pro on Cerebras was a private-preview trial with a shared queue. Requests can wait minutes for a first token, and the engine retries on HTTP 429.
- Only companies that file with the SEC are read. Other companies appear as names without their own filings.
- Customers the filings call "Customer A" are inferred, drawn dashed and labelled as guesses.
- Dollar impacts in what-ifs are model estimates, not forecasts. Nothing here is investment advice.
- SEC limits clients to 10 requests per second; the code stays under that, so cold filings take a moment to fetch.
- OpenClaw is pinned to 2026.11.6. Other versions are untested.
