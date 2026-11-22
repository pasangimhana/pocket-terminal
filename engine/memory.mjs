// Shared memory: every saved run in runs/ folds into one graph that keeps growing.
// Nodes are companies (by ticker when known), edges are "b is a's <rel>" with how many runs and filings said so.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm, pretty } from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'runs');
const FLIP = { supplier: 'customer', customer: 'supplier', competitor: 'competitor', partner: 'partner', investee: 'investor', investor: 'investee', other: 'other' };

let cache = { key: '', graph: null };

export async function memory() {
  const files = (await readdir(RUNS).catch(() => [])).filter(f => f.endsWith('.json') && !f.startsWith('dev-'));
  const stats = await Promise.all(files.map(async f => [f, (await stat(path.join(RUNS, f))).mtimeMs]));
  const key = stats.map(x => x.join(':')).sort().join('|');
  if (cache.key === key && cache.graph) return cache.graph;

  const nodes = new Map(), edges = new Map();
  const node = (id, name, ticker) => {
    let n = nodes.get(id);
    if (!n) { n = { id, name: name || id, ticker: ticker || null, maps: 0, degree: 0, desc: null }; nodes.set(id, n); }
    if (ticker && !n.ticker) n.ticker = ticker;
    return n;
  };
  const edge = (a, b, rel, file) => {
    if (!a || !b || a === b || !rel || rel === 'other') return;
    const k = `${a}|${b}|${rel}`;
    const e = edges.get(k) || { a, b, rel, n: 0, runs: new Set() };
    e.n++; e.runs.add(file);
    edges.set(k, e);
  };

  for (const [f] of stats) {
    let j;
    try { j = JSON.parse(await readFile(path.join(RUNS, f), 'utf8')); } catch { continue; }
    const ev = j.events || [];
    const scan = ev.find(e => e.type === 'scan');
    if (!scan) continue;
    const byName = new Map();
    for (const e of ev) if (e.type === 'candidates') for (const c of e.list || []) if (c.ticker) byName.set(norm(c.name), c.ticker);
    const idOf = (name, tk) => {
      const t = byName.get(norm(name)) || (tk && /^[A-Z.\-]{1,6}$/.test(String(tk)) ? String(tk) : null);
      return t ? 'T:' + t : 'N:' + norm(name);
    };
    const rootId = scan.kind === 'commodity' ? 'C:' + scan.commodity : 'T:' + scan.ticker;
    const root = node(rootId, scan.kind === 'commodity' ? scan.name : pretty(scan.name), scan.kind === 'commodity' ? null : scan.ticker);
    root.maps++;
    if (scan.kind === 'commodity') root.commodity = scan.commodity;
    const agentTicker = new Map();
    for (const e of ev) if (e.type === 'spawn') for (const a of e.agents || []) if (a.ticker) agentTicker.set(a.id, a.ticker);
    for (const e of ev) {
      if (e.type !== 'finding') continue;
      const x = e.f, id = e.agent || '';
      if (id[0] === 'a' && x.k === 'company' && x.rel) {
        const b = idOf(x.name, x.ticker); node(b, x.name, b.startsWith('T:') ? b.slice(2) : null);
        edge(rootId, b, x.rel, f);
      } else if (id[0] === 'b' && agentTicker.get(id)) {
        const filer = 'T:' + agentTicker.get(id);
        if (x.k === 'about') { node(filer, x.name, agentTicker.get(id)).desc ||= x.desc || null; continue; }
        if (x.k !== 'company' || !x.rel) continue;
        const b = idOf(x.name, x.ticker); node(b, x.name, b.startsWith('T:') ? b.slice(2) : null);
        edge(filer, b, x.rel, f);
      } else if (id[0] === 'm' && x.k === 'named' && x.rel && x.rel !== 'other' && (x.strength || 1) >= 2) {
        // "named": the filer's role toward the root -> the filer is the root's <rel>
        const b = idOf(x.name, x.ticker); node(b, x.name, x.ticker);
        edge(rootId, b, x.rel === 'investor' ? 'partner' : x.rel, f);
      } else if (id[0] === 'k' && x.k === 'chain' && x.stage && x.stage !== 'other') {
        const b = idOf(x.name, x.ticker); node(b, x.name, x.ticker);
        edge(rootId, b, x.stage, f);
      } else if (id[0] === 'p' && x.k === 'profile' && x.ticker) {
        node('T:' + x.ticker, x.name, x.ticker).desc ||= x.summary ? String(x.summary).slice(0, 160) : null;
      }
    }
  }
  const out = [...edges.values()].map(e => ({ a: e.a, b: e.b, rel: e.rel, n: e.n, runs: e.runs.size }));
  for (const e of out) { nodes.get(e.a).degree++; nodes.get(e.b).degree++; }
  const graph = { runs: stats.length, nodes: [...nodes.values()].filter(n => n.degree || n.maps), edges: out };
  cache = { key, graph };
  return graph;
}

