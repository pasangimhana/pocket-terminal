// Plain Node request handler, mounted at any prefix. The standalone server (server.mjs) mounts it at ""
// in scripted mode; the OpenClaw plugin mounts it at "/terminal" with mode "openclaw", where /api/ask
// runs a real OpenClaw agent turn that drives the scan/spawn/expand tools.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchTickers, findTicker, financials, ratiosFrom } from './sec.mjs';
import { subscribe, currentSession, isBusy, scriptedAsk, openclawAsk, scriptedWhatif, openclawWhatif, pretty } from './run.mjs';
import * as Hop from './hop.mjs';
import { providerConfig } from './llm.mjs';
import './env.mjs';
import { profile, privateProfile } from './profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const RUNS = path.join(ROOT, 'runs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  return true;
}

async function serveFile(res, base, rel) {
  const f = path.normalize(path.join(base, rel));
  if (!f.startsWith(base) || !existsSync(f)) return false;
  send(res, 200, await readFile(f), TYPES[path.extname(f)] || 'application/octet-stream');
  return true;
}

export async function handle(req, res, { prefix = '', mode = 'scripted' } = {}) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (prefix && !p.startsWith(prefix)) return false;
  p = p.slice(prefix.length) || '/';
  try {
    if (p === '/' || p === '/index.html') return serveFile(res, WEB, 'index.html');
    if (p === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const list = await searchTickers(q, 7);
      const logos = new Set((await readdir(path.join(WEB, 'logos')).catch(() => [])).map(f => f.replace('.png', '')));
      const extra = await specialMatches(q).catch(() => []);
      return send(res, 200, [...extra, ...list.map(t => ({ ...t, logo: logos.has(t.ticker) }))].slice(0, 8));
    }
    if (p === '/api/config') {
      const c = providerConfig();
      return send(res, 200, { provider: c.name, label: c.label, model: c.model, mode, busy: isBusy() });
    }
    if (p === '/api/ask' || p === '/api/run') {
      const q = url.searchParams.get('q') || url.searchParams.get('ticker') || '';
      if (!q.trim()) return send(res, 400, { error: 'q required' });
      const whatif = url.searchParams.get('mode') === 'whatif';
      const kind = url.searchParams.get('mode') || url.searchParams.get('kind') || '';
      try {
        const st = await import('./streams.mjs');
        if (['named', 'changes', 'earnings'].includes(kind)) {
          const s = await st.streamAsk(kind, mode);
          return send(res, 200, { ok: true, mode: kind, ticker: s.meta?.ticker ?? null });
        }
        if (kind === 'indexshock') {
          const id = url.searchParams.get('index') || 'SPX';
          await st.indexShockAsk(id, q, mode);
          return send(res, 200, { ok: true, mode: kind, index: id });
        }
        const com = kind === 'commodity' ? (url.searchParams.get('c') || q) : (!whatif && !/^\$?[A-Z.\-]{1,6}$/.test(q.trim()) ? q : '');
        if (com) {
          const W = await import('./sources/world.mjs').catch(() => null);
          const key = W && (W.COMMODITIES[com] ? com : W.findCommodity(com));
          if (key) { await st.commodityAsk(key, q, mode); return send(res, 200, { ok: true, mode: 'commodity', commodity: key, ticker: key.toUpperCase() }); }
        }
        if (whatif) {
          const s = await (mode === 'openclaw' ? openclawWhatif(q) : scriptedWhatif(q));
          return send(res, 200, { ok: true, q, mode: 'whatif', ticker: s.meta?.ticker ?? null });
        }
        const s = await (mode === 'openclaw' ? openclawAsk(q) : scriptedAsk(q));
        return send(res, 200, { ok: true, q, ticker: s.hit?.ticker ?? null, name: s.hit?.name ?? null, mode });
      } catch (e) {
        if (e.code === 'BUSY') return send(res, 409, { error: e.message });
        if (e.code === 'NOMAP') return send(res, 400, { error: e.message });
        throw e;
      }
    }
    // chain hopping (engine/hop.mjs): a hop pauses the map on screen instead of answering 409
    if (p.startsWith('/api/hop')) {
      const g = k => url.searchParams.get(k) || '';
      try {
        if (p === '/api/hop') return send(res, 200, await Hop.hop({ q: g('q'), from: g('from'), fromName: g('fromName'), rel: g('rel'), quote: g('quote'), private: g('private') === '1', mode }));
        if (p === '/api/hop/state') return send(res, 200, Hop.state());
        if (p === '/api/hop/go') { const s = await Hop.goTo(g('id')); return send(res, 200, { ok: true, id: s.id, paused: s.paused }); }
        if (p === '/api/hop/resume') { const s = await Hop.resume(g('id'), mode); return send(res, 200, { ok: true, id: s?.id }); }
        if (p === '/api/hop/hint') { Hop.hint(g('ticker')); return send(res, 200, { ok: true }); }
      } catch (e) {
        if (e.code === 'BAD') return send(res, 400, { error: e.message });
        if (e.code === 'NOHIT' || e.code === 'NOTRAIL') return send(res, 404, { error: e.message });
        throw e;
      }
    }
    if (p === '/api/profile') {
      try {
        const tk = url.searchParams.get('ticker'), nm = url.searchParams.get('name');
        if (!tk && nm) { const { mentionsOf } = await import('./run.mjs'); return send(res, 200, await privateProfile(nm, mentionsOf)); }
        return send(res, 200, await profile(tk || ''));
      }
      catch (e) { return send(res, 422, { error: String(e.message || e) }); }
    }
    if (p === '/api/financials') {
      const t = await findTicker(url.searchParams.get('ticker') || '');
      if (!t) return send(res, 404, { error: 'unknown ticker' });
      const rows = await financials(t.cik);
      return send(res, 200, { ticker: t.ticker, name: pretty(t.name), rows, ratios: ratiosFrom(rows) });
    }
    if (p.startsWith('/api/wire')) return (await import('./wire.mjs')).handle(req, res, p, url, { mode });
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': hello\n\n');
      // fresh=1: skip a finished session's backlog and only stream what comes next
      const fresh = url.searchParams.get('fresh') === '1';
      // skip the backlog of a finished session by identity, so a new session's events are never swallowed
      const old = fresh && currentSession()?.finished ? new Set(currentSession().events) : null;
      // replayed events (a late page, a saved map loaded back) are marked fast: the page skips its story pauses
      const unsub = subscribe((e, replayed) => { if (old && old.has(e)) return; res.write(`data: ${JSON.stringify(replayed ? { ...e, fast: true } : e)}\n\n`); });
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { unsub(); clearInterval(ping); });
      return true;
    }
    if (p.startsWith('/api/') && DATA[p.slice(5)]) {
      const r = await DATA[p.slice(5)](url.searchParams).catch(e => ({ error: String(e.message || e) }));
      return send(res, r && r.error && !r.needsKey ? 422 : 200, r ?? { error: 'no data' });
    }
    if (p === '/api/runs') {
      const files = (await readdir(RUNS).catch(() => [])).filter(f => f.endsWith('.json')).sort().reverse();
      return send(res, 200, files);
    }
    if (p.startsWith('/runs/')) return (await serveFile(res, RUNS, p.slice(6))) || send(res, 404, { error: 'not found' });
    if (await serveFile(res, WEB, p.slice(1))) return true;
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
    else res.end();
    return true;
  }
}

