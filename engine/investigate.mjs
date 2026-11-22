// Investigate one company on a map (wave 17) and per-company news tagged good / bad.
//   investigate({name, ticker})  gathers keyless sources (the root's own filings, SEC full-text search, the company's own
//                                annual report, Wikipedia, Google News headlines), one agent per source bundle, then one
//                                synthesis agent that emits {"k":"enrich"} and optional {"k":"lead"} lines.
//   investigateAsk(name, ticker, mode)  page driver: scripted, or a Main Agent turn in openclaw mode
//   companyNews({name, ticker, root})   headlines + red-flag headlines + Yahoo + recent 8-Ks, tagged by ONE scoring call
// News items carry only title, link, source, date, tag, kind and reason; never article text. Cached for 1 hour in data/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentSession, runAgent, inputOf, pretty, shortName, norm, finishSession, reopen, needMap, runAgentTurn, mentionsOf,
} from './run.mjs';
import { findTicker, cached, secGet } from './sec.mjs';
import { streamChat } from './llm.mjs';

const DATA = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const src = name => import(`./sources/${name}.mjs`);
const words = (t, n) => String(t ?? '').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const list = (a, n, w) => (Array.isArray(a) ? a : []).map(x => (x && typeof x === 'object' ? x.name || '' : x)).map(x => words(x, w)).filter(Boolean).slice(0, n);
const nul = v => { const t = String(v ?? '').trim(); return !t || /^(null|none|n\/a|unknown|undefined)$/i.test(t) ? null : t; };
const tidy = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, fallback = null) => Promise.race([Promise.resolve(p).catch(() => fallback), sleep(ms).then(() => fallback)]);
const feeds = async () => (await import('./wire.mjs')).feedTools;
const TK = /^[A-Z][A-Z0-9.\-]{0,5}$/;

const UNNAMED = /^(the\s+)?((direct|indirect|end|largest|major|top|single|one)\s+)?(customers?|clients?|vendors?|suppliers?|partners?|distributors?|licensees?|channel partners?|resellers?)\b(?!\s+(inc|corp|ltd|llc|co)\b)|\b(suppliers|customers|providers|manufacturers|partners|distributors|resellers|vendors|startups|integrators|hyperscalers|oems?|odms?|csps?)\b|unnamed|undisclosed/i;
export const isUnnamed = name => UNNAMED.test(String(name || '').trim());

let seq = 0;

// ---------------------------------------------------------------- source gathering
// Each gatherer returns a bundle { key, label, text, url, refs? } or null. refs[i] is the source of excerpt [i+1].
async function gMentions(s, name) {
  const { hits } = await mentionsOf(name, 8, s);
  const given = (s.invCtx?.get(norm(name)) || []).map(q => ({ source: `${s.meta.short || s.meta.ticker} map quote`, text: q }));
  const all = [...given, ...hits.filter(h => !given.some(g => g.text.slice(0, 60) === h.text.slice(0, 60)))].slice(0, 10);
  if (!all.length) return null;
  const root = s.meta.short || pretty(s.meta.name);
  const refs = all.map(h => ({ label: h.source, url: s.meta.filing?.url || null }));
  return { key: 'mentions', label: `${shortName(root) || root}'s own filings`, refs, text: all.map((h, i) => `[${i + 1}] (${h.source}) ${h.text}`).join('\n\n').slice(0, 7000), url: null };
}

