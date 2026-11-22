// SEC EDGAR: ticker search, latest 10-K, HTML -> text, section split.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
// SEC asks automated clients to name themselves with a contact address: set SEC_USER_AGENT="Your Name you@example.com".
export const UA = process.env.SEC_USER_AGENT || 'PocketTerminal-demo research@example.org';

export async function secGet(url, asText = true) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
    if (r.ok) return asText ? r.text() : r.json();
    if (r.status === 404) throw new Error('SEC 404 ' + url);
    await new Promise(s => setTimeout(s, 600 * (i + 1)));
  }
  throw new Error('SEC fetch failed ' + url);
}

export async function cached(name, fn) {
  const f = path.join(DATA, name);
  if (existsSync(f)) return readFile(f, 'utf8');
  const t = await fn();
  await mkdir(DATA, { recursive: true });
  await writeFile(f, t);
  return t;
}

let tickers;
export async function loadTickers() {
  if (tickers) return tickers;
  const raw = JSON.parse(await cached('company_tickers.json', () => secGet('https://www.sec.gov/files/company_tickers.json')));
  tickers = Object.values(raw).map(x => ({ cik: x.cik_str, ticker: x.ticker, name: x.title }));
  return tickers;
}

export async function searchTickers(q, limit = 7) {
  const list = await loadTickers();
  q = (q || '').trim().toUpperCase();
  if (!q) return [];
  const scored = [];
  list.forEach((t, i) => {
    const tk = t.ticker, nm = t.name.toUpperCase();
    let s = 0;
    if (tk === q) s = 100;
    else if (tk.startsWith(q)) s = 80;
    else if (nm.startsWith(q)) s = 60;
    else if (nm.includes(' ' + q)) s = 40;
    // plain tickers before preferred/unit/warrant variants of the same company (JPM before JPM-PC)
    if (s && /-(P[A-Z]?|U|UN|W|WS|WT|R|RT)$/.test(tk)) s -= 5;
    if (s) scored.push([s, i, t]);
  });
  // the SEC file is ordered by market cap: within a score, bigger companies (lower index) first
  scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return scored.slice(0, limit).map(x => x[2]);
}

export async function findTicker(tk) {
  const list = await loadTickers();
  tk = tk.toUpperCase().replace(/^\$/, '');
  return list.find(t => t.ticker === tk) || null;
}

