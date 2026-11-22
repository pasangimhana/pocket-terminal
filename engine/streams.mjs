// New agent waves on top of the map, plus whole new maps:
//   wave 11 named     "Who names you": every annual report that mentions the company, one agent each
//   wave 12 changes   "What changed this year": this 10-K vs last year's, one agent per block of new/dropped paragraphs
//   wave 13 earnings  KPIs from the latest earnings press release (8-K exhibit 99.1), one agent per company
//   wave 14 chain     a commodity's value chain: every annual report that mentions it, one agent each
//   wave 16 indexshock one what-if across every member of an index, sector map or ETF
// Each one is a function the OpenClaw tools call (plugin/extension/index.js) and the scripted server calls directly.
import {
  currentSession, isBusy, runAgent, inputOf, norm, pretty, shortName, finishSession, newSession, reopen, needMap, runAgentTurn,
} from './run.mjs';
import { findTicker, financials, ratiosFrom, priceSeries, secGet, cached, htmlToText, splitItems } from './sec.mjs';

const src = name => import(`./sources/${name}.mjs`);
const words = (t, n) => String(t || '').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
const NAMED_MAX = 200;
const CHAIN_MAX = 160;
const CHANGES_MAX = 24;
const EARNINGS_MAX = 12;

// run fn over items with at most n in flight; failures become null
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await Promise.resolve().then(() => fn(items[k], k)).catch(() => null); }
  }));
  return out;
}

function addMention(s, name, tickerObj, rel, weight = 1) {
  const key = norm(name);
  if (!key || key === norm(s.meta.name) || key === norm(s.meta.short)) return;
  const m = s.mentions.get(key) || { name, ticker: null, count: 0, rels: new Set(), looked: true };
  s.mentions.set(key, m);
  m.count += weight;
  if (rel) m.rels.add(rel);
  if (tickerObj && !m.ticker) m.ticker = tickerObj;
}

function candidatesFrom(s) {
  const merged = new Map();
  for (const m of s.mentions.values()) {
    const k = m.ticker ? 'T:' + m.ticker.ticker : 'N:' + norm(m.name);
    const g = merged.get(k) || { name: m.name, ticker: m.ticker?.ticker ?? null, count: 0, rels: new Set() };
    g.count += m.count;
    for (const r of m.rels) g.rels.add(r);
    merged.set(k, g);
  }
  return [...merged.values()].sort((a, b) => b.count - a.count).slice(0, 60).map(g => ({ name: pretty(g.name), ticker: g.ticker, count: g.count, rels: [...g.rels] }));
}

async function tickerOfCik(cik) {
  const { loadTickers } = await import('./sec.mjs');
  return (await loadTickers()).find(t => Number(t.cik) === Number(cik)) || null;
}

// Full-text search over several phrasings, one hit per filer
async function filersMentioning(terms, { forms = ['10-K', '20-F', '40-F'], max, excludeCik } = {}) {
  const { fullTextSearch } = await src('sec-extra');
  const seen = new Map();
  for (const t of terms) {
    const hits = await fullTextSearch(t, { forms, max, excludeCik }).catch(() => []);
    for (const h of Array.isArray(hits) ? hits : []) if (!seen.has(String(Number(h.cik)))) seen.set(String(Number(h.cik)), h);
    if (seen.size >= max) break;
  }
  return [...seen.values()].slice(0, max);
}

// Fetch the mention windows for each filer and start its agent as soon as its excerpt is ready.
// Spawn events go out in batches so the page fills while the filings download.
async function streamAgents(s, { filers, terms, wave, kind, idPrefix, labelFor, inputLabel, messagesFor, fix, maxTokens = 320 }) {
  const { mentionWindows } = await src('sec-extra');
  const running = [];
  let n = 0;
  const BATCH = 24;
  for (let b = 0; b < filers.length; b += BATCH) {
    const batch = filers.slice(b, b + BATCH);
    const wins = await pool(batch, 6, h => mentionWindows(h.url, terms, { max: 4, width: 700 }));
    const ready = batch.map((h, k) => ({ h, w: wins[k] })).filter(x => x.w && (x.w.windows || x.w).length);
    if (!ready.length) continue;
    const agents = ready.map(x => {
      const text = (x.w.windows || x.w).map(w => (typeof w === 'string' ? w : w.text)).join('\n…\n');
      return { id: idPrefix + (n++), label: labelFor(x.h), name: pretty(x.h.name), ticker: x.h.ticker || null, filer: x.h, text, input: inputOf(inputLabel(x.h), text) };
    });
    s.emit({ type: 'spawn', wave, kind, agents: agents.map(({ filer, text, ...a }) => a) });
    for (const a of agents) running.push(runAgent({ agent: a, emit: s.emit, maxTokens, fix: f => fix(f, a), messages: messagesFor(a) }));
  }
  return Promise.all(running);
}

