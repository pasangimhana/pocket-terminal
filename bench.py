#!/usr/bin/env python3
"""Benchmark saved Pocket Terminal runs, wave by wave.

usage: python3 bench.py runs/A.json [runs/B.json ...]

Per wave: agents, output tokens, queue wait (spawn -> first token), generation time
(first token -> done, the slowest agent, since agents run in parallel), median tok/s,
wave wall time (spawn -> last agent done) and the same tokens at 156 tok/s
(the fastest GPU host measured for Kimi K3.1 Pro during the hackathon).
"""
import json, statistics, sys

GPU_TPS = 156
KIND = {1: '10-K sections', 2: 'connected filings', 3: 'latest 8-Ks', 4: 'what-if', 5: 'annual reports',
        6: 'unmask', 7: 'validate', 8: 'fill-in', 9: 'confirm'}


def waves(path):
    ev = json.load(open(path))['events']
    spawn_t, wave_of, first, done = {}, {}, {}, {}
    for e in ev:
        if e['type'] == 'spawn':
            w = e.get('wave', 1)
            spawn_t.setdefault(w, e['t'])
            for a in e['agents']:
                wave_of[a['id']] = w
        elif e['type'] == 'first':
            first.setdefault(e['agent'], e['t'])
        elif e['type'] == 'done':
            done[e['agent']] = e
    asks = [e['t'] for e in ev if e['type'] == 'ask']
    ends = [e['t'] for e in ev if e['type'] == 'end']
    rows = []
    for w in sorted(spawn_t):
        ids = [a for a, x in wave_of.items() if x == w]
        d = [done[a] for a in ids if a in done]
        if not d:
            continue
        tok = [x.get('tokens') or 0 for x in d]
        tps = [x['tps'] for x in d if x.get('tps')]
        q = [first[a] - spawn_t[w] for a in ids if a in first]
        gen = []
        for x in d:
            if x.get('genMs') is not None:
                gen.append(x['genMs'])
            elif x['agent'] in first:
                gen.append(x['t'] - first[x['agent']])
            if not tps and x.get('tokens') and gen and gen[-1] > 0:
                tps.append(x['tokens'] / (gen[-1] / 1000))
        rows.append({
            'wave': w, 'kind': KIND.get(w, f'wave {w}'), 'agents': len(ids), 'tokens': sum(tok),
            'queue_med': statistics.median(q) / 1000 if q else None, 'queue_max': max(q) / 1000 if q else None,
            'gen': max(gen) / 1000 if gen else None, 'tps': statistics.median(tps) if tps else None,
            'wall': (max(x['t'] for x in d) - spawn_t[w]) / 1000, 'gpu': max(tok) / GPU_TPS if tok else None,
        })
    total = (ends[0] - asks[0]) / 1000 if asks and ends else None
    return rows, total, json.load(open(path)).get('provider', '?')


def f(v, unit='s', d=1):
    return '–' if v is None else f'{v:.{d}f}{unit}'


for path in sys.argv[1:]:
    rows, total, prov = waves(path)
    print(f'\n## {path.split("/")[-1]}  ·  {prov}  ·  map wall-clock {f(total)}\n')
    print('| Wave | Agents | Tokens | Queue wait (median / max) | Generation | Median tok/s | Wave wall | Same tokens at GPU 156 tok/s |')
    print('|---|---|---|---|---|---|---|---|')
    for r in rows:
        print(f"| {r['kind']} | {r['agents']} | {r['tokens']:,} | {f(r['queue_med'])} / {f(r['queue_max'])} | {f(r['gen'], d=2)} | {f(r['tps'], '', 0)} | {f(r['wall'])} | {f(r['gpu'])} |")
    gen_sum = sum(r['gen'] or 0 for r in rows); gpu_sum = sum(r['gpu'] or 0 for r in rows); q_sum = sum(r['queue_max'] or 0 for r in rows)
    print(f"\nSum over waves: generation {gen_sum:.1f}s · same tokens at GPU pace {gpu_sum:.1f}s · worst queue waits {q_sum:.1f}s")
