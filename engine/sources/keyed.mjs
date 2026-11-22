// Sources that want an API key: US patents by assignee, Korean filings (OpenDART), and which keys are set.
// No npm deps. Every export resolves: failures come back as { error }, a missing key as needsKey()'s object.
// Each keyed source has a keyless fallback that is used when the key is missing (or the keyed call fails),
// unless { fallback: false } is passed:
//   patents      PatentsView PatentSearch (PATENTSVIEW_API_KEY)  -> Google Patents xhr (no key, rate-limited)
//   dartFilings  OpenDART list.json (DART_API_KEY)               -> dart.fss.or.kr disclosure search page (no key)
//   dartFinancials OpenDART fnlttSinglAcnt.json (DART_API_KEY)   -> Yahoo Finance fundamentals timeseries (no key)
// Fallback results carry `source` and `fallbackFor: '<KEY NAME>'`, never `error`/`needsKey`.
// Key values are never put in error messages, cache names or logs.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsKey } from '../env.mjs';
import { cached } from '../sec.mjs';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const UA = 'Mozilla/5.0 (pocket-terminal demo)';
const TIMEOUT = 20000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
const errMsg = e => String(e?.message || e);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const clean = s => String(s || '').replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m).replace(/\s+/g, ' ').trim();

// One HTTP call. `label` is what errors show: never the URL (OpenDART puts the key in the query string).
async function request(url, { label, method = 'GET', headers = {}, body, retries = 1 } = {}) {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(url, { method, headers: { 'User-Agent': UA, ...headers }, body, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) {
      const code = e?.cause?.code || e?.name || 'error';
      if (i < retries && code !== 'ENOTFOUND') { await sleep(800); continue; }
      throw new Error(`${label} unreachable (${code})`);
    }
    if (r.ok) return r.text();
    if ((r.status === 429 || r.status >= 500) && i < retries) { await sleep(1500 * (i + 1)); continue; }
    throw new Error(`${label} HTTP ${r.status}`);
  }
}