// ---------- wave 11: who names you ----------
function namedMessages(rootShort, a) {
  const f = a.filer;
  const system = `You read paragraphs from ${a.name}'s ${f.form || 'annual report'} (filed ${f.date}) that mention ${rootShort}. What is ${a.name}'s relationship to ${rootShort}?
Output exactly one JSON line and nothing else:
{"k":"named","name":${JSON.stringify(a.name)},"ticker":${JSON.stringify(a.ticker)},"rel":"customer|supplier|competitor|partner|investor|other","strength":2,"detail":"<max 14 words>","q":"<verbatim quote from the excerpt, max 25 words>"}
rel is ${a.name}'s role toward ${rootShort}: customer = it buys from or depends on ${rootShort}'s products; supplier = it sells to ${rootShort}; competitor = it competes with ${rootShort}; partner = alliance, reseller or co-development; investor = it holds ${rootShort} shares; other = a passing mention (an index, an example, market data).
strength: 1 passing mention, 2 a real business tie, 3 a major dependency.`;
  return [{ role: 'system', content: system }, { role: 'user', content: a.text }];
}

export async function named({ max } = {}) {
  const s = currentSession();
  if (!s || !s.meta || !s.candidates) throw new Error('map a company first');
  if (s.meta.commodity) throw new Error('who-names-you works on a company map');
  if (s.finished) reopen(s, { source: 'chat', awaitReply: false });
  if (s.named) return s.named;
  const meta = s.meta;
  const name = pretty(meta.name);
  const terms = [...new Set([name, meta.short].filter(t => t && t.length > 2))];
  const cap = Math.max(10, Math.min(NAMED_MAX, Number(max) || NAMED_MAX));
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_named', args: {}, text: `Searching every annual report filed this year that names ${name}` });
  s.emit({ type: 'status', text: `SEC full-text search: annual reports naming ${name}…` });
  const filers = await filersMentioning(terms, { max: cap, excludeCik: meta.cik });
  s.emit({ type: 'status', text: `${filers.length} annual reports name ${name}: one agent each` });
  const tally = { customer: 0, supplier: 0, competitor: 0, partner: 0, investor: 0, other: 0 };
  const results = await streamAgents(s, {
    filers, terms, wave: 11, kind: 'named', idPrefix: 'm',
    labelFor: h => pretty(h.name).slice(0, 34),
    inputLabel: h => `${pretty(h.name)} ${h.form || '10-K'} filed ${h.date}, paragraphs naming ${name}`,
    messagesFor: a => namedMessages(name, a),
    fix: (f, a) => {
      if (f.k !== 'named' || a.done) return false;
      a.done = true;
      f.name = a.name;
      f.ticker = a.ticker;
      if (!(f.rel in tally)) f.rel = 'other';
      f.strength = Math.max(1, Math.min(3, Math.round(Number(f.strength) || 1)));
      f.detail = words(f.detail, 14);
      f.q = words(f.q, 25);
      f.form = a.filer.form; f.date = a.filer.date; f.url = a.filer.url;
      tally[f.rel]++;
      if (f.rel !== 'other' && f.strength >= 2) addMention(s, a.name, a.ticker ? { ticker: a.ticker, cik: a.filer.cik, name: a.filer.name } : null, f.rel === 'investor' ? 'partner' : f.rel, f.strength);
      return true;
    },
  });
  const found = results.flat().filter(Boolean);
  const top = rel => found.filter(f => f.rel === rel).sort((a, b) => b.strength - a.strength).slice(0, 8).map(f => `${f.name}${f.ticker ? ` (${f.ticker})` : ''}: ${f.detail}`);
  s.candidates = candidatesFrom(s);
  s.named = { filings: filers.length, agents: results.length, tally, customers: top('customer'), suppliers: top('supplier'), competitors: top('competitor') };
  return s.named;
}

// ---------- wave 12: what changed this year ----------
const paraKey = p => p.toLowerCase().replace(/[0-9$,.%()]/g, '').replace(/\s+/g, ' ').slice(0, 90);
async function fullText(url, name) {
  return htmlToText(await cached(name, () => secGet(url)));
}

