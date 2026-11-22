// Extra SEC EDGAR sources for the terminal: full-text search, mention windows, insider (Form 4) trades,
// the latest earnings release, a 10-K vs prior 10-K item diff, and TSMC's monthly revenue 6-Ks.
// No dependencies: global fetch through sec.mjs helpers. Every export catches its own errors and
// returns null / [] when there is nothing, or { error } when SEC could not be reached.
import { createHash } from 'node:crypto';
import { secGet as rawGet, cached, htmlToText, splitItems, loadTickers } from '../sec.mjs';

// SEC allows 10 requests/s per client and locks you out for ~10 minutes past that. Concurrency alone
// doesn't cap the rate (small Form 4 XMLs come back in ~100 ms), so space request starts too.
const GAP_MS = 160; // ~6 req/s from this module, leaving headroom for the rest of the app
let nextSlot = 0;
async function secGet(url, asText = true) {
  const now = Date.now(), at = Math.max(now, nextSlot);
  nextSlot = at + GAP_MS;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
  return rawGet(url, asText);
}

const pad10 = cik => String(Number(cik)).padStart(10, '0');
const noDash = acc => String(acc).replace(/-/g, '');
const archive = (cik, acc, file) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${noDash(acc)}/${file}`;
const safe = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180);
const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const errOf = e => ({ error: String(e?.message || e) });
const ymd = d => d.toISOString().slice(0, 10);
const daysAgo = n => ymd(new Date(Date.now() - n * 864e5));

// Per-file fetch inside a batch. A 404 just means that file is missing; any other failure (429 lockout,
// network) stops the rest of the batch so we don't keep firing into a lockout. Failures are counted in st.
async function guarded(st, fn, fallback) {
  if (st.stop) { st.failed++; return fallback; }
  try { return await fn(); } catch (e) {
    if (/SEC 404/.test(e?.message)) return fallback;
    st.failed++; st.stop = true; st.error = String(e?.message || e);
    return fallback;
  }
}

// Run fn over items with at most n in flight (SEC allows 10 req/s; we stay at 4).
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// htmlToText keeps empty table cells as long "| | | |" runs: squeeze them so trim budgets go to real text.
function squeeze(text) {
  return text.replace(/(?:\|[ \t]*){2,}/g, '| ')
    .split('\n').map(l => l.trim()).filter(l => l && l !== '|').join('\n');
}

// Submissions JSON, same cache file sec.mjs uses.
async function subs(cik) {
  const pad = pad10(cik);
  return JSON.parse(await cached(`subs-${pad}.json`, () => secGet(`https://data.sec.gov/submissions/CIK${pad}.json`)));
}

// Recent filings as row objects (newest first). `older` also pulls the paged history files.
async function filingRows(cik, { older = false } = {}) {
  const s = await subs(cik);
  const toRows = r => r.form.map((form, i) => ({
    form, acc: r.accessionNumber[i], date: r.filingDate[i], reportDate: r.reportDate?.[i] || '',
    doc: r.primaryDocument[i], desc: r.primaryDocDescription?.[i] || '', items: r.items?.[i] || '', size: r.size?.[i] || 0,
  }));
  let rows = toRows(s.filings.recent);
  if (older) {
    // history pages keep the same arrays at the top level instead of under filings.recent
    for (const f of s.filings.files || []) {
      const page = JSON.parse(await cached(safe(`subs-${f.name}`), () => secGet(`https://data.sec.gov/submissions/${f.name}`)));
      rows = rows.concat(toRows(page));
    }
  }
  return { name: s.name, tickers: s.tickers || [], rows };
}

// cik -> ticker, from the cached SEC ticker file.
let tickerByCik;
async function tickerFor(cik) {
  if (!tickerByCik) {
    tickerByCik = new Map();
    for (const t of await loadTickers()) if (!tickerByCik.has(t.cik)) tickerByCik.set(t.cik, t.ticker);
  }
  return tickerByCik.get(Number(cik)) || null;
}

