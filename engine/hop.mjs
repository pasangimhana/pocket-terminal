// Chain hopping: click a connected company on a map and its map opens next to the one you left.
//   hop         pause the map on screen (no new waves start), then map the target core-first
//   goTo        a crumb in the trail: the saved (or still-paused) session comes back on the page at once
//   resume      run a paused map's remaining waves on the restored session
//   prefetch    while a map is idle, run wave 1 for the single most likely next hop; hopping there replays its events
//   private     a company with no SEC filings (Carl Zeiss): a thin map from the annual reports that name it
// The pieces a hop reuses live in run.mjs (the waves, sessions and the trail); profiles are cached per ticker in profile.mjs
// and filings in data/. Scripted mode (server.mjs) runs the steps directly; plugin mode runs a Main Agent turn per hop.
import {
  currentSession, setCurrent, sessions, trail, hooks, newSession, sendAll, trailAdd, trailBroadcast, finishSession, runSteps, scan, spawnWave1,
  news, profiles, wave, emitCore, scriptedAsk, openclawAsk, runAgentTurn, hopMessage, loadSession, resolveQuery, runAgent, inputOf, pretty, norm, shortName, mentionsOf, beginSession,
} from './run.mjs';
import { findTicker } from './sec.mjs';
import { privateProfile } from './profile.mjs';