// cached() for data that changes daily: today's file, else (when the fetch fails) the newest earlier copy.
async function cachedDaily(prefix, ext, fn) {
  try {
    return { text: await cached(`${prefix}-${today()}.${ext}`, fn), stale: null };
  } catch (e) {
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{4}-\\d{2}-\\d{2})\\.${ext}$`);
    const old = (await readdir(DATA).catch(() => [])).map(f => re.exec(f)).filter(Boolean).sort((a, b) => b[1].localeCompare(a[1]))[0];
    if (!old) throw e;
    return { text: await cached(old[0], fn), stale: old[1] };
  }
}

// ---------------------------------------------------------------- key status

export const KEY_NAMES = ['CEREBRAS_API_KEY', 'EIA_API_KEY', 'NASS_API_KEY', 'PATENTSVIEW_API_KEY', 'DART_API_KEY', 'COMTRADE_API_KEY', 'FRED_API_KEY', 'SEC_USER_AGENT'];

// { NAME: true|false } only. Never values.
export async function keyStatus() {
  try { return Object.fromEntries(KEY_NAMES.map(k => [k, !!process.env[k]])); }
  catch (e) { return { error: errMsg(e) }; }
}

// ---------------------------------------------------------------- patents

// Short CPC subclass titles (paraphrased from the CPC scheme) for the subclasses tech companies patent in.
const CPC = {
  A61B: 'Diagnosis; surgery; identification', A61K: 'Medical preparations', A61N: 'Electrotherapy; radiation therapy', A61P: 'Therapeutic activity of compounds', A63F: 'Card, board and video games',
  B01D: 'Separation; filtering; gas cleaning', B01J: 'Chemical processes; catalysis', B05C: 'Applying liquids to surfaces', B08B: 'Cleaning in general', B23K: 'Soldering, welding, laser cutting', B24B: 'Grinding and polishing',
  B25J: 'Manipulators; robots', B29C: 'Shaping or joining plastics', B32B: 'Layered products', B33Y: 'Additive manufacturing', B60K: 'Vehicle propulsion and drive', B60L: 'Electric vehicle propulsion', B60R: 'Vehicle fittings and electrics',
  B60W: 'Vehicle sub-unit control; driver assistance', B62D: 'Motor vehicles', B64C: 'Aeroplanes; helicopters', B64D: 'Aircraft equipment', B64G: 'Spacecraft', B64U: 'Unmanned aerial vehicles', B65G: 'Conveying; load handling',
  B81B: 'Microstructural devices (MEMS)', B81C: 'Making MEMS', B82Y: 'Nanotechnology',
  C01B: 'Non-metallic elements and compounds', C07D: 'Heterocyclic compounds', C08G: 'Polymers (polymerisation)', C08K: 'Polymer additives', C08L: 'Polymer compositions', C09D: 'Coating compositions', C09J: 'Adhesives',
  C09K: 'Materials for miscellaneous applications', C12N: 'Microorganisms; genetic engineering', C12Q: 'Nucleic-acid and enzyme assays', C23C: 'Coating metals; vapour deposition', C23F: 'Etching metals', C25D: 'Electroplating', C30B: 'Single-crystal growth',
  F16H: 'Gearing', F21V: 'Lighting device details', F24F: 'Air conditioning; ventilation', F25B: 'Refrigeration machines', F25D: 'Refrigerators', F28D: 'Heat exchangers', F28F: 'Heat-exchange details',
  G01B: 'Measuring length, thickness, angles', G01C: 'Navigation; gyroscopes; surveying', G01D: 'Measuring (general)', G01J: 'Measuring light and infrared', G01K: 'Measuring temperature', G01L: 'Measuring force and pressure',
  G01M: 'Testing machines and structures', G01N: 'Analysing materials', G01R: 'Measuring electric variables; testing electronics', G01S: 'Radar, lidar, sonar, satellite positioning', G01T: 'Measuring nuclear or X-radiation', G01V: 'Geophysics; detecting objects',
  G02B: 'Optical elements and systems', G02C: 'Spectacles; contact lenses', G02F: 'Electro-optic devices (incl. LCDs)', G03B: 'Cameras and projectors', G03F: 'Photolithography; photomasks; resists', G03G: 'Electrography; xerography', G04G: 'Electronic timepieces',
  G05B: 'Control systems in general', G05D: 'Control of non-electric variables (vehicle position)', G05F: 'Regulating electric variables', G06E: 'Optical computing', G06F: 'Electric digital data processing', G06G: 'Analogue computers',
  G06J: 'Hybrid computing', G06K: 'Graphical data reading; record carriers', G06N: 'AI, machine learning and other computing models', G06Q: 'Business and finance data processing', G06T: 'Image processing and generation', G06V: 'Image and video recognition',
  G07C: 'Checking apparatus; access registers', G07F: 'Vending and payment machines', G08B: 'Alarm systems', G08C: 'Telemetry; remote control', G08G: 'Traffic control', G09B: 'Education and simulation appliances', G09F: 'Displays; signs',
  G09G: 'Display control circuits', G10H: 'Electronic musical instruments', G10K: 'Acoustics; sound-producing devices', G10L: 'Speech and audio processing', G11B: 'Disk and tape storage', G11C: 'Semiconductor memory (static stores)',
  G16B: 'Bioinformatics', G16C: 'Computational chemistry', G16H: 'Healthcare informatics', G16Y: 'Internet of Things', G21K: 'Particle and X-ray/EUV handling',
  H01B: 'Cables; conductors; insulators', H01F: 'Magnets; inductors; transformers', H01G: 'Capacitors', H01H: 'Switches; relays', H01J: 'Discharge tubes; plasma and electron-beam apparatus', H01L: 'Semiconductor devices (legacy, moving to H10)',
  H01M: 'Batteries; fuel cells', H01P: 'Waveguides; resonators', H01Q: 'Antennas', H01R: 'Electrical connectors', H01S: 'Lasers', H02H: 'Protective circuits', H02J: 'Power supply and distribution; charging',
  H02K: 'Electric motors and generators', H02M: 'Power conversion (AC/DC, DC/DC)', H02P: 'Motor and generator control', H02S: 'Photovoltaic power generation', H03B: 'Oscillators', H03F: 'Amplifiers', H03G: 'Gain control',
  H03H: 'Filters; impedance networks; resonators', H03K: 'Pulse and digital logic circuits', H03L: 'Oscillator control; PLLs', H03M: 'Coding; ADC/DAC; error correction', H04B: 'Transmission (radio, optical)', H04J: 'Multiplexing',
  H04K: 'Secret communication; jamming', H04L: 'Digital transmission; networking; security', H04M: 'Telephony', H04N: 'Video; image sensors; TV', H04Q: 'Switching; selecting', H04R: 'Speakers; microphones', H04S: 'Stereo and spatial audio',
  H04W: 'Wireless networks', H05B: 'Electric heating; lighting control', H05K: 'Printed circuits; housings; cooling',
  H10B: 'Electronic memory devices', H10D: 'Inorganic semiconductor devices (transistors, diodes)', H10F: 'Photodetectors; solar cells', H10H: 'Inorganic LEDs', H10K: 'Organic devices (OLED)',
  H10N: 'Other solid-state devices (thermoelectric, superconducting, magnetic)', H10P: 'Semiconductor manufacturing processes and apparatus', H10W: 'Semiconductor packaging and interconnects',
  Y02D: 'Energy-efficient ICT', Y02E: 'Low-emission energy', Y02P: 'Climate mitigation in manufacturing', Y02T: 'Climate mitigation in transport', Y02W: 'Climate mitigation in waste', Y04S: 'Smart grids', Y10S: 'Former USPC collections', Y10T: 'Former USPC collections',
};
const cpcTitle = code => CPC[String(code).replace(/\s+/g, '').slice(0, 4).toUpperCase()] || null;

// Assignee name matching: drop punctuation and legal-form words, then every remaining word must appear.
const SUFFIX = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'plc', 'sa', 'ag', 'gmbh', 'nv', 'bv', 'the', 'kk', 'spa', 'ab', 'oy', 'se', 'ulc', 'tld']);
const coreTokens = name => String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(t => t && !SUFFIX.has(t));
function assigneeMatcher(name) {
  const want = coreTokens(name);
  return cand => { const have = new Set(coreTokens(cand)); return want.length > 0 && want.every(t => have.has(t)); };
}

// Keyed: PatentsView PatentSearch API. NOTE: search.patentsview.org has been NXDOMAIN since USPTO moved PatentsView
// to the Open Data Portal (2026-03-20); this path is kept from the PatentSearch docs in case it returns, and any
// failure falls through to Google Patents. Request: POST /api/v1/patent/ {q,f,s,o}, header X-Api-Key.
async function patentSearch(assignee, { years, max }) {
  const y0 = new Date().getFullYear() - years + 1, from = `${y0}-01-01`;
  const name = coreTokens(assignee).join(' ') || assignee;
  const body = JSON.stringify({
    q: { _and: [{ _contains: { 'assignees.assignee_organization': name } }, { _gte: { patent_date: from } }] },
    f: ['patent_id', 'patent_title', 'patent_date', 'assignees.assignee_organization', 'cpc_current.cpc_subclass_id', 'cpc_current.cpc_group_id'],
    s: [{ patent_date: 'desc' }],
    o: { size: Math.max(1, Math.min(max, 1000)) },
  });
  const { text, stale } = await cachedDaily(`pat-pv-${slug(assignee)}-${y0}-${max}`, 'json', async () => {
    const t = await request('https://search.patentsview.org/api/v1/patent/', {
      label: 'PatentsView PatentSearch', method: 'POST', retries: 0, body,
      headers: { 'X-Api-Key': process.env.PATENTSVIEW_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    const j = JSON.parse(t);
    if (j.error || !Array.isArray(j.patents)) throw new Error('PatentsView PatentSearch: unexpected response');
    return t;
  });
  const j = JSON.parse(text);
  const byYear = {}, sub = new Map(), grp = new Map();
  for (const p of j.patents) {
    const y = (p.patent_date || '').slice(0, 4);
    if (y) byYear[y] = (byYear[y] || 0) + 1;
    const seenS = new Set(), seenG = new Set();
    for (const c of p.cpc_current || []) {
      if (c.cpc_subclass_id && !seenS.has(c.cpc_subclass_id)) { seenS.add(c.cpc_subclass_id); sub.set(c.cpc_subclass_id, (sub.get(c.cpc_subclass_id) || 0) + 1); }
      if (c.cpc_group_id && !seenG.has(c.cpc_group_id)) { seenG.add(c.cpc_group_id); grp.set(c.cpc_group_id, (grp.get(c.cpc_group_id) || 0) + 1); }
    }
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([code, count]) => ({ code, title: cpcTitle(code), count }));
  return {
    assignee, total: j.total_hits ?? j.patents.length, byYear, topCpc: top(sub, 15), allCpc: top(sub, 200), groups: top(grp, 40),
    recent: j.patents.slice(0, 10).map(p => ({ id: p.patent_id, title: p.patent_title, date: p.patent_date })),
    sampled: (j.total_hits ?? 0) > j.patents.length, cpcLevel: 'subclass', window: { from, to: today() }, source: 'patentsview', ...(stale && { stale }),
  };
}

// Keyless: Google Patents' own search backend (patents.google.com/xhr/query), one request per grant year.
// Google rate-limits this per network (HTTP 503 "unusual traffic" after a few dozen quick requests), so past
// years are cached for good, the current year daily, and an older copy is reused when Google refuses.
async function googleYear(assignee, year) {
  // inner query as the Google Patents page builds it (spaces as +, ':' left raw); commas would OR assignee names
  const inner = Object.entries({
    assignee: assignee.replace(/[,.;:()"']/g, ' ').replace(/\s+/g, ' ').trim(),
    country: 'US', status: 'GRANT', type: 'PATENT', dups: 'language',
    after: `publication:${year}0101`, before: `publication:${year}1231`, sort: 'new', num: '20',
  }).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+').replace(/%3A/gi, ':')}`).join('&');
  const url = `https://patents.google.com/xhr/query?url=${encodeURIComponent(inner)}&exp=`;
  const fetchIt = async () => {
    const t = await request(url, { label: 'Google Patents', retries: 0, headers: { Accept: 'application/json' } })
      .catch(e => { throw /HTTP (429|503)/.test(e.message) ? new Error(`Google Patents is rate-limiting this network (${e.message.slice(-8)}); try again later`) : e; });
    if (!t.trimStart().startsWith('{')) throw new Error('Google Patents refused the request (rate limit)');
    if (!JSON.parse(t).results) throw new Error('Google Patents: unexpected response');
    return t;
  };
  const prefix = `pat-gp-${slug(assignee)}-${year}`;
  if (year < new Date().getFullYear()) return { text: await cached(`${prefix}.json`, fetchIt), stale: null };
  return cachedDaily(prefix, 'json', fetchIt);
}

