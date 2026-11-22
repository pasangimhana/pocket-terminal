// Holdings data: ETF portfolios (SEC N-PORT), index and sector members (Wikipedia lists),
// and the biggest institutional holders of a stock (SEC Form 13F data sets). No dependencies.
// Everything returns null / [] / { error } for missing data instead of throwing.
import { readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secGet, loadTickers, findTicker, UA } from '../sec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'data', 'holdings');
const F13 = path.join(DIR, '13f');
const WIKI_UA = 'PocketTerminal/0.1 (hackathon research demo)';

// ---------------------------------------------------------------- helpers

// File cache under data/holdings with a max age in hours; a failed refresh falls back to the stale copy.
async function fresh(name, hours, fn) {
  const f = path.join(DIR, name);
  let st = null;
  try { st = await stat(f); } catch {}
  if (st && Date.now() - st.mtimeMs < hours * 36e5) return readFile(f, 'utf8');
  try {
    const t = await fn();
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, t);
    return t;
  } catch (e) {
    if (st) return readFile(f, 'utf8');
    throw e;
  }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
const decode = s => String(s ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m);

// first <tag>text</tag> inside an XML block
const tagText = (blk, t) => { const m = blk.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? decode(m[1]).trim() : ''; };
const round = (x, d = 4) => (x == null || !isFinite(x) ? null : +x.toFixed(d));
const isCusip = s => /^[0-9A-Z]{8}[0-9]$/i.test(s) && /\d/.test(s.slice(0, 3)) && !/^0+$/.test(s);
// US and Canadian ISINs carry the CUSIP (or CINS) in characters 3-11
const cusipFromIsin = isin => (/^(US|CA)[0-9A-Z]{9}\d$/.test(isin || '') ? isin.slice(2, 11) : null);

// ---------------------------------------------------------------- company-name matching