const fail = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
// a private company has no ticker: the page's centre card shows PRIVATE
const slugOf = () => 'PRIVATE';
// a short readable name for the trail's link text: "Asml" is a poor reading of ASML, and the full SEC names are long
const brief = (name, ticker) => { const p = pretty(name); return ticker && (p.length <= 5 || p.length > 20) ? ticker : p; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- pause and go back ----
// A paused map starts no new wave; the agents already running finish. It stops sending events to the page, and is
// saved by its own driver when the step it is in is done (the page's crumb shows "paused" until then).
export function pause(s) {
  if (!s || s.finished || s.paused) return;
  s.paused = true;
  s.detached = true;
  if (currentSession() === s) setCurrent(null);
  if (s.child) { try { s.child.kill('SIGTERM'); } catch {} }
  trailBroadcast();
}

async function waitFinished(s, ms = 90e3) {
  for (let t = 0; !s.finished && t < ms; t += 100) await sleep(100);
}

function activate(s) {
  const cur = currentSession();
  if (cur && cur !== s && !cur.finished) pause(cur);
  s.detached = false;
  setCurrent(s);
  trail.active = s.id;
}

export async function goTo(id) {
  const it = trail.items.find(x => x.id === id);
  if (!it) throw fail('NOTRAIL', 'that map is no longer in the trail');
  let s = sessions.get(id);
  if (!s) { if (!it.file) throw fail('NOTRAIL', 'that map was not saved'); s = await loadSession(it.file); it.id = s.id; }
  if (s.paused && !s.finished) {
    // still finishing the step it was in when it was paused: back in front means it carries on
    if (s.child || s.stopping) await waitFinished(s);
    else s.paused = false;
  }
  activate(s);
  trail.active = s.id;
  trailBroadcast();
  sendAll(s);
  schedulePrefetch(s);
  return s;
}

export async function resume(id, mode = 'scripted') {
  let s = id ? await goTo(id) : currentSession();
  if (!s || !s.finished || !s.paused) return s;
  s.paused = false;
  s.stopping = false;
  s.finished = false;
  s.awaitReply = mode === 'openclaw';
  s.emit({ type: 'resumed' });
  trailBroadcast();
  const left = ['expand', 'news', 'profiles', 'resolve'].filter(k => !s[k === 'expand' ? 'expanded' : k === 'resolve' ? 'resolved' : k]);
  if (mode === 'openclaw' && !s.private) { s.scripted = false; runAgentTurn(s, hopMessage(s, s.hop || { from: '' }, `still to run: ${(s.candidates ? left : ['spawn', ...left]).map(x => 'terminal_' + (x === 'expand' ? 'expand' : x)).join(', ')}`)); }
  else { s.scripted = true; runSteps(s).catch(e => finishSession({ session: s, error: e.message || e })); }
  return s;
}

// ---- hop ----
export async function hop({ q, from, fromName, rel, quote, private: priv, mode = 'scripted' }) {
  q = String(q || '').trim();
  if (!q) throw fail('BAD', 'q required');
  const cur = currentSession();
  from = String(from || cur?.meta?.ticker || '').toUpperCase();
  const info = from ? { from, fromName: cur?.meta?.ticker === from && cur.meta.name ? (cur.private ? cur.privateName : brief(cur.meta.name, from)) : (fromName || from), rel: rel || null, quote: quote ? String(quote).slice(0, 300) : null } : null;
  let hit = null;
  if (!priv) {
    hit = await resolveQuery(q).catch(() => null);
    if (!hit) throw fail('NOHIT', `No US-listed company found for "${q}"`);
    if (cur && cur.meta?.ticker === hit.ticker && !cur.paused) return { ok: true, same: true, ticker: hit.ticker };
    if (info) info.toName = brief(hit.name, hit.ticker);
  } else if (info) info.toName = q;
  if (cur && !cur.finished && !cur.paused) pause(cur);
  if (priv) return beginPrivate(q, info, mode);
  const pre = prefetched.get(hit.ticker);
  if (pre) return adopt(pre, info, mode);
  const s = await (mode === 'openclaw' ? openclawAsk(hit.ticker, { hop: info }) : scriptedAsk(hit.ticker, { hop: info }));
  return { ok: true, ticker: hit.ticker, name: hit.name, id: s.id };
}

function adopt(s, info, mode) {
  prefetched.delete(s.prefetchFor);
  delete s.prefetchFor;
  s.coreOnly = false;
  s.hop = info;
  s.source = 'page';
  if (s.events[0]?.type === 'ask') s.events[0].hop = { ...(info || {}), prefetched: true };
  s.detached = false;
  setCurrent(s);
  trailAdd(s, info);
  sendAll(s);
  if (mode === 'openclaw') { s.scripted = false; s.awaitReply = true; runAgentTurn(s, hopMessage(s, info || { from: '' })); }
  else { s.scripted = true; runSteps(s).catch(e => finishSession({ session: s, error: e.message || e })); }
  return { ok: true, ticker: s.hit.ticker, name: s.hit.name, id: s.id, prefetched: true };
}

// ---- prefetch: wave 1 of the most likely next hop, while the map on screen is idle ----
const prefetched = new Map(); // ticker -> detached session whose core wave ran (or is running)
let prefetchBusy = false;

function pickNext(s) {
  const skip = new Set([s.meta?.ticker, ...trail.items.map(x => x.ticker), ...prefetched.keys()]);
  if (s.lastOpened) return skip.has(s.lastOpened) ? null : s.lastOpened; // the tile the user opened is the guess; once it ran, nothing else does
  const named = (s.candidates || []).filter(c => c.ticker && !skip.has(c.ticker));
  return (named.find(c => (c.rels || []).includes('supplier')) || named[0])?.ticker || null;
}

// The biggest named supplier is only a guess: wait a few seconds so a popup the user opens (the better guess) can take its place.
let prefetchTimer = null;
export function schedulePrefetch(s, delay = 3500) {
  clearTimeout(prefetchTimer);
  if (process.env.PT_NO_PREFETCH || prefetchBusy || !s || s !== currentSession() || !s.finished || s.paused || s.private || !s.candidates) return;
  if (delay && !s.lastOpened) { prefetchTimer = setTimeout(() => schedulePrefetch(s, 0), delay); return; }
  const tk = pickNext(s);
  // one guess per map: the supplier guess runs once; a popup the user opens later (a new, better guess) gets its own run
  s.pfDone ||= new Set();
  if (!tk || s.pfDone.has(tk) || (!s.lastOpened && s.pfDone.size)) return;
  s.pfDone.add(tk);
  prefetchBusy = true;
  startPrefetch(tk, s).catch(() => {}).finally(() => { prefetchBusy = false; const c = currentSession(); if (c) setTimeout(() => schedulePrefetch(c), 50); });
}

async function startPrefetch(ticker, from) {
  const t = await findTicker(ticker);
  if (!t) return;
  while (prefetched.size >= 3) { const [k, old] = prefetched.entries().next().value; prefetched.delete(k); sessions.delete(old.id); }
  const s = newSession({ source: 'page', scripted: true, detached: true });
  s.prefetchFor = t.ticker; s.coreOnly = true; s.hit = t; s.ask = t.ticker;
  s.emit({ type: 'ask', q: t.ticker, ticker: t.ticker, name: t.name, source: 'page' });
  prefetched.set(t.ticker, s);
  s.job = (async () => { await scan({ ticker: t.ticker, session: s }); await spawnWave1({ ticker: t.ticker, session: s }); })();
  await s.job.catch(() => { prefetched.delete(t.ticker); sessions.delete(s.id); });
}

// the page opened a company popup: that is the likeliest next hop
export function hint(ticker) {
  const s = currentSession();
  ticker = String(ticker || '').toUpperCase();
  if (!s || !ticker || ticker === s.meta?.ticker) return;
  s.lastOpened = ticker;
  schedulePrefetch(s, 0);
}

export function state() {
  trailBroadcast();
  return { trail: trail.items, active: trail.active, prefetched: [...prefetched.entries()].map(([k, s]) => ({ ticker: k, ready: Boolean(s.candidates) })) };
}
hooks.finished = s => schedulePrefetch(s);

// ---- private companies ----
async function beginPrivate(name, info, mode) {
  const slug = slugOf();
  const s = await beginSession({ q: name, source: 'page', scripted: mode !== 'openclaw', awaitReply: mode === 'openclaw', hop: info, hit: { ticker: slug, name, private: true } });
  s.private = true; s.privateName = name;
  trailBroadcast();
  if (mode === 'openclaw') {
    const msg = `Hop to the private company "${name}"${info ? ` from ${info.from}${info.rel ? ` (${info.fromName || info.from}'s ${info.rel})` : ''}` : ''}. It has no SEC filings: call terminal_private with its name, then terminal_news and terminal_profiles with no tickers.`;
    s.emit({ type: 'bot', phase: 'thinking', text: msg });
    runAgentTurn(s, msg);
  } else runPrivate(s).catch(e => finishSession({ session: s, error: e.message || e }));
  return { ok: true, ticker: slug, name, id: s.id, private: true };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await Promise.resolve().then(() => fn(items[k], k)).catch(() => null); }
  }));
  return out;
}