async function googlePatents(assignee, { years }) {
  const y1 = new Date().getFullYear(), y0 = y1 - years + 1;
  const isMatch = assigneeMatcher(assignee);
  const byYear = {}, cpc = new Map(), recent = [], match = {};
  let approx = false, stale = null;
  for (let y = y1; y >= y0; y--) {
    const got = await googleYear(assignee, y);
    if (got.stale) stale = got.stale;
    const r = JSON.parse(got.text).results;
    const total = r.total_num_results || 0;
    byYear[y] = total;
    if (total > 1000) approx = true;
    // summary facets are per-mille shares of a sample of up to 1000 results: share x total = estimated count
    for (const f of r.summary?.cpc || []) {
      if (f.key === 'Total') continue;
      cpc.set(f.key, (cpc.get(f.key) || 0) + Math.round((f.value / 1000) * total));
    }
    const asg = (r.summary?.assignee || []).filter(f => f.key !== 'Total' && isMatch(f.key));
    match[y] = +(Math.min(1000, asg.reduce((s, f) => s + f.value, 0)) / 1000).toFixed(3);
    for (const x of (r.cluster || []).flatMap(c => c.result || [])) {
      const p = x.patent || {};
      if (!isMatch(clean(p.assignee))) continue; // the assignee search is fuzzy: keep only real matches
      recent.push({ id: p.publication_number, title: clean(p.title).replace(/\s*…$/, '…'), date: p.grant_date || p.publication_date });
    }
    if (y > y0) await sleep(400);
  }
  const seen = new Set();
  const allCpc = [...cpc].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, title: cpcTitle(code), count }));
  return {
    assignee,
    total: Object.values(byYear).reduce((s, n) => s + n, 0),
    byYear,
    topCpc: allCpc.slice(0, 15), allCpc,
    recent: recent.filter(p => p.id && !seen.has(p.id) && seen.add(p.id)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10),
    cpcLevel: 'subclass', approx, assigneeMatch: match,
    window: { from: `${y0}-01-01`, to: today() }, basis: 'US granted utility patents by grant year', source: 'google-patents',
    ...(stale && { stale }),
  };
}