function changesMessages(meta, item, latestDate, prevDate, text) {
  const system = `You compare ${pretty(meta.name)}'s annual report filed ${latestDate} with the one filed ${prevDate}, section "${item}". Below are paragraphs that are NEW this year, then paragraphs that were DROPPED.
Output one JSON object per line, nothing else (2 to 8 lines):
{"k":"change","name":"<max 8 words>","type":"new_supplier|lost_supplier|new_customer|lost_customer|new_risk|dropped_risk|new_product|segment|guidance|other","detail":"<max 18 words>","q":"<verbatim quote, max 20 words>"}
Only real business changes (suppliers, customers, risks, products, segments, outlook), not wording edits or updated dates and figures.`;
  return [{ role: 'system', content: system }, { role: 'user', content: text }];
}

export async function changes() {
  const s = currentSession();
  if (!s || !s.meta || !s.candidates || !s.meta.cik) throw new Error('map a company first');
  if (s.finished) reopen(s, { source: 'chat', awaitReply: false });
  if (s.changes) return s.changes;
  const meta = s.meta;
  const { tenKPair } = await src('sec-extra');
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_changes', args: {}, text: `Comparing ${pretty(meta.name)}'s annual report with last year's` });
  const pair = await tenKPair(meta.cik);
  if (!pair?.latest?.url || !pair?.previous?.url) { s.changes = { agents: 0, note: 'no earlier annual report to compare with' }; return s.changes; }
  const [now, before] = await Promise.all([
    fullText(pair.latest.url, `${meta.cik}-latest-${pair.latest.date}.htm`),
    fullText(pair.previous.url, `${meta.cik}-prev-${pair.previous.date}.htm`),
  ]);
  const A = splitItems(now), B = splitItems(before);
  const blocks = [];
  for (const [id, title] of [['1', 'Business'], ['1A', 'Risk Factors'], ['7', 'MD&A'], ['2', 'Properties'], ['3', 'Legal Proceedings']]) {
    if (!A[id] || !B[id]) continue;
    const pa = A[id].split('\n').filter(p => p.length > 100), pb = B[id].split('\n').filter(p => p.length > 100);
    const kb = new Set(pb.map(paraKey)), ka = new Set(pa.map(paraKey));
    const added = pa.filter(p => !kb.has(paraKey(p))), dropped = pb.filter(p => !ka.has(paraKey(p)));
    // blocks of ~7K chars, new paragraphs first
    let cur = '';
    const flush = () => { if (cur.trim()) blocks.push({ id, title, text: cur }); cur = ''; };
    for (const p of added) { if (cur.length > 6500) flush(); cur += (cur ? '\n' : 'NEW THIS YEAR:\n') + p.slice(0, 1500); }
    if (dropped.length) { if (cur.length > 4500) flush(); cur += '\n\nDROPPED SINCE LAST YEAR:\n'; for (const p of dropped) { if (cur.length > 7000) { flush(); cur = 'DROPPED SINCE LAST YEAR:\n'; } cur += p.slice(0, 1500) + '\n'; } }
    flush();
  }
  const list = blocks.slice(0, CHANGES_MAX);
  const agents = list.map((b, i) => ({ id: 'g' + i, label: `Item ${b.id} · ${b.title}`, input: inputOf(`Item ${b.id} ${b.title}: new and dropped paragraphs, ${pair.previous.date} → ${pair.latest.date}`, b.text) }));
  s.emit({ type: 'spawn', wave: 12, kind: 'changes', agents });
  const TYPES = ['new_supplier', 'lost_supplier', 'new_customer', 'lost_customer', 'new_risk', 'dropped_risk', 'new_product', 'segment', 'guidance', 'other'];
  const results = await Promise.all(agents.map((a, i) => {
    let n = 0;
    const fix = f => {
      if (f.k !== 'change' || n >= 8) return false;
      n++;
      if (!TYPES.includes(f.type)) f.type = 'other';
      f.item = list[i].id;
      f.name = words(f.name, 8); f.detail = words(f.detail, 18); f.q = words(f.q, 20);
      return true;
    };
    return runAgent({ agent: a, emit: s.emit, maxTokens: 900, fix, messages: changesMessages(meta, `Item ${list[i].id} ${list[i].title}`, pair.latest.date, pair.previous.date, list[i].text) });
  }));
  const found = results.flat();
  const by = {};
  for (const f of found) by[f.type] = (by[f.type] || 0) + 1;
  s.changes = { latest: pair.latest.date, previous: pair.previous.date, agents: agents.length, changes: found.length, byType: by, top: found.filter(f => f.type !== 'other').slice(0, 10).map(f => `${f.type}: ${f.name}: ${f.detail}`) };
  return s.changes;
}