export async function latest10K(cik) {
  const pad = String(cik).padStart(10, '0');
  const subs = JSON.parse(await cached(`subs-${pad}.json`, () => secGet(`https://data.sec.gov/submissions/CIK${pad}.json`)));
  const r = subs.filings.recent;
  // annual report first; newly listed companies fall back to their IPO prospectus, then the latest quarterly
  for (const form of ['10-K', '20-F', '40-F', '424B4', 'S-1/A', 'S-1', 'F-1/A', 'F-1', '10-Q']) {
    const i = r.form.indexOf(form);
    if (i >= 0) {
      const acc = r.accessionNumber[i];
      const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${r.primaryDocument[i]}`;
      return { form, acc, date: r.filingDate[i], url, name: subs.name, tickers: subs.tickers || [], sic: subs.sicDescription || '' };
    }
  }
  return null;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', bull: '•', reg: '®', trade: '™', copy: '©', hellip: '…' };
export function htmlToText(h) {
  h = h.replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*display:\s*none[\s\S]*?<\/div>/gi, '');
  h = h.replace(/<\/(p|div|tr|li|h\d|table|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ');
  h = h.replace(/<[^>]+>/g, '');
  h = h.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m);
  return h.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export async function get10KText(info, cik) {
  const html = await cached(`${cik}-${info.acc}.htm`, () => secGet(info.url));
  return htmlToText(html);
}

// Find "Item X." headings in the body (skip the table of contents: take the occurrence followed by the most text).
const ITEMS = [
  ['1', 'Business'], ['1A', 'Risk Factors'], ['1B', 'Unresolved Staff Comments'], ['1C', 'Cybersecurity'], ['2', 'Properties'], ['3', 'Legal Proceedings'],
  ['5', 'Market'], ['7', 'MD&A'], ['7A', 'Market Risk'], ['8', 'Financial Statements'], ['9', 'Controls'], ['9A', 'Controls'],
];
export function splitItems(text) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    const m = /^item\s+(\d+[a-c]?)\b\s*[.:\-–—]?\s*(.*)$/i.exec(l);
    if (m && l.length < 200) hits.push({ i, id: m[1].toUpperCase() });
  });
  // keep the last run of headings that appears in order (body, not TOC)
  const byId = {};
  for (const h of hits) byId[h.id] = h; // last occurrence wins
  const ordered = Object.values(byId).sort((a, b) => a.i - b.i);
  const out = {};
  for (let k = 0; k < ordered.length; k++) {
    const a = ordered[k], b = ordered[k + 1];
    out[a.id] = lines.slice(a.i, b ? b.i : lines.length).join('\n');
  }
  return out;
}

const LABEL = Object.fromEntries(ITEMS);

// Build agent chunks: ~targetChars each, cut on line boundaries, from the sections that carry relationships and numbers.
export function makeChunks(items, { maxAgents = 40, budgetChars = 220000 } = {}) {
  // Item 8 is often just a pointer to Item 15, where the statements and notes really are
  if ((!items['8'] || items['8'].length < 3000) && items['15'] && items['15'].length > 3000) items['8'] = items['15'];
  const wanted = [['1', 0.30], ['1A', 0.22], ['7', 0.28], ['8', 0.20]];
  const avail = wanted.filter(([id]) => items[id] && items[id].length > 500);
  const total = Math.min(budgetChars, avail.reduce((s, [id]) => s + items[id].length, 0));
  const target = Math.max(2500, Math.ceil(total / (maxAgents * 1.25))); // long lines overshoot, so aim a bit small
  const chunks = [];
  for (const [id, share] of avail) {
    let body = items[id];
    const cap = Math.floor(budgetChars * share * (1 / avail.reduce((s, x) => s + x[1], 0)));
    if (id === '8') {
      // notes matter more than the face statements: start at the notes if we can find them
      const n = body.search(/notes to (the )?consolidated financial statements/i);
      if (n > 0) body = body.slice(n);
    }
    body = body.slice(0, cap);
    const lines = body.split('\n');
    let cur = [], len = 0, part = 1;
    const flush = () => { if (len > 300) chunks.push({ section: id, label: `${LABEL[id] || 'Item ' + id} · ${part++}`, text: cur.join('\n') }); cur = []; len = 0; };
    for (const l of lines) { cur.push(l); len += l.length + 1; if (len >= target) flush(); }
    flush();
  }
  return chunks.slice(0, maxAgents);
}

// Last 4 fiscal years (10-K, fp=FY) of a few headline facts from SEC companyfacts. Code only, no LLM.
const FACTS = [
  ['Revenue', ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'], ['Revenue', 'RevenueFromContractsWithCustomers']],
  ['Gross profit', ['GrossProfit'], ['GrossProfit']],
  ['Operating income', ['OperatingIncomeLoss'], ['ProfitLossFromOperatingActivities']],
  ['Net income', ['NetIncomeLoss'], ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss']],
  ['R&D', ['ResearchAndDevelopmentExpense'], ['ResearchAndDevelopmentExpense']],
  ['Cash', ['CashAndCashEquivalentsAtCarryingValue'], ['CashAndCashEquivalents']],
];
export async function financials(cik, years = 4) {
  const pad = String(cik).padStart(10, '0');
  const facts = JSON.parse(await cached(`facts-${pad}.json`, () => secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad}.json`)));
  // US filers report us-gaap; foreign filers (20-F, e.g. TSM) report ifrs-full, often in their own currency
  const ifrs = !facts.facts?.['us-gaap']?.Revenues && !facts.facts?.['us-gaap']?.RevenueFromContractWithCustomerExcludingAssessedTax && facts.facts?.['ifrs-full'];
  const gaap = (ifrs ? facts.facts['ifrs-full'] : facts.facts?.['us-gaap']) || {};
  const rows = [];
  for (const [label, usTags, ifrsTags] of FACTS) {
    let best = null;
    for (const tag of ifrs ? ifrsTags : usTags) {
      const units = gaap[tag]?.units;
      if (!units) continue;
      // the filer's reporting currency: the unit with the most facts (TSM: TWD, not the USD convenience figures)
      const unit = Object.keys(units).sort((x, y) => units[y].length - units[x].length)[0];
      // one value per fiscal year: annual (10-K/20-F, fp FY) facts covering ~a year, latest filing wins
      const byFy = new Map();
      for (const x of units[unit]) {
        if (!/^(10-K|20-F|40-F)/.test(x.form || '') || x.fp !== 'FY') continue;
        if (x.start && x.end && (Date.parse(x.end) - Date.parse(x.start)) / 864e5 < 300) continue;
        const fy = Number((x.end || '').slice(0, 4));
        if (!fy) continue;
        const prev = byFy.get(fy);
        if (!prev || (x.filed || '') > (prev.filed || '')) byFy.set(fy, x);
      }
      const values = [...byFy.entries()].sort((a, b) => b[0] - a[0]).slice(0, years).map(([fy, x]) => ({ fy, v: x.val }));
      if (values.length && (!best || values[0].fy > best.values[0].fy)) best = { label, unit, values: values.reverse() };
    }
    if (best) rows.push(best);
  }
  return rows;
}