// patents('NVIDIA Corporation', { years: 3 }) -> { assignee, total, byYear, topCpc:[{code,title,count}], recent:[{id,title,date}], source, ... }
export async function patents(assignee, { years = 3, max = 500, fallback = true } = {}) {
  try {
    assignee = String(assignee || '').trim();
    if (!assignee) return { error: 'assignee required' };
    years = Math.max(1, Math.min(20, Math.floor(+years) || 3));
    max = Math.max(1, Math.min(1000, Math.floor(+max) || 500));
    const missing = needsKey('PATENTSVIEW_API_KEY');
    let keyedError = null;
    if (!missing) {
      try { return await patentSearch(assignee, { years, max }); } catch (e) { keyedError = errMsg(e); }
    }
    if (!fallback) return missing || { error: keyedError };
    try {
      const out = await googlePatents(assignee, { years });
      return { ...out, fallbackFor: 'PATENTSVIEW_API_KEY', ...(keyedError && { keyedError }) };
    } catch (e) {
      return missing ? { ...missing, fallbackError: errMsg(e) } : { error: `${keyedError}; fallback: ${errMsg(e)}` };
    }
  } catch (e) { return { error: errMsg(e) }; }
}

// techOverlap(a, b) -> { shared:[{code,title,a,b}], jaccard, weighted, onlyA:[{code,title,count}], onlyB:[...] }
// Uses CPC groups when both sides came from PatentSearch, else every CPC subclass each side reports (Google's
// facet lists ~19 subclasses per year, so "only" means "not among the other's reported subclasses").
export async function techOverlap(assigneeA, assigneeB, opts = {}) {
  try {
    const A = await patents(assigneeA, opts);
    if (A.error) return { ...A, side: 'a' };
    const B = await patents(assigneeB, opts);
    if (B.error) return { ...B, side: 'b' };
    const useGroups = A.groups?.length && B.groups?.length;
    const ma = new Map((useGroups ? A.groups : A.allCpc || A.topCpc).map(x => [x.code, x.count]));
    const mb = new Map((useGroups ? B.groups : B.allCpc || B.topCpc).map(x => [x.code, x.count]));
    const union = new Set([...ma.keys(), ...mb.keys()]);
    let mins = 0, maxs = 0;
    for (const c of union) { const a = ma.get(c) || 0, b = mb.get(c) || 0; mins += Math.min(a, b); maxs += Math.max(a, b); }
    const shared = [...ma.keys()].filter(c => mb.has(c)).map(c => ({ code: c, title: cpcTitle(c), a: ma.get(c), b: mb.get(c) }))
      .sort((x, y) => Math.min(y.a, y.b) - Math.min(x.a, x.b));
    const only = (m, o) => [...m].filter(([c]) => !o.has(c)).sort((x, y) => y[1] - x[1]).map(([code, count]) => ({ code, title: cpcTitle(code), count }));
    return {
      a: A.assignee, b: B.assignee, shared,
      jaccard: union.size ? +(shared.length / union.size).toFixed(3) : 0,
      weighted: maxs ? +(mins / maxs).toFixed(3) : 0,
      onlyA: only(ma, mb), onlyB: only(mb, ma),
      level: useGroups ? 'group' : 'subclass', totals: { a: A.total, b: B.total }, window: A.window,
      source: A.source === B.source ? A.source : `${A.source}+${B.source}`,
      ...(A.fallbackFor && { fallbackFor: A.fallbackFor }),
    };
  } catch (e) { return { error: errMsg(e) }; }
}