// ---------- wave 13: earnings releases ----------
function earningsMessages(a, date, text) {
  const system = `You read ${a.name}'s latest earnings press release (8-K exhibit 99.1, filed ${date}).
Output one JSON object per line, nothing else (4 to 9 lines):
{"k":"kpi","name":"<metric, e.g. Revenue, Data Center revenue, Gross margin, Diluted EPS>","value":"<as stated>","prior":"<year-ago value or empty>","change":"<e.g. +62% y/y, or empty>","period":"<e.g. Q3 FY2027>"}
Then at most one outlook line if the release gives guidance:
{"k":"guide","name":"<what is guided, e.g. Q4 revenue>","value":"<as stated>","period":"<period>"}`;
  return [{ role: 'system', content: system }, { role: 'user', content: text }];
}

export async function earnings({ tickers } = {}) {
  const s = currentSession();
  if (!s || !s.meta || !s.candidates || !s.meta.cik) throw new Error('map a company first');
  if (s.finished) reopen(s, { source: 'chat', awaitReply: false });
  if (s.earnings) return s.earnings;
  const meta = s.meta;
  const { earningsRelease } = await src('sec-extra');
  const asked = Array.isArray(tickers) ? tickers.map(x => String(x).toUpperCase()) : [];
  const list = [...new Set([meta.ticker, ...asked, ...s.candidates.filter(c => c.ticker).map(c => c.ticker)])].slice(0, EARNINGS_MAX);
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_earnings', args: { tickers: list }, text: `Reading the latest earnings releases of ${list.length} companies on the map` });
  const resolved = (await Promise.all(list.map(x => findTicker(x).catch(() => null)))).filter(Boolean);
  const rel = await pool(resolved, 4, t => earningsRelease(t.cik));
  const ok = resolved.map((t, i) => ({ t, r: rel[i] })).filter(x => x.r && x.r.text);
  const nameFor = t => (t.ticker === meta.ticker ? pretty(meta.name) : s.candidates.find(c => c.ticker === t.ticker)?.name || pretty(t.name));
  const agents = ok.map((x, i) => ({ id: 'e' + i, label: `${x.t.ticker} earnings ${x.r.date}`, ticker: x.t.ticker, name: nameFor(x.t), date: x.r.date, url: x.r.url, input: inputOf(`${x.t.ticker} press release (8-K ex. 99.1) filed ${x.r.date}`, x.r.text) }));
  s.emit({ type: 'spawn', wave: 13, kind: 'earnings', agents });
  const results = await Promise.all(agents.map((a, i) => {
    let n = 0;
    const fix = f => {
      if (!['kpi', 'guide'].includes(f.k) || n >= 10 || !String(f.value || '').trim()) return false;
      n++;
      Object.assign(f, { company: a.name, ticker: a.ticker, date: a.date, url: a.url });
      return true;
    };
    return runAgent({ agent: a, emit: s.emit, maxTokens: 700, fix, messages: earningsMessages(a, a.date, ok[i].r.text) });
  }));
  s.earnings = { agents: agents.length, lines: results.map((r, i) => `${agents[i].ticker} ${agents[i].date}: ${r.filter(f => f.k === 'kpi').slice(0, 3).map(f => `${f.name} ${f.value}${f.change ? ` (${f.change})` : ''}`).join('; ')}`) };
  return s.earnings;
}

// ---------- wave 14: a commodity's value chain ----------
const SHIP_TERMS = { copper: ['dry bulk'], ironore: ['dry bulk', 'capesize'], wheat: ['dry bulk', 'grain terminal'], cocoa: ['container shipping'], crude: ['crude tanker', 'VLCC'], lng: ['LNG carrier'], lithium: ['container shipping'], rareearths: ['container shipping'], uranium: [], gold: [] };
const STAGE_REL = { producer: 'supplier', refiner: 'supplier', shipper: 'partner', consumer: 'customer', hedger: 'competitor' };

