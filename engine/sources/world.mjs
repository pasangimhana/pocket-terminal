// World data for Commodities mode: commodity registry, futures, production by country, trade flows,
// shipping chokepoints and lanes, federal contracts, a macro pack, return correlations and earnings read-through.
// No npm deps. Every export resolves: failures come back as { error }, a missing key as needsKey()'s object.
// Units: chg*, share, avgMove and sameDirectionShare are percent (12.3 = 12.3%); correlations run -1..1.
// Key values never go into errors, cache names or logs (FRED, EIA and NASS put the key in the query string).
// Everything cached in data/ is prefixed `world-`; time-varying data carries the day or month in its name.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { needsKey } from '../env.mjs';
import { cached, secGet, findTicker } from '../sec.mjs';

// A browser-style UA. Yahoo answers a full Chrome UA string with 429s far more often than this short one (as sec.mjs uses).
const UA = 'Mozilla/5.0 (pocket-terminal demo)';
const STATIC = JSON.parse(readFileSync(new URL('./world-static.json', import.meta.url), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const month = () => today().slice(0, 7);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const errMsg = e => String(e?.message || e);
const rnd = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
const pct = (a, b) => (a == null || !b ? null : rnd((a / b - 1) * 100));
const num = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
// short, file-safe cache key (long symbol lists are hashed)
const fileKey = s => { const k = String(s).replace(/[^A-Za-z0-9._-]+/g, '-'); return k.length <= 60 ? k : createHash('sha1').update(k).digest('hex').slice(0, 16); };
// every export goes through this: a thrown error becomes { error }
const safe = fn => async (...a) => { try { return await fn(...a); } catch (e) { return { error: errMsg(e) }; } };

// One HTTP call with a timeout and retries on 429/5xx. Errors name `label`, never the URL.
async function http(url, { label = new URL(url).host, method = 'GET', headers = {}, body, json = false, tries = 3, timeout = 25000 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(1500 * 2 ** (i - 1));
    try {
      const r = await fetch(url, { method, body, headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
      if (r.ok) {
        const t = await r.text();
        if (!json) return t;
        try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch { err = new Error(`${label}: bad JSON`); break; }
      }
      err = new Error(`${label}: HTTP ${r.status}`);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { err = new Error(`${label}: ${e.name === 'TimeoutError' ? 'timed out' : errMsg(e)}`); }
  }
  throw err;
}

// cached() keeps a file forever and stores whatever fn returns, so fn must throw on bad data.
async function store(name, fn) {
  return JSON.parse(await cached('world-' + name, async () => {
    const v = await fn();
    if (v == null) throw new Error('empty result');
    return JSON.stringify(v);
  }));
}

// Serialize calls to a rate-limited host, `gap` ms apart.
function queue(gap) {
  let tail = Promise.resolve();
  return fn => { const run = tail.then(fn); tail = run.catch(() => {}).then(() => sleep(gap)); return run; };
}
const yahooTurn = queue(400);     // Yahoo 429s after ~20 quick calls
const comtradeTurn = queue(1200); // the Comtrade preview 429s on back-to-back calls

function downsample(points, n) {
  if (points.length <= n) return points;
  const step = (points.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => points[Math.round(i * step)]);
}

function csvRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); rows.push(out);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// 1. Registry
// futures[0] is the headline price; proxy:true marks an ETF/trust used where Yahoo has no liquid future.
// hs.ore is the raw/ore/concentrate code and hs.refined the processed one; `tradeHs` picks the one trade() maps.
// chokepoints are ids in CHOKEPOINTS; LANES below has the from -> to routes.
export const COMMODITIES = {
  copper: {
    name: 'Copper', aliases: ['copper', 'cu', 'dr copper', 'copper cathode'],
    futures: [{ symbol: 'HG=F', label: 'COMEX copper futures', unit: 'USD/lb', proxy: false }],
    hs: { ore: { code: '2603', label: 'Copper ores and concentrates' }, refined: { code: '740311', label: 'Refined copper cathodes' } }, tradeHs: 'ore',
    usgs: 'Copper', production: 'usgs',
    secTerms: ['copper cathode', 'copper concentrate', 'copper price'],
    chokepoints: ['malacca', 'cape', 'panama'],
    stages: ['Miners', 'Concentrate traders', 'Smelters & refiners', 'Fabricators (wire, rod, tube)', 'Consumers (grid, construction, EVs, data centers)', 'Hedgers (COMEX/LME)'],
  },
  crude: {
    name: 'Crude oil', aliases: ['crude', 'crude oil', 'oil', 'wti', 'brent', 'petroleum'],
    futures: [
      { symbol: 'CL=F', label: 'NYMEX WTI crude futures', unit: 'USD/bbl', proxy: false },
      { symbol: 'BZ=F', label: 'Brent crude futures', unit: 'USD/bbl', proxy: false },
    ],
    hs: { ore: { code: '2709', label: 'Crude petroleum oils' }, refined: { code: '2710', label: 'Refined petroleum products' } }, tradeHs: 'ore',
    usgs: null, production: 'oil',
    secTerms: ['crude oil price', 'WTI', 'Brent crude'],
    chokepoints: ['hormuz', 'malacca', 'redsea', 'cape', 'danish', 'bosporus', 'panama'],
    stages: ['Producers (upstream E&P)', 'Pipelines & storage (midstream)', 'Tankers', 'Refiners', 'Consumers (fuels, petrochemicals)', 'Hedgers (NYMEX/ICE)'],
  },
  lng: {
    name: 'LNG', aliases: ['lng', 'natural gas', 'nat gas', 'natgas', 'gas', 'liquefied natural gas', 'henry hub', 'jkm', 'ttf'],
    futures: [
      { symbol: 'NG=F', label: 'Henry Hub natural gas futures (US LNG feedgas)', unit: 'USD/MMBtu', proxy: false },
      { symbol: 'JKM=F', label: 'LNG Japan/Korea Marker (Platts) futures', unit: 'USD/MMBtu', proxy: false },
      { symbol: 'TTF=F', label: 'Dutch TTF natural gas futures', unit: 'EUR/MWh', proxy: false },
    ],
    hs: { ore: { code: '271121', label: 'Natural gas, gaseous (pipeline)' }, refined: { code: '271111', label: 'Natural gas, liquefied (LNG)' } }, tradeHs: 'refined',
    usgs: null, production: 'gas',
    secTerms: ['liquefied natural gas', 'LNG cargo', 'Henry Hub'],
    chokepoints: ['hormuz', 'malacca', 'redsea', 'cape', 'panama', 'danish'],
    stages: ['Gas producers', 'Liquefaction terminals', 'LNG carriers', 'Regasification terminals', 'Utilities & industry', 'Hedgers (Henry Hub/JKM/TTF)'],
  },
  lithium: {
    name: 'Lithium', aliases: ['lithium', 'spodumene', 'lithium carbonate', 'lithium hydroxide'],
    futures: [{ symbol: 'LIT', label: 'Global X Lithium & Battery Tech ETF (proxy: no liquid lithium future on Yahoo)', unit: 'USD/share', proxy: true }],
    hs: { ore: { code: '253090', label: 'Mineral substances n.e.s. (carries spodumene; not lithium-specific)' }, refined: { code: '283691', label: 'Lithium carbonates' } }, tradeHs: 'refined',
    usgs: 'Lithium', production: 'usgs',
    secTerms: ['lithium carbonate', 'lithium hydroxide', 'spodumene'],
    chokepoints: ['malacca', 'cape'],
    stages: ['Miners (spodumene, brine)', 'Chemical converters (carbonate, hydroxide)', 'Cathode makers', 'Battery cell makers', 'EV & storage OEMs', 'Recyclers'],
  },
  uranium: {
    name: 'Uranium', aliases: ['uranium', 'u3o8', 'yellowcake', 'nuclear fuel'],
    futures: [
      { symbol: 'SRUUF', label: 'Sprott Physical Uranium Trust (proxy: holds U3O8; Yahoo uranium future is stale)', unit: 'USD/unit', proxy: true },
      { symbol: 'URA', label: 'Global X Uranium ETF (miners, proxy)', unit: 'USD/share', proxy: true },
    ],
    hs: { ore: { code: '261210', label: 'Uranium ores and concentrates' }, refined: { code: '284410', label: 'Natural uranium and its compounds' } }, tradeHs: 'refined',
    usgs: null, production: 'wna',
    secTerms: ['uranium concentrate', 'U3O8', 'enrichment services'],
    chokepoints: ['danish', 'bosporus', 'cape'],
    stages: ['Miners (ISL, conventional)', 'Converters (UF6)', 'Enrichers', 'Fuel fabricators', 'Utilities (reactors)', 'Physical funds & traders'],
  },
  gold: {
    name: 'Gold', aliases: ['gold', 'xau', 'bullion'],
    futures: [{ symbol: 'GC=F', label: 'COMEX gold futures', unit: 'USD/troy oz', proxy: false }],
    hs: { ore: { code: '261690', label: 'Precious-metal ores and concentrates (excl. silver)' }, refined: { code: '710812', label: 'Gold, non-monetary, unwrought' } }, tradeHs: 'refined',
    usgs: 'Gold', production: 'usgs',
    secTerms: ['gold price', 'gold doré', 'ounces of gold'],
    chokepoints: [],
    stages: ['Miners', 'Refiners (doré to bars)', 'Vaults & bullion banks', 'Central banks', 'Jewellery & tech demand', 'ETFs & futures hedgers'],
  },
  ironore: {
    name: 'Iron ore', aliases: ['iron ore', 'iron-ore', 'ironore'],
    futures: [{ symbol: 'TIO=F', label: 'Iron ore 62% Fe CFR China (TSI) futures', unit: 'USD/t', proxy: false }],
    hs: { ore: { code: '2601', label: 'Iron ores and concentrates' }, refined: { code: '7201', label: 'Pig iron' } }, tradeHs: 'ore',
    usgs: 'Iron Ore', production: 'usgs',
    secTerms: ['iron ore', 'iron ore pellets', '62% Fe'],
    chokepoints: ['cape'],
    stages: ['Miners', 'Dry-bulk shippers (Capesize)', 'Steel mills (blast furnace)', 'Steel distributors', 'Consumers (construction, autos, machinery)', 'Hedgers (SGX/DCE)'],
  },
  wheat: {
    name: 'Wheat', aliases: ['wheat', 'srw wheat', 'hrw wheat'],
    futures: [{ symbol: 'ZW=F', label: 'CBOT soft red winter wheat futures', unit: 'US cents/bu', proxy: false }],
    hs: { ore: { code: '1001', label: 'Wheat and meslin' }, refined: { code: '1101', label: 'Wheat or meslin flour' } }, tradeHs: 'ore',
    usgs: null, production: 'owid:wheat-production', nass: 'WHEAT',
    secTerms: ['wheat prices', 'wheat flour', 'milling wheat'],
    chokepoints: ['bosporus', 'redsea', 'panama'],
    stages: ['Farmers', 'Grain handlers & elevators', 'Exporters & traders', 'Dry-bulk shippers', 'Millers & food makers', 'Hedgers (CBOT/Euronext)'],
  },
  cocoa: {
    name: 'Cocoa', aliases: ['cocoa', 'cacao', 'cocoa beans'],
    futures: [{ symbol: 'CC=F', label: 'ICE cocoa futures', unit: 'USD/t', proxy: false }],
    hs: { ore: { code: '1801', label: 'Cocoa beans' }, refined: { code: '1804', label: 'Cocoa butter, fat and oil' } }, tradeHs: 'ore',
    usgs: null, production: 'owid:cocoa-bean-production',
    secTerms: ['cocoa beans', 'cocoa prices', 'cocoa butter'],
    chokepoints: ['cape', 'malacca', 'panama'],
    stages: ['Smallholder farmers', 'Co-ops & marketing boards', 'Exporters & traders', 'Grinders (liquor, butter, powder)', 'Chocolate makers', 'Hedgers (ICE London/New York)'],
  },
  rareearths: {
    name: 'Rare earths', aliases: ['rare earths', 'rare earth', 'rare-earths', 'rare earth elements', 'ree', 'ndpr', 'neodymium'],
    futures: [{ symbol: 'REMX', label: 'VanEck Rare Earth & Strategic Metals ETF (proxy: no rare-earth future on Yahoo)', unit: 'USD/share', proxy: true }],
    hs: { ore: { code: '253090', label: 'Mineral substances n.e.s. (carries RE concentrate; not specific)' }, refined: { code: '2846', label: 'Rare-earth metal compounds' } }, tradeHs: 'refined',
    usgs: 'Rare Earths', production: 'usgs',
    secTerms: ['rare earth', 'NdPr', 'rare earth magnets'],
    chokepoints: ['malacca', 'redsea'],
    stages: ['Miners', 'Separators & refiners (oxides)', 'Metal & alloy makers', 'Magnet makers (NdFeB)', 'Consumers (EV motors, wind, defense)', 'Stockpiles & traders'],
  },
};

// Text -> commodity key or null. Exact alias, key or futures symbol first; otherwise an alias inside the text
// counts only when every other word is filler ("copper price", "wti crude oil futures"), so company names
// like "Marathon Oil" or "Lithium Americas" stay null. Some aliases are also tickers (LNG, WTI, GOLD):
// in ticker mode, look the ticker up first.
const FILLER = new Set(('price prices futures future spot market markets supply chain value trade flows flow routes route shipping '
  + 'chokepoints chokepoint production producers map the of for in on and a an global world commodity commodities outlook news '
  + 'cargo cargoes exports imports benchmark contract contracts chart').split(' '));
export function findCommodity(text) {
  const q = String(text || '').toLowerCase().replace(/[^a-z0-9= -]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  for (const [key, c] of Object.entries(COMMODITIES)) {
    if (q === key || c.aliases.includes(q) || c.futures.some(f => f.symbol.toLowerCase() === q)) return key;
  }
  const all = Object.entries(COMMODITIES).flatMap(([key, c]) => c.aliases.filter(a => a.length > 2).map(a => [a, key]));
  all.sort((a, b) => b[0].length - a[0].length); // "natural gas" before "gas"
  for (const [a, key] of all) {
    const re = new RegExp(`(^| )${a.replace(/-/g, '[- ]?')}( |$)`);
    if (!re.test(q)) continue;
    const own = new Set(COMMODITIES[key].aliases.flatMap(x => x.split(/[ -]/)));
    if (q.replace(re, ' ').split(' ').filter(Boolean).every(w => FILLER.has(w) || own.has(w))) return key;
  }
  return null;
}

const getCommodity = key => COMMODITIES[key] || COMMODITIES[findCommodity(key)] || null;

// ---------------------------------------------------------------------------------------------
// 2. Futures (Yahoo spark: up to 20 symbols per call, cached per day)

// Retry a throttled Yahoo call twice (about 5 s in all), alternating query1/query2, then give up.
async function yahooGet(path) {
  let err;
  for (let i = 0; i < 3; i++) {
    if (i) await sleep([0, 1500, 3500][i]);
    try { return await http(`https://query${1 + (i % 2)}.finance.yahoo.com${path}`, { json: true, label: 'Yahoo Finance', tries: 1 }); }
    catch (e) { err = e; if (!/429|HTTP 5\d\d|timed out/.test(e.message)) break; }
  }
  throw err;
}

// { SYM: { currency, name, exchange, points:[{t:'YYYY-MM-DD', c}] } }; nulls dropped, missing symbols left out.
async function spark(symbols, range = '1y') {
  const out = {};
  const syms = [...new Set(symbols.map(s => String(s).toUpperCase()))];
  for (let i = 0; i < syms.length; i += 20) {
    const batch = syms.slice(i, i + 20);
    const got = await store(`yahoo-${fileKey(batch.join('_'))}-${range}-${today()}.json`, () => yahooTurn(async () => {
      const j = await yahooGet(`/v7/finance/spark?symbols=${batch.map(encodeURIComponent).join(',')}&range=${range}&interval=1d`);
      const res = {};
      for (const x of j?.spark?.result || []) {
        const r = x.response?.[0];
        const close = r?.indicators?.quote?.[0]?.close || [];
        const byDay = new Map();
        (r?.timestamp || []).forEach((t, k) => { if (close[k] != null && Number.isFinite(close[k])) byDay.set(new Date(t * 1000).toISOString().slice(0, 10), +close[k].toFixed(4)); });
        const points = [...byDay].map(([t, c]) => ({ t, c }));
        if (points.length) res[x.symbol] = { currency: r.meta?.currency || null, name: r.meta?.longName || r.meta?.shortName || null, exchange: r.meta?.fullExchangeName || r.meta?.exchangeName || null, points };
      }
      if (!Object.keys(res).length) throw new Error('Yahoo Finance: no data');
      return res;
    }));
    Object.assign(out, got);
  }
  return out;
}

// last and changes come from the full daily series (Yahoo's meta price can be years stale, e.g. TIO=F)
function quoteFrom(f, d) {
  const p = d?.points;
  if (!p || p.length < 2) return null;
  const last = p.at(-1), monthAgo = new Date(Date.parse(last.t) - 30 * 864e5).toISOString().slice(0, 10);
  const m = [...p].reverse().find(x => x.t <= monthAgo) || p[0];
  return {
    symbol: f.symbol, label: f.label, unit: f.unit, proxy: f.proxy, currency: d.currency, asOf: last.t,
    last: rnd(last.c, 4), chg1d: pct(last.c, p.at(-2).c), chg1m: pct(last.c, m.c), chg1y: pct(last.c, p[0].c),
  };
}

export const futures = safe(async (key, { symbol, points = 60 } = {}) => {
  const c = getCommodity(key);
  if (!c) return { error: `unknown commodity: ${key}` };
  const data = await spark(c.futures.map(f => f.symbol), '1y');
  const main = (symbol && c.futures.find(f => f.symbol === symbol.toUpperCase())) || c.futures[0];
  const q = quoteFrom(main, data[main.symbol]);
  if (!q) return { error: `no price data for ${main.symbol}` };
  return {
    commodity: c.name, ...q,
    series: downsample(data[main.symbol].points, points).map(x => ({ t: x.t, c: rnd(x.c, 4) })),
    others: c.futures.filter(f => f !== main).map(f => quoteFrom(f, data[f.symbol])).filter(Boolean),
  };
});

// ---------------------------------------------------------------------------------------------
// 3. Production by country, latest year

// ISO3 for the country names in the USGS and WNA tables (OWID, EIA and Comtrade rows carry their own codes)
const ISO3 = {
  'United States': 'USA', USA: 'USA', Australia: 'AUS', Canada: 'CAN', Chile: 'CHL', China: 'CHN', 'Congo (Kinshasa)': 'COD', India: 'IND',
  Indonesia: 'IDN', Kazakhstan: 'KAZ', Mexico: 'MEX', Peru: 'PER', Poland: 'POL', Russia: 'RUS', Zambia: 'ZMB', Germany: 'DEU', Japan: 'JPN',
  'Korea, Republic of': 'KOR', Argentina: 'ARG', Brazil: 'BRA', Mali: 'MLI', Portugal: 'PRT', Zimbabwe: 'ZWE', Ghana: 'GHA', 'South Africa': 'ZAF',
  Uzbekistan: 'UZB', Iran: 'IRN', Mauritania: 'MRT', Sweden: 'SWE', Turkey: 'TUR', Ukraine: 'UKR', Burma: 'MMR', Madagascar: 'MDG',
  Malaysia: 'MYS', Nigeria: 'NGA', Thailand: 'THA', Vietnam: 'VNM', Namibia: 'NAM', Niger: 'NER',
};

function topRows(list, denom, n = 12) {
  return list.filter(r => r.value != null && r.value > 0).sort((a, b) => b.value - a.value).slice(0, n)
    .map(r => ({ ...r, share: denom ? rnd((r.value / denom) * 100, 1) : null }));
}

// USGS MCS 2026 tables (transcribed snapshot: the data-release CSVs on ScienceBase are behind a bot challenge)
function usgsProduction(key, stage = 'mine') {
  const u = STATIC.usgs, t = u.commodities[key]?.[stage];
  if (!t) return { error: `no USGS ${stage} table for ${key}` };
  const [y0, y1] = u.years;
  const rows = t.rows.map(([country, a, b]) => ({ country, iso: ISO3[country] || null, value: b ?? null, prev: a ?? null }));
  const withheld = t.rows.filter(r => r[1] == null && r[2] == null).map(r => r[0]);
  return {
    source: `USGS ${u.edition}`, url: u.urlBase + u.commodities[key].pdf + '.pdf', stage: t.label,
    year: y1, estimated: t.estimated.includes(y1), unit: t.unit, world: t.world[1], worldPrev: t.world[0], prevYear: y0,
    other: t.other[1], ...(withheld.length ? { withheld } : {}), ...(t.note ? { note: t.note } : {}),
    rows: topRows(rows, t.world[1]),
  };
}

// World Nuclear Association table (live, monthly cache), static snapshot if the page moves
async function wnaUranium() {
  try {
    return await store(`wna-uranium-${month()}.json`, async () => {
      const h = await http(STATIC.uranium.url, { label: 'World Nuclear Association' });
      const table = (h.match(/<table[\s\S]*?<\/table>/i) || [])[0] || '';
      const cells = r => (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(cells);
      const head = rows[0] || [];
      const year = Number(head.at(-1));
      if (!/country/i.test(head[0] || '') || !(year > 2000)) throw new Error('World Nuclear Association: table layout changed');
      const val = r => num(r.at(-1));
      const world = val(rows.find(r => /^world total tU/i.test(r[0])) || []);
      const other = val(rows.find(r => /^others?$/i.test(r[0])) || []);
      const list = rows.slice(1).filter(r => !/^(world|others?|%)/i.test(r[0])).map(r => [r[0], val(r)]);
      if (!world || list.length < 8) throw new Error('World Nuclear Association: table layout changed');
      return { year, world, other, rows: list };
    });
  } catch { return { ...STATIC.uranium, snapshot: true }; }
}

// Our World in Data grapher CSV -> latest year with a World value: { year, world, rows:[[country, value, iso3]] }
async function owidLatest(chart) {
  return store(`owid-${chart}-v2-${month()}.json`, async () => {
    const t = await http(`https://ourworldindata.org/grapher/${chart}.csv?v=1&csvType=full&useColumnShortNames=true`, { label: 'Our World in Data' });
    const rows = csvRows(t);
    if (rows[0]?.[0] !== 'entity' || rows[0].length < 4) throw new Error('Our World in Data: unexpected response');
    const world = new Map(), byYear = new Map();
    for (const [entity, code, y, v] of rows.slice(1)) {
      const year = Number(y), value = num(v);
      if (value == null) continue;
      if (entity === 'World') world.set(year, value);
      else if (/^[A-Z]{3}$/.test(code)) { if (!byYear.has(year)) byYear.set(year, []); byYear.get(year).push([entity, value, code]); } // countries only, no OWID_ aggregates
    }
    const year = Math.max(...[...world.keys()].filter(y => byYear.get(y)?.length > 20));
    if (!Number.isFinite(year)) throw new Error('Our World in Data: no recent data');
    return { year, world: world.get(year), rows: byYear.get(year) };
  });
}

// EIA international (official) when EIA_API_KEY is set: crude (productId 57, TBPD) or dry gas (26, BCF)
async function eiaIntlProduction(kind) {
  const [productId, unit, label] = kind === 'oil' ? [57, 'TBPD', 'thousand b/d (crude incl. lease condensate)'] : [26, 'BCF', 'billion cubic feet (dry natural gas)'];
  const y = new Date().getFullYear();
  const url = `https://api.eia.gov/v2/international/data/?api_key=${encodeURIComponent(process.env.EIA_API_KEY)}&frequency=annual&data[0]=value`
    + `&facets[activityId][]=1&facets[productId][]=${productId}&facets[unit][]=${unit}&start=${y - 4}&end=${y}&length=5000`;
  const j = await http(url, { json: true, label: 'EIA API' });
  const data = j?.response?.data || [];
  const years = [...new Set(data.filter(d => d.countryRegionId === 'WORL' && num(d.value) != null).map(d => Number(d.period)))].sort((a, b) => b - a);
  if (!years.length) throw new Error('EIA API: no international data');
  const year = years[0];
  const at = data.filter(d => Number(d.period) === year);
  const world = num(at.find(d => d.countryRegionId === 'WORL').value);
  const rows = at.filter(d => (d.countryRegionTypeId ? d.countryRegionTypeId === 'c' : d.countryRegionId.length === 3) && d.countryRegionId !== 'WORL')
    .map(d => ({ country: d.countryRegionName, iso: d.countryRegionId, value: num(d.value) }));
  return { source: 'U.S. Energy Information Administration, International Energy Statistics', year, unit: label, world, rows: topRows(rows, world) };
}

export const production = safe(async (key, { stage = 'mine' } = {}) => {
  const c = getCommodity(key);
  if (!c) return { error: `unknown commodity: ${key}` };
  const k = Object.keys(COMMODITIES).find(x => COMMODITIES[x] === c);
  const p = c.production;
  if (p === 'usgs') return { commodity: c.name, ...usgsProduction(k, stage) };
  if (p === 'wna') {
    const w = await wnaUranium();
    return {
      commodity: c.name, source: STATIC.uranium.source + (w.snapshot ? ' (snapshot)' : ''), url: STATIC.uranium.url,
      stage: 'Mine production', year: w.year, unit: 't U', world: w.world, other: w.other,
      rows: topRows(w.rows.map(([name, value]) => {
        const country = name.replace(/\s*\(est\.\)/, '');
        return { country, iso: ISO3[country] || null, value, ...(/est\./.test(name) ? { estimated: true } : {}) };
      }), w.world),
    };
  }
  if (p === 'oil' || p === 'gas') {
    if (process.env.EIA_API_KEY) {
      try { return { commodity: c.name, stage: p === 'gas' ? 'Dry natural gas production (not LNG exports)' : 'Crude oil production', ...(await eiaIntlProduction(p)) }; }
      catch { /* fall through to the keyless source */ }
    }
    const o = await owidLatest(p === 'oil' ? 'oil-production-by-country' : 'gas-production-by-country');
    return {
      commodity: c.name, source: 'Energy Institute Statistical Review of World Energy, via Our World in Data', fallbackFor: 'EIA_API_KEY',
      url: `https://ourworldindata.org/grapher/${p}-production-by-country`,
      stage: p === 'gas' ? 'Natural gas production (not LNG exports; see trade() for LNG)' : 'Oil production (crude + NGLs)',
      year: o.year, unit: 'TWh (energy content)', world: Math.round(o.world),
      rows: topRows(o.rows.map(([country, value, iso]) => ({ country, iso, value: rnd(value, 0) })), o.world),
    };
  }
  if (p.startsWith('owid:')) {
    const chart = p.slice(5), o = await owidLatest(chart);
    return {
      commodity: c.name, source: 'FAOSTAT (UN FAO), via Our World in Data', url: `https://ourworldindata.org/grapher/${chart}`,
      stage: 'Production', year: o.year, unit: 't', world: Math.round(o.world),
      rows: topRows(o.rows.map(([country, value, iso]) => ({ country, iso, value: Math.round(value) })), o.world),
    };
  }
  return { error: `no production source for ${c.name}` };
});

// ---------------------------------------------------------------------------------------------
// 4. Trade (UN Comtrade: full API with COMTRADE_API_KEY, else the public preview, which caps at 500 rows)

const NOT_COUNTRIES = new Set([0, 97, 899]); // World, EU-27, Areas n.e.s.
// keyed API first when COMTRADE_API_KEY is set; a failing key falls back to the public preview
async function comtradeYear(hs, flow, year) {
  const key = process.env.COMTRADE_API_KEY;
  if (key) { try { return await comtradeFetch(hs, flow, year, key); } catch { /* use the preview */ } }
  return comtradeFetch(hs, flow, year, null);
}
async function comtradeFetch(hs, flow, year, key) {
  return store(`comtrade-${hs}-${flow}-${year}-${key ? 'api' : 'preview'}-${month()}.json`, () => comtradeTurn(async () => {
    const qs = `period=${year}&partnerCode=0&partner2Code=0&motCode=0&customsCode=C00&cmdCode=${hs}&flowCode=${flow}&includeDesc=true`;
    const url = key ? `https://comtradeapi.un.org/data/v1/get/C/A/HS?${qs}` : `https://comtradeapi.un.org/public/v1/preview/C/A/HS?${qs}`;
    const j = await http(url, { json: true, label: 'UN Comtrade', tries: 4, headers: key ? { 'Ocp-Apim-Subscription-Key': key } : {} });
    if (!Array.isArray(j?.data)) throw new Error(`UN Comtrade: ${j?.error || j?.message || 'no data'}`);
    const seen = new Set(), rows = [];
    for (const x of j.data) {
      if (NOT_COUNTRIES.has(x.reporterCode) || seen.has(x.reporterCode) || !(x.primaryValue > 0)) continue;
      if (/\bnes\b/i.test(x.reporterDesc || '') && x.reporterCode !== 490) continue;
      seen.add(x.reporterCode);
      rows.push({ country: x.reporterCode === 490 ? 'Taiwan' : x.reporterDesc || String(x.reporterCode), iso: x.reporterISO || null, valueUSD: Math.round(x.primaryValue), tonnes: x.netWgt ? Math.round(x.netWgt / 1000) : null });
    }
    return { year, rows, keyed: !!key };
  }));
}

export const trade = safe(async (key, { flow = 'X', year, hs } = {}) => {
  const c = getCommodity(key);
  if (!c) return { error: `unknown commodity: ${key}` };
  flow = String(flow).toUpperCase() === 'M' ? 'M' : 'X';
  const h = hs ? (Object.values(c.hs).find(x => x.code === String(hs)) || { code: String(hs), label: `HS ${hs}` }) : c.hs[c.tradeHs];
  let pick;
  if (year) pick = await comtradeYear(h.code, flow, Number(year));
  else {
    // the latest year is still filling in (2025: 71 reporters vs 86 for 2023), so take whichever of the last two has more
    const y = new Date().getFullYear();
    const a = await comtradeYear(h.code, flow, y - 1), b = await comtradeYear(h.code, flow, y - 2);
    pick = a.rows.length >= b.rows.length ? a : b;
  }
  const total = pick.rows.reduce((s, r) => s + r.valueUSD, 0);
  return {
    commodity: c.name, source: `UN Comtrade${pick.keyed ? '' : ' (public preview)'}`, ...(process.env.COMTRADE_API_KEY && !pick.keyed ? { fallbackFor: 'COMTRADE_API_KEY' } : {}),
    year: pick.year, hs: h.code, hsLabel: h.label,
    flow: flow === 'X' ? 'exports' : 'imports', reporters: pick.rows.length, totalUSD: total,
    note: 'As reported by each country; share is of the reported total. Non-reporters (e.g. Russia since 2022) are missing.',
    rows: pick.rows.sort((p, q) => q.valueUSD - p.valueUSD).slice(0, 12).map(r => ({ ...r, share: total ? rnd((r.valueUSD / total) * 100, 1) : null })),
  };
});

// ---------------------------------------------------------------------------------------------
// 5. Chokepoints and lanes. Oil/LNG volumes: EIA "World Oil Transit Chokepoints" (updated 2026-03-03), 1H25 unless noted.
// lng.shareEst is our estimate against ~55 Bcf/d of global LNG trade (EIA puts Hormuz's 11.4 Bcf/d at "over 20%").
const EIA_CHOKE = 'EIA, World Oil Transit Chokepoints (updated 2026-03-03)';
export const CHOKEPOINTS = {
  hormuz: {
    name: 'Strait of Hormuz', label: 'Hormuz', lat: 26.57, lon: 56.25,
    oil: { mbd: 20.9, period: '1H25', shareSeaborne: 25, note: 'one-quarter of global maritime oil trade; ~20% of world liquids consumption', source: EIA_CHOKE },
    lng: { bcfd: 11.4, period: '1H25', shareEst: 21, note: 'over 20% of global LNG trade, mostly Qatar', source: EIA_CHOKE },
    containers: null,
  },
  redsea: {
    name: 'Bab el-Mandeb / Red Sea + Suez Canal', label: 'Red Sea–Suez', lat: 12.58, lon: 43.33,
    points: [{ name: 'Bab el-Mandeb', lat: 12.58, lon: 43.33 }, { name: 'Suez Canal', lat: 30.6, lon: 32.33 }],
    oil: { mbd: { babElMandeb: 4.2, suezSumed: 4.9 }, period: '1H25', shareSeaborne: 6, note: 'Suez/SUMED and Bab el-Mandeb together ~6% of seaborne oil; flows fell after the 2024 Red Sea attacks', source: EIA_CHOKE },
    lng: { bcfd: { babElMandeb: 0.0, suez: 0.9 }, period: '1H25', shareEst: 2, source: EIA_CHOKE },
    containers: { share: '12-15% of global trade (Suez, 2023)', source: 'UNCTAD (2024), trade volume fell 42% in two months after the Red Sea attacks escalated' },
  },
  panama: {
    name: 'Panama Canal', label: 'Panama', lat: 9.08, lon: -79.68,
    oil: { mbd: 2.3, period: 'FY2025', shareSeaborne: 3, source: EIA_CHOKE },
    lng: { bcfd: 0.3, period: 'FY2025', shareEst: 0.5, note: 'under 0.3 Bcf/d, down from ~2.5 in FY2021', source: EIA_CHOKE },
    containers: { share: null, note: 'about 22% of Chile’s and Peru’s trade volumes and 26% of Ecuador’s cross the canal', source: 'UNCTAD (2024)' },
  },
  malacca: {
    name: 'Strait of Malacca', label: 'Malacca', lat: 2.5, lon: 101.3,
    oil: { mbd: 23.2, period: '1H25', shareSeaborne: 29, note: 'largest oil chokepoint by volume', source: EIA_CHOKE },
    lng: { bcfd: 9.2, period: '1H25', shareEst: 17, source: EIA_CHOKE },
    containers: null,
  },
  bosporus: {
    name: 'Turkish Straits (Bosporus and Dardanelles)', label: 'Bosporus', lat: 41.12, lon: 29.07,
    oil: { mbd: 3.7, period: '1H25', shareSeaborne: 5, note: 'Bosporus 3.3, Dardanelles 3.7 million b/d', source: EIA_CHOKE },
    lng: { bcfd: 0.6, period: '1H25', shareEst: 1, note: 'Dardanelles', source: EIA_CHOKE },
    containers: null,
  },
  cape: {
    name: 'Cape of Good Hope', label: 'Cape', lat: -34.36, lon: 18.47,
    oil: { mbd: 9.1, period: '1H25', shareSeaborne: 11, note: 'not a chokepoint: the main detour when the Red Sea is closed', source: EIA_CHOKE },
    lng: { bcfd: 5.7, period: '1H25', shareEst: 10, source: EIA_CHOKE },
    containers: null,
  },
  danish: {
    name: 'Danish Straits', label: 'Danish Straits', lat: 55.6, lon: 12.6,
    oil: { mbd: 4.9, period: '1H25', shareSeaborne: 6, note: 'mostly Russian Baltic exports', source: EIA_CHOKE },
    lng: { bcfd: 1.6, period: '1H25', shareEst: 3, source: EIA_CHOKE },
    containers: null,
  },
};

// Main lanes per commodity: from region -> to region, via chokepoint ids (empty = open ocean, rail or air).
const LANES = {
  crude: [
    { from: 'Persian Gulf', to: 'China, India, Japan, Korea', via: ['hormuz', 'malacca'] },
    { from: 'Persian Gulf', to: 'Europe', via: ['hormuz', 'redsea'], note: 'or around the Cape when the Red Sea is unsafe' },
    { from: 'Russia (Baltic ports)', to: 'India, China', via: ['danish', 'redsea'] },
    { from: 'Russia / Kazakhstan (Black Sea, CPC)', to: 'Europe, Asia', via: ['bosporus'] },
    { from: 'US Gulf Coast', to: 'Europe', via: [] },
    { from: 'US Gulf Coast', to: 'Asia', via: ['panama'], note: 'large tankers go via the Cape' },
    { from: 'West Africa, Brazil', to: 'China, India', via: ['cape', 'malacca'] },
  ],
  lng: [
    { from: 'Qatar', to: 'Japan, Korea, China, India', via: ['hormuz', 'malacca'] },
    { from: 'Qatar', to: 'Europe', via: ['hormuz', 'cape'], note: 'Bab el-Mandeb LNG transits were ~0 in 1H25' },
    { from: 'US Gulf Coast', to: 'Europe', via: [] },
    { from: 'US Gulf Coast', to: 'Asia', via: ['cape'], note: 'Panama transits under 0.3 Bcf/d in FY2025' },
    { from: 'Australia', to: 'Japan, China, Korea', via: [] },
    { from: 'US, Norway, Qatar', to: 'Baltic terminals (Poland, Lithuania, Finland)', via: ['danish'] },
  ],
  copper: [
    { from: 'Chile, Peru', to: 'China, Japan, Korea', via: [], note: 'trans-Pacific, no chokepoint' },
    { from: 'DR Congo, Zambia (via Dar es Salaam, Durban)', to: 'China', via: ['malacca'] },
    { from: 'DR Congo, Zambia (via Lobito, Walvis Bay)', to: 'China', via: ['cape', 'malacca'] },
    { from: 'Chile, Peru', to: 'Europe, US East Coast', via: ['panama'] },
    { from: 'Indonesia', to: 'China, Japan', via: [] },
  ],
  lithium: [
    { from: 'Australia (spodumene)', to: 'China (converters)', via: [] },
    { from: 'Chile, Argentina (carbonate)', to: 'China, Korea, Japan', via: [], note: 'trans-Pacific' },
    { from: 'Zimbabwe (spodumene, via Beira, Durban)', to: 'China', via: ['malacca'] },
    { from: 'Mali (spodumene, via Abidjan, Dakar)', to: 'China', via: ['cape', 'malacca'] },
  ],
  uranium: [
    { from: 'Kazakhstan, Uzbekistan', to: 'Western converters via St Petersburg', via: ['danish'] },
    { from: 'Kazakhstan', to: 'Europe, North America (Trans-Caspian route)', via: ['bosporus'] },
    { from: 'Kazakhstan', to: 'China', via: [], note: 'by rail' },
    { from: 'Namibia (Walvis Bay)', to: 'China', via: ['cape'] },
    { from: 'Canada (Saskatchewan)', to: 'Converters in North America and Europe', via: [] },
  ],
  gold: [
    { from: 'Mines (Africa, Latin America, Asia)', to: 'Swiss, Dubai and Indian refineries', via: [], note: 'by air' },
    { from: 'Switzerland, London', to: 'China, India, Hong Kong', via: [], note: 'by air' },
    { from: 'London', to: 'New York (COMEX)', via: [], note: 'by air' },
  ],
  ironore: [
    { from: 'Western Australia (Port Hedland, Dampier)', to: 'China, Japan, Korea', via: [], note: 'via Lombok/Makassar straits' },
    { from: 'Brazil (Tubarão, Ponta da Madeira)', to: 'China', via: ['cape'], note: 'then Lombok/Sunda: Valemax ships are too deep for Malacca' },
    { from: 'Brazil', to: 'Europe, Middle East', via: [] },
  ],
  wheat: [
    { from: 'Black Sea (Russia, Ukraine)', to: 'Egypt, Turkey, North Africa', via: ['bosporus'] },
    { from: 'Black Sea (Russia, Ukraine)', to: 'Middle East, East Africa, Asia', via: ['bosporus', 'redsea'] },
    { from: 'US Gulf Coast', to: 'Asia', via: ['panama'] },
    { from: 'US Pacific Northwest, Canada, Australia', to: 'Asia', via: [] },
    { from: 'EU (France)', to: 'North and West Africa', via: [] },
  ],
  cocoa: [
    { from: "Côte d'Ivoire, Ghana", to: 'Netherlands, Belgium (Amsterdam, Antwerp)', via: [], note: 'Atlantic, no chokepoint' },
    { from: "Côte d'Ivoire, Ghana", to: 'US (Philadelphia)', via: [] },
    { from: "Côte d'Ivoire, Ghana", to: 'Malaysia, Indonesia (grinders)', via: ['cape', 'malacca'] },
    { from: 'Ecuador', to: 'Europe', via: ['panama'] },
  ],
  rareearths: [
    { from: 'China', to: 'Japan, Korea', via: [] },
    { from: 'China', to: 'Europe', via: ['malacca', 'redsea'], note: 'or around the Cape' },
    { from: 'China', to: 'US West Coast', via: [], note: 'trans-Pacific' },
    { from: 'Myanmar (Kachin)', to: 'China (separation)', via: [], note: 'overland' },
    { from: 'Australia (Mt Weld)', to: 'Malaysia (Lynas, Kuantan)', via: [] },
  ],
};

// One source of truth: each commodity's chokepoints cover its lane vias, and CHOKEPOINTS[id].commodities is derived.
for (const [k, c] of Object.entries(COMMODITIES)) c.chokepoints = [...new Set([...c.chokepoints, ...(LANES[k] || []).flatMap(l => l.via)])];
for (const [id, cp] of Object.entries(CHOKEPOINTS)) cp.commodities = Object.keys(COMMODITIES).filter(k => COMMODITIES[k].chokepoints.includes(id));

export function routesFor(key) {
  const c = getCommodity(key);
  if (!c) return { error: `unknown commodity: ${key}` };
  const k = Object.keys(COMMODITIES).find(x => COMMODITIES[x] === c);
  return {
    commodity: c.name,
    chokepoints: c.chokepoints.map(id => ({ id, ...CHOKEPOINTS[id] })),
    lanes: (LANES[k] || []).map(l => ({ ...l, via: l.via.map(id => ({ id, label: CHOKEPOINTS[id].label })) })),
    ...(k === 'gold' ? { note: 'Gold moves mostly by air between vault hubs (London, Zurich, New York, Dubai, Hong Kong, Shanghai), so sea chokepoints matter little.' } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// 6. Federal contracts (USAspending, no key). total/topAgencies are obligations in the window;
// top[].amount is each award's lifetime value (a 1990s contract can top the list).
export const usaspending = safe(async (name, { years = 3 } = {}) => {
  name = String(name || '').trim();
  if (!name) return { error: 'name required' };
  const start = daysAgo(Math.round(years * 365.25)) < '2007-10-01' ? '2007-10-01' : daysAgo(Math.round(years * 365.25));
  return store(`usaspending-${fileKey(name.toLowerCase())}-${years}y-${today()}.json`, async () => {
    const filters = { award_type_codes: ['A', 'B', 'C', 'D'], recipient_search_text: [name], time_period: [{ start_date: start, end_date: today() }] };
    const post = (p, body) => http(`https://api.usaspending.gov/api/v2/search/${p}/`, { method: 'POST', json: true, label: 'USAspending', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters, ...body }) });
    const [agencies, count, awards] = await Promise.all([
      post('spending_by_category/awarding_agency', { limit: 100, page: 1 }),
      post('spending_by_award_count', {}),
      post('spending_by_award', { fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency', 'Description', 'Start Date'], limit: 10, page: 1, sort: 'Award Amount', order: 'desc' }),
    ]);
    const ag = agencies.results || [];
    return {
      name, from: start, to: today(), source: 'USAspending.gov (prime contracts, award types A-D)',
      total: Math.round(ag.reduce((s, a) => s + (a.amount || 0), 0)),
      count: count.results?.contracts ?? 0,
      topAgencies: ag.slice(0, 8).map(a => ({ agency: a.name, amount: Math.round(a.amount || 0) })),
      top: (awards.results || []).map(a => ({
        recipient: a['Recipient Name'], agency: a['Awarding Agency'], subAgency: a['Awarding Sub Agency'] || null,
        amount: Math.round(a['Award Amount'] || 0), description: a.Description || null, date: a['Start Date'] || null, awardId: a['Award ID'],
      })),
      amountNote: 'total and topAgencies: obligations in the window; top[].amount: lifetime award value',
    };
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Macro pack. FRED (API with FRED_API_KEY, else the public fredgraph CSV). FRED does not carry the EIA
// weekly inventory series, so crude stocks and gas storage come from EIA's own history pages (no key).
const MACRO = [
  { id: 'DGS10', label: '10-year Treasury yield', unit: '%', days: 365 },
  { id: 'FEDFUNDS', label: 'Fed funds rate', unit: '%', days: 1220 },
  { id: 'CPIAUCSL', label: 'CPI inflation (y/y)', unit: '% y/y', days: 1590, yoy: true },
  { id: 'UNRATE', label: 'Unemployment rate', unit: '%', days: 1220 },
  { id: 'DCOILWTICO', label: 'WTI crude (spot)', unit: 'USD/bbl', days: 365 },
  { id: 'WCESTUS1', label: 'US crude inventories ex-SPR (EIA, weekly)', unit: 'million bbl', days: 300, eia: 'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WCESTUS1&f=W', scale: 1e-3 },
  { id: 'NW2_EPG0_SWO_R48_BCF', label: 'US natural gas in storage, Lower 48 (EIA, weekly)', unit: 'Bcf', days: 300, eia: 'https://www.eia.gov/dnav/ng/hist/nw2_epg0_swo_r48_bcfw.htm' },
];

async function fredSeries(id, start) {
  // -> { source, pts:[{t, v}] }; a failing FRED_API_KEY falls back to the public CSV
  const key = process.env.FRED_API_KEY;
  if (key) {
    try {
      return await store(`fred-${id}-${start}-api-${today()}.json`, async () => {
        const j = await http(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${start}`, { json: true, label: 'FRED API' });
        const pts = (j.observations || []).map(o => ({ t: o.date, v: num(o.value) })).filter(p => p.v != null);
        if (!pts.length) throw new Error(`FRED: no data for ${id}`);
        return { source: 'FRED API', pts };
      });
    } catch { /* use the CSV */ }
  }
  return store(`fred-${id}-${start}-csv-${today()}.json`, async () => {
    const t = await http(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`, { label: 'FRED' });
    const rows = csvRows(t);
    if (!/date/i.test(rows[0]?.[0] || '')) throw new Error(`FRED: unexpected response for ${id}`);
    const pts = rows.slice(1).map(([d, v]) => ({ t: d, v: num(v) })).filter(p => p.v != null); // skips "" and "."
    if (!pts.length) throw new Error(`FRED: no data for ${id}`);
    return { source: 'FRED', pts };
  });
}

// EIA dnav history table -> [{t, v}] (rows are "YYYY-Mon" with up to five week-ending dates each)
function parseDnav(html) {
  const out = [];
  for (const row of html.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const ym = /class='B6'>(?:&nbsp;|\s)*(\d{4})-[A-Za-z]{3}/.exec(row);
    if (!ym) continue;
    for (const [, d, v] of row.matchAll(/<td class='B5'>([^<]*)<\/td>\s*<td class='B3'>([^<]*)<\/td>/g)) {
      const md = /(\d\d)\/(\d\d)/.exec(d), val = num(v.replace(/&nbsp;/g, ''));
      if (md && val != null) out.push({ t: `${ym[1]}-${md[1]}-${md[2]}`, v: val });
    }
  }
  return out;
}
async function eiaHistory(url, id) {
  return store(`eia-${id}-${today()}.json`, async () => {
    const pts = parseDnav(await http(url, { label: 'EIA' }));
    if (pts.length < 20) throw new Error(`EIA: could not read ${id}`);
    return pts;
  });
}

export const macro = safe(async ({ points = 40 } = {}) => {
  const out = [];
  for (const m of MACRO) {
    try {
      const start = daysAgo(m.days);
      let pts, source = 'EIA', note;
      if (m.eia) pts = (await eiaHistory(m.eia, m.id)).filter(p => p.t >= start);
      else ({ source, pts } = await fredSeries(m.id, start));
      if (m.scale) pts = pts.map(p => ({ t: p.t, v: p.v * m.scale }));
      if (m.yoy) { // CPI index -> % change vs the same month a year earlier
        const byMonth = new Map(pts.map(p => [p.t.slice(0, 7), p.v]));
        const shift = (ym, k) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + k, 1)); return d.toISOString().slice(0, 7); };
        // a missing base month (BLS never published October 2025 CPI) is the geometric mean of its neighbours
        const guessed = new Set();
        const base = ym => {
          if (byMonth.has(ym)) return byMonth.get(ym);
          const a = byMonth.get(shift(ym, -1)), b = byMonth.get(shift(ym, 1));
          if (a && b) { guessed.add(ym); return Math.sqrt(a * b); }
          return null;
        };
        pts = pts.map(p => { const ym = shift(p.t.slice(0, 7), -12), b = base(ym); return b ? { t: p.t, v: (p.v / b - 1) * 100, guess: guessed.has(ym) ? ym : null } : null; }).filter(Boolean);
        const g = pts.slice(-2).find(p => p.guess);
        if (g) note = `index for ${g.guess} was never published; interpolated from the months either side`;
      }
      if (pts.length < 2) throw new Error('not enough data');
      const last = pts.at(-1), prev = pts.at(-2);
      out.push({
        id: m.id, label: m.label, unit: m.unit, date: last.t, last: rnd(last.v, 3), prev: rnd(prev.v, 3), change: rnd(last.v - prev.v, 3),
        source, ...(note ? { note } : {}),
        series: downsample(pts, points).map(p => ({ t: p.t, v: rnd(p.v, 3) })),
      });
    } catch (e) { out.push({ id: m.id, label: m.label, error: errMsg(e) }); }
  }
  return out;
});

// ---------------------------------------------------------------------------------------------
// 8. EIA weekly inventories (EIA_API_KEY) and USDA NASS wheat (NASS_API_KEY).
const EIA_WEEKLY = [
  { id: 'WCESTUS1', route: 'petroleum/stoc/wstk', label: 'Crude oil ex-SPR', unit: 'thousand bbl', page: 'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WCESTUS1&f=W' },
  { id: 'WCSSTUS1', route: 'petroleum/stoc/wstk', label: 'Strategic Petroleum Reserve', unit: 'thousand bbl', page: 'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WCSSTUS1&f=W' },
  { id: 'WGTSTUS1', route: 'petroleum/stoc/wstk', label: 'Total motor gasoline', unit: 'thousand bbl', page: 'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WGTSTUS1&f=W' },
  { id: 'WDISTUS1', route: 'petroleum/stoc/wstk', label: 'Distillate fuel oil', unit: 'thousand bbl', page: 'https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WDISTUS1&f=W' },
  { id: 'NW2_EPG0_SWO_R48_BCF', route: 'natural-gas/stor/wkly', label: 'Natural gas in storage, Lower 48', unit: 'Bcf', page: 'https://www.eia.gov/dnav/ng/hist/nw2_epg0_swo_r48_bcfw.htm' },
];

// Without the key this returns needsKey, unless { fallback: true }: then (as when a set key fails) each series
// is read from EIA's public history page and carries source 'EIA history page'.
export const eiaInventories = safe(async ({ fallback = false, weeks = 60 } = {}) => {
  const key = process.env.EIA_API_KEY;
  if (!key && !fallback) return needsKey('EIA_API_KEY');
  const series = [];
  for (const s of EIA_WEEKLY) {
    try {
      let pts, source = 'EIA API v2';
      if (key) {
        try {
          pts = await store(`eiaapi-${s.id}-${today()}.json`, async () => {
            const url = `https://api.eia.gov/v2/${s.route}/data/?api_key=${encodeURIComponent(key)}&frequency=weekly&data[0]=value`
              + `&facets[series][]=${s.id}&start=${daysAgo(weeks * 7 + 400)}&sort[0][column]=period&sort[0][direction]=asc&length=5000`;
            const j = await http(url, { json: true, label: 'EIA API' });
            const p = (j?.response?.data || []).map(d => ({ t: d.period, v: num(d.value) })).filter(d => d.v != null);
            if (!p.length) throw new Error(`EIA API: no data for ${s.id}`);
            return p;
          });
        } catch { pts = null; }
      }
      if (!pts) { pts = await eiaHistory(s.page, s.id); source = 'EIA history page'; }
      const last = pts.at(-1), prev = pts.at(-2);
      const yearAgo = [...pts].reverse().find(p => p.t <= new Date(Date.parse(last.t) - 364 * 864e5).toISOString().slice(0, 10));
      series.push({
        id: s.id, label: s.label, unit: s.unit, source, date: last.t, last: last.v, wow: rnd(last.v - prev.v, 3),
        yoy: yearAgo ? rnd(last.v - yearAgo.v, 3) : null, yoyPct: yearAgo ? pct(last.v, yearAgo.v) : null,
        series: pts.slice(-weeks),
      });
    } catch (e) { series.push({ id: s.id, label: s.label, error: errMsg(e) }); }
  }
  const keyed = series.some(s => s.source === 'EIA API v2');
  return { source: keyed ? 'EIA API v2' : 'EIA history pages', ...(keyed ? {} : { fallbackFor: 'EIA_API_KEY' }), series };
});

// USDA NASS Quick Stats: US production (annual) and quarterly stocks for a crop the registry maps (wheat).
export const usdaCrops = safe(async (key = 'wheat', { years = 6 } = {}) => {
  const c = getCommodity(key);
  if (!c) return { error: `unknown commodity: ${key}` };
  if (!c.nass) return { error: `USDA NASS has no US data for ${c.name}` };
  const miss = needsKey('NASS_API_KEY');
  if (miss) return miss;
  const since = new Date().getFullYear() - years;
  const q = async (desc, extra) => {
    const url = `https://quickstats.nass.usda.gov/api/api_GET/?key=${encodeURIComponent(process.env.NASS_API_KEY)}&format=JSON&source_desc=SURVEY`
      + `&commodity_desc=${c.nass}&agg_level_desc=NATIONAL&domain_desc=TOTAL&year__GE=${since}&short_desc=${encodeURIComponent(desc)}${extra}`;
    const j = await http(url, { json: true, label: 'USDA NASS' });
    return (j.data || []).map(d => ({ year: Number(d.year), period: d.reference_period_desc, value: num(d.Value), unit: d.unit_desc })).filter(d => d.value != null);
  };
  return store(`nass-${key}-${since}-${today()}.json`, async () => {
    const prod = await q(`${c.nass} - PRODUCTION, MEASURED IN BU`, '&statisticcat_desc=PRODUCTION&freq_desc=ANNUAL&reference_period_desc=YEAR');
    const stocks = await q(`${c.nass} - STOCKS, MEASURED IN BU`, '&statisticcat_desc=STOCKS&freq_desc=POINT IN TIME');
    const order = { 'FIRST OF MAR': 3, 'FIRST OF JUN': 6, 'FIRST OF SEP': 9, 'FIRST OF DEC': 12 };
    return {
      commodity: c.name, source: 'USDA NASS Quick Stats',
      production: prod.sort((a, b) => a.year - b.year).map(d => ({ year: d.year, value: d.value, unit: 'bu' })),
      stocks: stocks.filter(d => order[d.period]).sort((a, b) => a.year - b.year || order[a.period] - order[b.period])
        .map(d => ({ date: `${d.year}-${String(order[d.period]).padStart(2, '0')}-01`, value: d.value, unit: 'bu' })),
    };
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Pairwise correlation of daily returns over the last `days` common trading days.
export const correlations = safe(async (tickers, { days = 250 } = {}) => {
  tickers = [...new Set((Array.isArray(tickers) ? tickers : String(tickers).split(/[,\s]+/)).filter(Boolean).map(t => t.toUpperCase().replace(/^\$/, '')))];
  if (tickers.length < 2) return { error: 'need at least two tickers' };
  const data = await spark(tickers, days <= 200 ? '1y' : days <= 450 ? '2y' : '5y');
  const have = tickers.filter(t => data[t]?.points.length > 30);
  const missing = tickers.filter(t => !have.includes(t));
  if (have.length < 2) return { error: 'not enough price data', missing };
  const maps = have.map(t => new Map(data[t].points.map(p => [p.t, p.c])));
  const dates = data[have[0]].points.map(p => p.t).filter(d => maps.every(m => m.has(d))).slice(-(days + 1));
  const rets = maps.map(m => dates.slice(1).map((d, i) => m.get(d) / m.get(dates[i]) - 1));
  const corr = (a, b) => {
    const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
  };
  const matrix = have.map((_, i) => have.map((_, j) => (i === j ? 1 : rnd(corr(rets[i], rets[j]), 3))));
  const pairs = [];
  for (let i = 0; i < have.length; i++) for (let j = i + 1; j < have.length; j++) pairs.push({ a: have[i], b: have[j], r: matrix[i][j] });
  pairs.sort((p, q) => (q.r ?? -2) - (p.r ?? -2));
  return { tickers: have, days: rets[0].length, from: dates[0], to: dates.at(-1), matrix, pairs, ...(missing.length ? { missing } : {}) };
});

// ---------------------------------------------------------------------------------------------
// 10. Earnings read-through: the ticker's last 8 earnings 8-Ks (item 2.02), and how each peer moved
// close-to-close on the next trading day vs the ticker itself. Assumes after-close reporting (as NVDA does):
// for pre-market reporters the reaction is on the filing day itself.
async function earningsDates(cik, n = 8) {
  const pad = String(cik).padStart(10, '0');
  return store(`earnings-dates-${pad}-${today()}.json`, async () => {
    const subs = JSON.parse(await secGet(`https://data.sec.gov/submissions/CIK${pad}.json`));
    const r = subs.filings?.recent;
    if (!r?.form) throw new Error('SEC: no filings');
    const dates = [];
    r.form.forEach((f, i) => { if ((f === '8-K' || f === '8-K/A') && /\b2\.02\b/.test(r.items?.[i] || '')) dates.push(r.filingDate[i]); });
    return [...new Set(dates)].sort().reverse().slice(0, n);
  });
}

export const earningsMoves = safe(async (ticker, peers = []) => {
  ticker = String(ticker || '').toUpperCase().replace(/^\$/, '');
  peers = [...new Set((Array.isArray(peers) ? peers : String(peers).split(/[,\s]+/)).filter(Boolean).map(p => p.toUpperCase().replace(/^\$/, '')))].filter(p => p !== ticker);
  const t = await findTicker(ticker);
  if (!t) return { error: `unknown ticker: ${ticker}` };
  if (!peers.length) return { error: 'peers required' };
  const dates = await earningsDates(t.cik);
  if (!dates.length) return { error: `no earnings 8-Ks (item 2.02) found for ${ticker}` };
  const data = await spark([ticker, ...peers], '3y');
  // close on the filing date (or the last trading day before) -> close on the next trading day
  const reaction = (sym, d) => {
    const p = data[sym]?.points;
    if (!p) return null;
    const i = p.findLastIndex(x => x.t <= d);
    return i >= 0 && i + 1 < p.length ? { day: p[i + 1].t, move: (p[i + 1].c / p[i].c - 1) * 100 } : null;
  };
  const own = Object.fromEntries(dates.map(d => [d, reaction(ticker, d)]));
  const out = [];
  for (const peer of peers) {
    if (!data[peer]) { out.push({ peer, error: 'no price data' }); continue; }
    const moves = dates.map(d => { const m = reaction(peer, d); return m && own[d] ? { date: d, day: m.day, move: rnd(m.move), own: rnd(own[d].move) } : null; }).filter(Boolean);
    if (!moves.length) { out.push({ peer, error: 'no overlapping price data' }); continue; }
    const same = moves.filter(m => Math.sign(m.move) === Math.sign(m.own)).length;
    out.push({
      peer, n: moves.length,
      avgMove: rnd(moves.reduce((s, m) => s + m.move, 0) / moves.length),
      avgAbsMove: rnd(moves.reduce((s, m) => s + Math.abs(m.move), 0) / moves.length),
      sameDirectionShare: rnd((same / moves.length) * 100, 1),
      moves,
    });
  }
  return out.sort((a, b) => (b.avgMove ?? -1e9) - (a.avgMove ?? -1e9));
});

// ---------------------------------------------------------------------------------------------
// CLI check: node engine/sources/world.mjs <fn> [args]
//   futures copper | production lithium | trade cocoa M | routesFor crude | usaspending "Lockheed Martin"
//   macro | eiaInventories | usdaCrops wheat | correlations NVDA,AMD,TSM | earningsMoves NVDA AMD,TSM | findCommodity "brent"
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [fn, a, b] = process.argv.slice(2);
  const run = {
    futures: () => futures(a), production: () => production(a, b ? { stage: b } : {}), trade: () => trade(a, { flow: b || 'X' }),
    routesFor: () => routesFor(a), usaspending: () => usaspending(a), macro: () => macro(), eiaInventories: () => eiaInventories(),
    usdaCrops: () => usdaCrops(a || 'wheat'), correlations: () => correlations(a), earningsMoves: () => earningsMoves(a, b || ''),
    findCommodity: () => findCommodity(a),
  }[fn];
  if (!run) { console.log('usage: node engine/sources/world.mjs <' + 'futures|production|trade|routesFor|usaspending|macro|eiaInventories|usdaCrops|correlations|earningsMoves|findCommodity> [args]'); process.exit(2); }
  console.log(JSON.stringify(await run(), null, 1));
}
