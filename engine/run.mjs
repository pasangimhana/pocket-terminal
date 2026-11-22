// One session = one ask: page or chat question -> scan (10-K + financials) -> wave 1 (one agent per chunk)
// -> candidates -> wave 2 (one agent per chosen company's filing) -> the bot's reply -> end.
// In plugin mode the OpenClaw agent drives scan/spawn/expand through its tools; standalone runs the same
// steps scripted. Every event is broadcast over SSE and the session is saved to runs/<TICKER>-<provider>-<stamp>.json.
import { writeFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTicker, searchTickers, latest10K, get10KText, splitItems, makeChunks, financials, ratiosFrom, latest8K, get8KText, priceSeries } from './sec.mjs';
import { streamChat, providerConfig } from './llm.mjs';
import { SYSTEM as PROFILE_SYSTEM, profileExcerpt, parseProfile, setProfile, cachedProfile } from './profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'runs');
const OC = process.env.POCKET_OC || path.join(ROOT, 'plugin', 'oc');
const WAVE1_DEFAULT = 32;
const WAVE2_MAX = 14;
const NEWS_MAX = 15;
const WHATIF_MAX = 30;
const PROFILE_MAX = 24;
const RESOLVE_MAX = 8;

// ---- broadcast ----
const subscribers = new Set();
let current = null;
// fn(e, replayed): replayed is true for the backlog sent to a late subscriber and for a saved session loaded back onto the page
export function subscribe(fn) {
  subscribers.add(fn);
  if (current) for (const e of current.events) fn(e, true);
  return () => subscribers.delete(fn);
}
export function currentSession() { return current; }
// events outside any session (the watchlist, the hop trail): straight to the page, not saved
export function broadcast(e) { e.t = Date.now(); for (const fn of subscribers) { try { fn(e); } catch {} } }
export const currentRun = currentSession;
export const isBusy = () => Boolean(current && !current.finished);

// Hops: every session has an id; the page's trail lists the sessions of one chain (see hop.mjs).
export const sessions = new Map();
export const trail = { items: [], active: null };
export const hooks = { trail: () => {} };
let sidN = 0;
// make s the session the page shows and the tools act on (it does not send anything)
export function setCurrent(s) { current = s; }
// send a session's whole event list to every page at once (fast: the page skips its story pauses)
export function sendAll(s) { for (const e of s.events) for (const fn of subscribers) { try { fn(e, true); } catch {} } }

export function newSession({ source, scripted = false, awaitReply = false, detached = false }) {
  const s = { id: 's' + Date.now().toString(36) + (sidN++).toString(36), t0: Date.now(), events: [], finished: false, source, scripted, awaitReply, detached, paused: false, mentions: new Map(), prefetch: new Map(), pending: new Set(), inflight: new Set() };
  s.emit = (e) => {
    if (s.finished) return;
    if (e.type === 'bot' && s.scripted) e.scripted = true;
    e.t = Date.now() - s.t0;
    s.events.push(e);
    if (!s.detached) for (const fn of subscribers) { try { fn(e); } catch {} }
  };
  sessions.set(s.id, s);
  if (!detached) current = s;
  return s;
}

// ---- prompts ----
const SCHEMA = `Output one JSON object per line. No prose, no markdown, no code fences. Kinds:
{"k":"company","name":"Taiwan Semiconductor Manufacturing","ticker":"TSM","rel":"supplier","pct":11,"q":"<verbatim quote, max 20 words>"}
   rel is one of: supplier, customer, competitor, partner, investee, acquired, other
   pct: only when the excerpt states this company's share of revenue or purchases, as a number (11 for "11% of revenue"); otherwise leave pct out
{"k":"product","name":"<product or platform>","q":"..."}
{"k":"segment","name":"<reporting segment or market>","q":"..."}
{"k":"metric","name":"Revenue","value":"$130.5 billion","period":"FY2026","q":"..."}
{"k":"risk","name":"<risk in max 6 words>","q":"..."}
{"k":"place","name":"<country or region>","rel":"manufacturing|sales|operations","q":"..."}
{"k":"customer_hint","name":"Customer A","detail":"<share of revenue, segment>","guess":["<company>","<company>"],"q":"..."}`;

const RULES = `Rules:
- Only report what YOUR excerpt states. Quotes must be copied verbatim from the excerpt.
- Use common company names (e.g. "Microsoft", not "the Company's customer"). Ticker only if you are sure (US listing or ADR), otherwise null.
- For anonymous customers ("Customer A", "direct customer"), emit customer_hint with your best 1-3 guesses.
- Emit company lines first, then the rest. Between 6 and 22 lines. Start immediately.`;

function wave1Messages(meta, chunk, nAgents, focus) {
  const f = focus ? `\nThe lead analyst asked the team to focus on: ${focus}.` : '';
  const system = `You are one of ${nAgents} analyst agents reading ${meta.name}'s ${meta.filing.form} annual report (filed ${meta.filing.date}) in parallel. Each agent reads one excerpt and extracts the business network and key facts.${f}\n\n${SCHEMA}\n\n${RULES}`;
  return [{ role: 'system', content: system }, { role: 'user', content: `Excerpt: ${chunk.label}\n\n${chunk.text}` }];
}

function wave2Messages(rootShort, target, excerpt, known) {
  const system = `You are an analyst agent reading excerpts of ${target.name}'s ${target.form} annual report. The investigation maps the business network around ${rootShort}. Companies already in the network: ${known.join(', ')}.

Output one JSON object per line. No prose, no markdown, no code fences:
{"k":"about","name":"${target.name}","ticker":"${target.ticker}","desc":"<one line, max 14 words, what the company does>"}
{"k":"company","name":"<company>","ticker":"<ticker or null>","rel":"supplier|customer|competitor|partner|investee|other","pct":12,"q":"<verbatim quote, max 20 words>"}
   rel is that company's relationship TO ${target.name} (the filer).
   pct: only when the excerpt states that company's share of the filer's revenue or purchases, as a number; otherwise leave pct out.
{"k":"metric","name":"Revenue","value":"...","period":"...","q":"..."}

Rules: the first line is exactly one "about" line for ${target.name}. Then only what the excerpt states, quotes verbatim. Always report what it says about ${rootShort} if anything. Prefer companies from the network list. Between 4 and 14 lines. Start immediately.`;
  return [{ role: 'system', content: system }, { role: 'user', content: excerpt }];
}

// Fill-in: when the filing names few companies in a group (banks say "other banks"), one agent infers them.
const FILL = {
  competitor: { label: 'Rivals', plural: 'competitors', what: 'main competitors' },
  supplier: { label: 'Suppliers', plural: 'suppliers', what: 'main suppliers and vendors (chips, components, software, cloud, services, outsourcing)' },
  customer: { label: 'Customers', plural: 'customers', what: 'largest customers. Public companies only: for a consumer business or a bank, name large corporate or institutional clients that are public companies' },
  partner: { label: 'Partners', plural: 'partners', what: 'main strategic partners (alliances, distribution, technology or co-development partners)' },
};
function fillMessages(meta, group, biz) {
  const g = FILL[group];
  const system = `You are an analyst agent. ${meta.name} (${meta.ticker})${meta.filing.sic ? `, industry: ${meta.filing.sic}` : ''}. Its annual report names few ${g.plural}.
From the business description below and well-known facts, list up to 8 PUBLIC companies (US tickers where they exist) that are its ${g.what}. Fewer is fine if that is the honest answer. One JSON object per line, nothing else:
{"k":"company","name":"<company>","ticker":"<US ticker or null>","rel":"${group}","q":"<why, max 18 words>"}`;
  return [{ role: 'system', content: system }, { role: 'user', content: biz }];
}

function confirmMessages(rootShort, a, excerpt) {
  const system = `You are an analyst agent checking an inferred relationship against ${a.name}'s own annual report.
Hypothesis: ${a.name} (${a.ticker}) is a ${a.rel} of ${rootShort}.
Read the excerpt (its business section and paragraphs that mention ${rootShort}). Does it support the hypothesis?
Output exactly one JSON line, nothing else:
{"k":"confirm","name":"${a.name}","ticker":"${a.ticker}","rel":"${a.rel}","supports":"yes|no|unclear","q":"<verbatim quote from the excerpt, max 25 words, or empty>","why":"<max 16 words>"}`;
  return [{ role: 'system', content: system }, { role: 'user', content: excerpt }];
}

function newsMessages(a, text) {
  const system = `You read the start of ${a.name}'s latest ${a.form} filing with the SEC (filed ${a.date}). Output exactly one JSON line and nothing else:
{"k":"news","name":"${a.name}","headline":"<what happened, max 14 words>","sentiment":"positive|negative|neutral"}
sentiment is for ${a.name}'s investors. If the filing is routine (a cover page, an exhibit list), say what it is and use neutral.`;
  return [{ role: 'system', content: system }, { role: 'user', content: text || '(empty filing text)' }];
}

function whatifMessages(rootShort, a, question, context) {
  const role = a.isRoot ? (a.commodity ? `This is the ${a.name} market itself: "positive" means its price rises.` : `${a.name} is the company at the center of the map.`) : `${a.name}'s relationship to ${rootShort}: ${a.rels || 'mentioned in its filings'}.`;
  const system = `You are one analyst agent in a what-if exercise on ${rootShort}'s ${a.commodityMap ? 'value chain' : 'business network'}. Question: "${question}"
You assess ONE company: ${a.name}${a.ticker ? ` (${a.ticker})` : ''}. ${role}
Evidence from SEC filings:
${context || '(no quotes; use well-known facts about the company)'}

Output exactly one JSON line and nothing else:
{"k":"impact","name":"${a.name}","ticker":${JSON.stringify(a.ticker || null)},"impact":"negative|mixed|positive","severity":2,"pct":-4,"why":"<max 18 words>"}
severity: 1 minor, 2 material, 3 severe. pct: your estimate of the change in this company's revenue over the next 12 months, in percent (negative for a hit, 0 if none). Judge from the evidence plus well-known facts about the company.${a.upstream ? `\nAlready assessed one hop closer to the shock:\n${a.upstream}` : ''}`;
  return [{ role: 'system', content: system }, { role: 'user', content: 'Assess now.' }];
}