// ---------------------------------------------------------------- Korean filings (OpenDART)

// corp_codes checked against dart.fss.or.kr's disclosure search (00126380 -> 삼성전자, 00164779 -> SK하이닉스).
const KR = {
  samsung: { corp_code: '00126380', name: 'Samsung Electronics', nameKo: '삼성전자', stock: '005930', yahoo: '005930.KS' },
  // SK hynix also lists ADRs on Nasdaq (SKHY) and files 6-Ks with the SEC; Samsung has filed nothing there since 2015.
  skhynix: { corp_code: '00164779', name: 'SK hynix', nameKo: 'SK하이닉스', stock: '000660', yahoo: '000660.KS', sec: { cik: 2120882, ticker: 'SKHY' } },
};
function resolveCompany(c) {
  const raw = String(c || '').trim();
  const k = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (raw.includes('삼성전자') || ['samsung', 'samsungelectronics', '005930', '005930ks', '00126380', 'ssnlf'].includes(k)) return { ...KR.samsung };
  if (raw.includes('하이닉스') || ['skhynix', 'hynix', '000660', '000660ks', '00164779', 'skhy'].includes(k)) return { ...KR.skhynix };
  if (/^\d{8}$/.test(k)) return { corp_code: k, name: null };
  return null;
}
const UNKNOWN = c => ({ error: `unknown company "${c}": use 'samsung', 'skhynix' or an 8-digit DART corp_code` });

// Report titles -> English label and a kind. Matched with spaces and middle dots removed.
const TITLES = [
  [/^분기보고서/, 'Quarterly report', 'periodic'], [/^반기보고서/, 'Half-year report', 'periodic'], [/^사업보고서/, 'Annual report', 'periodic'],
  [/영업\(잠정\)실적/, 'Preliminary earnings', 'earnings'], [/매출액또는손익구조/, 'Revenue/profit change of 30%+', 'earnings'],
  [/배당결정/, 'Dividend decision', 'dividend'], [/주주명부폐쇄|기준일/, 'Record date set', 'dividend'], [/기업설명회/, 'Investor relations event', 'ir'],
  [/공정공시/, 'Fair disclosure', 'news'],
  [/자기주식취득결정/, 'Share buyback decision', 'buyback'], [/자기주식취득결과/, 'Share buyback result', 'buyback'], [/자기주식처분/, 'Treasury share disposal', 'buyback'],
  [/주식소각결정/, 'Share cancellation', 'buyback'], [/신탁계약/, 'Buyback trust contract', 'buyback'],
  [/단일판매.?공급계약/, 'Sales/supply contract', 'contract'], [/신규시설투자/, 'New facility investment', 'capex'], [/유형자산(취득|양수)/, 'Tangible asset acquisition', 'capex'],
  [/타법인주식및출자증권취득/, 'Stake acquisition in another company', 'deal'], [/타법인주식및출자증권처분/, 'Stake disposal in another company', 'deal'], [/합병/, 'Merger', 'deal'], [/분할/, 'Spin-off / split', 'deal'],
  [/풍문또는보도에대한해명/, 'Response to rumour or press report', 'news'], [/조회공시/, 'Exchange inquiry', 'news'], [/소송/, 'Litigation', 'legal'],
  [/주주총회소집/, 'Shareholder meeting notice', 'governance'], [/주주총회결과/, 'Shareholder meeting results', 'governance'], [/의결권대리행사권유/, 'Proxy solicitation', 'governance'],
  [/사외이사|임원.*(선임|해임|사임)/, 'Board / officer change', 'governance'], [/감사보고서/, 'Audit report', 'audit'],
  [/임원.?주요주주특정증권등소유상황/, 'Insider ownership report', 'ownership'], [/임원.?주요주주특정증권등거래계획/, 'Insider trading plan', 'ownership'],
  [/파생상품거래손실/, 'Derivatives trading loss', 'risk'], [/지급수단별.?지급기간별지급금액/, 'Supplier payment terms', 'other'], [/주식등의대량보유상황/, 'Large shareholding (5%) report', 'ownership'],
  [/최대주주등소유주식변동/, 'Largest-shareholder stake change', 'ownership'], [/특수관계인|계열회사|대규모기업집단/, 'Affiliate / related-party transaction', 'affiliate'],
  [/투자설명서/, 'Prospectus', 'issuance'], [/증권신고서/, 'Securities registration', 'issuance'], [/증권발행실적/, 'Securities issuance results', 'issuance'], [/사채|채권/, 'Bond issuance', 'issuance'],
  [/해외증권거래소/, 'Report filed with an overseas exchange', 'other'], [/기타경영사항/, 'Other management matters', 'other'],
];
function describe(title) {
  const t = clean(title);
  const amended = /^\[(기재정정|첨부정정|첨부추가|정정)/.test(t);
  const bare = t.replace(/^\[[^\]]*\]\s*/, '');
  const key = bare.replace(/[\sㆍ·・]/g, '');
  const hit = TITLES.find(([re]) => re.test(key));
  const period = /\((\d{4}\.\d{2})\)/.exec(bare)?.[1];
  const en = hit ? `${hit[1]}${period ? ` (${period})` : ''}` : null;
  return { title: t, titleEn: en && amended ? `${en} [amended]` : en, kind: hit ? hit[2] : 'other', ...(amended && { amended: true }) };
}
const viewer = rcp => `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcp}`;
// OpenDART answers the guide page's sample key (40 x's) with Samsung's data whatever corp_code is asked for,
// so never cache rows that belong to another company.
function assertCorp(list, co) {
  if ((list || []).some(r => r.corp_code && r.corp_code !== co.corp_code)) throw new Error("OpenDART returned another company's data (is DART_API_KEY a real key?)");
}