function chainMessages(C, a) {
  const lc = C.name.toLowerCase();
  const chokes = (C.chokepoints || []).join(', ') || 'Hormuz, Suez, Panama, Malacca';
  const system = `You read paragraphs from ${a.name}'s annual report (filed ${a.filer.date}) that mention ${lc}. Where does ${a.name} sit in the ${lc} value chain?
Output exactly one JSON line and nothing else:
{"k":"chain","name":${JSON.stringify(a.name)},"ticker":${JSON.stringify(a.ticker)},"stage":"producer|refiner|shipper|consumer|hedger|other","exposure":2,"margin_bps_per_10pct":-15,"routes":[],"detail":"<what it does with ${lc}, max 14 words>","q":"<verbatim quote from the excerpt, max 25 words>"}
stage: producer = mines, drills or grows it; refiner = smelts, refines or processes it; shipper = moves it (ships, rail, pipelines, terminals); consumer = buys it as an input; hedger = trades, finances, stores or hedges it (funds, banks, trading houses); other = a passing mention.
exposure: 1 minor, 2 material, 3 core to the business.
margin_bps_per_10pct: your estimate of how far its operating margin moves, in basis points, if the ${lc} price rises 10% (positive for producers, negative for consumers that buy it, 0 if negligible).
routes: for shippers and seaborne exporters only, which of these chokepoints its cargo passes: ${chokes}. Otherwise [].`;
  return [{ role: 'system', content: system }, { role: 'user', content: a.text }];
}

// Starts a commodity session (page ask or the OpenClaw tool) and fills the centre card.
export async function commodityStart(key, { q, source = 'page', awaitReply = false, scripted = false } = {}) {
  const { COMMODITIES } = await src('world');
  const C = COMMODITIES[key];
  if (!C) throw new Error('unknown commodity ' + key);
  let s = currentSession();
  if (!(s && !s.finished && s.hit?.commodity === key)) {
    if (isBusy()) { const e = new Error('a session is already in progress'); e.code = 'BUSY'; throw e; }
    s = newSession({ source, scripted, awaitReply });
    s.hit = { ticker: key.toUpperCase(), name: C.name, commodity: key };
    s.emit({ type: 'ask', q: q || C.name, ticker: key.toUpperCase(), name: C.name, commodity: key, source });
  }
  return s;
}