function privateMessages(name, a) {
  const system = `You read paragraphs from ${a.name}'s ${a.form} (filed ${a.date}) that mention ${name}. ${name} has no SEC filings, so this is what other companies say about it.
Output 1 to 3 JSON lines, nothing else:
{"k":"company","name":${JSON.stringify(a.name)},"ticker":${JSON.stringify(a.ticker)},"rel":"customer|supplier|competitor|partner|investee|other","q":"<verbatim quote from the excerpt, max 25 words>"}
The first line is ${a.name} itself. rel is ${a.name}'s role toward ${name}: customer = ${a.name} buys from or depends on ${name}; supplier = ${a.name} sells to ${name}; competitor; partner = alliance, co-development or distribution; investee = one holds shares in the other; other = a passing mention.
Optionally add up to 2 more lines for OTHER companies the excerpt ties to ${name} (same format, rel toward ${name}, ticker only if you are sure, else null).`;
  return [{ role: 'system', content: system }, { role: 'user', content: a.text }];
}

// step 1 (the core map): full-text search for the filers that name it, one agent per filing
async function privateWave1Impl({ session: s }) {
  const name = s.privateName;
  // "Carl Zeiss SMT" is also written "Carl Zeiss": search the longer name and its first two words
  const w2 = name.split(/\s+/);
  if (!s.privateTerms && w2.length > 2) s.privateTerms = [w2.slice(0, 2).join(' ')];
  const terms = [...new Set([name, ...(s.privateTerms || [])])];
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_private', args: { name }, text: `${name} files nothing with the SEC: searching every annual report that names it` });
  s.emit({ type: 'status', text: `SEC full-text search: annual reports naming ${name}…` });
  const { fullTextSearch, mentionWindows } = await import('./sources/sec-extra.mjs');
  let filers = [];
  for (const t of terms) {
    const hits = await fullTextSearch(t, { forms: ['10-K', '20-F', '40-F'], max: 14 });
    if (Array.isArray(hits)) for (const h of hits) if (!filers.some(x => x.cik === h.cik)) filers.push(h);
  }
  filers = filers.slice(0, 12);
  const wins = await pool(filers, 4, h => mentionWindows(h.url, terms, { max: 3, width: 700 }));
  const ready = filers.map((h, i) => ({ h, text: (wins[i]?.windows || []).map(w => w.text).join('\n…\n') })).filter(x => x.text);
  const today = new Date().toISOString().slice(0, 10);
  const items = {}, itemLabels = {};
  ready.forEach((x, i) => { items['n' + i] = x.text; itemLabels['n' + i] = `${pretty(x.h.name)} ${x.h.form || '10-K'} filed ${x.h.date}`; });
  const slug = s.hit.ticker;
  s.meta = { ticker: slug, name, short: name, cik: null, private: true, filing: { form: 'SEC full-text search', date: today, url: '' }, items, itemLabels, chunks: [] };
  s.emit({
    type: 'scan', ticker: slug, name, short: name, private: true, cik: null, filing: s.meta.filing,
    chunks: ready.map((x, i) => ({ id: 'a' + i, label: pretty(x.h.name).slice(0, 34), section: 'search', chars: x.text.length })),
  });
  // the root's own profile (the existing private-company agent) runs beside wave 1
  const pp = privateProfile(name, n => mentionsOf(n, 14, s)).then(p => { s.emit({ type: 'profile', private: true, name, summary: p.summary || '', background: p.background || '', relationships: p.relationships || [], mentions: p.mentions, sources: p.sources, ms: p.ms }); }).catch(() => {});
  s.pending.add(pp); pp.finally(() => s.pending.delete(pp));
  const agents = ready.map((x, i) => ({
    id: 'a' + i, label: pretty(x.h.name).slice(0, 34), name: pretty(x.h.name), ticker: x.h.ticker || null, form: x.h.form || '10-K', date: x.h.date, text: x.text,
    input: inputOf(`${pretty(x.h.name)} ${x.h.form || '10-K'} filed ${x.h.date}, paragraphs naming ${name}`, x.text),
  }));
  s.emit({ type: 'spawn', wave: 1, focus: null, agents: agents.map(({ text, form, date, ...a }) => a) });
  const note = async f => {
    const key = norm(f.name);
    if (!key || key === norm(name)) return;
    const m = s.mentions.get(key) || { name: f.name, ticker: null, count: 0, rels: new Set(), looked: true };
    s.mentions.set(key, m);
    m.count++;
    if (f.rel) m.rels.add(f.rel);
    if (!m.ticker && f.ticker) { const t = await findTicker(String(f.ticker)).catch(() => null); if (t && (norm(t.name).startsWith(key.slice(0, 4)) || key.startsWith(norm(t.name).slice(0, 4)))) m.ticker = t; }
  };
  const emit = e => { s.emit(e); if (e.type === 'finding' && e.f.k === 'company') { const p = note(e.f); s.pending.add(p); p.finally(() => s.pending.delete(p)); } };
  await Promise.all(agents.map(a => {
    let n = 0;
    const fix = f => {
      if (f.k !== 'company' || n >= 3) return false;
      if (n++ === 0) { f.name = a.name; f.ticker = a.ticker; }
      if (!['customer', 'supplier', 'competitor', 'partner', 'investee', 'other'].includes(f.rel)) f.rel = 'other';
      f.q = String(f.q || '').split(/\s+/).slice(0, 25).join(' ');
      return true;
    };
    return runAgent({ agent: a, emit, maxTokens: 500, fix, messages: privateMessages(name, a) });
  }));
  await Promise.allSettled([...s.pending]);
  emitCore(s);
  const merged = new Map();
  for (const m of s.mentions.values()) {
    const k = m.ticker ? 'T:' + m.ticker.ticker : 'N:' + norm(m.name);
    const g = merged.get(k) || { name: m.name, ticker: m.ticker?.ticker ?? null, count: 0, rels: new Set() };
    g.count += m.count;
    for (const r of m.rels) g.rels.add(r);
    merged.set(k, g);
  }
  s.candidates = [...merged.values()].sort((a, b) => b.count - a.count).slice(0, 25).map(g => ({ name: pretty(g.name), ticker: g.ticker, count: g.count, rels: [...g.rels] }));
  s.emit({ type: 'candidates', list: s.candidates });
  const done = s.events.filter(e => e.type === 'done' && /^a\d/.test(e.agent));
  s.wave1Agents = done.length; s.wave1Findings = done.reduce((n, e) => n + (e.findings || 0), 0); s.wave1Errors = done.filter(e => e.error).length;
  return { filings: filers.length, agents: done.length, findings: s.wave1Findings, candidates: s.candidates };
}
export const privateWave1 = wave(privateWave1Impl);