// Keyed: GET https://opendart.fss.or.kr/api/list.json?crtfc_key=…&corp_code=…&bgn_de=YYYYMMDD&end_de=YYYYMMDD&page_no=n&page_count=100
// The window always ends today, so (days, today) names a cache file and older days stay usable as stale copies.
async function dartList(co, bgn, end, max, days) {
  const out = [];
  for (let page = 1; page <= Math.ceil(max / 100); page++) {
    const { text } = await cachedDaily(`dart-list-${co.corp_code}-d${days}-p${page}`, 'json', async () => {
      const q = new URLSearchParams({ crtfc_key: process.env.DART_API_KEY, corp_code: co.corp_code, bgn_de: bgn, end_de: end, page_no: String(page), page_count: '100' });
      const t = await request(`https://opendart.fss.or.kr/api/list.json?${q}`, { label: 'OpenDART list.json' });
      const j = JSON.parse(t);
      if (j.status !== '000' && j.status !== '013') throw new Error(`OpenDART status ${j.status}: ${j.message}`);
      assertCorp(j.list, co);
      return t;
    });
    const j = JSON.parse(text);
    for (const x of j.list || []) {
      if (out.some(o => o.rcpNo === x.rcept_no)) continue;
      out.push({ date: `${x.rcept_dt.slice(0, 4)}-${x.rcept_dt.slice(4, 6)}-${x.rcept_dt.slice(6, 8)}`, raw: x.report_nm, url: viewer(x.rcept_no), rcpNo: x.rcept_no, filer: x.flr_nm });
    }
    // stop when done, or when the server did not honour page_no (it then repeats page 1)
    if (j.status === '013' || page >= (+j.total_page || 1) || +j.page_no !== page) break;
  }
  return out;
}

// Keyless: the disclosure search behind dart.fss.or.kr (POST /dsab007/detailSearch.ax, HTML rows).
async function dartWebList(co, bgn, end, max, days) {
  const out = [];
  for (let page = 1; page <= Math.ceil(max / 100); page++) {
    const { text } = await cachedDaily(`dart-web-${co.corp_code}-d${days}-p${page}`, 'html', async () => {
      const body = new URLSearchParams({ textCrpCik: co.corp_code, startDate: bgn, endDate: end, currentPage: String(page), maxResults: '100', maxLinks: '10', sort: 'date', series: 'desc' });
      const t = await request('https://dart.fss.or.kr/dsab007/detailSearch.ax', { label: 'DART disclosure search', method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
      if (!/pageInfo|tbody/.test(t)) throw new Error('DART disclosure search: unexpected page');
      return t;
    });
    for (const row of text.split(/<tr[\s>]/).slice(1)) {
      const rcp = /rcpNo=(\d{14})/.exec(row)?.[1];
      if (!rcp) continue;
      const a = new RegExp(`<a[^>]*rcpNo=${rcp}[^>]*>([\\s\\S]*?)</a>`).exec(row)?.[1] || '';
      const d = />\s*(\d{4})\.(\d{2})\.(\d{2})\s*</.exec(row);
      const filer = /class="tL ellipsis"[^>]*title="([^"]*)"/.exec(row)?.[1];
      out.push({ date: d ? `${d[1]}-${d[2]}-${d[3]}` : null, raw: a, url: viewer(rcp), rcpNo: rcp, filer: filer ? clean(filer) : null });
    }
    const pages = /pageInfo">\s*\[(\d+)\/(\d+)\]/.exec(text);
    if (!pages || page >= +pages[2]) break;
  }
  return out;
}