// Neighbours of a node, as "b is X's <rel>" from X's side (edges stored either way round are flipped).
export function neighbours(g, id) {
  const out = new Map();
  for (const e of g.edges) {
    let other = null, rel = null;
    if (e.a === id) { other = e.b; rel = e.rel; } else if (e.b === id) { other = e.a; rel = FLIP[e.rel] || e.rel; }
    if (!other) continue;
    const cur = out.get(other) || { id: other, rels: new Set(), n: 0 };
    cur.rels.add(rel); cur.n += e.n;
    out.set(other, cur);
  }
  return out;
}

export async function compare(a, b) {
  const g = await memory();
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const A = 'T:' + String(a).toUpperCase(), B = 'T:' + String(b).toUpperCase();
  const na = neighbours(g, A), nb = neighbours(g, B);
  const side = (id, nbr) => ({ id, ticker: id.slice(2), name: byId.get(id)?.name || id.slice(2), mapped: Boolean(byId.get(id)?.maps), nodes: [...nbr.values()].map(x => ({ id: x.id, name: byId.get(x.id)?.name || x.id.slice(2), ticker: byId.get(x.id)?.ticker || null, rels: [...x.rels], n: x.n })).sort((p, q) => q.n - p.n) });
  const shared = [...na.keys()].filter(k => nb.has(k)).map(k => ({ id: k, name: byId.get(k)?.name || k.slice(2), ticker: byId.get(k)?.ticker || null, relA: [...na.get(k).rels], relB: [...nb.get(k).rels] }));
  const direct = na.has(B) ? [...na.get(B).rels] : [];
  return { a: side(A, na), b: side(B, nb), shared, direct };
}

// An index / sector / ETF as a web: members, links between members only, and the bottlenecks they depend on.
export async function web(id, membersOf) {
  const { title, members } = await membersOf(id);
  const g = await memory();
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const inside = new Set(members.map(m => 'T:' + m.ticker));
  const links = g.edges.filter(e => inside.has(e.a) && inside.has(e.b)).map(e => ({ a: e.a.slice(2), b: e.b.slice(2), rel: e.rel, n: e.n }));
  // bottleneck: how many members name it as a supplier (member or not, e.g. TSMC for the S&P 500)
  const dep = new Map();
  for (const e of g.edges) {
    let user = null, sup = null;
    if (e.rel === 'supplier' && inside.has(e.a)) { user = e.a; sup = e.b; }
    else if (e.rel === 'customer' && inside.has(e.b)) { user = e.b; sup = e.a; }
    if (!user || user === sup) continue;
    const d = dep.get(sup) || { id: sup, users: new Set() };
    d.users.add(user.slice(2));
    dep.set(sup, d);
  }
  const bottlenecks = [...dep.values()].map(d => ({ id: d.id, ticker: byId.get(d.id)?.ticker || null, name: byId.get(d.id)?.name || d.id.slice(2), member: inside.has(d.id), dependents: d.users.size, from: [...d.users].slice(0, 12) }))
    .sort((a, b) => b.dependents - a.dependents).slice(0, 20);
  const mapped = new Set(g.nodes.filter(n => n.maps).map(n => n.ticker));
  return { id, title, members: members.map(m => ({ ...m, mapped: mapped.has(m.ticker) })), links, bottlenecks, memoryRuns: g.runs };
}