// ---------------------------------------------------------------------------------------------
// 1. Full-text search: which filers mention a phrase. One hit per filer, main document preferred.
// `max` caps the number of filers returned; at most 10 result pages (1000 raw hits) are read.
export async function fullTextSearch(q, { forms = ['10-K'], start, end, max = 200, excludeCik } = {}) {
  try {
    const phrase = String(q || '').trim().replace(/^"+|"+$/g, '');
    if (!phrase) return [];
    end = end || ymd(new Date());
    if (!start) { const d = new Date(end); d.setMonth(d.getMonth() - 13); start = ymd(d); }
    const formList = [].concat(forms).filter(Boolean);
    const base = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${phrase}"`)}`
      + (formList.length ? `&forms=${encodeURIComponent(formList.join(','))}` : '')
      + `&dateRange=custom&startdt=${start}&enddt=${end}`;
    const page = async from => {
      const url = `${base}&from=${from}`;
      return JSON.parse(await cached(`efts-${hash(url)}.json`, () => secGet(url)));
    };
    const first = await page(0);
    const total = first.hits?.total?.value || 0;
    const pages = Math.min(10, Math.ceil(total / 100));
    const rest = await pool(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * 100), 4, page);
    const hits = [first, ...rest].flatMap(p => p.hits?.hits || []);

    const skip = excludeCik != null ? Number(excludeCik) : null;
    const best = new Map();
    for (const h of hits) {
      const src = h._source || {};
      const ciks = (src.ciks || []).map(Number);
      if (!ciks.length || (skip != null && ciks.includes(skip))) continue;
      const file = String(h._id || '').split(':').slice(1).join(':');
      const type = String(src.file_type || '');
      // rank: the form's own document (10-K) first, exhibits (EX-21, EX-99 ...) last
      const rank = type === src.form || type === (src.root_forms || [])[0] ? 0 : /^EX-/i.test(type) ? 2 : 1;
      const cand = { cik: ciks[0], display: (src.display_names || [])[0] || '', adsh: src.adsh, form: src.form, date: src.file_date, file, rank };
      const prev = best.get(cand.cik);
      if (!prev || rank < prev.rank || (rank === prev.rank && cand.date > prev.date)) best.set(cand.cik, cand);
    }
    const out = [];
    for (const c of [...best.values()].sort((a, b) => a.rank - b.rank || (b.date || '').localeCompare(a.date || ''))) {
      if (out.length >= max) break;
      // "NVIDIA CORP  (NVDA)  (CIK 0001045810)" or "X  (A, B)  (CIK ...)" or no ticker at all
      const m = /^(.*?)\s+(?:\(([^)]*)\)\s+)?\(CIK \d+\)\s*$/.exec(c.display);
      const name = (m ? m[1] : c.display).trim();
      const ticker = (m?.[2] || '').split(',')[0].trim() || await tickerFor(c.cik);
      out.push({ cik: c.cik, name, ticker: ticker || null, adsh: c.adsh, form: c.form, date: c.date, url: archive(c.cik, c.adsh, c.file) });
    }
    return out;
  } catch (e) { return errOf(e); }
}

// ---------------------------------------------------------------------------------------------
// 2. Text windows around mentions of any term in one filing document.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termRe(terms) {
  const parts = [].concat(terms).map(t => String(t || '').trim()).filter(Boolean).map(t => {
    const body = escapeRe(t).replace(/\s+/g, '\\s+');
    return (/^\w/.test(t) ? '\\b' : '') + body + (/\w$/.test(t) ? '\\b' : '');
  });
  return parts.length ? new RegExp(parts.join('|'), 'gi') : null;
}