async function gFiled(s, name, ownCik) {
  const { fullTextSearch, mentionWindows } = await src('sec-extra');
  const phrase = tidy(name).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const ymd = d => d.toISOString().slice(0, 10);
  const back = m => { const d = new Date(); d.setMonth(d.getMonth() - m); return ymd(d); };
  const skip = new Set([Number(s.meta.cik), Number(ownCik)].filter(Boolean));
  const ok = r => (Array.isArray(r) ? r : []).filter(h => h && h.url && !skip.has(Number(h.cik)));
  const annual = ok(await fullTextSearch(phrase, { forms: ['10-K', '20-F', '40-F'], max: 12 })).slice(0, 4);
  const eightK = ok(await fullTextSearch(phrase, { forms: ['8-K'], start: back(6), max: 8 })).filter(h => !annual.some(a => Number(a.cik) === Number(h.cik))).slice(0, 3);
  const mk = async (rows, key, label) => {
    const out = [];
    for (const h of rows) {
      const w = await mentionWindows(h.url, [phrase], { max: 2, width: 600 });
      const wins = (w.windows || []).map(x => x.text);
      if (wins.length) out.push({ h, text: wins.join('\n…\n') });
    }
    if (!out.length) return null;
    return {
      key, label, url: out[0].h.url, refs: out.map(o => ({ label: `${pretty(o.h.name)} ${o.h.form} ${o.h.date}`, url: o.h.url })),
      text: out.map((o, i) => `[${i + 1}] ${pretty(o.h.name)} ${o.h.form} filed ${o.h.date}\n${o.text}`).join('\n\n').slice(0, 7000),
    };
  };
  const a = await mk(annual, 'annuals', 'Annual reports that name it');
  const b = await mk(eightK, 'eightks', 'Recent 8-Ks that name it');
  return [a, b].filter(Boolean);
}

async function gOwn(s, name, ticker) {
  if (ticker) {
    const p = await withTimeout(import('./profile.mjs').then(m => m.profile(ticker)), 60000);
    if (!p || p.error) return null;
    const parts = [p.summary, p.products?.length ? 'Products: ' + p.products.join('; ') : '', p.customers?.length ? 'Customers: ' + p.customers.map(x => `${x.name} ("${x.q || ''}")`).join('; ') : '',
      p.suppliers?.length ? 'Suppliers: ' + p.suppliers.map(x => `${x.name} ("${x.q || ''}")`).join('; ') : '', p.competitors?.length ? 'Competitors: ' + p.competitors.join('; ') : '',
      p.risks?.length ? 'Risks: ' + p.risks.join('; ') : '', p.facts?.length ? 'Facts: ' + p.facts.map(f => `${f.name}: ${f.value}`).join('; ') : ''].filter(Boolean);
    return { key: 'own', label: `${ticker} ${p.form || 'annual report'}`, url: p.url || null, text: parts.join('\n').slice(0, 6000) };
  }
  const p = await withTimeout(import('./profile.mjs').then(m => m.privateProfile(name, n => mentionsOf(n, 14, s))), 60000);
  if (!p || p.error) return null;
  const parts = [p.summary, ...(p.relationships || []).map(r => `${r.with} (${r.rel}): "${r.q}"`), ...(p.facts || []).map(f => `${f.name}: ${f.value}`), p.background ? 'General knowledge: ' + p.background : ''].filter(Boolean);
  return parts.length ? { key: 'own', label: 'Filings that name it', url: null, text: parts.join('\n').slice(0, 5000) } : null;
}

async function gWiki(name) {
  const H = { 'User-Agent': 'pocket-terminal-demo (research)', Accept: 'application/json' };
  const j = async u => { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  const q = tidy(name);
  const o = await j(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=4&namespace=0&format=json`);
  const titles = o[1] || [];
  if (!titles.length) return null;
  const k = norm(q);
  const title = titles.find(t => norm(t) === k) || titles.find(t => norm(t.replace(/\s*\(.*\)$/, '')) === k) || titles.find(t => /\(company\)/.test(t) && norm(t).startsWith(k)) || titles.find(t => norm(t).startsWith(k)) || titles[0];
  const p = await j('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
  if (p.type === 'disambiguation' || !p.extract) return null;
  return { key: 'wiki', label: 'Wikipedia', url: p.content_urls?.desktop?.page || null, text: `${p.title}${p.description ? ' (' + p.description + ')' : ''}\n${p.extract}`.slice(0, 3500) };
}

async function gHeadlines(name) {
  const F = await feeds();
  const items = F.parseRss(await F.webFetch(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${tidy(name)}" when:90d`)}&hl=en-US&gl=US&ceid=US:en`), 'Google News', 'GN');
  if (!items.length) return null;
  const rows = items.sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 14);
  return {
    key: 'news', label: 'Recent headlines', url: `https://news.google.com/search?q=${encodeURIComponent('"' + tidy(name) + '"')}`,
    refs: rows.map(r => ({ label: `${r.by}: ${clip(r.title, 70)}`, url: r.url })),
    text: rows.map((r, i) => `[${i + 1}] ${r.published ? new Date(r.published).toISOString().slice(0, 10) : ''} ${r.by}: ${r.title}`).join('\n'),
  };
}

