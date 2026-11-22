#!/usr/bin/env python3
"""Time a user's journey against a Pocket Terminal server:
search first ticker -> map it -> ask a what-if -> search second ticker -> map it.

usage: python3 journey.py http://127.0.0.1:4792 NVDA AMD "What if Taiwan is blockaded?" [--skip-first-map]
"""
import json, sys, time, urllib.parse, urllib.request

base, t1, t2, question = sys.argv[1:5]
skip_first = '--skip-first-map' in sys.argv


def get(path):
    t = time.time()
    with urllib.request.urlopen(base + path, timeout=60) as r:
        body = json.loads(r.read().decode() or 'null')
    return body, time.time() - t


def wait_idle(label, limit=1800):
    t = time.time()
    while time.time() - t < limit:
        cfg, _ = get('/api/config')
        if not cfg.get('busy'):
            return time.time() - t
        time.sleep(2)
    raise SystemExit(f'{label}: still busy after {limit}s')


steps = []
print('waiting for the server to be idle…', flush=True)
wait_idle('pre')

_, dt = get('/api/search?q=' + urllib.parse.quote(t1[:2]))
steps.append((f'Search "{t1[:2]}"', dt))
if not skip_first:
    t = time.time(); get('/api/ask?q=' + t1); wait_idle('map1'); steps.append((f'Map {t1}', time.time() - t))
    print(f'map {t1}: {steps[-1][1]:.1f}s', flush=True)

t = time.time(); r, _ = get('/api/ask?mode=whatif&q=' + urllib.parse.quote(question)); wait_idle('whatif')
steps.append((f'What-if: {question}', time.time() - t)); print(f'what-if: {steps[-1][1]:.1f}s', flush=True)

_, dt = get('/api/search?q=' + urllib.parse.quote(t2[:2])); steps.append((f'Search "{t2[:2]}"', dt))
t = time.time(); get('/api/ask?q=' + t2); wait_idle('map2'); steps.append((f'Map {t2}', time.time() - t))
print(f'map {t2}: {steps[-1][1]:.1f}s', flush=True)

print('\n| Step | Time |\n|---|---|')
for name, dt in steps:
    print(f'| {name} | {dt:.1f}s |')
print(f'| **Total** | **{sum(d for _, d in steps):.1f}s** |')