// ---- helpers ----
export const shortName = n => n.replace(/\/[A-Z]{1,4}\/?/gi, ' ').replace(/[,.]/g, ' ').replace(/\b(CORP(ORATION)?|INC|LTD|LIMITED|PLC|CO|COMPANY|HOLDINGS?|GROUP|N\.?V|S\.?A|SE|AG|DE)\b/gi, ' ').replace(/\s+/g, ' ').trim().replace(/\s*&$/, '');
export const norm = n => shortName(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Readable names for the page: SEC's "AMAZON COM INC" becomes "Amazon", acronyms like AMD or AT&T stay.
export function pretty(n) {
  const s = shortName(n || '').replace(/ COM$/i, '').trim();
  if (s !== s.toUpperCase()) return s;
  return s.split(' ').map((w, i) => (/&/.test(w) || (w.length <= 3 && !/^(THE|AND|OF)$/.test(w))) ? w : (i && /^(OF|AND|THE)$/.test(w) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase())).join(' ');
}
const SECTION = { '1': 'Business', '1A': 'Risk Factors', '7': 'MD&A', '8': 'Financial statements and notes' };

function parseLines(state, text, onObj) {
  state.buf += text;
  let i;
  while ((i = state.buf.indexOf('\n')) >= 0) {
    const line = state.buf.slice(0, i).trim();
    state.buf = state.buf.slice(i + 1);
    tryParse(line, onObj);
  }
}
function tryParse(line, onObj) {
  line = line.replace(/^```(json)?/, '').replace(/```$/, '').replace(/,$/, '').trim();
  if (!line.startsWith('{')) return;
  try { const o = JSON.parse(line); if (o && o.k && o.name) onObj(o); } catch {}
}

// what an agent read, for the page's trajectory view
export const inputOf = (label, text) => ({ label, chars: String(text || '').length, preview: String(text || '').slice(0, 700) });

export async function runAgent({ agent, messages, emit, maxTokens, fix, finalize }) {
  const state = { buf: '' };
  const t0 = Date.now();
  let chars = 0, findings = 0, content = '', reasoning = '', firstAt = 0;
  const found = [];
  const onFinding = f => { if (fix && fix(f) === false) return; findings++; found.push(f); emit({ type: 'finding', agent: agent.id, chars, f }); };
  try {
    const res = await streamChat({
      messages, maxTokens, sessionId: 'pt-' + agent.id + '-' + Date.now(),
      onRetry: (attempt, status) => emit({ type: 'retry', agent: agent.id, attempt, status }),
      onFirst: () => { firstAt = Date.now(); emit({ type: 'first', agent: agent.id }); },
      onText: (txt, kind) => {
        chars += txt.length;
        if (kind === 'reasoning') { if (reasoning.length < 6000) reasoning += txt; return; }
        if (content.length < 12000) content += txt;
        parseLines(state, txt, onFinding);
      },
    });
    tryParse(state.buf.trim(), onFinding);
    if (finalize) {
      const f = finalize(res.content);
      if (f) { findings++; found.push(f); emit({ type: 'finding', agent: agent.id, chars, f }); }
    }
    const tokens = res.usage?.completion_tokens || Math.round(chars / 3.6);
    const ct = res.timeInfo?.completion_time;
    const tps = ct ? tokens / ct : (res.first ? tokens / ((res.end - res.first) / 1000) : 0);
    emit({
      type: 'done', agent: agent.id, chars, tokens, promptTokens: res.usage?.prompt_tokens, cached: res.usage?.prompt_tokens_details?.cached_tokens, tps: Math.round(tps), findings,
      raw: (res.content || content).slice(0, 12000), ...(reasoning ? { reasoning: reasoning.slice(0, 6000) } : {}),
      queuedMs: res.first ? res.first - t0 : null, genMs: res.first ? res.end - res.first : null,
    });
  } catch (e) {
    emit({
      type: 'done', agent: agent.id, chars, tokens: 0, findings, error: String(e.message || e).slice(0, 200),
      raw: content.slice(0, 12000), ...(reasoning ? { reasoning: reasoning.slice(0, 6000) } : {}),
      queuedMs: firstAt ? firstAt - t0 : null, genMs: firstAt ? Date.now() - firstAt : null,
    });
  }
  return found;
}

// A wave-2 excerpt: the start of the business section plus the paragraphs that mention the root or known companies.
function excerptFor(text, rootShort, known) {
  const items = splitItems(text);
  const biz = (items['1'] || text).slice(0, 2500);
  const terms = [rootShort, ...known].map(s => s.toLowerCase()).filter(s => s.length > 2);
  const paras = text.split('\n').filter(p => p.length > 80);
  const scored = [];
  for (const p of paras) {
    const lp = p.toLowerCase();
    let s = 0;
    for (const t of terms) if (lp.includes(t)) s += t === rootShort.toLowerCase() ? 5 : 1;
    if (s) scored.push([s, p]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  let out = biz + '\n\n';
  for (const [, p] of scored) { if (out.length > 7500) break; out += p.slice(0, 900) + '\n'; }
  return out;
}

export async function resolveQuery(q) {
  const raw = String(q || '').trim();
  if (!raw) return null;
  const m = /^\$?([A-Za-z.\-]{1,6})$/.exec(raw) || /\(([A-Z.\-]{1,6})\)/.exec(raw) || /^(?:map|analy[sz]e|look up)\s+\$?([A-Za-z.\-]{1,6})\b/i.exec(raw);
  if (m) { const t = await findTicker(m[1]); if (t) return t; }
  const words = raw.replace(/^(map|analy[sz]e|look up|research)\s+/i, '').trim();
  const s = await searchTickers(words, 1);
  return s[0] || null;
}

export function pausedError() { const e = new Error('this map is paused (the user hopped to another company); do not start more waves'); e.code = 'PAUSED'; return e; }
// names already resolved to a ticker in earlier maps carry over to the next hop
const TICKER_MEMO = new Map();
const fmtUsd = v => (Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`);

// 20-F and 40-F filers number their items differently (4 = business, 3 = key information and risks, 5 = operating review), and some
// (ASML) file a whole integrated annual report that splitItems cannot cut. Map them onto the 10-K items wave 1 reads.
export function itemsOf(text, form) {
  const items = splitItems(text);
  if (!/^(20|40)-F$/.test(form || '')) return items;
  if ((items['4'] || '').length > 20000) return { ...items, '1': items['4'], '1A': items['3'] || '', '7': items['5'] || '', '8': items['18'] && items['18'].length > 3000 ? items['18'] : (items['8'] || '') };
  const lines = text.split('\n');
  const at = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i].trim())) return i; return -1; };
  const part = (from, chars) => { let out = '', i = Math.max(0, from); for (; i < lines.length && out.length < chars; i++) out += lines[i] + '\n'; return out; };
  const biz = at(/^(our )?business model$|^business overview$|^information on the company$/i, 300);
  const risk = at(/^risk (factors|management)$/i, Math.max(0, biz));
  const fin = at(/^(operating and financial review|financial performance)\b/i, Math.max(0, biz));
  const notes = at(/^notes to the (consolidated )?financial statements/i, Math.max(0, fin));
  const n = lines.length;
  return { ...items, '1': part(biz > 0 ? biz - 20 : Math.floor(n * 0.08), 70000), '1A': part(risk > 0 ? risk : Math.floor(n * 0.2), 50000), '7': part(fin > 0 ? fin : Math.floor(n * 0.3), 60000), '8': part(notes > 0 ? notes : Math.floor(n * 0.6), 45000) };
}

// ---- session lifecycle ----
// The trail is the chain of maps the user hopped through (NVDA > TSMC > ASML). A map started any other way starts a new trail.
function trailItem(s) {
  const st = s.finished && !s.paused ? 'done' : s.paused ? 'paused' : 'running';
  const h = s.hop || {};
  return { id: s.id, ticker: s.meta?.ticker || s.hit?.ticker || null, name: s.private ? s.privateName : pretty(s.meta?.name || s.hit?.name || ''), private: Boolean(s.private), state: st, file: s.file || null, from: h.from || null, fromName: h.fromName || null, rel: h.rel || null, quote: h.quote || null };
}
export function trailBroadcast() {
  for (const it of trail.items) { const s = sessions.get(it.id); if (s) Object.assign(it, trailItem(s)); }
  broadcast({ type: 'trail', items: trail.items, active: trail.active });
}
export function trailAdd(s, hop) {
  const it = trailItem(s);
  if (!hop) trail.items = [it];
  else {
    const at = trail.items.findIndex(x => x.id === trail.active);
    trail.items = [...(at >= 0 ? trail.items.slice(0, at + 1) : trail.items), it].slice(-12);
  }
  trail.active = s.id;
  const keep = new Set(trail.items.map(x => x.id));
  for (const [id, x] of sessions) if (!keep.has(id) && x !== current && !x.prefetchFor) sessions.delete(id);
  trailBroadcast();
}

export async function beginSession({ q, source = 'page', scripted = false, awaitReply = false, hop = null, hit = undefined }) {
  // a chat-started session whose agent stopped before expanding would block the page forever
  if (isBusy() && current.source === 'chat' && Date.now() - current.t0 - (current.events.at(-1)?.t || 0) > 120e3) await finishSession();
  if (isBusy()) { const e = new Error('a session is already in progress'); e.code = 'BUSY'; throw e; }
  const s = newSession({ source, scripted, awaitReply });
  s.hit = hit !== undefined ? hit : await resolveQuery(q).catch(() => null);
  s.hop = hop;
  s.emit({ type: 'ask', q: String(q || ''), ticker: s.hit?.ticker ?? null, name: s.hit?.name ?? null, source, ...(hop ? { hop } : {}) });
  trailAdd(s, hop);
  return s;
}

// A tool called from the OpenClaw chat with no page session running starts its own session.
async function sessionFor(ticker) {
  // a chat session for another ticker is done as far as the user is concerned: close it and start fresh
  if (isBusy() && current.source === 'chat' && current.meta && current.meta.ticker !== ticker) await finishSession();
  if (isBusy()) return current;
  const s = await beginSession({ q: ticker, source: 'chat' });
  s.emit({ type: 'bot', phase: 'thinking', text: `OpenClaw agent is mapping ${s.hit?.ticker || ticker}` });
  return s;
}

// paused: the map's remaining waves did not run; the saved file carries what a resume needs
export async function finishSession({ reply, error, session, paused } = {}) {
  const s = session || current;
  if (!s || s.finished) return null;
  await Promise.allSettled([...s.pending, ...s.inflight]);
  if (s.finished) return null;
  if (reply) s.emit({ type: 'bot', phase: 'reply', text: reply });
  if (error) s.emit({ type: 'error', text: String(error).slice(0, 500) });
  const done = s.events.filter(e => e.type === 'done');
  const stats = {
    agents: done.length, findings: s.events.filter(e => e.type === 'finding').length,
    tokens: done.reduce((n, e) => n + (e.tokens || 0), 0), errors: done.filter(e => e.error).length,
  };
  const cfg = providerConfig();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ticker = s.private ? String(s.privateName).replace(/\W+/g, '-') : (s.meta?.ticker || s.hit?.ticker || 'SESSION');
  const file = s.file || `${ticker}-${cfg.name}-${stamp}.json`;
  const steps = { wave1: Boolean(s.candidates), expand: Boolean(s.expanded), news: Boolean(s.news), profiles: Boolean(s.profiles), resolve: Boolean(s.resolved) };
  if (paused) s.emit({ type: 'paused', steps });
  s.emit({ type: 'end', stats, file, ...(paused ? { paused: true } : {}) });
  s.finished = true;
  s.file = file;
  await mkdir(RUNS, { recursive: true });
  await writeFile(path.join(RUNS, file), JSON.stringify({ ticker, provider: cfg.label, model: cfg.model, events: s.events, hop: { id: s.id, from: s.hop || null, private: s.private ? s.privateName : null, paused: Boolean(paused), steps } }));
  trailBroadcast();
  if (!paused && !s.detached) hooks.finished?.(s);
  return { file, stats, seconds: (Date.now() - s.t0) / 1000 };
}

// ---- the three steps (the OpenClaw tools call these) ----
export async function scan({ ticker, session }) {
  const T = String(ticker || '').toUpperCase().replace(/^\$/, '');
  const s = session || await sessionFor(T);
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_scan', args: { ticker: T }, text: `Pulling ${T}'s latest annual report and financials from SEC EDGAR` });
  if (s.scanResult && s.meta?.ticker === T) return s.scanResult; // a hop adopted a prefetched map: its scan already ran
  s.emit({ type: 'status', text: `Indexing ${T} filings…` });
  const t = await findTicker(T);
  if (!t) throw new Error(`Unknown ticker ${T}`);
  const filing = await latest10K(t.cik);
  if (!filing) throw new Error(`No annual report found for ${T}`);
  const text = await get10KText(filing, t.cik);
  const items = itemsOf(text, filing.form);
  const chunks = makeChunks(items, { maxAgents: WAVE1_DEFAULT });
  const short = shortName(t.name).split(' ')[0].length > 2 ? shortName(t.name) : t.name;
  if (s.meta && s.meta.ticker !== t.ticker) { s.candidates = null; s.expanded = null; s.mentions = new Map(); s.prefetch = new Map(); }
  s.meta = { ...t, filing, items, chunks, short };
  s.emit({
    type: 'scan', ticker: t.ticker, name: t.name, short, cik: t.cik,
    filing: { form: filing.form, date: filing.date, url: filing.url },
    chunks: chunks.map((c, i) => ({ id: 'a' + i, label: c.label, section: c.section, chars: c.text.length })),
  });
  // price chart: optional, never blocks the scan
  const pp = priceSeries(t.ticker).then(points => { if (points) s.emit({ type: 'price', ticker: t.ticker, points }); });
  s.pending.add(pp);
  pp.finally(() => s.pending.delete(pp));
  let rows = [];
  try { rows = await financials(t.cik); } catch {}
  if (rows.length) s.emit({ type: 'financials', ticker: t.ticker, rows });
  const sections = {};
  for (const c of chunks) sections[SECTION[c.section] || c.section] = (sections[SECTION[c.section] || c.section] || 0) + 1;
  return (s.scanResult = { ticker: t.ticker, name: t.name, form: filing.form, date: filing.date, chunks: chunks.length, sections, financials: rows });
}

async function spawnWave1Impl({ ticker, focus, agents, session }) {
  let s = session || current;
  const T = String(ticker || s?.meta?.ticker || '').toUpperCase();
  if (!s || s.finished || !s.meta || s.meta.ticker !== T) { await scan({ ticker: T, session: s && !s.finished ? s : undefined }); s = session || current; }
  if (s.paused && !s.coreOnly) throw pausedError();
  if (s.candidates) return { reused: true, agents: s.wave1Agents, findings: s.wave1Findings, errors: s.wave1Errors, candidates: s.candidates, fill: s.fill, confirm: s.confirm };
  const meta = s.meta;
  const n = Math.max(4, Math.min(48, Number.isInteger(agents) ? agents : WAVE1_DEFAULT));
  const chunks = n === meta.chunks.length ? meta.chunks : makeChunks(meta.items, { maxAgents: n });
  const what = focus ? focus : 'suppliers, customers and competitors';
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_spawn', args: { ticker: T, ...(focus ? { focus } : {}), agents: chunks.length }, text: `Spawning ${chunks.length} agents to read the ${meta.filing.form} for ${what}` });
  const list = chunks.map((c, i) => ({ id: 'a' + i, label: c.label, section: c.section, input: inputOf(`${meta.ticker} ${meta.filing.form} · ${c.label}`, c.text) }));
  s.emit({ type: 'spawn', wave: 1, focus: focus || null, agents: list });

  // tally named companies as findings stream in; prefetch public ones' filings for wave 2
  const consider = async (name, tk, rel) => {
    const key = norm(name);
    if (!key || key === norm(meta.name) || key === norm(meta.short)) return;
    const m = s.mentions.get(key) || { name, ticker: null, count: 0, rels: new Set(), looked: false };
    s.mentions.set(key, m);
    m.count++;
    if (rel) m.rels.add(rel);
    if (!m.ticker && !m.looked) {
      m.looked = true;
      let t = TICKER_MEMO.get(key) || null;
      if (!t) t = tk ? await findTicker(String(tk)).catch(() => null) : null;
      // a model-supplied ticker must belong to a company with a similar name (no SKHY for SK hynix)
      if (t) { const tn = norm(t.name); if (!(tn.startsWith(key.slice(0, 4)) || key.startsWith(tn.slice(0, 4)))) t = null; }
      if (!t) { const r = await searchTickers(shortName(name), 1).catch(() => []); if (r[0] && norm(r[0].name).startsWith(key.slice(0, 6))) t = r[0]; }
      if (t) TICKER_MEMO.set(key, t);
      if (t && t.ticker !== meta.ticker) m.ticker = t;
    }
    if (m.ticker && !s.coreOnly && !s.prefetch.has(m.ticker.ticker) && s.prefetch.size < 30) prefetchFiling(s, m.ticker);
  };
  const track = p => { s.pending.add(p); p.finally(() => s.pending.delete(p)); };
  const emit = e => {
    s.emit(e);
    if (e.type !== 'finding') return;
    if (e.f.k === 'company') track(consider(e.f.name, e.f.ticker, e.f.rel));
    if (e.f.k === 'customer_hint') for (const g of e.f.guess || []) track(consider(g, null, 'customer'));
  };
  await Promise.all(chunks.map((c, i) => runAgent({ agent: list[i], messages: wave1Messages(meta, c, chunks.length, focus), emit, maxTokens: 3000 })));
  await Promise.allSettled([...s.pending]);
  // the core map: wave 1 read, financials and price in. Everything after this fills in behind it.
  emitCore(s);

  // fill-in wave: any group with fewer than 3 named companies -> one agent per missing group infers them
  const named = rel => new Set([...s.mentions.values()].filter(m => m.rels.has(rel)).map(m => m.ticker?.ticker || norm(m.name))).size;
  const groups = ['competitor', 'supplier', 'customer', 'partner'].filter(g => named(g) < 3);
  s.fill = { competitor: 0, supplier: 0, customer: 0, partner: 0 };
  s.confirm = { checked: 0, yes: 0, no: 0, unclear: 0, noFiling: 0 };
  const inferred = [];
  if (groups.length && !s.paused && !s.coreOnly) {
    const biz = (meta.items['1'] || meta.items['4'] || '').slice(0, 8000);
    const fAgents = groups.map((g, i) => ({ id: 'x' + i, label: FILL[g].label, input: inputOf(`${meta.ticker} ${meta.filing.form} Item 1 (business), first 8K chars`, biz) }));
    s.emit({ type: 'status', text: `The filing names few ${groups.map(g => FILL[g].plural).join(', ')}: inferring them…` });
    s.emit({ type: 'spawn', wave: 8, kind: 'fill', agents: fAgents });
    await Promise.all(groups.map((g, i) => {
      let n = 0;
      const fix = f => {
        if (f.k !== 'company' || n >= 8) return false;
        n++;
        s.fill[g]++;
        f.rel = g;
        f.inferred = true;
        f.q = String(f.q || '').split(/\s+/).slice(0, 18).join(' ');
        inferred.push({ name: f.name, rel: g });
        return true;
      };
      return runAgent({ agent: fAgents[i], emit, maxTokens: 800, fix, messages: fillMessages(meta, g, biz) });
    }));
    await Promise.allSettled([...s.pending]);

    // confirm wave: every inferred company with an SEC filing is checked against its own annual report
    const toCheck = [];
    for (const x of inferred) {
      const t = s.mentions.get(norm(x.name))?.ticker;
      if (!t || !t.cik) { s.confirm.noFiling++; continue; }
      if (toCheck.some(c => c.t.ticker === t.ticker && c.rel === x.rel)) continue;
      toCheck.push({ t, rel: x.rel });
    }
    const docs = await Promise.all(toCheck.map(c => (s.prefetch.get(c.t.ticker) || prefetchFiling(s, c.t)).catch(() => null)));
    const ready = toCheck.map((c, k) => ({ ...c, d: docs[k] })).filter(c => c.d);
    s.confirm.noFiling += toCheck.length - ready.length;
    if (ready.length) {
      const excerpts = ready.map(c => excerptFor(c.d.text, meta.short, []));
      const cAgents = ready.map((c, k) => ({
        id: 'c' + k, label: `${c.t.ticker} → ${c.rel}`, ticker: c.t.ticker, name: pretty(c.t.name), rel: c.rel,
        input: inputOf(`${c.t.ticker} ${c.d.form}, business section + paragraphs mentioning ${meta.short}`, excerpts[k]),
      }));
      s.emit({ type: 'spawn', wave: 9, kind: 'confirm', agents: cAgents.map(({ rel, ...a }) => a) });
      await Promise.all(cAgents.map((a, k) => {
        let one = false;
        const fix = f => {
          if (f.k !== 'confirm' || one) return false;
          one = true;
          Object.assign(f, { name: a.name, ticker: a.ticker, rel: a.rel });
          if (!['yes', 'no', 'unclear'].includes(f.supports)) f.supports = 'unclear';
          f.q = String(f.q || '').split(/\s+/).slice(0, 25).join(' ');
          f.why = String(f.why || '').split(/\s+/).slice(0, 16).join(' ');
          s.confirm.checked++;
          s.confirm[f.supports]++;
          return true;
        };
        return runAgent({ agent: a, emit: s.emit, maxTokens: 300, fix, messages: confirmMessages(meta.short, a, excerpts[k]) });
      }));
    }
  }

  // merge spellings that resolved to the same ticker ("AMD" and "Advanced Micro Devices")
  const merged = new Map();
  for (const m of s.mentions.values()) {
    const k = m.ticker ? 'T:' + m.ticker.ticker : 'N:' + norm(m.name);
    const g = merged.get(k);
    if (!g) { merged.set(k, { name: m.name, best: m.count, ticker: m.ticker?.ticker ?? null, count: m.count, rels: new Set(m.rels) }); continue; }
    g.count += m.count;
    for (const r of m.rels) g.rels.add(r);
    if (m.count > g.best) { g.best = m.count; g.name = m.name; }
  }
  const ranked = [...merged.values()].sort((a, b) => (b.count - a.count) || (b.ticker ? 1 : 0) - (a.ticker ? 1 : 0)).slice(0, 25);
  s.candidates = ranked.map(g => ({ name: pretty(g.name), ticker: g.ticker, count: g.count, rels: [...g.rels] }));
  s.emit({ type: 'candidates', list: s.candidates });
  track(emitPeers(s));
  const done = s.events.filter(e => e.type === 'done' && e.agent.startsWith('a'));
  s.wave1Agents = done.length;
  s.wave1Findings = done.reduce((n, e) => n + (e.findings || 0), 0);
  s.wave1Errors = done.filter(e => e.error).length;
  return { agents: s.wave1Agents, findings: s.wave1Findings, errors: s.wave1Errors, candidates: s.candidates, fill: s.fill, confirm: s.confirm };
}

export const spawnWave1 = wave(spawnWave1Impl);

// the page's second clock (click to core map); queue and generation come from the slowest wave-1 agent
export function emitCore(s) {
  if (s.coreAt) return;
  s.coreAt = Date.now();
  const done = s.events.filter(e => e.type === 'done' && /^a\d/.test(e.agent) && !e.error);
  const last = done.reduce((m, e) => (!m || e.t > m.t ? e : m), null);
  s.emit({ type: 'core', ticker: s.meta.ticker, ms: s.coreAt - s.t0, agents: done.length, findings: done.reduce((n, e) => n + (e.findings || 0), 0), queuedMs: last?.queuedMs ?? null, genMs: last?.genMs ?? null });
}

// RV: the root plus up to 8 public competitors named in wave 1, with latest-FY ratios (SEC companyfacts, cached).
async function emitPeers(s) {
  const meta = s.meta;
  const comp = new Map();
  for (const m of s.mentions.values()) {
    if (!m.ticker || !m.rels.has('competitor')) continue;
    const g = comp.get(m.ticker.ticker) || { t: m.ticker, name: m.name, count: 0 };
    g.count += m.count;
    comp.set(m.ticker.ticker, g);
  }
  const list = [{ t: meta, name: pretty(meta.name) }, ...[...comp.values()].sort((a, b) => b.count - a.count).slice(0, 8).map(g => ({ t: g.t, name: pretty(g.name) }))];
  const rows = (await Promise.all(list.map(async ({ t, name }) => {
    try {
      const r = ratiosFrom(await financials(t.cik));
      return r && r.revenue ? { ticker: t.ticker, name, ...r } : null;
    } catch { return null; }
  }))).filter(Boolean);
  if (rows.length) s.emit({ type: 'peers', rows });
}

export function prefetchFiling(s, t) {
  const p = (async () => {
    const info = await latest10K(t.cik);
    if (!info) return null;
    return { name: t.name, ticker: t.ticker, form: info.form, text: await get10KText(info, t.cik) };
  })().catch(() => null);
  s.prefetch.set(t.ticker, p);
  return p;
}

// A wave belongs to the session it was called on (not whatever is current by the time it finishes). It is tracked as
// in flight so a paused map is only saved once its running agents are done, and a paused map starts no new wave.
export function wave(fn) {
  return (opts = {}) => {
    const s = opts.session || current;
    if (s?.paused) return Promise.reject(pausedError());
    const p = fn({ ...opts, session: s });
    if (s) { s.inflight.add(p); const rm = () => s.inflight.delete(p); p.then(rm, rm); }
    return p;
  };
}

async function expandImpl({ tickers, session }) {
  const s = session;
  if (!s || s.finished || !s.candidates) throw new Error('Run terminal_spawn first (wave 1), then expand on the companies it found');
  if (s.expanded) return s.expanded;
  const meta = s.meta;
  const wanted = [...new Set((tickers || []).map(x => String(x).toUpperCase().replace(/^\$/, '').trim()).filter(Boolean))].filter(x => x !== meta.ticker).slice(0, WAVE2_MAX);
  const resolved = (await Promise.all(wanted.map(x => findTicker(x).catch(() => null)))).filter(Boolean);
  const nameFor = t => s.candidates.find(c => c.ticker === t.ticker)?.name || pretty(t.name);
  const names = resolved.map(nameFor);
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_expand', args: { tickers: resolved.map(t => t.ticker) }, text: `Sending ${resolved.length} agents into the filings of ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}` });
  s.emit({ type: 'status', text: `Reading ${resolved.length} connected companies' filings…` });
  const known = [...s.mentions.values()].sort((a, b) => b.count - a.count).slice(0, 30).map(m => shortName(m.name));
  const loaded = (await Promise.all(resolved.map(t => s.prefetch.get(t.ticker) || prefetchFiling(s, t)))).filter(Boolean);
  const excerpts2 = loaded.map(d => excerptFor(d.text, meta.short, known));
  const agents2 = loaded.map((d, i) => ({ id: 'b' + i, label: d.ticker + ' ' + d.form, ticker: d.ticker, name: d.name, short: nameFor(d), input: inputOf(`${d.ticker} ${d.form}, business section + paragraphs mentioning ${meta.short} and the network`, excerpts2[i]) }));
  s.emit({ type: 'spawn', wave: 2, agents: agents2 });
  const results = await Promise.all(agents2.map((a, i) => {
    let about = false;
    const fix = f => {
      if (f.k !== 'about') return true;
      if (about) return false;
      about = true;
      f.name = a.short;
      f.ticker = a.ticker;
      return true;
    };
    return runAgent({
      agent: a, emit: s.emit, maxTokens: 2000, fix,
      messages: wave2Messages(meta.short, { name: a.short, form: loaded[i].form, ticker: a.ticker }, excerpts2[i], known),
    });
  }));
  const rootKey = norm(meta.short);
  const knownKeys = new Set(known.map(norm));
  const links = [];
  results.forEach((found, i) => {
    for (const f of found) {
      if (f.k !== 'company') continue;
      const k = norm(f.name);
      if (k === rootKey || k.startsWith(rootKey) || knownKeys.has(k)) links.push(`${agents2[i].short} -> ${shortName(f.name)}: ${f.rel || 'other'}`);
    }
  });
  const done = s.events.filter(e => e.type === 'done' && e.agent.startsWith('b'));
  s.expanded = {
    agents: agents2.length, skipped: wanted.filter(x => !agents2.some(a => a.ticker === x)),
    findings: done.reduce((n, e) => n + (e.findings || 0), 0), errors: done.filter(e => e.error).length,
    crossLinks: [...new Set(links)].slice(0, 24),
    totalAgents: (s.wave1Agents || 0) + agents2.length, filings: 1 + agents2.length, crossLinkCount: new Set(links).size,
    newsTickers: [meta.ticker, ...agents2.map(a => a.ticker)].join(', '),
  };
  return s.expanded;
}

// CN: one agent per company's latest 8-K (6-K for foreign filers), all at once.
async function newsImpl({ tickers, session }) {
  const s = session;
  if (!s || s.finished || !s.meta) throw new Error('Map a company first (terminal_scan, terminal_spawn, terminal_expand)');
  if (s.news) return s.news;
  const meta = s.meta;
  const wanted = [...new Set([meta.ticker, ...(tickers || []).map(x => String(x).toUpperCase().replace(/^\$/, '').trim()).filter(Boolean)])].slice(0, NEWS_MAX);
  const resolved = (await Promise.all(wanted.map(x => findTicker(x).catch(() => null)))).filter(Boolean);
  const nameFor = t => (t.ticker === meta.ticker ? pretty(meta.name) : s.candidates?.find(c => c.ticker === t.ticker)?.name || pretty(t.name));
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_news', args: { tickers: resolved.map(t => t.ticker) }, text: `Spawning ${resolved.length} agents to read the latest 8-K filings across the network` });
  const filings = await Promise.all(resolved.map(async t => {
    try {
      const info = await latest8K(t.cik);
      if (!info) return null;
      return { t, info, text: await get8KText(info, t.cik) };
    } catch { return null; }
  }));
  const ok = filings.filter(Boolean);
  const agents = ok.map((x, i) => ({ id: 'n' + i, label: `${x.t.ticker} ${x.info.form}`, ticker: x.t.ticker, name: nameFor(x.t), date: x.info.date, url: x.info.url, form: x.info.form, input: inputOf(`${x.t.ticker} ${x.info.form} filed ${x.info.date}, from the first item`, x.text) }));
  s.emit({ type: 'spawn', wave: 3, kind: 'news', agents: agents.map(({ form, ...a }) => a) });
  const results = await Promise.all(agents.map((a, i) => {
    let one = false;
    const fix = f => {
      if (f.k !== 'news' || one) return false;
      one = true;
      Object.assign(f, { name: a.name, ticker: a.ticker, date: a.date, url: a.url });
      if (!['positive', 'negative', 'neutral'].includes(f.sentiment)) f.sentiment = 'neutral';
      return true;
    };
    return runAgent({ agent: a, emit: s.emit, maxTokens: 250, fix, messages: newsMessages(a, ok[i].text) });
  }));
  const items = results.map((found, i) => found[0] ? `${agents[i].ticker} ${agents[i].date}: ${found[0].headline} (${found[0].sentiment})` : null).filter(Boolean);
  s.news = { agents: agents.length, skipped: wanted.filter(x => !agents.some(a => a.ticker === x)), items };
  return s.news;
}

// ---- profiles: one agent per company on the map reads its annual report (same prompt as /api/profile) ----
async function loadFiling(s, t) {
  const p = s.prefetch.get(t.ticker) || prefetchFiling(s, t);
  const d = await p;
  if (!d) return null;
  const info = await latest10K(t.cik);
  return { ...d, info };
}

async function profilesImpl({ tickers, session } = {}) {
  const s = session;
  if (!s || s.finished || !s.meta || !s.candidates) throw new Error('Map a company first (terminal_scan, terminal_spawn)');
  if (s.profiles) return s.profiles;
  const meta = s.meta;
  // always cover the whole map: whatever the bot named first, then every first-degree company with an SEC ticker
  // (wave-1 mentions, most-mentioned first) and the companies the bot expanded into
  const asked = Array.isArray(tickers) ? tickers.map(x => String(x).toUpperCase().replace(/^\$/, '').trim()) : [];
  const byT = new Map();
  for (const m of s.mentions.values()) if (m.ticker) byT.set(m.ticker.ticker, (byT.get(m.ticker.ticker) || 0) + m.count);
  for (const e of s.events) if (e.type === 'spawn' && e.wave === 2) for (const a of e.agents) if (a.ticker && !byT.has(a.ticker)) byT.set(a.ticker, 0.5);
  let list = [...asked, ...[...byT.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)];
  list = [...new Set(list)].filter(x => x && x !== meta.ticker).slice(0, PROFILE_MAX);
  const resolved = (await Promise.all(list.map(x => findTicker(x).catch(() => null)))).filter(Boolean);
  const nameFor = t => s.candidates.find(c => c.ticker === t.ticker)?.name || pretty(t.name);
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_profiles', args: { tickers: resolved.map(t => t.ticker) }, text: `Spawning ${resolved.length} agents to profile every company on the map from its annual report` });
  // profiles read on an earlier map (or opened in a popup) carry over: no agent, the finding is replayed from the cache
  const known = await Promise.all(resolved.map(t => cachedProfile(t.ticker)?.catch(() => null)));
  const arr = v => (Array.isArray(v) ? v.slice(0, 6) : []);
  let reused = 0;
  resolved.forEach((t, i) => {
    const j = known[i];
    if (!j || j.error || (!j.summary && !j.products)) { known[i] = null; return; }
    s.emit({ type: 'finding', agent: 'pc' + i, chars: 0, f: { k: 'profile', name: nameFor(t), ticker: t.ticker, form: j.form, date: j.date, url: j.url, summary: String(j.summary || ''), segments: arr(j.segments), products: arr(j.products), customers: arr(j.customers), suppliers: arr(j.suppliers), competitors: arr(j.competitors), risks: arr(j.risks), facts: arr(j.facts), cached: true } });
    reused++;
  });
  const fresh = resolved.filter((t, i) => !known[i]);
  const loaded = await Promise.all(fresh.map(t => loadFiling(s, t).catch(() => null)));
  const ok = fresh.map((t, i) => ({ t, d: loaded[i] })).filter(x => x.d && x.d.info);
  const pex = ok.map(x => profileExcerpt(x.d.text));
  const agents = ok.map((x, i) => ({ id: 'p' + i, label: `${x.t.ticker} ${x.d.info.form}`, ticker: x.t.ticker, name: x.t.name, short: nameFor(x.t), input: inputOf(`${x.t.ticker} ${x.d.info.form} Item 1 + start of risk factors`, pex[i]) }));
  if (agents.length) s.emit({ type: 'spawn', wave: 5, kind: 'profile', agents });
  const cfg = providerConfig();
  const results = await Promise.all(agents.map((a, i) => {
    const { info, text } = ok[i].d;
    const started = Date.now();
    return runAgent({
      agent: a, emit: s.emit, maxTokens: 2500, fix: () => false,
      messages: [{ role: 'system', content: PROFILE_SYSTEM(a.name, info.form, info.date) }, { role: 'user', content: pex[i] }],
      finalize: content => {
        const j = parseProfile(content);
        const f = {
          k: 'profile', name: a.short, ticker: a.ticker, form: info.form, date: info.date, url: info.url,
          summary: String(j.summary || ''), segments: arr(j.segments), products: arr(j.products), customers: arr(j.customers),
          suppliers: arr(j.suppliers), competitors: arr(j.competitors), risks: arr(j.risks), facts: arr(j.facts),
        };
        setProfile(a.ticker, { ticker: a.ticker, name: a.name, form: info.form, date: info.date, url: info.url, provider: cfg.label, ms: Date.now() - started, ...j });
        return f;
      },
    });
  }));
  const done = results.filter(r => r.length).length;
  s.profiles = { agents: agents.length, profiled: done + reused, reused, skipped: list.filter(x => !agents.some(a => a.ticker === x)) };
  return s.profiles;
}

// ---- resolve: unmask anonymous parties ("Customer A", "two vendors") in three all-at-once steps ----
const ANON = /^(customer|vendor|supplier|partner|distributor|direct customer|indirect customer)\s+[A-Z0-9]\b/i;

function proposeMessages(rootShort, e) {
  const system = `You are an analyst agent unmasking an anonymous party in ${rootShort}'s SEC annual report.
Entity: "${e.entity}" (${e.rel} of ${rootShort}).${e.detail ? ` Detail: ${e.detail}.` : ''}
Quotes from the filing:
${e.quotes.map(q => `- "${q}"`).join('\n') || '- (none)'}
${e.guess.length ? `Earlier guesses: ${e.guess.join(', ')}.` : ''}
Propose up to 3 PUBLIC companies (US listing or ADR, with ticker) most likely to be this entity. One JSON object per line, nothing else:
{"k":"candidate","entity":"${e.entity}","name":"<company>","ticker":"<ticker>","why":"<max 14 words>"}`;
  return [{ role: 'system', content: system }, { role: 'user', content: 'Propose now.' }];
}

function validateMessages(rootShort, a, rel, excerpt) {
  const system = `You are an analyst agent checking a hypothesis against ${a.name}'s own annual report.
Hypothesis: ${a.name} (${a.ticker}) is "${a.entity}", an anonymous ${rel} of ${rootShort} in ${rootShort}'s filing.
Read the excerpt (its business section and paragraphs that mention ${rootShort}). Does it support the hypothesis?
Output exactly one JSON line, nothing else:
{"k":"evidence","entity":"${a.entity}","name":"${a.name}","ticker":"${a.ticker}","supports":"yes|no|unclear","q":"<verbatim quote from the excerpt, max 25 words, or empty>","why":"<max 16 words>"}`;
  return [{ role: 'system', content: system }, { role: 'user', content: excerpt }];
}

async function resolveImpl({ session } = {}) {
  const s = session;
  if (!s || s.finished || !s.meta) throw new Error('Map a company first');
  if (s.resolved) return s.resolved;
  const meta = s.meta;
  // a. the anonymous entities, from customer hints and anonymous-looking company names
  const ents = new Map();
  for (const e of s.events) {
    if (e.type !== 'finding' || !e.agent.startsWith('a')) continue;
    const f = e.f;
    // only real labelled unknowns ("Customer A", "Vendor B") or unnamed parties with a stated share; not categories like "AI model makers"
    const labelled = ANON.test(f.name) || /\b(customer|vendor|supplier|partner)\s+[A-Z0-9]\b/i.test(f.name) || /unnamed|undisclosed|two vendors/i.test(f.name);
    const anon = (f.k === 'customer_hint' && (labelled || /\d+(\.\d+)?\s*%/.test(f.detail || ''))) || (f.k === 'company' && labelled);
    if (!anon) continue;
    const key = norm(f.name);
    const x = ents.get(key) || { entity: f.name, rel: f.k === 'customer_hint' ? 'customer' : (f.rel || 'partner'), detail: f.detail || '', quotes: [], guess: [] };
    if (f.q && x.quotes.length < 3 && !x.quotes.includes(f.q)) x.quotes.push(f.q);
    for (const g of f.guess || []) if (!x.guess.includes(g)) x.guess.push(g);
    ents.set(key, x);
  }
  const entities = [...ents.values()].slice(0, RESOLVE_MAX);
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_resolve', args: {}, text: `Unmasking ${entities.length} anonymous parties in ${meta.short}'s filing` });
  if (!entities.length) { s.resolved = { entities: 0, lines: [] }; return s.resolved; }
  const rAgents = entities.map((e, i) => ({ id: 'r' + i, label: e.entity.split(/[,(]/)[0].slice(0, 40), entity: e.entity, input: inputOf(`Quotes on "${e.entity}" from ${meta.short}'s ${meta.filing.form}`, e.quotes.join('\n') || e.detail || e.entity) }));
  s.emit({ type: 'spawn', wave: 6, kind: 'resolve', agents: rAgents });
  const proposals = await Promise.all(entities.map((e, i) => {
    let n = 0;
    const fix = f => {
      if (f.k !== 'candidate' || n >= 3 || !f.ticker) return false;
      n++;
      f.entity = e.entity;
      f.ticker = String(f.ticker).toUpperCase().replace(/^\$/, '');
      return true;
    };
    return runAgent({ agent: rAgents[i], emit: s.emit, maxTokens: 400, fix, messages: proposeMessages(meta.short, e) });
  }));
  // b. validate every proposal that is a real SEC ticker, against that company's own filing
  const checks = [];
  for (const [i, props] of proposals.entries()) {
    for (const c of props) {
      const t = await findTicker(c.ticker).catch(() => null);
      if (!t || t.ticker === meta.ticker || checks.some(x => x.i === i && x.t.ticker === t.ticker)) continue;
      checks.push({ i, t, c });
    }
  }
  const filings = await Promise.all(checks.map(x => loadFiling(s, x.t).catch(() => null)));
  const vex = filings.map(d => (d ? excerptFor(d.text, meta.short, []) : '(filing not available)'));
  const vAgents = checks.map((x, k) => ({ id: 'v' + k, label: `${x.t.ticker} → ${rAgents[x.i].label}`, entity: entities[x.i].entity, ticker: x.t.ticker, name: pretty(x.t.name), input: inputOf(`${x.t.ticker} ${filings[k]?.form || '10-K'}, business section + paragraphs mentioning ${meta.short}`, vex[k]) }));
  s.emit({ type: 'spawn', wave: 7, kind: 'validate', agents: vAgents });
  const verdicts = await Promise.all(vAgents.map((a, k) => {
    let one = false;
    const fix = f => {
      if (f.k !== 'evidence' || one) return false;
      one = true;
      Object.assign(f, { entity: a.entity, name: a.name, ticker: a.ticker });
      if (!['yes', 'no', 'unclear'].includes(f.supports)) f.supports = 'unclear';
      f.q = String(f.q || '').split(/\s+/).slice(0, 25).join(' ');
      f.why = String(f.why || '').split(/\s+/).slice(0, 16).join(' ');
      return true;
    };
    return runAgent({ agent: a, emit: s.emit, maxTokens: 300, fix, messages: validateMessages(meta.short, a, entities[checks[k].i].rel, vex[k]) });
  }));
  // c. verdict per entity (code): yes > unclear, ties by proposal order
  const lines = [];
  entities.forEach((e, i) => {
    const mine = checks.map((x, k) => ({ x, v: verdicts[k][0] })).filter(o => o.x.i === i);
    const yes = mine.find(o => o.v?.supports === 'yes');
    const unclear = mine.find(o => o.v?.supports === 'unclear');
    let f;
    if (yes) f = { name: yes.x.t ? pretty(yes.x.t.name) : yes.x.c.name, ticker: yes.x.t.ticker, confidence: yes.v.q ? 'high' : 'medium', why: yes.v.why || yes.x.c.why };
    // nothing confirmed: the agents' first proposal wins (it is their best guess); "unclear" checks do not outrank it
    else if (proposals[i][0]) f = { name: proposals[i][0].name, ticker: proposals[i][0].ticker, confidence: 'low', why: `Best guess; no filing confirmed it. ${proposals[i][0].why || ''}`.trim() };
    else if (unclear) f = { name: pretty(unclear.x.t.name), ticker: unclear.x.t.ticker, confidence: 'low', why: unclear.v.why || unclear.x.c.why };
    else return;
    s.emit({ type: 'finding', agent: rAgents[i].id, f: { k: 'resolved', entity: e.entity, ...f } });
    lines.push(`${e.entity} -> ${f.name} (${f.ticker}), ${f.confidence}: ${f.why}`);
  });
  s.resolved = { entities: entities.length, proposals: proposals.reduce((n, p) => n + p.length, 0), validated: vAgents.length, lines };
  return s.resolved;
}
export const expand = wave(expandImpl), news = wave(newsImpl), profiles = wave(profilesImpl), resolve = wave(resolveImpl);

// The main agent's side of the trajectory: what each tool returned to it, and its own text between tools.
export function toolResult(tool, text) {
  const s = current;
  if (!s || s.finished) return;
  s.emit({ type: 'bot', phase: 'tool_result', tool, text: String(text || '').slice(0, 4000) });
  // a chat-started session has no CLI reply to wait for: it ends after its last step
  if ((tool === 'terminal_resolve' || tool === 'terminal_whatif') && !s.awaitReply && !s.scripted) finishSession().catch(() => {});
}
export function botNote(text) {
  const s = current;
  if (!s || s.finished || !String(text || '').trim()) return;
  s.emit({ type: 'bot', phase: 'note', text: String(text).slice(0, 2000) });
}

// Bring a finished map session back to life for a follow-up (what-if): same event list, same file.
export function reopen(s, { source, awaitReply }) {
  s.finished = false;
  s.source = source;
  s.awaitReply = awaitReply;
  s.whatif = null;
  s.stream = null;
}

// ECO what-if: one agent per company in the graph (root + every mentioned company, capped), all at once.
export async function whatif({ question }) {
  const s = current;
  if (!s || !s.meta || !s.candidates) throw new Error('map a company first');
  if (s.finished) reopen(s, { source: 'chat', awaitReply: false });
  if (s.whatif) return s.whatif;
  const meta = s.meta;
  const q = String(question || '').trim().slice(0, 300);
  if (!q) throw new Error('terminal_whatif needs a question');
  // the companies on the graph, merged by ticker, most-mentioned first
  const merged = new Map();
  for (const m of s.mentions.values()) {
    const k = m.ticker ? 'T:' + m.ticker.ticker : 'N:' + norm(m.name);
    const g = merged.get(k) || { name: m.name, ticker: m.ticker?.ticker ?? null, count: 0, rels: new Set(), keys: new Set() };
    g.count += m.count;
    for (const r of m.rels) g.rels.add(r);
    g.keys.add(norm(m.name));
    merged.set(k, g);
  }
  const others = [...merged.values()].filter(g => g.count >= 1).sort((a, b) => b.count - a.count).slice(0, WHATIF_MAX - 1);
  // evidence: quotes naming each company (wave 1: about it; wave 2: from its own filing)
  const agentTicker = new Map(s.events.filter(e => e.type === 'spawn' && e.wave === 2).flatMap(e => e.agents.map(a => [a.id, a.ticker])));
  const findings = s.events.filter(e => e.type === 'finding' && /^[abkm]/.test(e.agent));
  const evidenceFor = g => {
    const lines = [];
    for (const e of findings) {
      const f = e.f;
      const own = g.ticker && agentTicker.get(e.agent) === g.ticker;
      const named = f.k === 'company' && g.keys.has(norm(f.name));
      if (!own && !named) continue;
      if (own && f.k !== 'company' && f.k !== 'about') continue;
      const line = f.k === 'about' ? `about: ${f.desc}` : `${own ? `${f.name} is its ${f.rel}` : `${f.rel || 'related'} of ${meta.short}`}: "${(f.q || '').slice(0, 160)}"`;
      if (!lines.includes(line)) lines.push(line);
      if (lines.length >= 8) break;
    }
    return lines.join('\n');
  };
  const rootEvidence = findings.filter(e => ['risk', 'place', 'segment'].includes(e.f.k)).slice(0, 12).map(e => `${e.f.k}: ${e.f.name}${e.f.rel ? ` (${e.f.rel})` : ''}: "${(e.f.q || '').slice(0, 140)}"`).join('\n');
  const base = s.events.filter(e => e.type === 'spawn' && e.wave === 4).reduce((n, e) => n + e.agents.length, 0);
  const targets = [
    { name: meta.commodity ? meta.name : pretty(meta.name), ticker: meta.commodity ? null : meta.ticker, isRoot: true, commodity: Boolean(meta.commodity), context: rootEvidence },
    ...others.map(g => ({ name: pretty(g.name), ticker: g.ticker, rels: [...g.rels].join(', '), context: evidenceFor(g) })),
  ].map((a, i) => ({ ...a, id: 'w' + (base + i), commodityMap: Boolean(meta.commodity) }));
  // shock rings: ring 1 = companies the mapped company's own filing names (or the value chain), ring 2 = the rest;
  // ring 2 is assessed after ring 1 and sees ring 1's verdicts, so the shock spreads hop by hop
  const firstHop = new Set(findings.filter(e => /^[akm]/.test(e.agent) && e.f.k !== 'about').map(e => norm(e.f.name)));
  targets.forEach(a => { a.ring = a.isRoot ? 0 : (firstHop.has(norm(a.name)) ? 1 : 2); });
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_whatif', args: { question: q }, text: `Asking ${targets.length} agents how this hits every company on the map, ring by ring` });
  const assess = list => {
    if (!list.length) return Promise.resolve([]);
    s.emit({ type: 'spawn', wave: 4, kind: 'whatif', question: q, ring: list[0].ring, agents: list.map(a => ({ id: a.id, label: a.name, ticker: a.ticker, name: a.name, ring: a.ring, input: inputOf(`Evidence on ${a.name} from the map`, (a.context || '(no quotes; well-known facts)') + (a.upstream ? `\n\nRing ${a.ring - 1} verdicts:\n${a.upstream}` : '')) })) });
    return Promise.all(list.map(a => {
      let one = false;
      const fix = f => {
        if (f.k !== 'impact' || one) return false;
        one = true;
        f.name = a.name;
        f.ticker = a.ticker;
        f.ring = a.ring;
        if (!['negative', 'mixed', 'positive'].includes(f.impact)) f.impact = 'mixed';
        f.severity = Math.max(1, Math.min(3, Math.round(Number(f.severity) || 1)));
        const pct = Number(f.pct);
        f.pct = Number.isFinite(pct) ? Math.max(-60, Math.min(60, Math.round(pct * 10) / 10)) : null;
        f.why = String(f.why || '').split(/\s+/).slice(0, 18).join(' ');
        return true;
      };
      return runAgent({ agent: a, emit: s.emit, maxTokens: 260, fix, messages: whatifMessages(meta.short, a, q, a.context) });
    }));
  };
  const inner = targets.filter(a => a.ring < 2), outer = targets.filter(a => a.ring === 2);
  const r1 = await assess(inner);
  const upstream = r1.map(r => r[0]).filter(Boolean).filter(f => f.impact !== 'mixed' || f.severity > 1).sort((a, b) => b.severity - a.severity).slice(0, 10)
    .map(f => `- ${f.name}: ${f.impact}, severity ${f.severity}${f.pct != null ? `, revenue ${f.pct > 0 ? '+' : ''}${f.pct}%` : ''}: ${f.why}`).join('\n');
  outer.forEach(a => { a.upstream = upstream; });
  const r2 = await assess(outer);
  const results = [...r1, ...r2];
  const impacts = results.map(r => r[0]).filter(Boolean);
  const tally = { negative: 0, mixed: 0, positive: 0 };
  for (const f of impacts) tally[f.impact]++;
  const worst = impacts.filter(f => f.impact === 'negative').sort((a, b) => b.severity - a.severity).slice(0, 6).map(f => `${f.name} (severity ${f.severity}): ${f.why}`);
  const best = impacts.filter(f => f.impact === 'positive').sort((a, b) => b.severity - a.severity).slice(0, 3).map(f => `${f.name}: ${f.why}`);
  // ~$ impact per ring: each company's revenue estimate times its latest annual revenue (SEC companyfacts, cached)
  const revenue = new Map(await Promise.all(impacts.filter(f => f.ticker && f.pct).map(async f => {
    try { const t = await findTicker(f.ticker); const r = t ? ratiosFrom(await financials(t.cik)) : null; return [f.ticker, r?.revenue || null]; } catch { return [f.ticker, null]; }
  })));
  const companies = impacts.map(f => ({ name: f.name, ticker: f.ticker, ring: f.ring, impact: f.impact, severity: f.severity, pct: f.pct, usd: f.ticker && f.pct && revenue.get(f.ticker) ? Math.round(revenue.get(f.ticker) * f.pct / 100) : null }));
  const rings = [0, 1, 2].map(ring => {
    const list = companies.filter(c => c.ring === ring);
    return { ring, label: ['The company', 'Named in its filings', 'One hop further'][ring], companies: list.length, negative: list.filter(c => c.impact === 'negative').length, positive: list.filter(c => c.impact === 'positive').length, usd: list.reduce((n, c) => n + (c.usd || 0), 0), priced: list.filter(c => c.usd != null).length };
  }).filter(r => r.companies);
  s.emit({ type: 'rings', question: q, rings, companies });
  const ringLines = rings.map(r => `ring ${r.ring} (${r.label}): ${r.companies} companies, ${r.negative} hit, ${r.positive} gain, ~${fmtUsd(r.usd)} revenue at stake`);
  s.whatif = { question: q, agents: targets.length, assessed: impacts.length, tally, worst, best, rings: ringLines };
  return s.whatif;
}

// ---- drivers ----
// Standalone (server.mjs): the same steps, scripted. Bot events carry scripted: true.
// A paused session stops between steps (never inside one): the step it is in finishes, then it is saved.
export async function runSteps(s) {
  if (s.private) return hooks.runPrivate(s);
  const stop = async () => { if (!s.paused) return false; s.stopping = true; await finishSession({ session: s, paused: true }); return true; };
  const T = s.meta?.ticker || s.hit?.ticker;
  if (!s.meta) {
    if (!s.hit) throw new Error(`No US-listed company found for "${s.ask || ''}"`);
    s.emit({ type: 'bot', phase: 'thinking', text: s.hop ? `Hop to ${s.hit.ticker} (${pretty(s.hit.name)}) from ${s.hop.from}` : `Mapping ${s.hit.ticker} (${pretty(s.hit.name)})` });
    await scan({ ticker: T, session: s });
  }
  if (await stop()) return;
  if (s.job) await s.job.catch(() => {});
  if (!s.candidates) { await spawnWave1({ ticker: T, session: s }); if (await stop()) return; }
  const pick = s.candidates.filter(c => c.ticker).slice(0, 12).map(c => c.ticker);
  if (!s.expanded) { await expand({ tickers: pick, session: s }); if (await stop()) return; }
  if (!s.news) { await news({ tickers: pick, session: s }); if (await stop()) return; }
  if (!s.profiles) { await profiles({ session: s }); if (await stop()) return; }
  if (!s.resolved) { await resolve({ session: s }); if (await stop()) return; }
  const top = s.candidates.filter(c => c.ticker).slice(0, 4).map(c => c.name);
  const list = top.length > 1 ? top.slice(0, -1).join(', ') + ' and ' + top.at(-1) : (top[0] || 'no public companies');
  const w2 = s.expanded || { agents: 0, crossLinks: [] };
  await finishSession({ session: s, reply: `${pretty(s.meta.name)}'s most-cited connections are ${list}. ${(s.wave1Agents || 0) + w2.agents} agents read ${1 + w2.agents} filings and found ${w2.crossLinks.length} cross-links.` });
}

export async function scriptedAsk(q, { hop = null } = {}) {
  const s = await beginSession({ q, source: 'page', scripted: true, hop });
  s.ask = q;
  runSteps(s).catch(e => finishSession({ session: s, error: e.message || e }));
  return s;
}

// After a Gateway restart there is no session in memory: rebuild the latest saved map (enough for a what-if).
export async function restoreLatest() {
  const files = (await readdir(RUNS).catch(() => [])).filter(f => f.endsWith('.json') && !f.startsWith('dev-'));
  const dated = await Promise.all(files.map(async f => ({ f, m: (await stat(path.join(RUNS, f))).mtimeMs })));
  for (const { f } of dated.sort((a, b) => b.m - a.m)) {
    try {
      const j = JSON.parse(await readFile(path.join(RUNS, f), 'utf8'));
      const scanE = j.events.find(e => e.type === 'scan'), cand = j.events.find(e => e.type === 'candidates');
      if (!scanE || !cand) continue;
      const s = newSession({ source: 'page' });
      s.events = j.events;
      s.t0 = Date.now() - (j.events.at(-1)?.t || 0);
      s.finished = true;
      s.file = f;
      s.meta = { ticker: scanE.ticker, name: scanE.name, short: scanE.short, cik: scanE.cik, filing: scanE.filing };
      s.candidates = cand.list;
      for (const c of cand.list) s.mentions.set(norm(c.name), { name: c.name, ticker: c.ticker ? { ticker: c.ticker } : null, count: c.count, rels: new Set(c.rels || []) });
      return s;
    } catch {}
  }
  return null;
}

// A saved session back in memory (detached: nothing is sent to the page). meta is rebuilt from the cached filing in data/,
// so a resumed map can run its remaining waves; candidates, mentions and the wave tallies come from the saved events.
export async function loadSession(file) {
  if (!/^[\w.\-]+\.json$/.test(file)) throw new Error('bad file name');
  const j = JSON.parse(await readFile(path.join(RUNS, file), 'utf8'));
  const scanE = j.events.find(e => e.type === 'scan'), cand = j.events.find(e => e.type === 'candidates');
  if (!scanE) throw new Error('not a map session');
  const s = newSession({ source: 'page', scripted: true, detached: true });
  s.events = j.events;
  s.t0 = Date.now() - (j.events.at(-1)?.t || 0);
  s.finished = true;
  s.file = j.hop?.id ? file : null; // only our own hop files are rewritten; the sample runs never are
  s.paused = Boolean(j.hop?.paused);
  s.hop = j.hop?.from || j.events.find(e => e.type === 'ask')?.hop || null;
  s.hit = { ticker: scanE.ticker, name: scanE.name };
  if (j.hop?.private) { s.private = true; s.privateName = j.hop.private; }
  s.meta = { ticker: scanE.ticker, name: scanE.name, short: scanE.short, cik: scanE.cik, filing: scanE.filing, items: {}, chunks: [] };
  if (!s.private && scanE.cik) {
    try {
      const filing = await latest10K(scanE.cik);
      const text = filing && await get10KText(filing, scanE.cik);
      if (text) { const items = itemsOf(text, filing?.form); s.meta = { ...s.meta, filing, items, chunks: makeChunks(items, { maxAgents: WAVE1_DEFAULT }) }; }
    } catch {}
  }
  const found = e => j.events.some(x => x.type === 'spawn' && x.wave === e);
  if (cand) {
    s.candidates = cand.list;
    for (const c of cand.list) s.mentions.set(norm(c.name), { name: c.name, ticker: c.ticker ? { ticker: c.ticker } : null, count: c.count, rels: new Set(c.rels || []), looked: true });
  }
  const st = j.hop?.steps || {};
  if (!j.hop?.paused) { st.expand = found(2); st.news = found(3); st.profiles = found(5) || st.news; st.resolve = st.profiles && j.events.some(e => e.type === 'bot' && e.phase === 'reply'); }
  if (st.expand) s.expanded = { agents: j.events.filter(e => e.type === 'spawn' && e.wave === 2).reduce((n, e) => n + e.agents.length, 0), crossLinks: [], skipped: [] };
  if (st.news) s.news = { agents: 0, items: [], skipped: [] };
  if (st.profiles) s.profiles = { agents: 0, profiled: 0, skipped: [] };
  if (st.resolve) s.resolved = { entities: 0, lines: [] };
  const w1 = j.events.filter(e => e.type === 'done' && /^a\d/.test(e.agent));
  s.wave1Agents = w1.length; s.wave1Findings = w1.reduce((n, e) => n + (e.findings || 0), 0); s.wave1Errors = w1.filter(e => e.error).length;
  if (j.events.some(e => e.type === 'core')) s.coreAt = s.t0;
  return s;
}

export async function needMap() {
  if (!current && !(await restoreLatest())) { const e = new Error('map a company first'); e.code = 'NOMAP'; throw e; }
  if (!current.meta || !current.candidates) { const e = new Error('map a company first'); e.code = 'NOMAP'; throw e; }
  if (isBusy()) { const e = new Error('a session is already in progress'); e.code = 'BUSY'; throw e; }
  return current;
}

export async function scriptedWhatif(q) {
  const s = await needMap();
  reopen(s, { source: 'page', awaitReply: true });
  s.scripted = true;
  s.emit({ type: 'ask', q, mode: 'whatif', source: 'page' });
  s.emit({ type: 'bot', phase: 'thinking', text: q });
  (async () => {
    const w = await whatif({ question: q });
    const hit = w.worst.slice(0, 3).map(x => x.split(' (')[0]);
    await finishSession({ reply: `${w.tally.negative} of ${w.assessed} companies take a hit, worst ${hit.join(', ') || 'none'}. ${w.tally.positive} could gain.` });
  })().catch(e => finishSession({ error: e.message || e }));
  return s;
}

// Run one OpenClaw agent turn through the CLI against this Gateway; the reply (or an error) ends the session.
export function runAgentTurn(s, msg) {
  s.agentSessionId ||= `pt-${Date.now()}`;
  const args = ['agent', '--agent', 'main', '--session-id', s.agentSessionId, '--timeout', '900', '--json', '-m', msg];
  const child = spawnChild(OC, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  s.child = child; // a hop away from this map stops the agent's turn (the tool call in flight still finishes)
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const kill = setTimeout(() => child.kill('SIGTERM'), 20 * 60e3);
  child.on('close', async (code) => {
    clearTimeout(kill);
    let reply = null;
    try {
      const j = JSON.parse(out.slice(out.indexOf('{')));
      reply = j.result?.meta?.finalAssistantVisibleText || (j.result?.payloads || []).map(p => p.text).filter(Boolean).join('\n') || null;
    } catch {}
    s.child = null;
    if (s.paused) await finishSession({ session: s, paused: true });
    else if (reply) await finishSession({ session: s, reply });
    else await finishSession({ session: s, error: `OpenClaw agent turn ended without a reply (exit ${code}). ${err.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}` });
  });
}

// What-if from the page: continue the finished map session with a real agent turn in the same agent session.
export async function openclawWhatif(q) {
  const s = await needMap();
  reopen(s, { source: 'page', awaitReply: true });
  s.emit({ type: 'ask', q, mode: 'whatif', source: 'page' });
  s.emit({ type: 'bot', phase: 'thinking', text: q });
  runAgentTurn(s, `What-if on the ${pretty(s.meta.name)} map: ${q}`);
  return s;
}

// "Hop to TSM (Taiwan Semiconductor) from NVDA: its supplier." The agent runs the same tools as for a map (see the skill's Hops section).
export function hopMessage(s, hop, resume) {
  const link = hop.rel ? ` (${hop.fromName || hop.from}'s ${hop.rel})` : '';
  const name = s.private ? s.privateName : `${s.hit.ticker} (${pretty(s.hit.name)})`;
  if (resume) return `Resume the ${name} map: ${resume}. The earlier steps are done; call only the remaining tools in order.`;
  return `Hop to ${name} from ${hop.from}${link}. Same steps as mapping it.`;
}

// Plugin mode: a real OpenClaw agent turn drives the tools. The page's ask spawns the CLI against this Gateway.
export async function openclawAsk(q, { hop = null } = {}) {
  const s = await beginSession({ q, source: 'page', awaitReply: true, hop });
  if (!s.hit) { await finishSession({ session: s, error: `No US-listed company found for "${q}"` }); return s; }
  const msg = hop ? hopMessage(s, hop) : `Map ${s.hit.ticker} (${pretty(s.hit.name)})`;
  s.emit({ type: 'bot', phase: 'thinking', text: msg });
  runAgentTurn(s, msg);
  return s;
}

// CLI: node engine/run.mjs NVDA   (scripted session, prints the event stream)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tk = process.argv[2] || 'NVDA';
  subscribe(e => {
    if (e.type === 'finding' || e.type === 'first') return;
    const j = JSON.stringify(e);
    console.log((e.t / 1000).toFixed(1).padStart(6), j.length > 220 ? j.slice(0, 220) + '…' : j);
  });
  const s = await scriptedAsk(tk);
  await new Promise(r => { const iv = setInterval(() => { if (s.finished) { clearInterval(iv); r(); } }, 500); });
}

// ---- private companies: find what the session's filings say about a name ----
// Scans the mapped company's 10-K items and every filing loaded for this session; returns paragraphs that name it.
export async function mentionsOf(name, max = 14, session) {
  const s = session || current;
  if (!s || !s.meta || !name) return { root: null, hits: [] };
  const one = n => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const pat = new RegExp('\\b(?:' + [name, ...(s.privateTerms || [])].map(one).join('|') + ')\\b', 'i');
  const hits = [];
  const scan = (source, text) => {
    for (const p of String(text || '').split('\n')) if (p.length > 60 && pat.test(p)) { hits.push({ source, text: p.slice(0, 900) }); if (hits.length >= max * 3) return; }
  };
  for (const [id, body] of Object.entries(s.meta.items || {})) scan(s.meta.itemLabels?.[id] || `${s.meta.short || s.meta.name} ${s.meta.filing?.form || '10-K'} · Item ${id}`, body);
  const docs = await Promise.all([...s.prefetch.values()].map(p => p.catch(() => null)));
  for (const d of docs) if (d && d.text) scan(`${pretty(d.name || d.ticker)} ${d.form || '10-K'}`, d.text);
  // keep the longest distinct paragraphs, spread across sources
  const seen = new Set(), out = [];
  for (const h of hits.sort((a, b) => b.text.length - a.text.length)) { const k = h.text.slice(0, 80); if (seen.has(k)) continue; seen.add(k); out.push(h); if (out.length >= max) break; }
  return { root: s.meta.short || s.meta.name, hits: out };
}