// ---- data routes: no agents, straight from public sources (each module loads on first use) ----
const mod = name => import(`./sources/${name}.mjs`);
const cikOf = async q => { const t = await findTicker(q.get('ticker') || ''); if (!t) throw new Error('unknown ticker'); return t; };
const list = (q, k) => String(q.get(k) || '').split(',').map(x => x.trim()).filter(Boolean);
const DATA = {
  insiders: async q => (await mod('sec-extra')).insiders((await cikOf(q)).cik),
  earningsrelease: async q => (await mod('sec-extra')).earningsRelease((await cikOf(q)).cik),
  tsmc: async () => (await mod('sec-extra')).tsmcMonthly(),
  holders: async q => (await mod('holdings')).holders(q.get('name') || pretty((await cikOf(q)).name)),
  sharedholders: async q => (await mod('holdings')).sharedHolders(list(q, 'names')),
  etf: async q => (await mod('holdings')).etfHoldings(String(q.get('symbol') || '').toUpperCase()),
  index: async q => (await mod('holdings')).indexMembers(String(q.get('id') || 'SPX').toUpperCase()),
  contracts: async q => (await mod('world')).usaspending(q.get('name') || pretty((await cikOf(q)).name)),
  macro: async () => (await mod('world')).macro(),
  eia: async () => (await mod('world')).eiaInventories(),
  usda: async q => (await mod('world')).usdaCrops(q.get('c') || 'wheat'),
  futures: async q => (await mod('world')).futures(q.get('c') || ''),
  production: async q => (await mod('world')).production(q.get('c') || ''),
  trade: async q => (await mod('world')).trade(q.get('c') || '', { flow: q.get('flow') || 'X' }),
  routes: async q => (await mod('world')).routesFor(q.get('c') || ''),
  commodities: async () => Object.entries((await mod('world')).COMMODITIES).map(([key, c]) => ({ key, name: c.name, futures: Array.isArray(c.futures) ? c.futures[0] : c.futures })),
  correlations: async q => (await mod('world')).correlations(list(q, 'tickers').slice(0, 40), { days: +(q.get('days') || 250) }),
  ripple: async q => (await mod('world')).earningsMoves(String(q.get('ticker') || '').toUpperCase(), list(q, 'peers').slice(0, 16)),
  patents: async q => (await mod('keyed')).patents(q.get('assignee') || ''),
  overlap: async q => (await mod('keyed')).techOverlap(q.get('a') || '', q.get('b') || ''),
  dart: async q => { const k = await mod('keyed'); const c = q.get('company') || 'samsung'; const [filings, fin] = await Promise.all([k.dartFilings(c), k.dartFinancials(c)]); return filings?.needsKey ? filings : { filings, financials: fin }; },
  keys: async () => (await mod('keyed')).keyStatus(),
  memory: async () => (await import('./memory.mjs')).memory(),
  compare: async q => (await import('./memory.mjs')).compare(q.get('a') || '', q.get('b') || ''),
  web: async q => { const st = await import('./streams.mjs'); return (await import('./memory.mjs')).web(String(q.get('id') || 'SPX').toUpperCase(), st.membersOf); },
  watch: async q => { const w = await import('./watch.mjs'); if (q.get('off')) return w.unwatch(); const t = list(q, 'tickers'); return t.length ? w.watch(t) : w.status(); },
};