// Company names from N-PORT, 13F and SEC titles differ in punctuation and suffixes:
// "Exxon Mobil Corp", "ExxonMobil Holdings Corp", "Williams Cos Inc/The", "ARM HOLDINGS PLC /UK".
const SUFFIX = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COMPANIES', 'COS', 'LTD', 'LIMITED', 'PLC', 'NV', 'SA', 'AG', 'SE', 'SPA', 'AB', 'ASA', 'OYJ', 'LP', 'LLC', 'HOLDING', 'HOLDINGS', 'HLDGS', 'GROUP', 'GRP', 'THE', 'NEW', 'DE', 'DEL', 'MFG']);
const NOISE = new Set(['ADR', 'ADS', 'GDR', 'SPONSORED', 'SPON', 'UNSPONSORED', 'ORD', 'SHS', 'REG', 'REGISTERED']);
export function normName(s) {
  let t = decode(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase() // Estée -> ESTEE
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(CLASS|CL|SERIES|SER)\s+[A-Z]\b/g, ' ');
  for (let i = 0; i < 3; i++) t = t.replace(/\s*\/\s*[A-Z]{1,4}\s*\/?\s*$/, ''); // "/DE", "/UK", "/THE", "/NEW/"
  t = t.replace(/&/g, ' AND ').replace(/[.']/g, '').replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(N) (V)\b|\b(S) (A)\b|\b(A) (G)\b/g, (...m) => m.slice(1, 7).join('')); // 13F's "ASML HOLDING N V"
  let w = t.split(/\s+/).filter(x => x && !NOISE.has(x));
  if (w[0] === 'THE' && w.length > 1) w.shift();
  while (w.length > 1 && SUFFIX.has(w.at(-1))) w.pop();
  return w.join(' ');
}
const compact = s => s.replace(/ /g, '');
const classOf = s => (decode(s).toUpperCase().match(/\b(?:CLASS|CL)\s+([A-C])\b/) || [])[1] || '';

// Hand fixes for names the rules can't reach (normalised name -> ticker).
const ALIAS = { 'TAIWAN SEMICONDUCTOR MFG': 'TSM', 'TAIWAN SEMICONDUCTOR': 'TSM', 'ASML': 'ASML', 'ALPHABET#C': 'GOOG', 'ALPHABET#A': 'GOOGL', 'BERKSHIRE HATHAWAY#A': 'BRK-A', 'BERKSHIRE HATHAWAY#B': 'BRK-B', 'JB HUNT TRANSPORT SERVICES': 'JBHT' };
const SIDE_CLASS = /-(P[A-Z]?|U|UN|W|WS|WT|R|RT)$/; // preferred / units / warrants / rights

let nameMap;
// normalised (and space-free) name -> ticker, from SEC titles (big companies first) plus S&P 500 security names.
async function tickerNames() {
  if (nameMap) return nameMap;
  const m = new Map();
  const put = (k, tk) => { if (k && !m.has(k)) m.set(k, tk); };
  const list = await loadTickers();
  for (const pass of [0, 1]) for (const t of list) {
    if (SIDE_CLASS.test(t.ticker) !== !!pass) continue;
    const n = normName(t.name);
    put(n, t.ticker); put(compact(n), t.ticker);
  }
  try {
    for (const r of await indexMembers('SPX')) {
      const n = normName(r.name), c = classOf(r.name);
      if (c) put(`${n}#${c}`, r.ticker);
      put(n, r.ticker); put(compact(n), r.ticker);
    }
  } catch {}
  for (const [k, v] of Object.entries(ALIAS)) m.set(k, v);
  nameMap = m;
  return m;
}

// Exact normalised-name match only (no fuzzy matching: a cash sweep must not turn into a bank's ticker).
export async function tickerFor(name, title = '') {
  const m = await tickerNames();
  const n = normName(name);
  if (!n) return null;
  const c = classOf(name) || classOf(title);
  return (c && m.get(`${n}#${c}`)) || m.get(n) || m.get(compact(n)) || null;
}

// ---------------------------------------------------------------- 1. ETF holdings (N-PORT)

// Symbol -> fund series via SEC's mutual-fund / ETF ticker file.
async function fundSeries(symbol) {
  const raw = await fresh('company_tickers_mf.json', 24 * 7, () => secGet('https://www.sec.gov/files/company_tickers_mf.json'));
  const { fields, data } = JSON.parse(raw);
  const ix = k => fields.indexOf(k);
  const row = data.find(r => String(r[ix('symbol')]).toUpperCase() === symbol);
  return row ? { cik: row[ix('cik')], seriesId: row[ix('seriesId')], classId: row[ix('classId')], symbol } : null;
}

// EDGAR's browse endpoint accepts a series id in place of a CIK and lists only that series' filings,
// so we don't have to open every NPORT-P a big trust (iShares: hundreds per quarter) has filed.
async function latestNport(series) {
  const atom = await fresh(`nport-list-${series.seriesId}.xml`, 12, () =>
    secGet(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${series.seriesId}&type=NPORT-P&dateb=&owner=include&count=20&output=atom`));
  for (const e of atom.split('<entry>').slice(1)) {
    if (tagText(e, 'filing-type') !== 'NPORT-P') continue;
    const href = tagText(e, 'filing-href');
    return { acc: tagText(e, 'accession-number'), filed: tagText(e, 'filing-date'), index: href, dir: href.replace(/[^/]+$/, '') };
  }
  return null;
}

async function nportXml(f) {
  return fresh(`nport-${f.acc}.xml`, Infinity, async () => {
    try { return await secGet(f.dir + 'primary_doc.xml'); }
    catch {
      // older or odd filings: look the XML up in the filing index
      const idx = await secGet(f.dir + 'index.json', false);
      const x = idx.directory.item.find(i => /\.xml$/i.test(i.name));
      if (!x) throw new Error('no XML in ' + f.dir);
      return secGet(f.dir + x.name);
    }
  });
}

export async function etfHoldings(symbol, { top = 60 } = {}) {
  try {
    symbol = String(symbol || '').toUpperCase().replace(/^\$/, '').trim();
    const series = await fundSeries(symbol);
    if (!series) return { error: `${symbol} is not in SEC's fund ticker list` };
    const filing = await latestNport(series);
    if (!filing) return { error: `no NPORT-P filing found for ${symbol} (${series.seriesId})` };
    const xml = await nportXml(filing);
    const gen = xml.slice(xml.indexOf('<genInfo>'), xml.indexOf('</genInfo>'));
    if (tagText(gen, 'seriesId') && tagText(gen, 'seriesId') !== series.seriesId)
      return { error: `filing ${filing.acc} is for series ${tagText(gen, 'seriesId')}, not ${series.seriesId}` };

    // one <invstOrSec> per position; merge repeats of the same security (e.g. lent-out lots)
    const byKey = new Map();
    for (const part of xml.split('<invstOrSec>').slice(1)) {
      const b = part.slice(0, part.indexOf('</invstOrSec>'));
      const name = tagText(b, 'name'), title = tagText(b, 'title');
      const isin = (b.match(/<isin value="([^"]+)"/) || [])[1] || null;
      const raw = tagText(b, 'cusip').toUpperCase();
      const cusip = isCusip(raw) ? raw : cusipFromIsin(isin);
      const h = {
        name, title, cusip, isin,
        value: +tagText(b, 'valUSD') || 0, pct: +tagText(b, 'pctVal') || 0, shares: +tagText(b, 'balance') || 0,
        units: tagText(b, 'units'), assetCat: tagText(b, 'assetCat'), country: tagText(b, 'invCountry') || null,
        idTicker: (b.match(/<ticker value="([^"]+)"/) || [])[1] || null,
      };
      const k = cusip || isin || name;
      const prev = byKey.get(k);
      if (prev) { prev.value += h.value; prev.pct += h.pct; prev.shares += h.shares; } else byKey.set(k, h);
    }
    const all = [...byKey.values()].sort((a, b) => b.pct - a.pct);
    const holdings = [];
    for (const h of all.slice(0, top)) {
      // only stocks get a ticker; cash sweeps, futures and bonds stay null
      let ticker = null;
      if (/^(EC|EP)$/.test(h.assetCat) || !h.assetCat) {
        // a filer-supplied ticker is only trusted for US listings (a local foreign code can clash with a US one)
        const idt = h.idTicker && h.country === 'US' ? await findTicker(h.idTicker) : null;
        ticker = idt ? idt.ticker : await tickerFor(h.name, h.title);
      }
      holdings.push({ name: h.name, ticker, cusip: h.cusip, pct: round(h.pct, 3), value: Math.round(h.value), shares: h.units === 'NS' ? h.shares : null, country: h.country, type: h.assetCat || null });
    }
    const asOf = tagText(gen, 'repPdDate') || tagText(gen, 'repPdEnd');
    return {
      stale: !!asOf && Date.now() - Date.parse(asOf) > 200 * 864e5, // fund closed or stopped filing
      fund: {
        symbol, name: tagText(gen, 'seriesName'), trust: tagText(gen, 'regName'), cik: series.cik, seriesId: series.seriesId,
        netAssets: Math.round(+tagText(xml, 'netAssets') || 0) || null, positions: all.length,
      },
      asOf,
      filed: filing.filed,
      url: filing.dir + 'primary_doc.xml',
      holdings,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- 2. index members (Wikipedia)

// The Nasdaq-100 and Dow articles moved their member tables to "List of ..." pages (2026); keep both.
const INDEX = {
  SPX: { name: 'S&P 500', pages: ['List_of_S%26P_500_companies'], min: 480, max: 520 },
  NDX: { name: 'Nasdaq-100', pages: ['Nasdaq-100', 'List_of_NASDAQ-100_companies'], min: 95, max: 110 },
  DJI: { name: 'Dow Jones Industrial Average', pages: ['Dow_Jones_Industrial_Average', 'List_of_Dow_Jones_Industrial_Average_companies'], min: 30, max: 30 },
};
const INDEX_ALIAS = { SP500: 'SPX', 'S&P500': 'SPX', GSPC: 'SPX', INX: 'SPX', NASDAQ100: 'NDX', DOW: 'DJI', DJIA: 'DJI', DOW30: 'DJI' };

async function wikiGet(page) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://en.wikipedia.org/wiki/${page}`, { headers: { 'User-Agent': WIKI_UA } });
    if (r.ok) return r.text();
    if (r.status === 404) return '';
    await new Promise(s => setTimeout(s, 800 * (i + 1)));
  }
  throw new Error('wikipedia fetch failed ' + page);
}

const cellText = h => decode(h.replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ''))
  .replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();

// Every wikitable on the page as { head:[...], rows:[[...]] }.
function wikiTables(html) {
  html = html.replace(/\sdata-mw='[^']*'/g, '').replace(/\sdata-mw="[^"]*"/g, ''); // JSON attrs can hold '>'
  const out = [];
  for (const t of html.match(/<table[^>]*class="[^"]*wikitable[\s\S]*?<\/table>/g) || []) {
    const rows = (t.match(/<tr[\s\S]*?<\/tr>/g) || []).map(r => [...r.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/g)].map(c => ({ th: c[1] === 'th', text: cellText(c[2]) })));
    const hi = rows.findIndex(r => r.length && r.every(c => c.th));
    if (hi < 0) continue;
    out.push({ head: rows[hi].map(c => c.text), rows: rows.slice(hi + 1).filter(r => r.length).map(r => r.map(c => c.text)) });
  }
  return out;
}

function membersFrom(tables, spec) {
  for (const { head, rows } of tables) {
    const col = re => head.findIndex(h => re.test(h));
    const iT = col(/^(symbol|ticker)/i), iN = col(/^(security|company|name)/i);
    if (iT < 0 || iN < 0 || rows.length < spec.min || rows.length > spec.max + 5) continue;
    const iSub = col(/sub-?industry|subsector/i);
    const iSec = head.findIndex((h, i) => i !== iSub && /sector|industry/i.test(h));
    const iCik = col(/^cik/i), iIsin = col(/^isin/i);
    const out = rows.map(r => {
      const isin = iIsin >= 0 ? (r[iIsin] || '').match(/[A-Z]{2}[0-9A-Z]{9}\d/)?.[0] || null : null;
      return {
        ticker: (r[iT] || '').toUpperCase().replace(/\s+/g, '').replace(/\./g, '-'),
        name: r[iN] || '',
        sector: iSec >= 0 ? r[iSec] || null : null,
        subIndustry: iSub >= 0 ? r[iSub] || null : null,
        cik: iCik >= 0 && /^\d+$/.test(r[iCik] || '') ? Number(r[iCik]) : null,
        isin, cusip: cusipFromIsin(isin),
      };
    }).filter(x => /^[A-Z][A-Z0-9-]{0,7}$/.test(x.ticker));
    if (out.length >= spec.min && out.length <= spec.max + 5) return out;
  }
  return null;
}

async function scrapeIndex(id) {
  const spec = INDEX[id];
  for (const page of spec.pages) {
    const rows = membersFrom(wikiTables(await wikiGet(page)), spec);
    if (rows) return { page, rows };
  }
  throw new Error(`no ${spec.name} member table found on Wikipedia`);
}

const indexMemo = new Map(); // id -> { at, rows }, so lookups in a loop don't re-read the cache file
export async function indexMembers(id) {
  id = String(id || '').toUpperCase().replace(/^\^/, '');
  id = INDEX_ALIAS[id] || id;
  if (!INDEX[id]) return [];
  const memo = indexMemo.get(id);
  if (memo && Date.now() - memo.at < 36e5) return memo.rows;
  const rows = await loadIndex(id);
  if (rows.length) indexMemo.set(id, { at: Date.now(), rows });
  return rows;
}

async function loadIndex(id) {
  try {
    // throws on a bad parse, so junk never gets cached for the day
    const { rows } = JSON.parse(await fresh(`index-${id}.json`, 24, async () => JSON.stringify(await scrapeIndex(id))));
    if (id === 'SPX') return rows.map(r => ({ ...r, taxonomy: 'GICS' }));
    // NDX (ICB sectors) and DJI: take GICS sector / sub-industry / CIK from the S&P 500 row when there is one
    const spx = new Map((await indexMembers('SPX')).map(r => [r.ticker, r]));
    const out = [];
    for (const r of rows) {
      const s = spx.get(r.ticker);
      const cik = s?.cik || (await findTicker(r.ticker))?.cik || null;
      out.push(s ? { ...r, sector: s.sector, subIndustry: s.subIndustry, cik, taxonomy: 'GICS' }
        : { ...r, cik, taxonomy: id === 'NDX' ? 'ICB' : 'other' });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 3. sector members

const SECTORS = {
  SEMIS: { sub: ['Semiconductors', 'Semiconductor Materials & Equipment'], extra: ['TSM', 'ASML', 'ARM'] },
  BANKS: { sub: ['Diversified Banks', 'Regional Banks'] },
  ENERGY: { sector: 'Energy' },
};
const SECTOR_ALIAS = {
  TECH: 'Information Technology', IT: 'Information Technology', TECHNOLOGY: 'Information Technology', HEALTHCARE: 'Health Care',
  FINANCIALS: 'Financials', FINANCE: 'Financials', UTILITIES: 'Utilities', MATERIALS: 'Materials', INDUSTRIALS: 'Industrials',
  REALESTATE: 'Real Estate', REIT: 'Real Estate', REITS: 'Real Estate', STAPLES: 'Consumer Staples', DISCRETIONARY: 'Consumer Discretionary',
  COMMS: 'Communication Services', COMMUNICATION: 'Communication Services', TELECOM: 'Communication Services',
  SEMICONDUCTORS: 'SEMIS', SEMI: 'SEMIS', CHIPS: 'SEMIS', BANK: 'BANKS', OIL: 'ENERGY',
};

// id: SEMIS / BANKS / ENERGY, or any GICS sector or sub-industry name ("Health Care", "Application Software").
export async function sectorMembers(id) {
  const spx = await indexMembers('SPX');
  if (!spx.length) return [];
  const key = String(id || '').toUpperCase().replace(/[^A-Z]/g, '');
  const alias = SECTOR_ALIAS[key];
  const spec = SECTORS[key] || SECTORS[alias] || null;
  const flat = s => (s || '').toUpperCase().replace(/[^A-Z]/g, '');
  let picked;
  if (spec?.sub) picked = spx.filter(r => spec.sub.includes(r.subIndustry));
  else if (spec?.sector) picked = spx.filter(r => r.sector === spec.sector);
  else {
    const want = flat(alias || id);
    picked = spx.filter(r => flat(r.sector) === want);
    if (!picked.length) picked = spx.filter(r => flat(r.subIndustry) === want);
    if (!picked.length && want.length >= 5) picked = spx.filter(r => flat(r.subIndustry).includes(want));
  }
  const out = picked.map(r => ({ ticker: r.ticker, name: r.name, sector: r.sector, subIndustry: r.subIndustry, cik: r.cik, source: 'SPX' }));
  for (const tk of spec?.extra || []) {
    if (out.some(r => r.ticker === tk)) continue;
    const t = await findTicker(tk);
    if (t) out.push({ ticker: t.ticker, name: t.name, sector: 'Information Technology', subIndustry: tk === 'ASML' ? 'Semiconductor Materials & Equipment' : 'Semiconductors', cik: t.cik, source: 'extra' });
  }
  return out;
}

// ---------------------------------------------------------------- 4. 13F holders

const F13_PAGE = 'https://www.sec.gov/dera/data/form-13f'; // redirects to the "Form 13F data sets" page
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const isoDate = s => { const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec((s || '').toUpperCase()); return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : ''; };
const quarterOf = iso => (iso ? `${iso.slice(0, 4)}Q${Math.ceil(+iso.slice(5, 7) / 3)}` : '');
const TOP_KEPT = 40;

// Newest data-set zip linked from the page (newer sets live under a different path than older ones).
async function latestDataset() {
  const html = await secGet(F13_PAGE);
  const links = [...new Set([...html.matchAll(/href="([^"]*_form13f\.zip)"/gi)].map(m => m[1]))];
  const endOf = u => {
    let m = /(\d{2})([a-z]{3})(\d{4})_form13f\.zip$/i.exec(u); // 01jun2026-31aug2026_form13f.zip
    if (m) return `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1]}`;
    m = /(\d{4})q(\d)_form13f\.zip$/i.exec(u);
    return m ? `${m[1]}-${String(m[2] * 3).padStart(2, '0')}-28` : '';
  };
  const best = links.sort((a, b) => endOf(b).localeCompare(endOf(a)))[0];
  if (!best) throw new Error('no 13F data set link found on ' + F13_PAGE);
  return { url: new URL(best, 'https://www.sec.gov').href, name: path.basename(best, '.zip') };
}

async function download(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(file + '.part'));
  await rename(file + '.part', file);
}

const unzipText = (zip, member) => new Promise((res, rej) =>
  execFile('unzip', ['-p', zip, member], { maxBuffer: 256 << 20 }, (e, out) => (e ? rej(e) : res(out))));
const tsv = text => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('\t');
  return lines.slice(1).map(l => { const c = l.split('\t'), o = {}; head.forEach((h, i) => { o[h] = c[i] ?? ''; }); return o; });
};

// Download the newest quarterly data set and write data/holdings/13f/index.json:
// per CUSIP the issuer name, totals and top 40 holders; a filer table; a name -> CUSIP map.
// ticker -> CUSIP from broad ETFs' N-PORT filings: they carry a CUSIP per stock under a full company name
// ("C.H. Robinson Worldwide Inc") that matches SEC titles, where 13F names are abbreviated ("ROBINSON C H WORLDWIDE").
const BRIDGE_FUNDS = ['IVV', 'ITOT', 'QQQ'];
async function tickerBridge(holders, log) {
  const map = {};
  for (const sym of BRIDGE_FUNDS) {
    const r = await etfHoldings(sym, { top: 10000 });
    if (r.error) { log(`ticker bridge: ${sym} skipped (${r.error})`); continue; }
    for (const h of r.holdings) if (h.ticker && h.cusip && holders[h.cusip] && !map[h.ticker]) map[h.ticker] = h.cusip;
  }
  log(`ticker bridge: ${Object.keys(map).length} tickers from ${BRIDGE_FUNDS.join(', ')}`);
  return map;
}

// Pass { zip } to build from a data-set zip already on disk (it is then left in place).
export async function build13f({ log = console.log, zip: localZip = null } = {}) {
  const t0 = Date.now();
  await mkdir(F13, { recursive: true });
  const ds = localZip ? { url: 'file://' + path.resolve(localZip), name: path.basename(localZip, '.zip') } : await latestDataset();
  const zip = localZip ? path.resolve(localZip) : path.join(F13, ds.name + '.zip');
  try { await stat(zip); log('using', zip); } catch { log('downloading', ds.url); await download(ds.url, zip); }

  // Which filings count: the data set's main report period, one position set per filer (CIK).
  const subs = tsv(await unzipText(zip, 'SUBMISSION.tsv'));
  const cover = new Map(tsv(await unzipText(zip, 'COVERPAGE.tsv')).map(r => [r.ACCESSION_NUMBER, r]));
  const periods = {};
  for (const s of subs) if (s.SUBMISSIONTYPE === '13F-HR') periods[s.PERIODOFREPORT] = (periods[s.PERIODOFREPORT] || 0) + 1;
  const period = Object.entries(periods).sort((a, b) => b[1] - a[1])[0][0];
  const byCik = new Map();
  for (const s of subs) {
    if (s.PERIODOFREPORT !== period || !/^13F-HR/.test(s.SUBMISSIONTYPE)) continue;
    const c = cover.get(s.ACCESSION_NUMBER) || {};
    const e = byCik.get(s.CIK) || { base: null, adds: [] };
    const f = { acc: s.ACCESSION_NUMBER, filed: isoDate(s.FILING_DATE), name: c.FILINGMANAGER_NAME || s.CIK };
    // a RESTATEMENT replaces the original report; a NEW HOLDINGS amendment adds positions to it
    if (c.AMENDMENTTYPE === 'NEW HOLDINGS') e.adds.push(f);
    else if (!e.base || f.filed > e.base.filed || (f.filed === e.base.filed && f.acc > e.base.acc)) e.base = f;
    byCik.set(s.CIK, e);
  }
  const filers = [], keep = new Map(); // accession -> filer id
  for (const [cik, e] of byCik) {
    const id = filers.length;
    filers.push([(e.base || e.adds[0]).name, Number(cik)]);
    for (const f of [e.base, ...e.adds]) if (f) keep.set(f.acc, id);
  }
  log(`period ${period}: ${filers.length} filers, ${keep.size} filings`);

  // Stream the info table (~4M rows). It is grouped by accession: sum rows per (filing, CUSIP), flush on change.
  const byCusip = new Map(); // cusip -> { f:[], v:[], s:[] }
  const names = new Map(); // "cusip\tname" -> rows
  let head = null, cur = null, filer = -1, rows = 0;
  const agg = new Map();
  const flush = () => {
    for (const [cu, a] of agg) {
      let e = byCusip.get(cu);
      if (!e) byCusip.set(cu, (e = { f: [], v: [], s: [] }));
      e.f.push(filer); e.v.push(a[0]); e.s.push(a[1]);
    }
    agg.clear();
  };
  const child = spawn('unzip', ['-p', zip, 'INFOTABLE.tsv']);
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let I;
  for await (const line of rl) {
    if (!head) {
      head = line.split('\t');
      const at = k => head.indexOf(k);
      I = { acc: at('ACCESSION_NUMBER'), name: at('NAMEOFISSUER'), cusip: at('CUSIP'), val: at('VALUE'), amt: at('SSHPRNAMT'), typ: at('SSHPRNAMTTYPE'), pc: at('PUTCALL') };
      continue;
    }
    const c = line.split('\t');
    if (c[I.acc] !== cur) { flush(); cur = c[I.acc]; filer = keep.has(cur) ? keep.get(cur) : -1; }
    if (filer < 0 || c[I.pc] || c[I.typ] !== 'SH') continue; // skip other periods, options and bonds
    const cu = (c[I.cusip] || '').trim().toUpperCase();
    if (!isCusip(cu)) continue;
    const v = +c[I.val] || 0, s = +c[I.amt] || 0;
    const a = agg.get(cu);
    if (a) { a[0] += v; a[1] += s; } else agg.set(cu, [v, s]);
    const nk = cu + '\t' + (c[I.name] || '').trim();
    names.set(nk, (names.get(nk) || 0) + 1);
    rows++;
  }
  flush();
  log(`${rows} share rows, ${byCusip.size} CUSIPs`);

  // issuer names per CUSIP, most common first (filers spell and truncate them differently)
  const issuer = new Map();
  for (const [k, n] of names) {
    const [cu, nm] = k.split('\t');
    if (!issuer.has(cu)) issuer.set(cu, []);
    issuer.get(cu).push([nm, n]);
  }
  names.clear();
  for (const v of issuer.values()) v.sort((a, b) => b[1] - a[1]);

  const holders = {}, nameIx = {};
  let fixed = 0, repriced = 0;
  for (const [cu, e] of byCusip) {
    // merge a filer's original + new-holdings rows
    const m = new Map();
    for (let i = 0; i < e.f.length; i++) {
      const p = m.get(e.f[i]);
      if (p) { p[0] += e.v[i]; p[1] += e.s[i]; } else m.set(e.f[i], [e.v[i], e.s[i]]);
    }
    let list = [...m].map(([f, [v, s]]) => [f, v, s]);
    // Values are in dollars since 2023, but some filers still report thousands (implied price ~1000x under the
    // median): scale those up. Rows priced far above the median (a $41B AstraZeneca stake from a small adviser)
    // are re-valued at shares x median price, so a typo can't top the list.
    const px = list.filter(x => x[1] > 0 && x[2] > 0).map(x => x[1] / x[2]).sort((a, b) => a - b);
    const med = px.length >= 5 ? px[px.length >> 1] : 0;
    if (med) for (const x of list) {
      const p = x[2] > 0 ? x[1] / x[2] : 0;
      if (p > 0 && p < med / 300 && p > med / 3000) { x[1] *= 1000; fixed++; }
      else if (p > med * 20) { x[1] = x[2] * med; repriced++; }
    }
    const total = list.reduce((s, x) => s + x[1], 0);
    if (total < 1e6) continue; // drop the long tail of tiny / mistyped CUSIPs
    const shares = list.reduce((s, x) => s + x[2], 0);
    list.sort((a, b) => b[1] - a[1]);
    const variants = issuer.get(cu) || [];
    holders[cu] = [variants[0]?.[0] || '', Math.round(total), list.length, Math.round(shares), list.slice(0, TOP_KEPT).flatMap(x => [x[0], Math.round(x[1]), Math.round(x[2])])];
    // name -> CUSIP from the three most common spellings; a shared name goes to the most widely held CUSIP
    // (holder count, not value: a mis-entered bond line can carry a huge value but has few holders)
    for (const [nm] of variants.slice(0, 3)) {
      const n = normName(nm);
      for (const k of [n, compact(n)]) if (k && (!nameIx[k] || holders[nameIx[k]][2] < list.length)) nameIx[k] = cu;
    }
  }
  const tickers = await tickerBridge(holders, log);
  const iso = isoDate(period);
  const meta = { quarter: quarterOf(iso), period: iso, dataset: ds.name, source: ds.url, built: new Date().toISOString(), filers: filers.length, cusips: Object.keys(holders).length, tickers: Object.keys(tickers).length, unitFixes: fixed, repriced };
  const file = path.join(F13, 'index.json');
  await writeFile(file + '.tmp', JSON.stringify({ meta, filers, holders, names: nameIx, tickers }));
  await rename(file + '.tmp', file); // atomic: holdersReady() never sees half a file
  await writeFile(path.join(F13, 'meta.json'), JSON.stringify({ ...meta, bytes: (await stat(file)).size }, null, 1));
  if (!localZip) await unlink(zip).catch(() => {}); // the zip is ~100MB; a rebuild re-downloads it in seconds
  ix13 = null;
  log(`built ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${meta.cusips} CUSIPs, ${fixed} thousands fixes, ${repriced} repriced)`);
  return meta;
}

// true once the 13F index exists
export async function holdersReady() {
  return !!(await holdersMeta());
}

// { quarter, period, dataset, built, filers, cusips, tickers, bytes, ... } or null when not built
export async function holdersMeta() {
  try {
    await stat(path.join(F13, 'index.json'));
    return JSON.parse(await readFile(path.join(F13, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

let ix13;
async function load13f() {
  if (ix13) return ix13;
  try { ix13 = JSON.parse(await readFile(path.join(F13, 'index.json'), 'utf8')); } catch { return null; }
  return ix13;
}

// ticker -> CUSIP from the Nasdaq-100 and Dow lists (their ISINs carry it): exact share class, e.g. GOOG vs GOOGL
let listCusips;
async function loadListCusips() {
  if (!listCusips) {
    const m = new Map();
    for (const id of ['NDX', 'DJI']) for (const r of await indexMembers(id)) if (r.cusip) m.set(r.ticker, r.cusip);
    listCusips = m;
  }
  return listCusips;
}
const cusipOfTicker = async tk => (await loadListCusips()).get(tk) || null;

// 13F issuer names are often cut at ~28 characters ("TAIWAN SEMICONDUCTOR MANUFAC"), so beyond an exact
// normalised match also accept an index name that is a long prefix of the wanted one (longest wins).
function byName(n, ix) {
  if (!n) return null;
  if (ix.names[n] || ix.names[compact(n)]) return ix.names[n] || ix.names[compact(n)];
  let best = null;
  for (const k of Object.keys(ix.names)) if (k.length >= 18 && n.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? ix.names[best] : null;
}

// A known ticker -> CUSIP. Sources in order of trust: the N-PORT bridge, Nasdaq-100 / Dow ISINs, then the SEC
// title and S&P 500 name looked up among 13F issuer names. A candidate with under a fifth of the best one's
// holders is a stale CUSIP (renamed company, old ISIN: GE) and is skipped; share classes (GOOG/GOOGL) survive.
async function tickerCusip(t, ix) {
  const spxName = (await indexMembers('SPX')).find(r => r.ticker === t.ticker)?.name;
  const cands = [ix.tickers?.[t.ticker], await cusipOfTicker(t.ticker), byName(normName(t.name), ix), spxName && byName(normName(spxName), ix)]
    .filter(cu => cu && ix.holders[cu]);
  if (!cands.length) return null;
  const most = Math.max(...cands.map(cu => ix.holders[cu][2]));
  return cands.find(cu => ix.holders[cu][2] >= most * 0.2);
}

// CUSIP, ticker or company name -> { cusip, ticker } in the index.
async function resolveIssuer(q, ix) {
  q = String(q || '').trim().replace(/^\$/, '');
  if (!q) return null;
  const up = q.toUpperCase();
  if (isCusip(up) && ix.holders[up]) return { cusip: up, ticker: null };
  const known = /^[A-Z][A-Z0-9.-]{0,6}$/i.test(q) ? await findTicker(up.replace(/\./g, '-')) : null;
  const viaTicker = async t => { const cu = t && await tickerCusip(t, ix); return cu ? { cusip: cu, ticker: t.ticker } : null; };
  // All caps ("AMD", "BNY") is a ticker: resolve it or give up, never prefix-match it as a name (DHI -> DHI GROUP).
  if (known && q === up) return viaTicker(known);

  // A name goes S&P / SEC name -> ticker -> CUSIP first: 13F issuer names are loose ("STATE STREET" is also
  // written on SPDR ETF lines), so a raw 13F name match only comes after.
  const n = normName(q);
  const tk = await tickerFor(q);
  const hit = (tk && await viaTicker(await findTicker(tk))) || (byName(n, ix) && { cusip: byName(n, ix), ticker: null }) || (await viaTicker(known));
  if (hit) return hit;
  // the query is the start of a name: word boundary, most widely held first ("Amd" never -> AMDOCS)
  let best = null;
  for (const [k, cu] of Object.entries(ix.names)) {
    if (k.startsWith(n + ' ') && (!best || ix.holders[cu][2] > ix.holders[best][2])) best = cu;
  }
  return best ? { cusip: best, ticker: null } : null;
}

// ticker for an index CUSIP: the N-PORT bridge, the Nasdaq-100 / Dow lists, or the issuer name
async function tickerOfCusip(cu, issuer) {
  for (const [tk, c] of Object.entries(ix13?.tickers || {})) if (c === cu) return tk;
  for (const [tk, c] of await loadListCusips()) if (c === cu) return tk;
  const exact = await tickerFor(issuer);
  if (exact) return exact;
  const n = normName(issuer); // truncated 13F name: first SEC name that starts with it (biggest company first)
  if (n.length < 20) return null;
  for (const [k, tk] of await tickerNames()) if (k.startsWith(n)) return tk;
  return null;
}

const NOT_BUILT = { error: '13F index not built yet: run node engine/sources/holdings.mjs build13f' };

export async function holders(nameOrCusip, { top = 20 } = {}) {
  try {
    const ix = await load13f();
    if (!ix) return NOT_BUILT;
    const hit = await resolveIssuer(nameOrCusip, ix);
    if (!hit) return { error: `no 13F issuer matches "${nameOrCusip}"` };
    const cu = hit.cusip;
    const [issuer, totalValue, holderCount, totalShares, flat] = ix.holders[cu];
    const list = [];
    for (let i = 0; i < flat.length && list.length < top; i += 3) list.push({ filer: ix.filers[flat[i]][0], cik: ix.filers[flat[i]][1], value: flat[i + 1], shares: flat[i + 2] });
    const shown = list.reduce((s, h) => s + h.value, 0) || 1;
    for (const h of list) { h.pctOfShown = round((h.value / shown) * 100, 2); h.pctOf13F = round((h.value / totalValue) * 100, 2); }
    return { issuer, cusip: cu, ticker: hit.ticker || await tickerOfCusip(cu, issuer), quarter: ix.meta.quarter, period: ix.meta.period, holderCount, totalValue, totalShares, holders: list };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Filers found among the top-40 holders of several of the given companies, most overlaps then biggest combined value.
export async function sharedHolders(namesOrCusips, { top = 15, min = 2 } = {}) {
  try {
    const ix = await load13f();
    if (!ix) return NOT_BUILT;
    const companies = [], agg = new Map();
    for (const q of namesOrCusips || []) {
      const hit = await resolveIssuer(q, ix);
      if (!hit) { companies.push({ query: q, error: 'not found' }); continue; }
      const cu = hit.cusip;
      if (companies.some(c => c.cusip === cu)) continue;
      const [issuer, , , , flat] = ix.holders[cu];
      companies.push({ query: q, issuer, cusip: cu, ticker: hit.ticker || await tickerOfCusip(cu, issuer) });
      for (let i = 0; i < flat.length; i += 3) {
        const f = flat[i];
        const e = agg.get(f) || { filer: ix.filers[f][0], cik: ix.filers[f][1], count: 0, value: 0, companies: [], values: {} };
        e.count++; e.value += flat[i + 1]; e.companies.push(issuer); e.values[issuer] = flat[i + 1];
        agg.set(f, e);
      }
    }
    // overlap needs at least two companies: with one found, nothing is "shared"
    const found = companies.filter(c => c.cusip).length;
    const need = Math.max(2, Math.min(min, found));
    const list = found < 2 ? [] : [...agg.values()].filter(e => e.count >= need).sort((a, b) => b.count - a.count || b.value - a.value).slice(0, top);
    return { quarter: ix.meta.quarter, period: ix.meta.period, companies, note: `overlap among each company's top ${TOP_KEPT} 13F holders`, holders: list };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- CLI
// node engine/sources/holdings.mjs build13f | etf SMH | index SPX | sector SEMIS | holders NVIDIA | shared NVIDIA AMD Broadcom
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const show = x => console.log(JSON.stringify(x, null, 1));
  if (cmd === 'build13f') await build13f({ zip: args[0] || null });
  else if (cmd === 'etf') show(await etfHoldings(args[0] || 'SMH', { top: +(args[1] || 60) }));
  else if (cmd === 'index') show(await indexMembers(args[0] || 'SPX'));
  else if (cmd === 'sector') show(await sectorMembers(args.join(' ') || 'SEMIS'));
  else if (cmd === 'holders') show(await holders(args.join(' ') || 'NVIDIA'));
  else if (cmd === 'shared') show(await sharedHolders(args.length ? args : ['NVIDIA', 'AMD', 'Broadcom']));
  else if (cmd === 'ready') show({ ready: await holdersReady(), meta: await holdersMeta() });
  else console.log('usage: node engine/sources/holdings.mjs build13f [local.zip] | etf SYM | index SPX|NDX|DJI | sector ID | holders NAME | shared A B C | ready');
}
