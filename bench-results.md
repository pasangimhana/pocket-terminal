# Runs for the video

Newest complete Kimi K3.1 Pro on Cerebras runs (all in `runs/`, all verified: 0 agent errors, every wave finished):

- **Use these: driven by the real OpenClaw Main Agent** (the agent called terminal_scan, terminal_spawn, terminal_expand, terminal_news, terminal_profiles, terminal_resolve and terminal_whatif itself; no scripted steps):
  - `runs/NVDA-cerebras-2026-11-22T18-11-47.json`: NVDA map, then the what-if "What if Taiwan is blockaded?" (96 agents for the map, 126 including the what-if; 622 findings)
  - `runs/AMD-cerebras-2026-11-22T18-14-42.json`: AMD map (80 agents, 541 findings)
  - Journey timing on the gateway: search 0.0 s, NVDA map 467.8 s, what-if 8.1 s, search 0.0 s, AMD map 166.5 s, total 642.4 s. Nearly all of it is waiting in the shared Kimi trial queue (HTTP 429), not generation.
- **Earlier pair from the scripted server** (real Kimi sub-agents, but the Main Agent's steps were written by code): `runs/NVDA-cerebras-2026-11-22T17-39-24.json` (NVDA + the same what-if, 124 agents) and `runs/AMD-cerebras-2026-11-22T17-45-38.json` (AMD, 79 agents).

Replay any run in the app: `http://127.0.0.1:19789/terminal/?replay=<file name>`

# Benchmark · Kimi K3.1 Pro on Cerebras vs DeepSeek (2026-11-22)

Journey on Kimi (separate scripted server, port 4792): search NV 0.0s → map NVDA 340.2s → what-if 17.1s → search AM 0.0s → map AMD 355.0s → total ≈ 712s.
DeepSeek through OpenClaw on the gateway: map NVDA 25.0s, what-if 5.5s.

Generation is fast on Cerebras (≈380–500 tok/s per agent, 26K-token 10-K wave generated in 3.6s vs 10.7s at 156 tok/s). Wall-clock is almost all queue wait on the shared trial endpoint (≈342s of the 340s map).

## NVDA-cerebras-2026-11-22T17-39-24.json  ·  Kimi K3.1 Pro · Cerebras  ·  map wall-clock 340.2s

| Wave | Agents | Tokens | Queue wait (median / max) | Generation | Median tok/s | Wave wall | Same tokens at GPU 156 tok/s |
|---|---|---|---|---|---|---|---|
| 10-K sections | 32 | 26,299 | 37.4s / 41.0s | 3.59s | 504 | 44.3s | 10.7s |
| connected filings | 12 | 7,623 | 0.8s / 3.6s | 2.55s | 411 | 5.7s | 7.2s |
| latest 8-Ks | 13 | 1,554 | 2.7s / 7.6s | 0.66s | 432 | 7.9s | 1.0s |
| what-if | 30 | 5,576 | 8.2s / 16.2s | 1.19s | 360 | 17.1s | 1.6s |
| annual reports | 24 | 22,381 | 8.8s / 134.5s | 3.77s | 382 | 136.5s | 9.5s |
| unmask | 2 | 800 | 25.9s / 26.5s | 1.70s | 266 | 28.1s | 2.6s |
| validate | 4 | 759 | 6.4s / 36.4s | 0.94s | 419 | 36.7s | 1.7s |
| fill-in | 1 | 786 | 46.5s / 46.5s | 2.82s | 278 | 49.3s | 5.0s |
| confirm | 6 | 683 | 22.6s / 30.2s | 0.69s | 384 | 30.4s | 0.8s |

Sum over waves: generation 17.9s · same tokens at GPU pace 40.1s · worst queue waits 342.4s

## AMD-cerebras-2026-11-22T17-45-38.json  ·  Kimi K3.1 Pro · Cerebras  ·  map wall-clock 354.9s

| Wave | Agents | Tokens | Queue wait (median / max) | Generation | Median tok/s | Wave wall | Same tokens at GPU 156 tok/s |
|---|---|---|---|---|---|---|---|
| 10-K sections | 32 | 26,021 | 44.0s / 123.8s | 3.35s | 482 | 125.7s | 11.4s |
| connected filings | 12 | 8,755 | 14.7s / 32.0s | 2.32s | 472 | 33.7s | 7.4s |
| latest 8-Ks | 13 | 1,568 | 25.4s / 36.2s | 0.79s | 438 | 36.9s | 1.4s |
| annual reports | 19 | 15,660 | 2.6s / 7.7s | 3.74s | 382 | 10.3s | 9.1s |
| unmask | 1 | 328 | 69.1s / 69.1s | 1.00s | 327 | 70.1s | 2.1s |
| validate | 2 | 208 | 45.1s / 77.2s | 0.67s | 394 | 77.4s | 0.8s |

Sum over waves: generation 11.9s · same tokens at GPU pace 32.2s · worst queue waits 346.0s

## NVDA-deepseek-2026-11-22T17-02-02.json  ·  deepseek-flash · DeepSeek (test)  ·  map wall-clock 25.0s

| Wave | Agents | Tokens | Queue wait (median / max) | Generation | Median tok/s | Wave wall | Same tokens at GPU 156 tok/s |
|---|---|---|---|---|---|---|---|
| 10-K sections | 32 | 19,205 | 1.1s / 1.3s | 3.63s | 290 | 4.8s | 7.9s |
| connected filings | 12 | 4,167 | 0.7s / 0.7s | 1.94s | 268 | 2.6s | 3.8s |
| latest 8-Ks | 13 | 434 | 0.7s / 0.8s | 0.40s | 140 | 1.1s | 0.2s |
| what-if | 30 | 1,369 | 0.6s / 1.0s | 0.43s | 127 | 1.5s | 0.3s |
| annual reports | 22 | 9,951 | 0.7s / 1.7s | 3.12s | 218 | 4.0s | 4.5s |
| unmask | 2 | 260 | 0.5s / 0.6s | 0.67s | 197 | 1.2s | 0.8s |
| validate | 6 | 379 | 0.5s / 0.6s | 0.60s | 164 | 1.2s | 0.5s |

Sum over waves: generation 10.8s · same tokens at GPU pace 18.1s · worst queue waits 6.7s