// Latest-FY ratios from financials() rows, as fractions (0.71 = 71%).
export function ratiosFrom(rows) {
  const get = l => rows.find(r => r.label === l);
  const rev = get('Revenue');
  if (!rev || !rev.values.length) return null;
  const last = rev.values.at(-1), fy = last.fy;
  const at = (l, y) => { const r = get(l); return r && r.unit === rev.unit ? r.values.find(v => v.fy === y)?.v : undefined; };
  const prev = at('Revenue', fy - 1);
  const frac = x => (x == null || !last.v ? null : +(x / last.v).toFixed(4));
  return {
    fy, unit: rev.unit, revenue: last.v, growth: prev ? +(last.v / prev - 1).toFixed(4) : null,
    grossMargin: frac(at('Gross profit', fy)), opMargin: frac(at('Operating income', fy)), netMargin: frac(at('Net income', fy)), rdPct: frac(at('R&D', fy)),
  };
}

// Most recent current report: 8-K (US filers) or 6-K (foreign filers), from the submissions feed.
export async function latest8K(cik) {
  const pad = String(cik).padStart(10, '0');
  const subs = JSON.parse(await cached(`subs-${pad}.json`, () => secGet(`https://data.sec.gov/submissions/CIK${pad}.json`)));
  const r = subs.filings.recent;
  for (const form of ['8-K', '6-K']) {
    const i = r.form.indexOf(form);
    if (i >= 0) {
      const acc = r.accessionNumber[i];
      const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${r.primaryDocument[i]}`;
      return { form, acc, date: r.filingDate[i], url, items: r.items?.[i] || '' };
    }
  }
  return null;
}

// The substance of a current report: skip the cover page to the first "Item x.xx", ~6K chars.
export async function get8KText(info, cik, max = 6000) {
  const text = htmlToText(await cached(`${cik}-${info.acc}.htm`, () => secGet(info.url)));
  const i = text.search(/^item\s+\d+\.\d+/im);
  return text.slice(i > 0 ? i : 0, (i > 0 ? i : 0) + max);
}

// Daily closes for the last ~year (Yahoo's public chart endpoint, no key), cached per day. Null on any failure.
export async function priceSeries(ticker) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const raw = await cached(`price-${ticker}-${day}.json`, async () => {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (pocket-terminal demo)' } });
      if (!r.ok) throw new Error('price ' + r.status);
      return r.text();
    });
    const res = JSON.parse(raw).chart?.result?.[0];
    const ts = res?.timestamp || [], close = res?.indicators?.quote?.[0]?.close || [];
    const points = ts.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: close[i] == null ? null : +close[i].toFixed(2) })).filter(x => x.c != null).slice(-252);
    return points.length > 20 ? points : null;
  } catch { return null; }
}

export async function prepare(ticker, opts = {}) {
  const t = await findTicker(ticker);
  if (!t) throw new Error('Unknown ticker ' + ticker);
  const info = await latest10K(t.cik);
  if (!info) throw new Error('No annual report found for ' + ticker);
  const text = await get10KText(info, t.cik);
  const items = splitItems(text);
  const chunks = makeChunks(items, opts);
  return { ...t, filing: info, chunks, textChars: text.length };
}

// CLI check: node engine/sec.mjs NVDA
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = await prepare(process.argv[2] || 'NVDA', { maxAgents: +(process.argv[3] || 40) });
  console.log(p.name, p.filing.form, p.filing.date, 'text chars', p.textChars, 'chunks', p.chunks.length);
  const by = {};
  for (const c of p.chunks) by[c.section] = (by[c.section] || 0) + c.text.length;
  console.log(by, 'total chars', p.chunks.reduce((s, c) => s + c.text.length, 0));
  console.log(p.chunks.slice(0, 3).map(c => c.label + ' :: ' + c.text.slice(0, 160).replace(/\n/g, ' / ')).join('\n'));
}
