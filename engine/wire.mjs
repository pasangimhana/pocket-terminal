// News Wire: live (or replayed) news from public feeds, scored in batches by the model, painted onto a company board.
// Own session and SSE stream (/api/wire/events), separate from the map session in run.mjs, so a map and the wire run side by side.
//
//   pollers -> dedupe -> (8-K full read) -> batch scorer (<=20 stories / call, JSON lines) -> ticker check against SEC
//   -> ripple agents (suppliers/customers/rivals from saved maps) -> price check (Yahoo 1-minute bars) -> save/replay
//
// Events: wire_item, wire_score, wire_ripple, wire_price, wire_status, wire_gpu, wire_desk, plus spawn / first / finding / done
// in the same shapes runAgent emits, so each scoring batch shows as an agent wave.
// SEC etiquette: every SEC request goes through secFetch (>=250 ms apart, ~4/s), 429/403 back off for minutes, the 8-K
// Atom feed is polled once a minute, Google News queries rotate (one request a minute, each query every ~7 min).
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamChat, providerConfig } from './llm.mjs';
import { UA, findTicker, loadTickers, cached, htmlToText } from './sec.mjs';
import { inputOf, pretty } from './run.mjs';
import './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'runs');
const BROWSER_UA = 'Mozilla/5.0 (pocket-terminal demo)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const median = a => { const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const BATCH_MAX = 20, GATHER_MS = 1200, PARALLEL = 3, MAX_STORIES = 4000;

// ---------------------------------------------------------------- session
let W = null; // current wire session
const subscribers = new Set();
let lastStatus = null;

function emit(e) {
  e.t = Date.now();
  if (W && e.type !== 'wire_status') { W.events.push(e); if (W.events.length > 40000) W.events.splice(0, 2000); }
  if (e.type === 'wire_status') lastStatus = e;
  for (const fn of subscribers) { try { fn(e); } catch {} }
}

function subscribe(fn) {
  subscribers.add(fn);
  if (W) for (const e of W.events) fn(e);
  if (lastStatus) fn(lastStatus);
  return () => subscribers.delete(fn);
}

// ---------------------------------------------------------------- small helpers: XML, ET time, SEC fetch, Yahoo
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m);
const strip = s => decode(decode(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, 'gi'))].map(m => m[0]);
const tag = (b, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(b); return m ? decode(m[1]).trim() : ''; };

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function etParts(ms) { const o = {}; for (const p of ET.formatToParts(new Date(ms))) o[p.type] = p.value; return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour % 24, minute: +o.minute, wd: o.weekday }; }
const etDate = ms => etParts(ms).date;
function extendedHours(ms) { const p = etParts(ms); if (p.wd === 'Sat' || p.wd === 'Sun') return false; const m = p.hour * 60 + p.minute; return m >= 4 * 60 && m < 20 * 60; }

let secNext = 0, secBlockedUntil = 0;
async function secFetch(url, asText = true) {
  if (Date.now() < secBlockedUntil) throw new Error('SEC backoff until ' + new Date(secBlockedUntil).toISOString().slice(11, 19));
  const now = Date.now(), at = Math.max(now, secNext);
  secNext = at + 250;
  if (at > now) await sleep(at - now);
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
  if (r.status === 429 || r.status === 403) { secBlockedUntil = Date.now() + 6 * 60e3; throw new Error(`SEC ${r.status}: backing off 6 min`); }
  if (!r.ok) throw new Error('SEC ' + r.status);
  return asText ? r.text() : r.json();
}
const safeName = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 150);

let webNext = 0;
async function webFetch(url, { gap = 400, ua = BROWSER_UA } = {}) {
  const now = Date.now(), at = Math.max(now, webNext);
  webNext = at + gap;
  if (at > now) await sleep(at - now);
  const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

// ---------------------------------------------------------------- tickers
let tickIdx = null; // ticker -> {cik,name}; cik -> ticker (market-cap order from the SEC file, first wins)
async function tickers() {
  if (tickIdx) return tickIdx;
  const list = await loadTickers();
  const byTicker = new Map(), byCik = new Map();
  for (const t of list) { if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, t); if (!byCik.has(String(t.cik))) byCik.set(String(t.cik), t); }
  tickIdx = { byTicker, byCik };
  return tickIdx;
}
const nameOf = t => pretty(t.name || t.ticker).replace(/\b(Inc|Corp|Corporation|Ltd|Plc|Holdings)\b\.?/gi, '').replace(/[\s,.]+$/, '').trim();