// ---------------------------------------------------------------- prompts
function sourceMessages(rootShort, rootTicker, name, ticker, b) {
  const system = `You read one source about "${name}"${ticker ? ` (${ticker})` : ''} for a terminal that maps ${rootShort} (${rootTicker}). Source: ${b.label}.
Output 1 to 4 JSON lines and nothing else:
{"k":"source","name":${JSON.stringify(name)},"ref":1,"says":"<what the source says about ${name}, max 25 words>","q":"<verbatim quote from the source, max 25 words>"}
ref is the number in brackets of the excerpt you used (use 1 when there is only one).
Cover, when stated: what ${name} is, its tie to ${rootShort}, owner or parent, headquarters, size, products, customers, suppliers, rivals, problems.
If the source is about a different entity or says nothing relevant, output one line with an empty "says".`;
  return [{ role: 'system', content: system }, { role: 'user', content: b.text }];
}

function synthMessages(rootShort, rootTicker, name, ticker, unnamed, found, bundles) {
  const system = `You are the synthesis agent of an investigation of "${name}"${ticker ? ` (${ticker})` : ''} for a terminal that maps ${rootShort} (${rootTicker}). Source agents report below, with trimmed source text.
Output ONE JSON line and nothing else:
{"k":"enrich","name":${JSON.stringify(name)},"ticker":${JSON.stringify(ticker || null)},"what":"<max 16 words: what it is>","relationship":{"rel":"customer|supplier|competitor|partner|investor|subsidiary|parent|other","toRoot":"<max 18 words: how it connects to ${rootShort}>","evidence":"<verbatim quote from the sources, or empty>","confidence":"high|medium|low"},"hq":"<city, country or null>","ownership":"public|private|subsidiary of <X>|government|null","parent":"<parent company or null>","employees":"<e.g. ~25K or null>","revenue":"<e.g. ~$8.1B or null>","products":["<max 6>"],"customers":["<max 6 names>"],"suppliers":["<max 6 names>"],"competitors":["<max 6 names>"],"risks":["<max 5, each max 8 words>"],"facts":[{"name":"Founded","value":"1846"}],"identity":[{"name":"<company>","ticker":"<ticker or null>","confidence":"high|medium|low","why":"<max 14 words>"}]}
Then 0 to 4 lines for OTHER companies that connect to ${rootShort} itself (its customers, suppliers, competitors or partners, e.g. a parent or unit of ${name} that ${rootShort}'s filings name) and are worth adding to its map, but ONLY companies that the sources actually name (no guesses from general knowledge). Never add ${name}'s own rivals, and never ${rootShort}:
{"k":"lead","name":"<company>","ticker":"<ticker or null>","rel":"customer|supplier|competitor|partner","why":"<max 14 words>"}
Rules: only what the sources state; use null for unknown fields and [] for empty lists; write "~" instead of "approximately". ticker only for a US listing or ADR you are sure of: if ${name} is public, or a subsidiary of a public company, give that ticker (put the parent's ticker in "ticker" only when ${name} itself has none and say so in "parent"). ${unnamed ? `${name} is an unnamed party or a category: fill "identity" with your best 1 to 3 candidates (with tickers) and a confidence each, from the evidence.` : 'identity must be [].'} Be honest: if the sources say little, say "low" confidence.`;
  const rep = found.length ? found.map(f => `- [${f.label}] ${f.says}${f.q ? ` — "${f.q}"` : ''}`).join('\n') : '(the source agents found nothing)';
  const raw = bundles.map(b => `### ${b.label}\n${b.text.slice(0, 1800)}`).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `SOURCE AGENT FINDINGS:\n${rep}\n\nSOURCE TEXT (trimmed):\n${raw}` }];
}