// dartFilings('samsung', { days: 120 }) -> { company, corp_code, filings:[{date,title,titleEn,kind,url,...}], total, hidden, source }
// Insider and 5%-holder ownership reports (most of Samsung's volume) are dropped unless { ownership: true }.
export async function dartFilings(company, { days = 120, ownership = false, max = 300, fallback = true } = {}) {
  try {
    const co = resolveCompany(company);
    if (!co) return UNKNOWN(company);
    days = Math.max(1, Math.min(3650, Math.floor(+days) || 120));
    max = Math.max(1, Math.min(1000, Math.floor(+max) || 300));
    const endD = new Date(), bgnD = new Date(Date.now() - days * 864e5);
    const bgn = ymd(bgnD), end = ymd(endD);
    const missing = needsKey('DART_API_KEY');
    let rows = null, source = null, keyedError = null;
    if (!missing) {
      try { rows = await dartList(co, bgn, end, max, days); source = 'opendart'; } catch (e) { keyedError = errMsg(e); }
    }
    if (!rows) {
      if (!fallback) return missing || { error: keyedError };
      try { rows = await dartWebList(co, bgn, end, max, days); source = 'dart-web'; }
      catch (e) { return missing ? { ...missing, fallbackError: errMsg(e) } : { error: `${keyedError}; fallback: ${errMsg(e)}` }; }
    }
    const all = rows.map(({ raw, ...r }) => ({ ...r, ...describe(raw) }));
    const filings = ownership ? all : all.filter(f => f.kind !== 'ownership');
    return {
      company: co.name || co.corp_code, nameKo: co.nameKo || null, corp_code: co.corp_code,
      from: bgnD.toISOString().slice(0, 10), to: endD.toISOString().slice(0, 10),
      total: all.length, hidden: all.length - filings.length, filings, source,
      ...(source !== 'opendart' && { fallbackFor: 'DART_API_KEY' }), ...(keyedError && { keyedError }), ...(co.sec && { sec: co.sec }),
    };
  } catch (e) { return { error: errMsg(e) }; }
}