// Commodities, index maps and ETFs show up in the search box next to tickers.
const SPECIAL = [
  { id: 'SPX', name: 'S&P 500 web', words: ['spx', 's&p', 's&p 500', 'sp500', 'spy'] },
  { id: 'NDX', name: 'Nasdaq-100 web', words: ['ndx', 'nasdaq', 'nasdaq-100', 'qqq'] },
  { id: 'DJI', name: 'Dow 30 web', words: ['dji', 'dow', 'dow 30', 'dia'] },
  { id: 'SEMIS', name: 'Semiconductors map', words: ['semis', 'semiconductors', 'chips'] },
  { id: 'ENERGY', name: 'Energy map', words: ['energy'] },
  { id: 'BANKS', name: 'Banks map', words: ['banks', 'banking'] },
];
const ETFS = ['SMH', 'SOXX', 'XLE', 'XLK', 'XLF', 'URA', 'ICLN', 'LIT', 'GDX', 'XME', 'COPX', 'ITA', 'IBB', 'XBI'];
async function specialMatches(q) {
  const t = q.trim().toLowerCase();
  if (t.length < 2) return [];
  const out = [];
  const W = await mod('world').catch(() => null);
  if (W) for (const [key, c] of Object.entries(W.COMMODITIES)) {
    const names = [c.name, ...(c.aliases || [])].map(x => String(x).toLowerCase());
    if (names.some(n => n.startsWith(t))) out.push({ type: 'commodity', key, ticker: key.toUpperCase(), name: c.name, symbol: (Array.isArray(c.futures) ? c.futures[0] : c.futures)?.symbol || null });
  }
  for (const x of SPECIAL) if (x.words.some(w => w.startsWith(t)) || x.id.toLowerCase().startsWith(t)) out.push({ type: 'web', ticker: x.id, name: x.name });
  for (const e of ETFS) if (e.toLowerCase() === t || (t.length >= 3 && e.toLowerCase().startsWith(t))) out.push({ type: 'etf', ticker: e, name: `${e} ETF look-through` });
  if (/^(compare\s+|.+\s+vs\.?\s+)/i.test(q.trim())) {
    const m = /^compare\s+\$?([a-z.\-]{1,6})\s*(?:,|and|vs\.?|&)?\s*\$?([a-z.\-]{1,6})$/i.exec(q.trim()) || /^\$?([a-z.\-]{1,6})\s+vs\.?\s+\$?([a-z.\-]{1,6})$/i.exec(q.trim());
    if (m) out.push({ type: 'compare', ticker: `${m[1].toUpperCase()} vs ${m[2].toUpperCase()}`, a: m[1].toUpperCase(), b: m[2].toUpperCase(), name: 'Compare side by side' });
  }
  if (['wire', 'news', 'news wire', 'live news'].some(w => w.startsWith(t))) out.push({ type: 'wire', ticker: 'WIRE', name: 'News Wire: live news scored by agents' });
  if ('memory'.startsWith(t) || t === 'shared memory') out.push({ type: 'memory', ticker: 'MEMORY', name: 'Shared memory: every run in one graph' });
  return out.slice(0, 4);
}