// ---------------------------------------------------------------- the investigation (wave 17)
export async function investigate({ name, ticker } = {}) {
  name = tidy(name);
  if (!name) throw new Error('name required');
  ticker = TK.test(String(ticker || '').toUpperCase().replace(/^\$/, '')) ? String(ticker).toUpperCase().replace(/^\$/, '') : null;
  const s = currentSession();
  if (!s || !s.meta || !s.candidates) throw new Error('map a company first');
  if (s.finished) reopen(s, { source: 'chat', awaitReply: false });
  const t0 = Date.now();
  const id = 'iv' + (++seq) + '-';
  const rootShort = s.meta.short || shortName(pretty(s.meta.name)) || s.meta.ticker;
  const rootTicker = s.meta.ticker;
  const unnamed = isUnnamed(name);
  s.emit({ type: 'bot', phase: 'tool', tool: 'terminal_investigate', args: { name, ticker }, text: `Investigating ${name}${ticker ? ' (' + ticker + ')' : ''} in the ${rootShort} map` });
  s.emit({ type: 'status', text: `Gathering sources on ${name}…` });
  const own = ticker ? await findTicker(ticker).catch(() => null) : null;

  // gather every source at once; a slow or failing one just drops out
  const jobs = [withTimeout(gMentions(s, name), 15000)];
  if (!unnamed) jobs.push(withTimeout(gFiled(s, name, own?.cik), 60000), withTimeout(gOwn(s, name, ticker), 70000), withTimeout(gWiki(name), 20000), withTimeout(gHeadlines(name), 20000));
  const bundles = (await Promise.all(jobs)).flat().filter(b => b && b.text && b.text.trim().length > 20);
  s.emit({ type: 'status', text: `${bundles.length} sources on ${name}: one agent each, then one to synthesise` });

  const agents = bundles.map((b, i) => ({ id: id + 's' + i, label: b.label.slice(0, 34), name, ticker, bundle: b, input: inputOf(`${b.label} · about ${name}`, b.text) }));
  const found = [];
  if (agents.length) {
    s.emit({ type: 'spawn', wave: 17, kind: 'investigate', target: name, agents: agents.map(({ bundle, ...a }) => a) });
    await Promise.all(agents.map(a => runAgent({
      agent: a, emit: s.emit, maxTokens: 500, messages: sourceMessages(rootShort, rootTicker, name, ticker, a.bundle),
      fix: f => {
        if (f.k !== 'source') return false;
        f.says = words(f.says, 25); f.q = words(f.q, 25);
        if (!f.says) return false;
        const ref = a.bundle.refs?.[Math.max(0, Math.min((a.bundle.refs.length || 1) - 1, Math.round(Number(f.ref) || 1) - 1))];
        f.name = name; f.target = name; f.targetTicker = ticker;
        f.label = ref?.label ? `${a.bundle.label}: ${ref.label}`.slice(0, 120) : a.bundle.label;
        f.url = ref?.url || a.bundle.url || null;
        found.push(f);
        return true;
      },
    }).then(r => r)));
  }

  // synthesis
  const sid = id + 'y';
  const synth = { id: sid, label: 'Synthesis', name, ticker, input: inputOf(`${found.length} source findings on ${name}`, found.map(f => f.says).join('\n')) };
  s.emit({ type: 'spawn', wave: 17, kind: 'investigate', target: name, agents: [synth] });
  let enrich = null, leads = 0;
  await runAgent({
    agent: synth, emit: s.emit, maxTokens: 1800, messages: synthMessages(rootShort, rootTicker, name, ticker, unnamed, found, bundles),
    fix: f => {
      if (f.k === 'lead') {
        const ln = tidy(f.name); const lk = norm(ln);
        if (!ln || lk === norm(name) || lk === norm(rootShort) || leads >= 4) return false;
        leads++;
        f.name = ln; f.ticker = TK.test(String(f.ticker || '').toUpperCase()) ? String(f.ticker).toUpperCase() : null;
        f.rel = ['customer', 'supplier', 'competitor', 'partner'].includes(f.rel) ? f.rel : 'partner';
        f.why = words(f.why, 14); f.from = name; f.target = name;
        return true;
      }
      if (f.k !== 'enrich' || enrich) return false;
      const rel = f.relationship && typeof f.relationship === 'object' ? f.relationship : {};
      const tk = String(f.ticker || '').toUpperCase().replace(/^\$/, '');
      Object.assign(f, {
        name, target: name, targetTicker: ticker, ticker: TK.test(tk) ? tk : ticker,
        what: words(f.what, 16),
        relationship: {
          rel: ['customer', 'supplier', 'competitor', 'partner', 'investor', 'subsidiary', 'parent', 'other'].includes(rel.rel) ? rel.rel : 'other',
          toRoot: words(rel.toRoot, 18), evidence: words(rel.evidence, 30), confidence: ['high', 'medium', 'low'].includes(rel.confidence) ? rel.confidence : 'low',
        },
        hq: nul(f.hq), ownership: nul(f.ownership), parent: nul(f.parent), employees: nul(f.employees), revenue: nul(f.revenue),
        products: list(f.products, 6, 6), customers: list(f.customers, 6, 5), suppliers: list(f.suppliers, 6, 5), competitors: list(f.competitors, 6, 5), risks: list(f.risks, 5, 8),
        facts: (Array.isArray(f.facts) ? f.facts : []).map(x => ({ name: words(x?.name, 4), value: words(x?.value, 8) })).filter(x => x.name && x.value).slice(0, 6),
        identity: unnamed ? (Array.isArray(f.identity) ? f.identity : []).map(x => ({ name: tidy(words(x?.name, 6)), ticker: TK.test(String(x?.ticker || '').toUpperCase()) ? String(x.ticker).toUpperCase() : null, confidence: ['high', 'medium', 'low'].includes(x?.confidence) ? x.confidence : 'low', why: words(x?.why, 14) })).filter(x => x.name && !/^(unknown|undisclosed|unnamed|n\/a|none)\b/i.test(x.name)).slice(0, 3) : [],
        sources: found.map(x => ({ label: x.label, url: x.url, says: x.says, q: x.q })).slice(0, 12),
      });
      enrich = f;
      return true;
    },
  });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const res = { target: name, ticker: enrich?.ticker || ticker || null, agents: agents.length + 1, sources: bundles.length, findings: found.length, leads, seconds, enriched: Boolean(enrich), what: enrich?.what || null, relationship: enrich?.relationship?.toRoot || null };
  (s.investigations ||= []).push(res);
  return res;
}