export async function commodity({ commodity: raw, max } = {}) {
  const W = await src('world');
  const key = W.COMMODITIES[raw] ? raw : W.findCommodity(String(raw || ''));
  if (!key) throw new Error(`Unknown commodity "${raw}". Try: ${Object.values(W.COMMODITIES).map(c => c.name).join(', ')}`);
  const C = W.COMMODITIES[key];
  let s = currentSession();
  if (!(s && !s.finished && s.hit?.commodity === key)) s = await commodityStart(key, { source: 'chat' });
  if (s.chain) return s.chain;
  const T = key.toUpperCase();
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_commodity', args: { commodity: key }, text: `Mapping the ${C.name.toLowerCase()} value chain: price, producing countries, trade flows, shipping routes, and every annual report that mentions it` });
  const fut0 = await W.futures(key).catch(() => null);
  const reg = Array.isArray(C.futures) ? C.futures[0] : C.futures;
  const fut = fut0 && !fut0.error ? fut0 : null;
  const routes = await Promise.resolve(W.routesFor(key)).catch(() => null);
  const C2 = { ...C, chokepoints: (routes?.chokepoints || []).map(c => c.name || c.label || c.id) };
  const today = new Date().toISOString().slice(0, 10);
  s.meta = { ticker: T, name: C.name, short: C.name, cik: null, commodity: key, filing: { form: 'value chain', date: today, url: null }, items: {} };
  s.emit({ type: 'scan', kind: 'commodity', commodity: key, ticker: T, name: C.name, short: C.name, futures: fut ? { ...fut, series: undefined } : (reg || null), filing: { form: 'Value chain', date: today }, chunks: [] });
  const sym = fut?.symbol || reg?.symbol;
  const side = [
    sym && priceSeries(sym).then(points => { if (points) s.emit({ type: 'price', ticker: T, symbol: sym, points }); }),
    W.production(key).then(r => { if (r && (!r.error || r.needsKey)) s.emit({ ...r, type: 'production', commodity: key }); }),
    W.trade(key, { flow: 'X' }).then(r => { if (r) s.emit({ ...r, type: 'trade', commodity: key, flow: 'X' }); }),
    W.trade(key, { flow: 'M' }).then(r => { if (r) s.emit({ ...r, type: 'trade', commodity: key, flow: 'M' }); }),
    Promise.resolve(routes).then(r => { if (r) s.emit({ ...(Array.isArray(r) ? { chokepoints: r } : r), type: 'routes', commodity: key }); }),
  ].filter(Boolean).map(p => p.catch(() => null));
  for (const p of side) { s.pending.add(p); p.finally(() => s.pending.delete(p)); }

  const terms = (C.secTerms?.length ? C.secTerms : C.terms?.length ? C.terms : [C.name.toLowerCase()]).slice(0, 4);
  const cap = Math.max(10, Math.min(CHAIN_MAX, Number(max) || CHAIN_MAX));
  s.emit({ type: 'status', text: `SEC full-text search: annual reports that mention ${C.name.toLowerCase()}…` });
  // the shipping layer: carriers rarely name the cargo's market, so search for the vessel trade too
  const shipTerms = SHIP_TERMS[key] || [];
  const shippers = shipTerms.length ? await filersMentioning(shipTerms, { max: 24 }) : [];
  const main = await filersMentioning(terms, { max: cap });
  const seenCik = new Set(main.map(h => String(Number(h.cik))));
  const filers = [...main, ...shippers.filter(h => !seenCik.has(String(Number(h.cik))))];
  const tally = { producer: 0, refiner: 0, shipper: 0, consumer: 0, hedger: 0, other: 0 };
  const results = await streamAgents(s, {
    filers, terms: [...terms, ...shipTerms], wave: 14, kind: 'chain', idPrefix: 'k',
    labelFor: h => pretty(h.name).slice(0, 34),
    inputLabel: h => `${pretty(h.name)} ${h.form || '10-K'} filed ${h.date}, paragraphs on ${C.name.toLowerCase()}`,
    messagesFor: a => chainMessages(C2, a),
    fix: (f, a) => {
      if (f.k !== 'chain' || a.done) return false;
      a.done = true;
      f.name = a.name;
      f.ticker = a.ticker;
      if (!(f.stage in tally)) f.stage = 'other';
      f.exposure = Math.max(1, Math.min(3, Math.round(Number(f.exposure) || 1)));
      const m = Number(f.margin_bps_per_10pct);
      f.margin_bps_per_10pct = Number.isFinite(m) ? Math.max(-500, Math.min(500, Math.round(m))) : 0;
      f.routes = Array.isArray(f.routes) ? f.routes.slice(0, 6).map(String) : [];
      f.detail = words(f.detail, 14); f.q = words(f.q, 25);
      f.rel = STAGE_REL[f.stage] || 'other';
      tally[f.stage]++;
      if (f.stage !== 'other') addMention(s, a.name, a.ticker ? { ticker: a.ticker, cik: a.filer.cik, name: a.filer.name } : null, f.rel, f.exposure);
      return true;
    },
  });
  const found = results.flat().filter(Boolean);
  s.candidates = candidatesFrom(s);
  s.emit({ type: 'candidates', list: s.candidates });
  const top = st => found.filter(f => f.stage === st).sort((a, b) => b.exposure - a.exposure).slice(0, 6).map(f => `${f.name}${f.ticker ? ` (${f.ticker})` : ''}`);
  s.chain = {
    commodity: C.name, price: fut ? `${fut.last} ${fut.unit || ''} (${fut.label || sym})` : null, filings: filers.length, agents: results.length, tally,
    producers: top('producer'), refiners: top('refiner'), shippers: top('shipper'), consumers: top('consumer'), hedgers: top('hedger'),
  };
  return s.chain;
}

// ---------- wave 16: one what-if across an index, a sector map or an ETF ----------
function shockMessages(m, question, title) {
  const system = `You are one of many analyst agents running a what-if across ${title}. Question: "${question}"
You assess ONE company: ${m.name} (${m.ticker})${m.sector ? `, sector ${m.sector}${m.subIndustry ? ` / ${m.subIndustry}` : ''}` : ''}.
Output exactly one JSON line and nothing else:
{"k":"impact","name":${JSON.stringify(m.name)},"ticker":${JSON.stringify(m.ticker)},"impact":"negative|mixed|positive","severity":2,"pct":-4,"why":"<max 16 words>"}
severity: 1 minor, 2 material, 3 severe. pct: your estimate of the change in its revenue over the next 12 months, in percent (0 if none). Use well-known facts about the company.`;
  return [{ role: 'system', content: system }, { role: 'user', content: 'Assess now.' }];
}