export async function filingText(url) {
  const m = /\/data\/(\d+)\/(\d+)\/([^?#]+)/.exec(url);
  const name = m ? `doc-${m[1]}-${m[2]}-${safe(m[3])}` : `doc-${hash(url)}.htm`;
  return squeeze(htmlToText(await cached(name, () => secGet(url))));
}

export async function mentionWindows(url, terms, { max = 4, width = 700 } = {}) {
  try {
    const re = termRe(terms);
    if (!re) return { url, chars: 0, matches: 0, windows: [] };
    const text = await filingText(url);
    const hits = [...text.matchAll(re)].map(x => ({ at: x.index, len: x[0].length, term: x[0] }));
    const half = Math.floor(width / 2);
    // score each hit by how many hits its window holds, then pick the densest non-overlapping windows
    const scored = hits.map(h => {
      const a = Math.max(0, h.at + (h.len >> 1) - half), b = Math.min(text.length, a + width);
      return { ...h, a, b, score: hits.filter(o => o.at >= a && o.at < b).length };
    }).sort((x, y) => y.score - x.score || x.at - y.at);
    const picked = [];
    for (const w of scored) {
      if (picked.length >= max) break;
      if (picked.some(p => w.a < p.b && p.a < w.b)) continue;
      picked.push(w);
    }
    const windows = picked.sort((x, y) => x.a - y.a).map(w => {
      // snap to word edges so windows don't start or end mid-word
      let a = w.a, b = w.b;
      if (a > 0) { const s = text.indexOf(' ', a); if (s > 0 && s - a < 40) a = s + 1; }
      if (b < text.length) { const s = text.lastIndexOf(' ', b); if (s > a && b - s < 40) b = s; }
      return { at: a, term: w.term, hits: w.score, text: (a > 0 ? '…' : '') + text.slice(a, b).trim() + (b < text.length ? '…' : '') };
    });
    return { url, chars: text.length, matches: hits.length, windows };
  } catch (e) { return { url, ...errOf(e) }; }
}

// ---------------------------------------------------------------------------------------------
// 3. Insider trades from the latest Form 4 filings (non-derivative table only).
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENT[e]).trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? unxml(m[1]) : ''; };
const val = (xml, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); const t = m ? m[1] : ''; return unxml(/<value>([\s\S]*?)<\/value>/.exec(t)?.[1] ?? t); };
const flag = v => v === '1' || /^true$/i.test(v);
const num = s => { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) && s !== '' ? n : null; };
const CODES = { P: 'buy', S: 'sell', A: 'award', M: 'exercise', F: 'tax', G: 'gift', D: 'disposition to issuer', C: 'conversion', X: 'exercise', J: 'other' };

function parseForm4(xml, cik) {
  if (Number(tag(xml, 'issuerCik')) !== Number(cik)) return null; // filed as an owner of another issuer
  const owners = [...xml.matchAll(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/g)].map(m => {
    const o = m[1], rel = tag(o, 'reportingOwnerRelationship');
    const roles = [];
    if (flag(tag(rel, 'isDirector').trim())) roles.push('Director');
    if (flag(tag(rel, 'isOfficer').trim())) roles.push(tag(rel, 'officerTitle').trim() || 'Officer');
    if (flag(tag(rel, 'isTenPercentOwner').trim())) roles.push('10% owner');
    if (flag(tag(rel, 'isOther').trim())) roles.push(tag(rel, 'otherText').trim() || 'Other');
    return { name: tag(o, 'rptOwnerName').trim(), title: roles.join(', ') };
  });
  const plan = flag(tag(xml, 'aff10b5One').trim());
  const rows = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)].map(m => {
    const t = m[1];
    const code = tag(tag(t, 'transactionCoding'), 'transactionCode').trim();
    const shares = num(val(t, 'transactionShares')), price = num(val(t, 'transactionPricePerShare'));
    return {
      owner: owners.map(o => o.name).join(' / '), title: owners[0]?.title || '',
      date: val(t, 'transactionDate').slice(0, 10), code, kind: CODES[code] || code,
      shares, price: price || null, value: shares != null && price ? Math.round(shares * price) : null,
      acquiredDisposed: val(t, 'transactionAcquiredDisposedCode'), sharesAfter: num(val(t, 'sharesOwnedFollowingTransaction')),
      direct: val(t, 'directOrIndirectOwnership') !== 'I', security: val(t, 'securityTitle'), plan10b51: plan,
    };
  });
  return rows;
}