export async function investigateAsk(name, ticker, mode, ctx = {}) {
  const s = await needMap();
  name = tidy(name);
  if (!name) { const e = new Error('name required'); e.code = 'BAD'; throw e; }
  if (ctx.quotes?.length) (s.invCtx ||= new Map()).set(norm(name), ctx.quotes.slice(0, 3).map(q => clip(q, 400)));
  reopen(s, { source: 'page', awaitReply: true });
  s.emit({ type: 'ask', mode: 'investigate', q: 'Investigate ' + name, target: name, source: 'page' });
  const root = s.meta.short || pretty(s.meta.name);
  const msg = `Run terminal_investigate on "${name}"${ticker ? ` (${ticker})` : ''} in the context of the ${root} map`;
  if (mode === 'openclaw') { s.emit({ type: 'bot', phase: 'thinking', text: msg }); runAgentTurn(s, msg); return s; }
  s.scripted = true;
  s.emit({ type: 'bot', phase: 'thinking', text: `Investigating ${name}` });
  (async () => {
    const r = await investigate({ name, ticker });
    await finishSession({ reply: r.enriched ? `${r.agents} agents read ${r.sources} sources on ${name}: ${r.what || 'done'}${r.relationship ? ` (${r.relationship})` : ''}.` : `${r.agents} agents read ${r.sources} sources on ${name}, but the synthesis came back empty.` });
  })().catch(e => finishSession({ error: e.message || e }));
  return s;
}