const ACCOUNTS = [['매출액', 'Revenue'], ['영업이익', 'Operating profit'], ['당기순이익', 'Net income']];
const REPORT = { 11013: 'Q1', 11012: 'H1', 11014: 'Q3', 11011: 'FY' };
const krw = s => { const t = String(s ?? '').replace(/,/g, '').trim(); if (!t || t === '-') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const tn = n => (n == null ? null : Math.round(n / 1e10) / 100); // won -> KRW trillions, 2 dp
const growth = (a, b) => (a == null || b == null || b <= 0 ? null : +(a / b - 1).toFixed(4));

// Report periods newest first, skipping ones that have not ended yet.
function periods() {
  const now = new Date(), Y = now.getFullYear(), out = [];
  for (let y = Y; y >= Y - 2; y--) {
    for (const [code, mmdd] of [['11011', '12-31'], ['11014', '09-30'], ['11012', '06-30'], ['11013', '03-31']]) {
      if (new Date(`${y}-${mmdd}T00:00:00Z`) < now) out.push({ year: y, code, end: `${y}-${mmdd}` });
    }
  }
  return out.sort((a, b) => b.end.localeCompare(a.end));
}

// Keyed: GET https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=…&corp_code=…&bsns_year=YYYY&reprt_code=11013|11012|11014|11011
async function dartFin(co) {
  for (const p of periods().slice(0, 7)) {
    let text;
    try {
      // only filed reports are cached; status 013 (no data yet) moves on to the previous period
      text = await cached(`dart-fin-${co.corp_code}-${p.year}-${p.code}.json`, async () => {
        const q = new URLSearchParams({ crtfc_key: process.env.DART_API_KEY, corp_code: co.corp_code, bsns_year: String(p.year), reprt_code: p.code });
        const t = await request(`https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?${q}`, { label: 'OpenDART fnlttSinglAcnt.json' });
        const j = JSON.parse(t);
        if (j.status === '013') { const e = new Error('no data'); e.nodata = true; throw e; }
        if (j.status !== '000') throw new Error(`OpenDART status ${j.status}: ${j.message}`);
        assertCorp(j.list, co);
        return t;
      });
    } catch (e) { if (e.nodata) continue; throw e; }
    const list = JSON.parse(text).list || [];
    const cfs = list.filter(r => r.fs_div === 'CFS');
    const rows = cfs.length ? cfs : list.filter(r => r.fs_div === 'OFS');
    const norm = s => String(s || '').replace(/\s+/g, '').replace(/\(손실\)$/, '');
    const accounts = ACCOUNTS.map(([ko, label]) => {
      const r = rows.find(x => x.sj_div === 'IS' && norm(x.account_nm) === ko) || rows.find(x => norm(x.account_nm) === ko);
      if (!r) return { account: ko, label, value: null, prior: null, yoy: null };
      const v = krw(r.thstrm_amount), pv = krw(r.frmtrm_amount);
      const out = { account: r.account_nm, label, value: tn(v), prior: tn(pv), yoy: growth(v, pv) };
      if (p.code !== '11011') {
        const c = krw(r.thstrm_add_amount), pc = krw(r.frmtrm_add_amount);
        Object.assign(out, { ytd: tn(c), ytdPrior: tn(pc), ytdYoy: growth(c, pc) });
      }
      return out;
    });
    if (accounts[0].value == null) throw new Error(`OpenDART: no revenue row (매출액) in the ${REPORT[p.code]} ${p.year} key accounts`);
    const first = rows.find(x => x.sj_div === 'IS') || rows[0] || {};
    // In quarterly reports the *_amount fields are the 3-month quarter and *_add_amount the year to date;
    // the *_dt fields describe the year-to-date span, so the quarter's own dates are built here.
    const q = { 11013: ['Q1', '01-01', '03-31'], 11012: ['Q2', '04-01', '06-30'], 11014: ['Q3', '07-01', '09-30'] }[p.code];
    return {
      period: {
        year: p.year, report: REPORT[p.code], reprt_code: p.code, end: p.end,
        ...(q ? {
          label: `${q[0]} ${p.year} (3 months)`, current: `${p.year}-${q[1]} ~ ${p.year}-${q[2]}`, prior: `${p.year - 1}-${q[1]} ~ ${p.year - 1}-${q[2]}`,
          ytd: first.thstrm_dt || null, ytdPrior: first.frmtrm_dt || null,
        } : { label: `FY ${p.year}`, current: first.thstrm_dt || null, prior: first.frmtrm_dt || null }),
      },
      consolidated: cfs.length > 0, accounts, url: first.rcept_no ? viewer(first.rcept_no) : null, source: 'opendart',
    };
  }
  throw new Error('OpenDART: no report found in the last 7 periods');
}

// Keyless: Yahoo Finance fundamentals timeseries (quarterly, consolidated, KRW). Last ~5 quarters, so no YTD.
async function yahooFin(co) {
  if (!co.yahoo) throw new Error('no keyless source for this corp_code');
  const now = Math.floor(Date.now() / 1000), p1 = now - 2 * 366 * 86400;
  const types = ['quarterlyTotalRevenue', 'quarterlyOperatingIncome', 'quarterlyNetIncome'];
  const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${co.yahoo}?type=${types.join(',')}&period1=${p1}&period2=${now}`;
  const { text, stale } = await cachedDaily(`yf-fund-${co.yahoo}`, 'json', async () => {
    const t = await request(url, { label: 'Yahoo fundamentals' });
    if (!JSON.parse(t).timeseries?.result?.length) throw new Error('Yahoo fundamentals: empty');
    return t;
  });
  const series = {};
  for (const r of JSON.parse(text).timeseries.result) {
    const t = r.meta?.type?.[0];
    series[t] = (r[t] || []).filter(x => x?.reportedValue?.raw != null).map(x => ({ date: x.asOfDate, v: x.reportedValue.raw, cur: x.currencyCode }));
  }
  const rev = series.quarterlyTotalRevenue || [];
  if (!rev.length) throw new Error('Yahoo fundamentals: no quarterly revenue');
  const end = rev.map(x => x.date).sort().at(-1);
  const priorEnd = `${+end.slice(0, 4) - 1}${end.slice(4)}`;
  const pick = (t, d) => series[t]?.find(x => x.date === d)?.v ?? null;
  const labels = [['quarterlyTotalRevenue', '매출액', 'Revenue'], ['quarterlyOperatingIncome', '영업이익', 'Operating profit'], ['quarterlyNetIncome', '당기순이익', 'Net income']];
  const qn = Math.ceil(+end.slice(5, 7) / 3);
  return {
    period: { year: +end.slice(0, 4), report: `Q${qn}`, end, label: `Q${qn} ${end.slice(0, 4)} (3 months)`, current: end, prior: priorEnd },
    consolidated: true,
    accounts: labels.map(([t, ko, label]) => { const v = pick(t, end), pv = pick(t, priorEnd); return { account: ko, label, value: tn(v), prior: tn(pv), yoy: growth(v, pv) }; }),
    currencyCheck: rev.find(x => x.date === end)?.cur || null,
    url: null, source: 'yahoo-finance', note: "Yahoo Finance figures, not the filing: net income's definition may differ from DART's 당기순이익",
    ...(stale && { stale }),
  };
}

// dartFinancials('skhynix') -> { company, period:{label,...}, accounts:[{account,label,value,prior,yoy,ytd,...}], unit:'KRW trillion', source }
export async function dartFinancials(company, { fallback = true } = {}) {
  try {
    const co = resolveCompany(company);
    if (!co) return UNKNOWN(company);
    const head = { company: co.name || co.corp_code, nameKo: co.nameKo || null, corp_code: co.corp_code, currency: 'KRW', unit: 'KRW trillion' };
    const missing = needsKey('DART_API_KEY');
    let keyedError = null;
    if (!missing) {
      try { return { ...head, ...(await dartFin(co)) }; } catch (e) { keyedError = errMsg(e); }
    }
    if (!fallback) return missing || { error: keyedError };
    try { return { ...head, ...(await yahooFin(co)), fallbackFor: 'DART_API_KEY', ...(keyedError && { keyedError }) }; }
    catch (e) { return missing ? { ...missing, fallbackError: errMsg(e) } : { error: `${keyedError}; fallback: ${errMsg(e)}` }; }
  } catch (e) { return { error: errMsg(e) }; }
}

// CLI check (prints data, never key values):
//   node engine/sources/keyed.mjs keys | patents "NVIDIA Corporation" | overlap NVIDIA AMD | filings samsung | fin skhynix
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd = 'keys', a, b] = process.argv.slice(2);
  const run = { keys: () => keyStatus(), patents: () => patents(a || 'NVIDIA Corporation'), overlap: () => techOverlap(a || 'NVIDIA Corporation', b || 'Advanced Micro Devices Inc'), filings: () => dartFilings(a || 'samsung'), fin: () => dartFinancials(a || 'samsung') }[cmd];
  console.log(JSON.stringify(run ? await run() : { error: 'commands: keys | patents <assignee> | overlap <a> <b> | filings <company> | fin <company>' }, null, 2));
}