export async function insiders(cik, { max = 40 } = {}) {
  try {
    const { rows: filings } = await filingRows(cik);
    // originals only: a 4/A usually restates the original's rows and would double count them
    const f4 = filings.filter(r => r.form === '4').slice(0, max);
    const st = { failed: 0 };
    const parsed = await pool(f4, 4, async f => {
      const file = f.doc.replace(/^xsl[^/]+\//i, ''); // xslF345X06/x.xml is a rendering; the raw XML sits at the root
      return guarded(st, async () => {
        const xml = await cached(safe(`f4-${f.acc}-${file}`), () => secGet(archive(cik, f.acc, file)));
        return (parseForm4(xml, cik) || []).map(r => ({ ...r, filed: f.date, url: archive(cik, f.acc, file) }));
      }, []);
    });
    if (st.failed && st.failed >= f4.length) return { error: st.error };
    const rows = parsed.flat().sort((a, b) => b.date.localeCompare(a.date) || b.filed.localeCompare(a.filed));
    const win = since => {
      const w = rows.filter(r => r.date >= since);
      const buys = w.filter(r => r.code === 'P'), sells = w.filter(r => r.code === 'S');
      const sum = a => a.reduce((s, r) => s + (r.value || 0), 0);
      return { buys: buys.length, sells: sells.length, buyValue: sum(buys), sellValue: sum(sells), net: sum(buys) - sum(sells) };
    };
    const d90 = win(daysAgo(90)), d365 = win(daysAgo(365));
    const sellers = new Map();
    for (const r of rows) if (r.code === 'S' && r.date >= daysAgo(365)) {
      const s = sellers.get(r.owner) || { name: r.owner, title: r.title, value: 0, shares: 0, trades: 0 };
      s.value += r.value || 0; s.shares += r.shares || 0; s.trades++;
      sellers.set(r.owner, s);
    }
    return {
      rows,
      summary: {
        buys90: d90.buys, sells90: d90.sells, buyValue90: d90.buyValue, sellValue90: d90.sellValue, netValue90: d90.net,
        buys365: d365.buys, sells365: d365.sells, buyValue365: d365.buyValue, sellValue365: d365.sellValue, netValue365: d365.net,
        topSellers: [...sellers.values()].sort((a, b) => b.value - a.value).slice(0, 5),
        filings: f4.length, coveredFrom: f4.at(-1)?.date || null, // windows longer than this are truncated
        failed: st.failed, // filings that could not be fetched (rate limit): the figures above are partial when > 0
      },
    };
  } catch (e) { return errOf(e); }
}

// ---------------------------------------------------------------------------------------------
// 4. Latest earnings press release: the EX-99.1 of the newest 8-K carrying Item 2.02.
async function filingDocs(cik, acc) {
  const html = await cached(`idx-${noDash(acc)}.htm`, () => secGet(archive(cik, acc, `${acc}-index.htm`)));
  const docs = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    const href = /href="([^"]+)"/i.exec(tr)?.[1];
    if (cells.length >= 4 && href) {
      const file = href.replace(/^\/ix\?doc=/, '').split('/').pop();
      docs.push({ desc: htmlToText(cells[1]), type: htmlToText(cells[3]).trim(), file });
    }
  }
  return docs;
}

export async function earningsRelease(cik) {
  try {
    const { rows } = await filingRows(cik);
    const f = rows.find(r => r.form === '8-K' && r.items.split(',').map(s => s.trim()).includes('2.02'));
    if (!f) return null; // foreign filers (6-K) carry no item numbers
    const docs = await filingDocs(cik, f.acc).catch(() => []);
    const pick = docs.find(d => /^EX-99\.0?1$/i.test(d.type)) || docs.find(d => /^EX-99/i.test(d.type));
    const file = pick?.file || f.doc;
    const url = archive(cik, f.acc, file);
    let text = squeeze(htmlToText(await cached(safe(`pr-${noDash(f.acc)}-${file}`), () => secGet(url))));
    // drop the SGML header residue ("EX-99.1 / 2 / q3fy27pr.htm / EX-99.1") some exhibits start with
    const lines = text.split('\n');
    while (lines.length && (lines[0] === file || /^\d+$/.test(lines[0]) || /^EX-[\d.]+$/i.test(lines[0]))) lines.shift();
    text = lines.join('\n');
    return { date: f.date, acc: f.acc, items: f.items, exhibit: pick?.type || 'primary', url, chars: text.length, text: text.slice(0, 14000) };
  } catch (e) { return errOf(e); }
}