export async function membersOf(id) {
  const H = await src('holdings');
  const up = String(id || '').toUpperCase().replace(/^ETF[:\s]+/, '');
  if (['SPX', 'NDX', 'DJI'].includes(up)) return { title: { SPX: 'the S&P 500', NDX: 'the Nasdaq-100', DJI: 'the Dow 30' }[up], members: await H.indexMembers(up) };
  if (['SEMIS', 'ENERGY', 'BANKS'].includes(up)) return { title: `the ${up[0] + up.slice(1).toLowerCase()} sector map`, members: await H.sectorMembers(up) };
  const etf = await H.etfHoldings(up);
  if (etf && etf.holdings) {
    // sectors for ETF members come from the S&P 500 list when the company is in it
    const spx = new Map(((await H.indexMembers('SPX').catch(() => [])) || []).map(m => [m.ticker, m]));
    return { title: `${up} · ${etf.fund?.name || 'ETF'}`, members: etf.holdings.filter(h => h.ticker && (h.type || 'EC') === 'EC').map(h => ({ ticker: h.ticker, name: h.name, sector: spx.get(h.ticker)?.sector || (h.country && h.country !== 'US' ? 'Non-US listed' : 'Other'), subIndustry: spx.get(h.ticker)?.subIndustry || null, weight: h.pct })) };
  }
  throw new Error('unknown index, sector or ETF ' + id);
}

export async function indexShock({ id, question, source = 'page', awaitReply = false, scripted = false } = {}) {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) throw new Error('needs a question');
  let s = currentSession();
  const fresh = !(s && !s.finished && s.indexId === id);
  const { title, members } = await membersOf(id);
  if (fresh) {
    if (isBusy()) { const e = new Error('a session is already in progress'); e.code = 'BUSY'; throw e; }
    s = newSession({ source, scripted, awaitReply });
    s.indexId = id;
    s.hit = { ticker: String(id).toUpperCase(), name: title };
    s.emit({ type: 'ask', q, mode: 'indexshock', index: id, ticker: String(id).toUpperCase(), name: title, source });
  }
  s.meta = { ticker: String(id).toUpperCase(), name: title, short: title, cik: null, index: id, filing: { form: 'index', date: new Date().toISOString().slice(0, 10) }, items: {} };
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_indexshock', args: { id, question: q }, text: `Spawning ${members.length} agents, one per company in ${title}` });
  const list = members.filter(m => m.ticker).map((m, i) => ({ ...m, id: 'i' + i }));
  const running = [];
  for (let b = 0; b < list.length; b += 100) {
    const batch = list.slice(b, b + 100);
    s.emit({ type: 'spawn', wave: 16, kind: 'indexshock', question: q, agents: batch.map(m => ({ id: m.id, label: m.ticker, name: m.name, ticker: m.ticker, sector: m.sector || null, input: inputOf(`${m.name} (${m.ticker}), ${m.sector || 'sector n/a'}`, `${m.name} · ${m.sector || ''} ${m.subIndustry || ''}`) })) });
    for (const m of batch) {
      let one = false;
      running.push(runAgent({
        agent: m, emit: s.emit, maxTokens: 220, messages: shockMessages(m, q, title),
        fix: f => {
          if (f.k !== 'impact' || one) return false;
          one = true;
          Object.assign(f, { name: m.name, ticker: m.ticker, sector: m.sector || null, weight: m.weight ?? null });
          if (!['negative', 'mixed', 'positive'].includes(f.impact)) f.impact = 'mixed';
          f.severity = Math.max(1, Math.min(3, Math.round(Number(f.severity) || 1)));
          const pct = Number(f.pct); f.pct = Number.isFinite(pct) ? Math.max(-60, Math.min(60, pct)) : 0;
          f.why = words(f.why, 16);
          return true;
        },
      }));
    }
  }
  const impacts = (await Promise.all(running)).map(r => r[0]).filter(Boolean);
  const bySector = new Map();
  for (const f of impacts) {
    const k = f.sector || 'Other';
    const g = bySector.get(k) || { sector: k, n: 0, negative: 0, positive: 0, pctSum: 0 };
    g.n++; if (f.impact === 'negative') g.negative++; if (f.impact === 'positive') g.positive++; g.pctSum += f.pct || 0;
    bySector.set(k, g);
  }
  const sectors = [...bySector.values()].map(g => ({ ...g, avgPct: Math.round(g.pctSum / g.n * 10) / 10 })).sort((a, b) => a.avgPct - b.avgPct);
  const worst = impacts.filter(f => f.impact === 'negative').sort((a, b) => (a.pct || 0) - (b.pct || 0)).slice(0, 8);
  const best = impacts.filter(f => f.impact === 'positive').sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 5);
  s.emit({ type: 'indexshock', id, title, question: q, agents: list.length, assessed: impacts.length, sectors, worst, best });
  s.indexShock = { title, question: q, agents: list.length, assessed: impacts.length, sectors: sectors.map(g => `${g.sector}: ${g.negative}/${g.n} hit, avg revenue ${g.avgPct}%`), worst: worst.map(f => `${f.name} (${f.ticker}) ${f.pct}%: ${f.why}`), best: best.map(f => `${f.name} (${f.ticker}) +${f.pct}%: ${f.why}`) };
  return s.indexShock;
}