// ---------------------------------------------------------------- company news, tagged good / bad
const EIGHT_K = {
  '1.05': 'Cybersecurity incident', '5.02': 'Executive or director change', '2.06': 'Material impairment', '4.02': 'Restatement: prior financials not reliable',
  '1.03': 'Bankruptcy or receivership', '3.01': 'Delisting notice', '4.01': 'Change of auditor', '2.05': 'Restructuring costs', '2.04': 'Debt acceleration event',
};
const KINDS = ['lawsuit', 'regulatory', 'investigation', 'recall', 'fraud', 'breach', 'layoffs', 'executive', 'restatement', 'earnings', 'deal', 'product', 'partnership', 'guidance', 'other'];
const RED = new Set(['lawsuit', 'regulatory', 'investigation', 'recall', 'fraud', 'breach', 'restatement']);
const isRed = (tag, kind) => RED.has(kind) || (tag === 'bad' && (kind === 'layoffs' || kind === 'executive'));
const NEWS_TTL = 60 * 60e3;
const newsJobs = new Map();
let yahooBlock = 0;

async function eightKs(ticker) {
  const t = await findTicker(ticker).catch(() => null);
  if (!t) return [];
  const pad = String(t.cik).padStart(10, '0');
  const subs = JSON.parse(await cached(`subs-${pad}.json`, () => secGet(`https://data.sec.gov/submissions/CIK${pad}.json`)));
  const r = subs.filings.recent, out = [], cutoff = Date.now() - 120 * 864e5;
  for (let i = 0; i < r.form.length && out.length < 6; i++) {
    if (r.form[i] !== '8-K' || Date.parse(r.filingDate[i]) < cutoff) continue;
    const hit = String(r.items?.[i] || '').split(',').map(x => x.trim()).filter(x => EIGHT_K[x]);
    if (!hit.length) continue;
    out.push({ title: `8-K · Item ${hit[0]} · ${EIGHT_K[hit[0]]}`, link: `https://www.sec.gov/Archives/edgar/data/${Number(t.cik)}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i]}`, source: 'SEC 8-K', ts: Date.parse(r.filingDate[i]) });
  }
  return out;
}

async function fetchNews(name, ticker) {
  const F = await feeds();
  const gn = async q => F.parseRss(await F.webFetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`), 'Google News', 'GN').map(x => ({ title: x.title, link: x.url, source: x.by || 'Google News', ts: x.published }));
  const n = tidy(name);
  const flags = 'lawsuit OR investigation OR probe OR recall OR fraud OR fine OR layoffs OR breach';
  const yahoo = async () => {
    if (!ticker || Date.now() < yahooBlock) return [];
    try { return F.parseRss(await F.webFetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`), 'Yahoo Finance', 'YF').map(x => ({ title: x.title, link: x.url, source: 'Yahoo Finance', ts: x.published })); }
    catch (e) { if (/429/.test(String(e.message))) yahooBlock = Date.now() + 10 * 60e3; return []; }
  };
  const [eks, general, red, yh] = await Promise.all([
    ticker ? withTimeout(eightKs(ticker), 20000, []) : [], withTimeout(gn(`"${n}" when:90d`), 20000, []), withTimeout(gn(`"${n}" (${flags}) when:90d`), 20000, []), withTimeout(yahoo(), 15000, []),
  ]);
  const cutoff = Date.now() - 95 * 864e5, seen = new Set(), out = [];
  const add = (rows, cap) => {
    let k = 0;
    for (const r of rows) {
      const key = String(r.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (!r.title || !r.link || seen.has(key) || (r.ts && r.ts < cutoff) || k >= cap) continue;
      seen.add(key); out.push(r); k++;
    }
  };
  const byDate = rows => [...rows].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  add(eks, 6); add(byDate(red), 12); add(byDate(general), 14); add(byDate(yh), 6);
  return byDate(out).slice(0, 30);
}