// ---------------------------------------------------------------------------------------------
// 5. The latest annual report and the one before it, aligned item by item.
const itemOrder = k => { const m = /^(\d+)([A-Z]?)$/.exec(k); return m ? +m[1] * 10 + (m[2] ? m[2].charCodeAt(0) - 64 : 0) : 9999; };
const itemTitle = (key, text) => {
  // "Item 1A. Risk Factors", or "ITEM 3. |" with the title on the next line
  const [l0 = '', l1 = ''] = (text || '').split('\n');
  const head = l0.replace(/^item\s+\d+[a-c]?\b\s*[.:\-–—]?\s*/i, '').replace(/\|/g, ' ').trim() || l1.replace(/\|/g, ' ').trim();
  return head && head.length < 120 ? head : `Item ${key}`;
};

export async function tenKPair(cik) {
  try {
    let { rows } = await filingRows(cik);
    const form = ['10-K', '20-F', '40-F'].find(fm => rows.some(r => r.form === fm));
    if (!form) return null;
    if (rows.filter(r => r.form === form).length < 2) ({ rows } = await filingRows(cik, { older: true }));
    const [latest, previous] = rows.filter(r => r.form === form);
    if (!latest) return null;
    // same cache names as sec.mjs get10KText, so 10-Ks already pulled for a run are reused
    const items = async f => splitItems(squeeze(htmlToText(await cached(`${Number(cik)}-${f.acc}.htm`, () => secGet(archive(cik, f.acc, f.doc))))));
    const [now, before] = await Promise.all([items(latest), previous ? items(previous) : {}]);
    const keys = [...new Set([...Object.keys(now), ...Object.keys(before)])].sort((a, b) => itemOrder(a) - itemOrder(b));
    const pairs = keys.map(key => ({
      key, title: itemTitle(key, now[key] || before[key]),
      nowChars: (now[key] || '').length, beforeChars: (before[key] || '').length,
      now: (now[key] || '').slice(0, 9000), before: (before[key] || '').slice(0, 9000),
    }));
    const meta = f => f && { date: f.date, acc: f.acc, url: archive(cik, f.acc, f.doc) };
    return { form, latest: meta(latest), previous: meta(previous) || null, pairs };
  } catch (e) { return errOf(e); }
}

// ---------------------------------------------------------------------------------------------
// 6. TSMC monthly revenue, parsed from its monthly "Revenue Report" 6-Ks. Oldest month first.
const TSMC = 1046179;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function parseTsmc(text) {
  // "revenue for October 2026 was approximately NT$586.89 billion, an increase of 14.7 percent from
  //  September 2026 and an increase of 59.7 percent from October 2025"
  const m = /revenue for (\w+) (\d{4}) was approximately NT\$\s*([\d,.]+) billion,?\s+an? (increase|decrease) of ([\d.]+) percent from \w+ \d{4},? and an? (increase|decrease) of ([\d.]+) percent/i.exec(text.replace(/\s+/g, ' '));
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  const sign = (w, v) => (/decrease/i.test(w) ? -1 : 1) * Number(v);
  return { month: `${m[2]}-${String(mi + 1).padStart(2, '0')}`, revenueNTD: Number(m[3].replace(/,/g, '')), mom: sign(m[4], m[5]), yoy: sign(m[6], m[7]) };
}

export async function tsmcMonthly({ months = 12 } = {}) {
  try {
    const { rows } = await filingRows(TSMC);
    const cands = rows.filter(r => r.form === '6-K' && /revenue/i.test(r.doc)).slice(0, months + 2);
    const st = { failed: 0 };
    const parsed = await pool(cands, 4, async f => {
      const url = archive(TSMC, f.acc, f.doc);
      return guarded(st, async () => {
        const p = parseTsmc(htmlToText(await cached(safe(`tsm6k-${noDash(f.acc)}-${f.doc}`), () => secGet(url))));
        return p && { ...p, filed: f.date, url };
      }, null);
    });
    const byMonth = new Map();
    for (const p of parsed) if (p && !byMonth.has(p.month)) byMonth.set(p.month, p);
    if (!byMonth.size && st.failed) return { error: st.error }; // partial lists come back shorter instead
    return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-months);
  } catch (e) { return errOf(e); }
}