// ---------------------------------------------------------------- feeds
const GN_QUERIES = ['stock market today', 'earnings results stock', 'semiconductor chip stocks', 'merger acquisition deal announced', 'FDA approval biotech', 'oil prices OPEC', 'Federal Reserve rates inflation', 'antitrust lawsuit regulators company', 'AI data center spending', 'guidance raises lowers outlook'];
const YF_GROUPS = [
  'NVDA,AMD,AVGO,TSM,INTC,MU,QCOM,ASML,AMAT,LRCX', 'AAPL,MSFT,GOOGL,AMZN,META,TSLA,NFLX,ORCL,CRM,ADBE',
  'JPM,BAC,GS,MS,WFC,C,V,MA,BRK-B,BLK', 'XOM,CVX,COP,OXY,LLY,PFE,MRK,UNH,JNJ,ABBV', 'WMT,COST,HD,NKE,DIS,BA,CAT,GE,LMT,F',
];
const RSS = [
  { id: 'cnbc', badge: 'CNBC', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', every: 90e3 },
  { id: 'prn', badge: 'PRN', name: 'PR Newswire', url: 'https://www.prnewswire.com/rss/news-releases-list.rss', every: 90e3 },
  { id: 'inv', badge: 'INV', name: 'Investing.com', url: 'https://www.investing.com/rss/news.rss', every: 120e3 },
  { id: 'sa', badge: 'SA', name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml', every: 90e3 },
  { id: 'fed', badge: 'FED', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', every: 300e3 },
];

function parseRss(xml, src, badge) {
  return blocks(xml, 'item').map(b => {
    const title = strip(tag(b, 'title'));
    let link = strip(tag(b, 'link')) || strip(tag(b, 'guid'));
    const pd = tag(b, 'pubDate') || tag(b, 'dc:date');
    // investing.com dates have no zone: they are UTC
    const pub = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(pd) ? pd.replace(' ', 'T') + 'Z' : pd);
    const sym = [...b.matchAll(/<category domain="[^"]*\/symbol\/([A-Z.\-]+)"/g)].map(m => m[1]);
    let t = title, by = src;
    const m = / - ([^-]{2,40})$/.exec(title);
    if (m && src === 'Google News') { by = m[1]; t = title.slice(0, m.index); }
    return { src, badge, by, title: t, url: link, summary: strip(tag(b, 'description')).slice(0, 260), published: Number.isFinite(pub) ? pub : null, hint: sym.slice(0, 3) };
  }).filter(x => x.title && x.url);
}

function parseSecAtom(xml) {
  return blocks(xml, 'entry').map(b => {
    const t = tag(b, 'title');
    const m = /^(8-K(?:\/A)?)\s*-\s*(.+?)\s*\((\d{10})\)/.exec(t);
    if (!m) return null;
    const sum = decode(tag(b, 'summary'));
    const acc = /AccNo:<\/b>\s*([\d-]+)/.exec(sum)?.[1] || /accession-number=([\d-]+)/.exec(tag(b, 'id'))?.[1];
    const items = [...sum.matchAll(/Item\s+(\d+\.\d+):\s*([^<\n]+)/g)].map(x => ({ n: x[1], label: x[2].trim() }));
    const href = /<link[^>]*href="([^"]+)"/.exec(b)?.[1] || '';
    return { form: m[1], company: m[2], cik: String(+m[3]), acc, items, index: href, published: Date.parse(tag(b, 'updated')) };
  }).filter(x => x && x.acc && x.form === '8-K');
}

const ITEM_EV = { '2.02': 'earnings', '1.01': 'deal', '1.02': 'deal', '2.01': 'deal', '5.02': 'mgmt', '1.05': 'other', '7.01': 'other', '8.01': 'other', '3.01': 'legal', '4.02': 'legal', '1.03': 'legal' };
const secTitle = (company, items) => {
  const main = items.find(i => i.n !== '9.01') || items[0];
  return `${company} files 8-K${main ? ': ' + main.label.replace(/\s+/g, ' ').slice(0, 90) : ''}`;
};

// text of an 8-K for the scorer: the earnings/other exhibit when the main document only points to one
async function readFiling(s) {
  const { cik, acc } = s.sec;
  const base = `https://www.sec.gov/Archives/edgar/data/${+cik}/${acc.replace(/-/g, '')}/`;
  const want99 = s.sec.items.some(i => ['2.02', '7.01', '8.01'].includes(i.n));
  let doc = s.sec.doc, ex = null;
  if (!doc || want99) {
    try {
      const idx = await cached(safeName(`wire-index-${acc}.htm`), () => secFetch(s.sec.index || `${base}${acc}-index.htm`));
      const links = blocks(idx, 'tr').map(r => [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1])).filter(c => c.length >= 4).map(c => ({ href: (/href="([^"]+\.htm)"/.exec(c[2]) || [])[1]?.replace(/^\/ix\?doc=/, ''), type: strip(c[3]) })).filter(l => l.href);
      doc = doc || links.find(l => /^8-K/.test(l.type))?.href?.split('/').pop();
      ex = links.find(l => /^EX-99/.test(l.type))?.href;
    } catch (e) { if (!doc) throw e; }
  }
  const pick = want99 && ex ? ex : doc;
  if (!pick) return '';
  const url = pick.startsWith('http') ? pick : pick.startsWith('/') ? 'https://www.sec.gov' + pick : base + pick;
  s.sec.docUrl = url;
  const html = await cached(safeName(`wire-doc-${acc}-${url.split('/').pop()}`), () => secFetch(url));
  const text = htmlToText(html);
  const i = pick === ex ? 0 : text.search(/^item\s+\d+\.\d+/im);
  return text.slice(Math.max(i, 0)).replace(/(?:\|[ \t]*){2,}/g, '| ').slice(0, 1500);
}

// ---------------------------------------------------------------- dedupe
const STOP = new Set('the a an of to in on for and or at by with from is are was were be as it its this that after over amid says said new will has have had not but into than more less up down'.split(' '));
const tokens = t => new Set(String(t).toLowerCase().replace(/[^a-z0-9$%. ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
function dupOf(s) {
  const tk = tokens(s.title);
  if (tk.size < 4) return null;
  for (let i = W.order.length - 1, n = 0; i >= 0 && n < 500; i--, n++) {
    const o = W.stories.get(W.order[i]);
    if (o.url === s.url) return o;
    if (o.kind === 'sec' || s.kind === 'sec') continue;
    let inter = 0; for (const w of tk) if (o._tok.has(w)) inter++;
    const j = inter / (tk.size + o._tok.size - inter);
    if (j >= 0.72) return o;
  }
  return null;
}

// ---------------------------------------------------------------- ingest
function pubStory(s) {
  return { id: s.id, n: s.n, kind: s.kind, src: s.src, badge: s.badge, by: s.by, title: s.title, url: s.url, pub: s.published, fetched: s.fetched, items: s.sec?.items?.map(i => i.n) || undefined, tk: s.tk || undefined, nm: s.nm || undefined, srcs: s.srcs.length, hint: s.hint?.length ? s.hint : undefined };
}

async function ingest(raw) {
  if (!W || W.stopped) return;
  const tk = await tickers();
  const now = Date.now();
  let s;
  if (raw.sec) {
    const t = tk.byCik.get(raw.sec.cik);
    if (!t) { W.counters.skipped++; return; } // filers without a listed ticker: not market news for this board
    const id = 'sec:' + raw.sec.acc;
    if (W.stories.has(id)) return;
    s = { id, kind: 'sec', src: 'SEC 8-K', badge: 'SEC', by: 'SEC EDGAR', title: secTitle(nameOf(t), raw.sec.items), url: raw.sec.index, published: raw.published, sec: raw.sec, tk: t.ticker, nm: nameOf(t), summary: '' };
  } else {
    const id = 'n:' + sha(raw.url);
    if (W.stories.has(id)) return;
    s = { id, kind: 'news', src: raw.src, badge: raw.badge, by: raw.by, title: raw.title, url: raw.url, published: raw.published || now, summary: raw.summary, hint: raw.hint };
  }
  s.fetched = raw.fetched || now;
  s._tok = tokens(s.title);
  const dup = dupOf(s);
  if (dup) {
    if (!dup.srcs.some(x => x.url === s.url)) {
      dup.srcs.push({ badge: s.badge, by: s.by, url: s.url });
      emit({ type: 'wire_item', update: true, s: { id: dup.id, srcs: dup.srcs.length, srcList: dup.srcs.map(x => x.badge) } });
    }
    W.counters.dups++;
    return;
  }
  s.n = ++W.seq;
  s.srcs = [{ badge: s.badge, by: s.by, url: s.url }];
  s.state = s.kind === 'sec' ? 'reading' : 'queued';
  W.stories.set(s.id, s); W.order.push(s.id);
  if (W.order.length > MAX_STORIES) { W.stories.delete(W.order.shift()); }
  W.counters.in++; W.recentIn.push(now);
  emit({ type: 'wire_item', s: pubStory(s) });
  if (s.kind === 'sec') {
    readFiling(s).then(text => { s.summary = text; }, e => { s.readError = String(e.message || e).slice(0, 80); W.counters.readFail++; })
      .finally(() => { s.state = 'queued'; s.queuedAt = Date.now(); W.queue.push(s); pump(); });
  } else { s.queuedAt = now; W.queue.push(s); pump(); }
}

// ---------------------------------------------------------------- scoring
const SYSTEM = `You score market-moving news for a trading desk. For each numbered story output ONE JSON object per line, in order. No prose, no markdown, no code fences.
Keys: i (story number); rel (1 if it can move a listed US stock or ADR, or the broad market; else 0); f (1 = fact: something happened or was officially reported: results, filings, deals, guidance, regulatory or legal action, data release, outage, product launch; 0 = opinion: analyst view, price prediction, "should you buy", fund holdings, listicle, commentary); ev (earnings|guidance|deal|legal|supply|macro|mgmt|product|other); c (confidence 0 to 1); imp (list of at most 3, only when rel=1) of {t: ticker, d: 1 for up or -1 for down, m: 1 small (under 1% move), 2 notable (1 to 3%), 3 major (over 3%), h: "day"|"week"|"quarter", r: reason of at most 12 words, plain, use "~" never "approximately"}.
When rel=0 output only {"i":N,"rel":0}.
Rules: tickers must be real US-listed symbols and you must be sure; otherwise leave the impact out. Judge only from the text given and never invent numbers. For an SEC 8-K the filer's ticker is given: 2.02 = results, 1.01 = agreement, 5.02 = executive change, 1.05 = cyber incident, 3.01 = listing notice, 8.01 = other event. An 8-K with only routine items (9.01, 5.07 vote results, 5.03 bylaws) is rel=0 unless its text says otherwise. Opinion pieces and price predictions get f=0 and a magnitude of 1.`;

function storyBlock(s, i) {
  if (s.kind === 'sec') {
    const items = s.sec.items.map(x => `${x.n} ${x.label}`).join('; ').slice(0, 220);
    return `[${i}] SEC 8-K | ${s.nm} (${s.tk}) | items: ${items}${s.summary ? '\ntext: ' + s.summary.replace(/\s+/g, ' ').slice(0, 1300) : ''}`;
  }
  return `[${i}] ${s.by || s.src} | ${s.title}${s.summary && s.summary !== s.title ? ' | ' + s.summary.slice(0, 200) : ''}${s.hint?.length ? ' | tagged: ' + s.hint.join(',') : ''}`;
}

const trimWords = (t, n = 12) => String(t || '').replace(/\s+/g, ' ').trim().replace(/approximately/gi, '~').split(' ').slice(0, n).join(' ').replace(/[.,;:]+$/, '');

async function applyScore(s, o, meta) {
  const tk = await tickers();
  const imp = [];
  let rejected = 0;
  if (o.rel) for (const x of Array.isArray(o.imp) ? o.imp : []) {
    const t = String(x?.t || '').toUpperCase().replace(/^\$/, '').replace(/\./g, '-').replace(/-$/, '');
    const hit = tk.byTicker.get(t) || tk.byTicker.get(String(x?.t || '').toUpperCase());
    const d = Number(x?.d) > 0 ? 1 : Number(x?.d) < 0 ? -1 : 0;
    if (!hit || !d) { rejected++; continue; }
    if (imp.some(y => y.t === hit.ticker)) continue;
    imp.push({ t: hit.ticker, name: nameOf(hit), d, m: Math.max(1, Math.min(3, Math.round(Number(x.m) || 1))), h: ['day', 'week', 'quarter'].includes(x.h) ? x.h : 'day', r: trimWords(x.r) });
  }
  const rel = o.rel && imp.length ? 1 : 0;
  const f = o.f === 1 || o.f === true ? 1 : 0;
  const now = Date.now();
  s.state = 'scored';
  s.score = { rel, f, ev: String(o.ev || 'other'), c: Math.max(0, Math.min(1, Number(o.c) || 0)), imp, scoredAt: now, lat: now - s.fetched, queueWait: meta.startAt - (s.queuedAt || s.fetched), batch: meta.batch, rejected };
  W.counters.scored++; W.counters.rejected += rejected;
  if (rel) W.counters.relevant++; else W.counters.noise++;
  W.lat.push(s.score.lat); if (W.lat.length > 60) W.lat.shift();
  emit({ type: 'wire_score', id: s.id, rel, f, ev: s.score.ev, c: s.score.c, imp, lat: s.score.lat, batch: meta.batch, rejected });
  emit({ type: 'finding', agent: meta.agent, f: { k: 'score', name: s.id, tickers: imp.map(x => x.t), rel, fact: f } });
  if (rel && f) {
    for (const x of imp) schedulePrice(s, x);
    if (imp.some(x => x.m >= 2)) rippleLater(s);
    if (imp.some(x => x.m >= 3)) deskLater(s);
  }
}

function pump() {
  if (!W || W.stopped) return;
  if (W.inflight >= PARALLEL) return;
  if (!W.queue.length) return;
  const oldest = W.queue[0].queuedAt || 0;
  if (W.queue.length < BATCH_MAX && Date.now() - oldest < GATHER_MS) {
    if (!W.gatherTimer) W.gatherTimer = setTimeout(() => { W.gatherTimer = null; pump(); }, GATHER_MS - (Date.now() - oldest) + 20);
    return;
  }
  const list = W.queue.splice(0, BATCH_MAX);
  runBatch(list).finally(pump);
  pump();
}

async function runBatch(list) {
  const batch = ++W.batchNo, agent = 'w' + batch;
  W.inflight++;
  for (const s of list) s.state = 'scoring';
  const user = list.map((s, i) => storyBlock(s, i + 1)).join('\n\n');
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  const label = `Wire batch ${batch} · ${list.length} ${list.length === 1 ? 'story' : 'stories'}`;
  emit({ type: 'spawn', wave: 100 + batch, kind: 'wire', label, agents: [{ id: agent, label, input: inputOf(label, list.map(s => s.title).join('\n')) }] });
  const startAt = Date.now();
  const meta = { batch, agent, startAt };
  const done = new Set(), applies = [];
  const buf = { s: '' };
  const onLine = line => {
    line = line.replace(/^```(json)?/, '').replace(/```$/, '').replace(/,$/, '').trim();
    if (!line.startsWith('{')) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    const s = list[(+o.i || 0) - 1];
    if (!s || done.has(s.id)) return;
    done.add(s.id);
    applies.push(applyScore(s, o, meta));
  };
  if (W.gpu) gpuEnqueue(batch, list, messages);
  let firstAt = 0, res = null, err = null;
  try {
    res = await streamChat({
      messages, maxTokens: 450 + list.length * 140, signal: W.ac.signal, provider: W.provider,
      onRetry: (attempt, status) => emit({ type: 'retry', agent, attempt, status }),
      onFirst: () => { firstAt = Date.now(); emit({ type: 'first', agent }); },
      onText: (txt, kind) => {
        if (kind === 'reasoning') return;
        buf.s += txt; let i;
        while ((i = buf.s.indexOf('\n')) >= 0) { onLine(buf.s.slice(0, i).trim()); buf.s = buf.s.slice(i + 1); }
      },
    });
    onLine(buf.s.trim());
  } catch (e) { err = e; }
  await Promise.all(applies);
  const end = Date.now();
  const tokens = res?.usage?.completion_tokens || 0;
  const ct = res?.timeInfo?.completion_time;
  const tps = tokens ? Math.round(ct ? tokens / ct : (res.first ? tokens / Math.max(0.05, (res.end - res.first) / 1000) : 0)) : 0;
  const queuedMs = firstAt ? firstAt - startAt : null, genMs = firstAt ? end - firstAt : null;
  if (!err) { W.batches.push({ batch, n: list.length, queuedMs, genMs, tps, tokens, promptTokens: res.usage?.prompt_tokens }); if (W.batches.length > 40) W.batches.shift(); }
  emit({ type: 'done', agent, chars: res?.content?.length || 0, tokens, promptTokens: res?.usage?.prompt_tokens, cached: res?.usage?.prompt_tokens_details?.cached_tokens, tps, findings: done.size, queuedMs, genMs, total: end - startAt, ...(err ? { error: String(err.message || err).slice(0, 160) } : {}) });
  // anything the model skipped goes back once, then is dropped
  for (const s of list) {
    if (done.has(s.id)) continue;
    if (!s.retried && !W.stopped) { s.retried = true; s.state = 'queued'; s.queuedAt = Date.now(); W.queue.push(s); }
    else { s.state = 'scored'; s.score = { rel: 0, f: 0, ev: 'other', c: 0, imp: [], lat: Date.now() - s.fetched, batch, missed: true }; W.counters.scored++; W.counters.noise++; emit({ type: 'wire_score', id: s.id, rel: 0, f: 0, ev: 'other', c: 0, imp: [], lat: s.score.lat, batch, missed: true }); }
  }
  W.inflight--;
}

// ---------------------------------------------------------------- GPU side-by-side: the same batches, same prompts, scored by a GPU host
function gpuEnqueue(batch, list, messages) {
  const g = W.gpu;
  g.q.push({ batch, ids: list.map(s => s.id), fetched: list.map(s => s.fetched), messages, t0: Date.now() });
  gpuPump();
}
function gpuPump() {
  const g = W.gpu;
  while (g && g.active < 2 && g.q.length && !W.stopped) {
    const job = g.q.shift();
    g.active++;
    gpuRun(job).finally(() => { g.active--; gpuPump(); });
  }
}
async function gpuRun(job) {
  const g = W.gpu, cfg = providerConfig(g.provider);
  const lats = [], buf = { s: '' }, tk = await tickers();
  let first = 0, lines = 0, agree = 0, cmp = 0, err = null, res = null;
  const startAt = Date.now();
  const onLine = line => {
    line = line.replace(/^```(json)?/, '').replace(/```$/, '').replace(/,$/, '').trim();
    if (!line.startsWith('{')) return;
    let o; try { o = JSON.parse(line); } catch { return; }
    const idx = (+o.i || 0) - 1; if (idx < 0 || idx >= job.ids.length) return;
    lines++; lats.push(Date.now() - job.fetched[idx]);
    const mine = W.stories.get(job.ids[idx])?.score;
    const x = o.imp?.[0], t = x && tk.byTicker.get(String(x.t || '').toUpperCase());
    if (mine && o.rel && t && mine.imp[0]) { cmp++; if (mine.imp[0].t === t.ticker && mine.imp[0].d === Math.sign(x.d)) agree++; }
  };
  try {
    res = await streamChat({ messages: job.messages, maxTokens: 450 + job.ids.length * 140, signal: W.ac.signal, provider: g.provider, retryForMs: 90e3,
      onFirst: () => { first = Date.now(); },
      onText: (txt, kind) => { if (kind === 'reasoning') return; buf.s += txt; let i; while ((i = buf.s.indexOf('\n')) >= 0) { onLine(buf.s.slice(0, i).trim()); buf.s = buf.s.slice(i + 1); } } });
    onLine(buf.s.trim());
  } catch (e) { err = e; }
  const end = Date.now(), tokens = res?.usage?.completion_tokens || 0;
  const rec = { type: 'wire_gpu', batch: job.batch, label: cfg.label, n: job.ids.length, queuedMs: first ? first - startAt : null, waitMs: startAt - job.t0, genMs: first ? end - first : null, totalMs: end - job.t0, tps: first && tokens ? Math.round(tokens / Math.max(0.05, (end - first) / 1000)) : 0, medLatMs: median(lats), lines, agree, cmp, backlog: g.q.reduce((n, j) => n + j.ids.length, 0) + g.active, ...(err ? { error: String(err.message || err).slice(0, 120) } : {}) };
  g.done.push(rec); if (g.done.length > 40) g.done.shift();
  emit(rec);
}

// ---------------------------------------------------------------- ripple through the saved maps
async function rippleLater(s) {
  try {
    if (!W || W.stopped) return;
    const root = s.score.imp.filter(x => x.m >= 2).sort((a, b) => b.m - a.m)[0];
    if (!root) return;
    const key = root.t + (root.d > 0 ? '+' : '-');
    if (W.rippleSeen.get(key) > Date.now() - 10 * 60e3) return;
    const mem = await import('./memory.mjs');
    const g = await mem.memory();
    const id = 'T:' + root.t;
    if (!g.nodes.some(n => n.id === id)) return;
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    const nb = [...mem.neighbours(g, id).values()].map(x => ({ ...x, node: byId.get(x.id) })).filter(x => x.node?.ticker && x.node.ticker !== root.t && x.id.startsWith('T:')).sort((a, b) => b.n - a.n).slice(0, 28);
    if (nb.length < 2) return;
    W.rippleSeen.set(key, Date.now());
    W.rippleQ.push({ s, root, nb });
    if (!W.rippleTimer) W.rippleTimer = setTimeout(() => { W.rippleTimer = null; runRipples(); }, 500);
  } catch {}
}

async function runRipples() {
  if (!W || W.stopped || !W.rippleQ.length) return;
  const jobs = W.rippleQ.splice(0, 8);
  const tk = await tickers();
  const wave = ++W.rippleWave;
  const agents = jobs.map((j, i) => ({ id: `r${wave}_${i}`, label: `Ripple ${j.root.t}`, ticker: j.root.t, input: inputOf(`Ripple · ${j.root.t} · ${j.nb.length} connected companies`, j.s.title) }));
  emit({ type: 'spawn', wave: 200 + wave, kind: 'ripple', label: `Ripple wave ${wave} · ${jobs.length} ${jobs.length === 1 ? 'story' : 'stories'}`, agents });
  await Promise.all(jobs.map(async (j, i) => {
    const agent = agents[i].id, found = [];
    const list = j.nb.map(x => `${x.node.ticker} (${[...x.rels].join('/')} of ${j.root.t})`).join(', ');
    const messages = [
      { role: 'system', content: 'You work out second-order effects on connected companies. Output one JSON object per line, no prose, no code fences: {"t":"TICKER","d":1 or -1,"m":1 or 2,"r":"reason, at most 12 words, use ~ never approximately"}. List only connected companies from the list that are plausibly and materially affected; at most 6; skip the rest.' },
      { role: 'user', content: `Story: ${j.s.title}\nRoot effect: ${j.root.t} ${j.root.d > 0 ? 'up' : 'down'} (magnitude ${j.root.m}): ${j.root.r}\nConnected companies (relation as seen from ${j.root.t}'s supply-chain map): ${list}` },
    ];
    let first = 0; const t0 = Date.now(), buf = { s: '' };
    const onLine = line => {
      line = line.replace(/^```(json)?/, '').replace(/```$/, '').replace(/,$/, '').trim();
      if (!line.startsWith('{')) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      const hit = tk.byTicker.get(String(o.t || '').toUpperCase());
      const nbr = j.nb.find(x => x.node.ticker === hit?.ticker);
      const d = Number(o.d) > 0 ? 1 : Number(o.d) < 0 ? -1 : 0;
      if (!hit || !nbr || !d) return;
      found.push({ t: hit.ticker, name: nameOf(hit), d, m: Math.min(2, Math.max(1, Math.round(Number(o.m) || 1))), r: trimWords(o.r), via: j.root.t, rel: [...nbr.rels][0] });
    };
    let res = null, err = null;
    try {
      res = await streamChat({ messages, maxTokens: 500, signal: W.ac.signal, provider: W.provider,
        onFirst: () => { first = Date.now(); emit({ type: 'first', agent }); },
        onText: (txt, kind) => { if (kind === 'reasoning') return; buf.s += txt; let k; while ((k = buf.s.indexOf('\n')) >= 0) { onLine(buf.s.slice(0, k).trim()); buf.s = buf.s.slice(k + 1); } } });
      onLine(buf.s.trim());
    } catch (e) { err = e; }
    if (found.length) { j.s.ripple = found; emit({ type: 'wire_ripple', id: j.s.id, root: j.root.t, d: j.root.d, imp: found }); W.counters.ripples += found.length; }
    const tokens = res?.usage?.completion_tokens || 0, end = Date.now();
    emit({ type: 'done', agent, tokens, tps: first && tokens ? Math.round(tokens / Math.max(0.05, (end - first) / 1000)) : 0, findings: found.length, queuedMs: first ? first - t0 : null, genMs: first ? end - first : null, ...(err ? { error: String(err.message || err).slice(0, 120) } : {}) });
  }));
}

// ---------------------------------------------------------------- the main agent's desk note for big stories
function deskLater(s) {
  if (!W || W.stopped || Date.now() - W.lastDesk < 90e3) return;
  W.lastDesk = Date.now();
  const imp = s.score.imp.filter(x => x.m >= 3).map(x => `${x.t} ${x.d > 0 ? 'up' : 'down'}: ${x.r}`).join('; ');
  streamChat({ signal: W.ac.signal, provider: W.provider, maxTokens: 160, messages: [
    { role: 'system', content: 'You are the desk head of a trading terminal. Write a desk note in exactly two short plain lines: what happened, then who is exposed. No markdown, use "~" never "approximately".' },
    { role: 'user', content: `${s.title}\nScored: ${imp}` }] })
    .then(r => emit({ type: 'wire_desk', id: s.id, text: String(r.content || '').trim().slice(0, 320), by: 'Main Agent' }), () => {});
}

// ---------------------------------------------------------------- prices and the hit rate
const yahoo = t => String(t).replace(/\./g, '-');
const barsMem = new Map(); // ticker -> {at, b}
let yNext = 0;
async function bars(ticker, fresh = false) {
  const m = barsMem.get(ticker);
  if (m && (Date.now() - m.at < (fresh ? 40e3 : 3600e3) || (m.fail && Date.now() - m.at < 300e3))) return m.b;
  try {
    // a replay keys its bars by the replay date (Yahoo keeps 1-minute bars ~7 days: once on disk they are never refetched)
    const day = W?.mode === 'replay' ? W.date : new Date().toISOString().slice(0, 10);
    const name = safeName(`wire-bars-${ticker}-${day}.json`);
    const read = async () => {
      const now = Date.now(), at = Math.max(now, yNext); yNext = at + 300; if (at > now) await sleep(at - now);
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo(ticker))}?range=7d&interval=1m&includePrePost=true`, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('yahoo ' + r.status);
      const res = (await r.json()).chart?.result?.[0];
      const ts = res?.timestamp || [], cl = res?.indicators?.quote?.[0]?.close || [];
      const t = [], c = [];
      ts.forEach((x, i) => { if (cl[i] != null) { t.push(x * 1000); c.push(+cl[i].toFixed(4)); } });
      if (t.length < 30) throw new Error('no bars');
      return JSON.stringify({ t, c });
    };
    // live runs refetch so the newest bars are there; replays use the day's file cache
    const raw = fresh ? await read() : await cached(name, read);
    const b = JSON.parse(raw);
    barsMem.set(ticker, { at: Date.now(), b });
    return b;
  } catch { barsMem.set(ticker, { at: Date.now(), b: null, fail: true }); return null; }
}
const idxAtOrBefore = (t, x) => { let lo = 0, hi = t.length - 1, r = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] <= x) { r = mid; lo = mid + 1; } else hi = mid - 1; } return r; };

function moveOver(b, from, to, tol = 15 * 60e3) {
  const i0 = idxAtOrBefore(b.t, from);
  if (i0 < 0 || from - b.t[i0] > tol) return null;
  const i1 = idxAtOrBefore(b.t, to);
  if (i1 <= i0 || to - b.t[i1] > tol) return null;
  return { p0: b.c[i0], p1: b.c[i1], r: b.c[i1] / b.c[i0] - 1, at: b.t[i1] };
}

async function outcome(pub, ticker, d) {
  const b = await bars(ticker, W.mode === 'live');
  if (!b) return { closed: true, why: 'no bars' };
  const m15 = moveOver(b, pub, pub + 15 * 60e3);
  let m60 = moveOver(b, pub, pub + 60 * 60e3);
  if (!m60) { // a partial window still counts when the data ends at least 10 minutes in (e.g. 8-K at 19:30)
    const last = b.t.at(-1); if (last - pub >= 10 * 60e3 && last - pub < 60 * 60e3) m60 = moveOver(b, pub, last, 30 * 60e3);
  }
  if (!m15 && !m60) return { closed: true, why: 'market closed' };
  const spy = ticker === 'SPY' ? null : await bars('SPY', W.mode === 'live');
  const sp = spy && m60 ? moveOver(spy, pub, m60.at, 30 * 60e3) : null;
  const r60 = m60?.r ?? null;
  return { p0: (m15 || m60).p0, r15: m15?.r ?? null, r60, rs: sp?.r ?? null, hit: r60 == null || r60 === 0 ? null : Math.sign(r60) === d, hitEx: r60 == null || !sp || r60 === sp.r ? null : Math.sign(r60 - sp.r) === d, strong: r60 == null ? null : Math.abs(r60) >= 0.003 && Math.sign(r60) === d };
}

function tally(m, o, pub, kind) {
  if (o.hit == null) return;
  const bump = k => { const h = (W.hits[k] ||= { n: 0, hit: 0, ex: 0, exN: 0, strong: 0 }); h.n++; if (o.hit) h.hit++; if (o.strong) h.strong++; if (o.hitEx != null) { h.exN++; if (o.hitEx) h.ex++; } };
  bump('m' + Math.min(m, 3)); bump('m0');
  if (m >= 2) { bump('p2'); const p = etParts(pub), mins = p.hour * 60 + p.minute; bump(mins >= 570 && mins < 960 ? 'reg' : 'ext'); bump(kind === 'sec' ? 'sec' : 'news'); }
}

function schedulePrice(s, x) {
  const key = s.id + x.t;
  if (W.priced.has(key)) return;
  W.priced.add(key);
  const pub = s.published, now = Date.now();
  const send = async final => {
    if (!W || W.stopped) return;
    const o = await outcome(pub, x.t, x.d);
    if (o.closed) { emit({ type: 'wire_price', id: s.id, t: x.t, closed: true, why: o.why }); return; }
    emit({ type: 'wire_price', id: s.id, t: x.t, d: x.d, m: x.m, p0: o.p0, r15: o.r15, r60: o.r60, rs: o.rs, hit: o.hit, hitEx: o.hitEx, final });
    if (final && o.hit != null) { tally(x.m, o, pub, s.kind); }
  };
  if (W.mode === 'live' && !extendedHours(pub)) { emit({ type: 'wire_price', id: s.id, t: x.t, closed: true, why: 'market closed' }); return; }
  if (pub + 60 * 60e3 <= now) { W.pricePromises.push(send(true).catch(() => {})); return; }
  const t15 = Math.max(1000, pub + 16 * 60e3 - now), t60 = Math.max(2000, pub + 61 * 60e3 - now);
  W.timers.add(setTimeout(() => send(false).catch(() => {}), t15));
  W.timers.add(setTimeout(() => send(true).catch(() => {}), t60));
}

// ---------------------------------------------------------------- live pollers
function feedState(id, name, badge) { return (W.feeds[id] ||= { id, name, badge, ok: null, n: 0, last: null, next: null, err: null, polls: 0 }); }

function startLive() {
  const stagger = 2500;
  const loop = (f, fn, every, offset) => {
    const st = feedState(f.id, f.name, f.badge);
    const run = async () => {
      if (!W || W.stopped) return;
      let wait = every;
      try {
        const items = await fn();
        st.ok = true; st.err = null; st.n = items.length; st.last = Date.now(); st.polls++;
        const first = st.polls === 1;
        const fresh = items.filter(x => x.published && (first ? Date.now() - x.published < 30 * 3600e3 : true)).sort((a, b) => a.published - b.published).slice(first ? -10 : -40);
        for (const it of fresh) await ingest(it);
      } catch (e) {
        st.ok = false; st.err = String(e.message || e).slice(0, 100);
        wait = /429|backoff|403/.test(st.err) ? Math.max(every, 6 * 60e3) : Math.min(every * 2, 10 * 60e3);
      }
      st.next = Date.now() + wait;
      W.timers.add(setTimeout(run, wait));
    };
    st.next = Date.now() + offset;
    W.timers.add(setTimeout(run, offset));
  };
  let o = 0;
  loop({ id: 'sec', name: 'SEC EDGAR 8-K', badge: 'SEC' }, async () => {
    const xml = await secFetch('https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=40&output=atom');
    return parseSecAtom(xml).map(x => ({ sec: x, published: x.published }));
  }, 60e3, o += 300);
  for (const f of RSS) loop(f, async () => parseRss(await webFetch(f.url), f.name, f.badge), f.every, o += stagger);
  let gi = 0, yi = 0;
  loop({ id: 'gn', name: 'Google News', badge: 'GN' }, async () => parseRss(await webFetch('https://news.google.com/rss/search?q=' + encodeURIComponent(GN_QUERIES[gi++ % GN_QUERIES.length] + ' when:1d') + '&hl=en-US&gl=US&ceid=US:en'), 'Google News', 'GN').slice(0, 25), 70e3, o += stagger);
  loop({ id: 'yf', name: 'Yahoo Finance', badge: 'YF' }, async () => parseRss(await webFetch('https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + YF_GROUPS[yi++ % YF_GROUPS.length] + '&region=US&lang=en-US'), 'Yahoo Finance', 'YF'), 60e3, o += stagger);
}

// ---------------------------------------------------------------- replay of a past trading day
async function loadReplay(date) {
  const status = msg => emit({ type: 'wire_status', phase: 'preparing', msg, ...snapshot() });
  const tk = await tickers();
  const [y, mo] = date.split('-');
  status('Reading the SEC daily index');
  const idx = await cached(`wire-idx-${date}.txt`, () => secFetch(`https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${Math.ceil(+mo / 3)}/form.${date.replace(/-/g, '')}.idx`));
  const rows = [];
  for (const line of idx.split('\n')) {
    const m = /^8-K\s+(.+?)\s{2,}(\d+)\s+(\d{8})\s+edgar\/data\/\d+\/([\d-]+)\.txt/.exec(line);
    if (m && tk.byCik.has(String(+m[2]))) rows.push({ company: m[1].trim(), cik: String(+m[2]), acc: m[4], t: tk.byCik.get(String(+m[2])) });
  }
  const order = new Map([...tk.byTicker.keys()].map((k, i) => [k, i]));
  rows.sort((a, b) => order.get(a.t.ticker) - order.get(b.t.ticker));
  const keep = rows.slice(0, 150);
  const out = [];
  let k = 0;
  for (const r of keep) {
    if (W.stopped) return [];
    k++;
    if (k % 10 === 1) status(`Reading filing times · ${k}/${keep.length}`);
    try {
      const pad = r.cik.padStart(10, '0');
      const slim = await cached(safeName(`wire-subs-${pad}-${r.acc}.json`), async () => {
        const subs = await secFetch(`https://data.sec.gov/submissions/CIK${pad}.json`, false);
        const f = subs.filings.recent, i = f.accessionNumber.indexOf(r.acc);
        if (i < 0) throw new Error('not in recent');
        return JSON.stringify({ at: f.acceptanceDateTime[i], doc: f.primaryDocument[i], items: f.items?.[i] || '' });
      });
      const j = JSON.parse(slim);
      const labels = { '1.01': 'Entry into a Material Agreement', '1.02': 'Termination of a Material Agreement', '1.03': 'Bankruptcy or Receivership', '1.05': 'Material Cybersecurity Incidents', '2.01': 'Completion of Acquisition or Disposition', '2.02': 'Results of Operations and Financial Condition', '2.03': 'Creation of a Direct Financial Obligation', '2.05': 'Costs Associated with Exit or Disposal Activities', '2.06': 'Material Impairments', '3.01': 'Notice of Delisting or Listing Standard Failure', '3.02': 'Unregistered Sales of Equity Securities', '4.01': 'Changes in Certifying Accountant', '4.02': 'Non-Reliance on Previously Issued Financials', '5.01': 'Changes in Control of Registrant', '5.02': 'Departure or Election of Directors or Officers', '5.03': 'Amendments to Articles or Bylaws', '5.07': 'Submission of Matters to a Vote', '7.01': 'Regulation FD Disclosure', '8.01': 'Other Events', '9.01': 'Financial Statements and Exhibits' };
      const items = String(j.items).split(',').map(x => x.trim()).filter(Boolean).map(n => ({ n, label: labels[n] || 'Item ' + n }));
      const pub = Date.parse(j.at);
      if (!Number.isFinite(pub) || etDate(pub) !== date) continue;
      const base = `https://www.sec.gov/Archives/edgar/data/${+r.cik}/${r.acc.replace(/-/g, '')}/`;
      out.push({ sec: { cik: r.cik, acc: r.acc, items, doc: j.doc, index: `${base}${r.acc}-index.htm`, form: '8-K', company: r.company }, published: pub });
    } catch (e) { if (/backoff/.test(e.message)) break; }
  }
  status('Reading Google News for that day');
  const day0 = Date.parse(date + 'T00:00:00Z');
  const prev = new Date(day0 - 864e5).toISOString().slice(0, 10), next = new Date(day0 + 864e5).toISOString().slice(0, 10);
  const q = ['stock market', 'earnings results stock', 'semiconductor chip stocks', 'merger acquisition deal announced', 'FDA approval biotech', 'oil prices OPEC', 'Federal Reserve rates', 'antitrust lawsuit regulators company', 'AI data center spending', 'guidance outlook raises lowers'];
  for (const text of q) {
    if (W.stopped) return [];
    try {
      const xml = await cached(safeName(`wire-gn-${date}-${text}.xml`), () => webFetch('https://news.google.com/rss/search?q=' + encodeURIComponent(`${text} after:${prev} before:${next}`) + '&hl=en-US&gl=US&ceid=US:en', { gap: 3000 }));
      for (const it of parseRss(xml, 'Google News', 'GN')) { if (!it.published || etDate(it.published) !== date) continue; const h = etParts(it.published).hour; if (h >= 4 && h < 21) out.push(it); }
    } catch {}
  }
  out.sort((a, b) => a.published - b.published);
  return out;
}

async function startReplay(date, speed) {
  let items;
  try { items = await loadReplay(date); }
  catch (e) { emit({ type: 'wire_status', phase: 'error', msg: String(e.message || e).slice(0, 160), ...snapshot() }); throw e; }
  if (!W || W.stopped) return;
  W.replayTotal = items.length;
  emit({ type: 'wire_status', phase: 'running', msg: `Replaying ${items.length} stories from ${date}`, ...snapshot() });
  const t0 = Date.now();
  let prevPub = null;
  for (const it of items) {
    if (!W || W.stopped) return;
    if (prevPub != null) {
      const gap = Math.min(900, Math.max(40, (it.published - prevPub) / speed));
      await sleep(gap);
    }
    prevPub = it.published;
    await ingest({ ...it, fetched: Date.now() });
    W.replayDone++;
  }
  // drain: wait for the backlog to empty, then wrap up
  for (let i = 0; i < 1200 && W && !W.stopped; i++) {
    if (!W.queue.length && !W.inflight && ![...W.stories.values()].some(s => s.state === 'reading' || s.state === 'scoring' || s.state === 'queued')) break;
    await sleep(500);
  }
  if (!W || W.stopped) return;
  await Promise.all(W.pricePromises.splice(0));
  W.finishedAt = Date.now();
  emit({ type: 'wire_status', phase: 'done', msg: 'Replay finished', elapsed: Date.now() - t0, ...snapshot() });
  emit({ type: 'wire_summary', ...summary() });
  await save();
}

// ---------------------------------------------------------------- status, summary, save
function snapshot() {
  if (!W) return { running: false };
  const now = Date.now();
  W.recentIn = W.recentIn.filter(x => now - x < 60e3);
  const open = [...W.stories.values()].filter(s => s.state !== 'scored').length;
  const bs = W.batches.slice(-12);
  const cfg = providerConfig(W.provider);
  const g = W.gpu;
  return {
    running: !W.stopped && !W.finishedAt, mode: W.mode, date: W.date, model: cfg.label, provider: cfg.name,
    feeds: Object.values(W.feeds).map(f => ({ id: f.id, name: f.name, badge: f.badge, ok: f.ok, n: f.n, last: f.last, next: f.next, err: f.err })),
    spm: W.mode === 'replay' ? Math.round((W.counters.in / Math.max(1, (now - W.startedAt) / 60e3)) * 10) / 10 : W.recentIn.length,
    scoredPerMin: Math.round(W.counters.scored / Math.max(1, (now - W.startedAt) / 60e3) * 10) / 10,
    backlog: open, medLatMs: median(W.lat), medQueueMs: median(bs.map(b => b.queuedMs)), medGenMs: median(bs.map(b => b.genMs)), medTps: median(bs.map(b => b.tps)),
    counters: W.counters, hits: W.hits, replay: W.mode === 'replay' ? { total: W.replayTotal || 0, done: W.replayDone } : undefined,
    gpu: g ? { label: providerConfig(g.provider).label, n: g.done.length, medTotalMs: median(g.done.map(x => x.totalMs)), medLatMs: median(g.done.map(x => x.medLatMs)), medQueueMs: median(g.done.map(x => x.queuedMs)), medGenMs: median(g.done.map(x => x.genMs)), medTps: median(g.done.map(x => x.tps)), backlog: g.q.reduce((n, j) => n + j.ids.length, 0) + g.active * 20, errors: g.done.filter(x => x.error).length, agree: g.done.reduce((n, x) => n + x.agree, 0), cmp: g.done.reduce((n, x) => n + x.cmp, 0) } : undefined,
  };
}

function summary() {
  const bs = W.batches;
  const h = k => { const x = W.hits[k]; return x && x.n ? { n: x.n, hit: x.hit, rate: +(x.hit / x.n).toFixed(3), strongRate: +(x.strong / x.n).toFixed(3), exN: x.exN, exRate: x.exN ? +(x.ex / x.exN).toFixed(3) : null } : { n: 0 }; };
  return {
    date: W.date, mode: W.mode, model: providerConfig(W.provider).label, stories: W.counters.in, scored: W.counters.scored, relevant: W.counters.relevant, dups: W.counters.dups, ripples: W.counters.ripples, rejectedTickers: W.counters.rejected,
    batches: bs.length, medQueueMs: median(bs.map(b => b.queuedMs)), medGenMs: median(bs.map(b => b.genMs)), medTps: median(bs.map(b => b.tps)), medLatMs: median(W.lat),
    hitRate: { sec8kM2plus: h('sec'), newsM2plus: h('news'), regularHoursM2plus: h('reg'), extendedHoursM2plus: h('ext'), m2plus: h('p2'), m3: h('m3'), all: h('m0'), m1: h('m1') },
  };
}

async function save() {
  if (!W || !W.events.length) return null;
  const date = W.date || etDate(Date.now());
  // a stopped, unfinished replay never overwrites a complete recording
  const file = W.mode === 'replay' && !W.finishedAt ? `wire-${date}.partial.json` : `wire-${date}.json`;
  await mkdir(RUNS, { recursive: true });
  await writeFile(path.join(RUNS, file), JSON.stringify({ kind: 'wire', date, mode: W.mode, provider: providerConfig(W.provider).label, startedAt: W.startedAt, summary: summary(), events: W.events.filter(e => e.type !== 'wire_status') }));
  return file;
}

// ---------------------------------------------------------------- public API
async function start({ replay = '', provider = '', gpu = false, speed = 600 } = {}) {
  if (W && !W.stopped && !W.finishedAt) {
    if (!replay || (W.mode === 'replay' && W.date === replay)) return { ok: true, already: true, ...snapshot() };
    await stop();
  }
  const cfg = providerConfig(provider || undefined);
  if (!cfg.key) throw Object.assign(new Error(`No API key for provider ${cfg.name}`), { code: 'NOKEY' });
  await tickers();
  W = {
    mode: replay ? 'replay' : 'live', date: replay || etDate(Date.now()), provider: provider || undefined, startedAt: Date.now(), stopped: false, finishedAt: 0,
    events: [], stories: new Map(), order: [], queue: [], inflight: 0, batchNo: 0, seq: 0, rippleWave: 0, rippleQ: [], rippleSeen: new Map(), lastDesk: 0,
    feeds: {}, timers: new Set(), ac: new AbortController(), recentIn: [], lat: [], batches: [], pricePromises: [], priced: new Set(),
    counters: { in: 0, scored: 0, relevant: 0, noise: 0, dups: 0, skipped: 0, rejected: 0, ripples: 0, readFail: 0 }, hits: {}, replayDone: 0,
    gpu: gpu ? { provider: 'openrouter', q: [], active: 0, done: [] } : null,
  };
  if (W.gpu && !providerConfig('openrouter').key) W.gpu = null;
  lastStatus = null;
  emit({ type: 'wire_status', phase: 'starting', msg: replay ? `Replay ${replay}` : 'Live wire', ...snapshot() });
  W.statusTimer = setInterval(() => emit({ type: 'wire_status', phase: W.finishedAt ? 'done' : 'running', ...snapshot() }), 1500);
  W.timers.add(W.statusTimer);
  if (!replay) { W.saveTimer = setInterval(() => save().catch(() => {}), 120e3); W.timers.add(W.saveTimer); startLive(); }
  else startReplay(replay, Math.max(60, +speed || 600)).catch(() => {});
  return { ok: true, mode: W.mode, date: W.date, model: cfg.label, gpu: Boolean(W.gpu) };
}

async function stop() {
  if (!W) return { ok: true, running: false };
  W.stopped = true;
  for (const t of W.timers) { clearTimeout(t); clearInterval(t); }
  W.ac.abort();
  emit({ type: 'wire_status', phase: 'stopped', ...snapshot() });
  const file = await save().catch(() => null);
  return { ok: true, running: false, file };
}

const status = () => ({ ...snapshot(), phase: W ? (W.stopped ? 'stopped' : W.finishedAt ? 'done' : 'running') : 'idle', summary: W ? summary() : null });

export const _t = { readFiling, parseSecAtom };
export const wire = { start, stop, status, summary: () => (W ? summary() : null) };

function stories() {
  if (!W) return [];
  return W.order.map(id => { const s = W.stories.get(id); return { ...pubStory(s), state: s.state, score: s.score || null, ripple: s.ripple || null }; });
}

// Answer a question from the scored stories only
async function ask(q) {
  if (!W) throw new Error('The wire is not running');
  const rows = W.order.map(id => W.stories.get(id)).filter(s => s.score?.rel).slice(-160).reverse();
  if (!rows.length) return { answer: 'Nothing scored yet.', tickers: [] };
  const hm = ms => { const p = etParts(ms); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
  const ctx = rows.map(s => `${hm(s.published)} ${s.score.imp.map(x => `${x.t}${x.d > 0 ? '+' : '-'}${x.m}`).join(' ')} ${s.score.f ? 'FACT' : 'opinion'} | ${s.title} | ${s.score.imp[0]?.r || ''}`).join('\n');
  const t0 = Date.now(); let first = 0;
  const r = await streamChat({ provider: W.provider, maxTokens: 400, signal: W.ac.signal, onFirst: () => { first = Date.now(); }, messages: [
    { role: 'system', content: 'You answer questions about today\'s scored news wire. Use ONLY the stories given. Answer in at most three short plain sentences, naming tickers with direction (up/down) and the reason; say so if the wire has nothing on it. Facts outweigh opinion. Use "~" never "approximately". No markdown.' },
    { role: 'user', content: `Scored stories (time ET, ticker with +up/-down and magnitude 1-3, FACT or opinion, headline, reason):\n${ctx}\n\nQuestion: ${q}` }] });
  const text = String(r.content || '').trim();
  return { answer: text, tickers: [...new Set(text.match(/\b[A-Z]{2,5}\b/g) || [])].filter(t => rows.some(s => s.score.imp.some(x => x.t === t))).slice(0, 6), ms: Date.now() - t0, firstMs: first ? first - t0 : null, model: providerConfig(W.provider).label, tokens: r.usage?.completion_tokens || null };
}

async function priceSeries(ticker, date) {
  const b = await bars(String(ticker).toUpperCase(), W?.mode === 'live');
  if (!b) return { ticker, t: [], c: [] };
  const from = date ? Date.parse(date + 'T08:00:00Z') : Date.now() - 2 * 864e5, to = date ? Date.parse(date + 'T02:00:00Z') + 864e5 : Date.now() + 1;
  const t = [], c = [];
  let lastBucket = -1;
  b.t.forEach((x, i) => { if (x >= from && x <= to) { const k = Math.floor(x / 300e3); if (k !== lastBucket) { t.push(x); c.push(b.c[i]); lastBucket = k; } } });
  return { ticker, t, c };
}

export async function handle(req, res, p, url, { mode } = {}) {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
  const sub = p.replace(/^\/api\/wire\/?/, '');
  try {
    if (sub === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': hello\n\n');
      const unsub = subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { unsub(); clearInterval(ping); });
      return true;
    }
    if (sub === 'start') {
      const g = url.searchParams.get('gpu');
      return send(200, { ...(await start({ replay: /^\d{4}-\d\d-\d\d$/.test(url.searchParams.get('replay') || '') ? url.searchParams.get('replay') : '', provider: ['cerebras', 'deepseek', 'openrouter'].includes(url.searchParams.get('provider')) ? url.searchParams.get('provider') : '', gpu: g === '1' || g === 'true', speed: url.searchParams.get('speed') || 600 })), appMode: mode });
    }
    if (sub === 'stop') return send(200, await stop());
    if (sub === 'status') return send(200, status());
    if (sub === 'stories') return send(200, stories());
    if (sub === 'ask') { const q = (url.searchParams.get('q') || '').trim(); if (!q) return send(400, { error: 'q required' }); return send(200, await ask(q)); }
    if (sub === 'price') return send(200, await priceSeries(url.searchParams.get('ticker') || '', url.searchParams.get('date') || (W?.mode === 'replay' ? W.date : '')));
    if (sub === 'neighbours') {
      const t = String(url.searchParams.get('ticker') || '').toUpperCase();
      const mem = await import('./memory.mjs'), g = await mem.memory(), byId = new Map(g.nodes.map(n => [n.id, n]));
      const list = [...mem.neighbours(g, 'T:' + t).values()].map(x => ({ t: byId.get(x.id)?.ticker, rel: [...x.rels][0], n: x.n })).filter(x => x.t && x.t !== t).sort((a, b) => b.n - a.n).slice(0, 12);
      return send(200, { ticker: t, list });
    }
    if (sub === 'saved') return send(200, (await readdir(RUNS).catch(() => [])).filter(f => /^wire-\d{4}-\d\d-\d\d\.json$/.test(f)).sort().reverse());
    return send(404, { error: 'unknown wire route' });
  } catch (e) {
    return send(e.code === 'NOKEY' ? 400 : 500, { error: String(e.message || e) });
  }
}

// Feed helpers reused by engine/investigate.mjs (per-company news).
export const feedTools = { parseRss, webFetch };