async function scoreNews(name, ticker, rows) {
  const system = `You tag news headlines about ${name}${ticker ? ` (${ticker})` : ''} for its investors. For each numbered headline output one JSON line and nothing else:
{"i":1,"about":1,"tag":"good|bad|neutral","kind":"${KINDS.join('|')}","reason":"<max 12 words>"}
about: 1 if the headline is really about ${name}, 0 if it is about another company or a generic topic.
tag: good = positive for ${name}'s investors (beats, wins, approvals, growth, upgrades), bad = negative (lawsuits, probes, recalls, fraud, breaches, layoffs, misses, downgrades, fines), neutral = routine, mixed or unclear.
kind: use lawsuit, regulatory, investigation, recall, fraud, breach, layoffs, executive (leadership change) or restatement only when the headline reports that problem; otherwise earnings, deal, product, partnership, guidance or other.
reason: say why in plain words, no hype. One line per headline, in order.`;
  const user = rows.map((r, i) => `${i + 1}. [${r.source}] ${r.title}`).join('\n');
  const res = await streamChat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 4500, sessionId: 'pt-news-' + Date.now(), retryForMs: 60000 });
  const tags = new Map();
  for (const line of String(res.content || '').split('\n')) {
    const t = line.trim().replace(/^```(json)?/, '').replace(/```$/, '').replace(/,$/, '');
    if (!t.startsWith('{')) continue;
    try { const o = JSON.parse(t); if (Number.isInteger(o.i)) tags.set(o.i, o); } catch {}
  }
  return tags;
}

export async function companyNews({ name, ticker, root, fresh } = {}) {
  name = tidy(name);
  if (!name) throw new Error('name required');
  ticker = TK.test(String(ticker || '').toUpperCase().replace(/^\$/, '')) ? String(ticker).toUpperCase().replace(/^\$/, '') : null;
  const key = norm(name) + (ticker ? '-' + ticker : '');
  const file = path.join(DATA, `news-${key.replace(/[^a-z0-9\-]/gi, '_').slice(0, 80)}.json`);
  if (!fresh && existsSync(file)) {
    try { const c = JSON.parse(await readFile(file, 'utf8')); if (Date.now() - c.t < NEWS_TTL) return { ...c, cached: true }; } catch {}
  }
  if (newsJobs.has(key)) return newsJobs.get(key);
  const job = (async () => {
    const rows = await fetchNews(name, ticker);
    let tags = new Map(), scoreError = null;
    if (rows.length) { try { tags = await scoreNews(name, ticker, rows); } catch (e) { scoreError = String(e.message || e).slice(0, 160); } }
    const items = [];
    rows.forEach((r, i) => {
      const o = tags.get(i + 1);
      if (o && Number(o.about) === 0) return;
      const tag = ['good', 'bad', 'neutral'].includes(o?.tag) ? o.tag : 'neutral';
      const kind = KINDS.includes(o?.kind) ? o.kind : 'other';
      items.push({ title: clip(r.title, 200), link: r.link, source: clip(r.source, 40), date: r.ts ? new Date(r.ts).toISOString().slice(0, 10) : null, tag, kind, reason: words(o?.reason, 12), red: isRed(tag, kind) });
    });
    const out = {
      name, ticker, root: root || null, t: Date.now(), scored: !scoreError && tags.size > 0, ...(scoreError ? { error: 'scoring failed: ' + scoreError } : {}),
      counts: { good: items.filter(x => x.tag === 'good').length, bad: items.filter(x => x.tag === 'bad').length, neutral: items.filter(x => x.tag === 'neutral').length, red: items.filter(x => x.red).length, total: items.length },
      items,
    };
    if (out.scored || !rows.length) { await mkdir(DATA, { recursive: true }); await writeFile(file, JSON.stringify(out)); }
    return out;
  })();
  newsJobs.set(key, job);
  job.then(() => newsJobs.delete(key), () => newsJobs.delete(key));
  return job;
}