export async function runPrivate(s) {
  const stop = async () => { if (!s.paused) return false; s.stopping = true; await finishSession({ session: s, paused: true }); return true; };
  if (!s.meta || !s.candidates) { await privateWave1({ session: s }); if (await stop()) return; }
  const pick = s.candidates.filter(c => c.ticker).slice(0, 12).map(c => c.ticker);
  if (!s.news) { await news({ tickers: pick, session: s }); if (await stop()) return; }
  if (!s.profiles) { await profiles({ session: s }); if (await stop()) return; }
  const top = s.candidates.slice(0, 4).map(c => c.name);
  const list = top.length > 1 ? top.slice(0, -1).join(', ') + ' and ' + top.at(-1) : (top[0] || 'no company');
  await finishSession({ session: s, reply: `${s.privateName} files nothing with the SEC. ${list} name${top.length > 1 ? '' : 's'} it in their annual reports: ${s.wave1Agents || 0} agents read ${s.wave1Agents || 0} filings.` });
}
hooks.runPrivate = runPrivate;

// OpenClaw tool: the first step of a private hop (the agent then calls terminal_news and terminal_profiles)
export async function privateStep({ name, terms }) {
  const s = currentSession();
  if (!s || !s.private) throw new Error('terminal_private is for a hop to a private company');
  if (terms) s.privateTerms = String(terms).split(',').map(x => x.trim()).filter(Boolean);
  if (s.candidates) return { reused: true, candidates: s.candidates };
  return privateWave1({ session: s });
}
