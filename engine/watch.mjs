// Watchlist: every few minutes, check SEC for new filings by the companies on the map; an agent reads each new one.
// Results go straight to open pages (broadcast), outside any session.
import { broadcast, runAgent, inputOf } from './run.mjs';
import { findTicker, htmlToText, UA } from './sec.mjs';

const EVERY = 5 * 60e3;
const FORMS = new Set(['8-K', '6-K', '10-Q', '10-K', '20-F', '4', 'SC 13D', 'SC 13G', 'S-1', '424B4']);
const state = { tickers: [], since: null, seen: new Set(), timer: null, last: null, found: [] };

async function recent(cik) {
  const pad = String(cik).padStart(10, '0');
  const r = await fetch(`https://data.sec.gov/submissions/CIK${pad}.json`, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const j = await r.json(), x = j.filings.recent;
  return x.accessionNumber.slice(0, 15).map((acc, i) => ({ acc, form: x.form[i], date: x.filingDate[i], url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${x.primaryDocument[i]}` }));
}

async function check() {
  state.last = new Date().toISOString();
  for (const t of state.tickers) {
    const list = await recent(t.cik).catch(() => []);
    for (const f of list) {
      if (state.seen.has(f.acc)) continue;
      state.seen.add(f.acc);
      if (!state.since || f.date < state.since || !FORMS.has(f.form)) continue;
      // a new filing since the watch started: one agent reads it
      const text = htmlToText(await (await fetch(f.url, { headers: { 'User-Agent': UA } })).text()).slice(0, 6000);
      const agent = { id: 'watch-' + f.acc, label: `${t.ticker} ${f.form} ${f.date}`, ticker: t.ticker, name: t.name, input: inputOf(`${t.ticker} ${f.form} filed ${f.date}`, text) };
      broadcast({ type: 'watch', phase: 'new', agent, filing: f });
      await runAgent({
        agent, maxTokens: 250, emit: e => broadcast({ ...e, watch: true }),
        fix: x => { if (x.k !== 'news') return false; Object.assign(x, { ticker: t.ticker, date: f.date, url: f.url, form: f.form }); state.found.unshift(x); return true; },
        messages: [{ role: 'system', content: `You read ${t.name}'s new ${f.form} filing with the SEC (filed ${f.date}). Output exactly one JSON line and nothing else:\n{"k":"news","name":${JSON.stringify(t.name)},"headline":"<what happened, max 14 words>","sentiment":"positive|negative|neutral"}` }, { role: 'user', content: text || '(empty)' }],
      });
    }
  }
  broadcast({ type: 'watch', phase: 'checked', at: state.last, tickers: state.tickers.length });
}

export async function watch(tickers) {
  const list = (await Promise.all([...new Set((tickers || []).map(x => String(x).toUpperCase()))].slice(0, 60).map(x => findTicker(x).catch(() => null)))).filter(Boolean);
  clearInterval(state.timer);
  Object.assign(state, { tickers: list, since: new Date().toISOString().slice(0, 10), seen: new Set(), found: [] });
  // mark what exists now as seen, so only filings that arrive after this moment get read
  for (const t of list) for (const f of await recent(t.cik).catch(() => [])) state.seen.add(f.acc);
  state.last = new Date().toISOString();
  state.timer = setInterval(() => check().catch(() => {}), EVERY);
  state.timer.unref?.();
  return status();
}

export function unwatch() { clearInterval(state.timer); state.timer = null; state.tickers = []; return status(); }
export function status() { return { watching: state.tickers.map(t => t.ticker), since: state.since, lastCheck: state.last, everyMin: EVERY / 60e3, found: state.found.slice(0, 20) }; }