// ---------- page drivers (scripted server, or a real OpenClaw agent turn) ----------
const STREAM = {
  named: { tool: 'terminal_named', fn: named, label: 'Who names you', msg: n => `Run terminal_named on the ${n} map: read every annual report that names ${n}.` },
  changes: { tool: 'terminal_changes', fn: changes, label: 'What changed', msg: n => `Run terminal_changes on the ${n} map: what changed in its annual report since last year.` },
  earnings: { tool: 'terminal_earnings', fn: earnings, label: 'Earnings', msg: n => `Run terminal_earnings on the ${n} map: KPIs from the latest earnings releases.` },
};

export async function streamAsk(kind, mode) {
  const st = STREAM[kind];
  if (!st) throw new Error('unknown stream ' + kind);
  const s = await needMap();
  reopen(s, { source: 'page', awaitReply: true });
  const n = pretty(s.meta.name);
  s.emit({ type: 'ask', q: st.label, mode: kind, source: 'page' });
  if (mode === 'openclaw') { s.emit({ type: 'bot', phase: 'thinking', text: st.msg(n) }); runAgentTurn(s, st.msg(n)); return s; }
  s.scripted = true;
  s.emit({ type: 'bot', phase: 'thinking', text: `${st.label}: ${n}` });
  (async () => {
    const r = await st.fn({});
    const reply = kind === 'named' ? `${r.filings} annual reports name ${n}: ${r.tally.customer} customers, ${r.tally.supplier} suppliers, ${r.tally.competitor} rivals, ${r.tally.partner} partners.`
      : kind === 'changes' ? `${r.changes || 0} changes since ${r.previous || 'last year'}${r.top?.length ? `, e.g. ${r.top[0]}` : ''}.`
        : `KPIs read from ${r.agents} earnings releases.`;
    await finishSession({ reply });
  })().catch(e => finishSession({ error: e.message || e }));
  return s;
}

export async function commodityAsk(key, q, mode) {
  const s = await commodityStart(key, { q, source: 'page', awaitReply: true, scripted: mode !== 'openclaw' });
  const { COMMODITIES } = await src('world');
  const C = COMMODITIES[key];
  if (mode === 'openclaw') { const msg = `Map the ${C.name.toLowerCase()} value chain`; s.emit({ type: 'bot', phase: 'thinking', text: msg }); runAgentTurn(s, msg); return s; }
  s.emit({ type: 'bot', phase: 'thinking', text: `Mapping the ${C.name.toLowerCase()} value chain` });
  (async () => {
    const r = await commodity({ commodity: key });
    await finishSession({ reply: `${r.agents} agents read ${r.filings} annual reports that mention ${C.name.toLowerCase()}: ${r.tally.producer} producers, ${r.tally.refiner} refiners, ${r.tally.shipper} shippers, ${r.tally.consumer} consumers.` });
  })().catch(e => finishSession({ error: e.message || e }));
  return s;
}

export async function indexShockAsk(id, q, mode) {
  if (mode === 'openclaw') {
    if (isBusy()) { const e = new Error('a session is already in progress'); e.code = 'BUSY'; throw e; }
    const s = newSession({ source: 'page', awaitReply: true });
    s.indexId = id;
    s.hit = { ticker: String(id).toUpperCase(), name: String(id) };
    s.emit({ type: 'ask', q, mode: 'indexshock', index: id, ticker: String(id).toUpperCase(), source: 'page' });
    const msg = `Run terminal_indexshock on ${id}: ${q}`;
    s.emit({ type: 'bot', phase: 'thinking', text: msg });
    runAgentTurn(s, msg);
    return s;
  }
  const s0 = currentSession();
  if (isBusy()) { const e = new Error('a session is already in progress'); e.code = 'BUSY'; throw e; }
  (async () => {
    const r = await indexShock({ id, question: q, source: 'page', awaitReply: true, scripted: true });
    await finishSession({ reply: `${r.assessed} of ${r.agents} companies assessed. Worst: ${r.worst.slice(0, 3).map(x => x.split(' (')[0]).join(', ') || 'none'}.` });
  })().catch(e => finishSession({ error: e.message || e }));
  await new Promise(r => setTimeout(r, 50));
  return currentSession() || s0;
}
