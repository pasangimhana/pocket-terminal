// On-demand profile agent: one sub-agent reads a company's latest annual report and returns a structured profile.
// Used when someone opens a company in the terminal. Cached per ticker for the life of the process.
import { findTicker, latest10K, get10KText, splitItems } from './sec.mjs';
import { streamChat, providerConfig } from './llm.mjs';

const cache = new Map();

export const SYSTEM = (name, form, date) => `You are an analyst agent reading ${name}'s ${form} annual report (filed ${date}).
Return ONE JSON object and nothing else (no prose, no code fences):
{"summary":"<2 sentences: what the company does and how it makes money>",
 "segments":[{"name":"<segment>","note":"<max 12 words>"}],
 "products":["<product or service line>"],
 "customers":[{"name":"<company or customer type>","q":"<verbatim quote, max 18 words>"}],
 "suppliers":[{"name":"<company or supplier type>","q":"<verbatim quote, max 18 words>"}],
 "competitors":["<company>"],
 "risks":["<risk in max 8 words>"],
 "facts":[{"name":"<e.g. Employees, Revenue share outside US>","value":"<value>"}]}
Rules: only what the excerpt states; quotes copied verbatim; at most 6 items per list; empty list if the excerpt says nothing.`;

// The excerpt a profile agent reads: Item 1 (Item 4 on a 20-F) plus the start of the risk factors.
export function profileExcerpt(text) {
  const items = splitItems(text);
  const biz = (items['1'] || items['4'] || text).slice(0, 14000);
  const risk = (items['1A'] || items['3'] || '').slice(0, 5000);
  return `BUSINESS:\n${biz}\n\nRISK FACTORS (start):\n${risk}`;
}

// Parse a profile agent's JSON answer (tolerates code fences and stray prose).
export function parseProfile(content) {
  const raw = String(content || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '');
  try { return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return { summary: raw.slice(0, 400) }; }
}

// The map's profiles wave fills the same cache, so /api/profile answers instantly afterwards.
export function setProfile(ticker, value) {
  cache.set(String(ticker).toUpperCase(), Promise.resolve(value));
}

// The cached profile (a promise) or undefined; a later hop reuses it instead of starting another agent.
export function cachedProfile(ticker) { return cache.get(String(ticker || '').toUpperCase()); }

export async function profile(ticker) {
  ticker = String(ticker || '').toUpperCase().replace(/^\$/, '');
  if (!ticker) throw new Error('ticker required');
  if (cache.has(ticker)) return cache.get(ticker);
  const job = (async () => {
    const t = await findTicker(ticker);
    if (!t) throw new Error(`Unknown ticker ${ticker}`);
    const info = await latest10K(t.cik);
    if (!info) throw new Error(`No annual report on EDGAR for ${ticker}`);
    const text = await get10KText(info, t.cik);
    const items = splitItems(text);
    const biz = (items['1'] || items['4'] || text).slice(0, 14000);
    const risk = (items['1A'] || items['3'] || '').slice(0, 5000);
    const started = Date.now();
    const excerpt = `BUSINESS:\n${biz}\n\nRISK FACTORS (start):\n${risk}`;
    const res = await streamChat({
      messages: [{ role: 'system', content: SYSTEM(t.name, info.form, info.date) }, { role: 'user', content: excerpt }],
      maxTokens: 2500, sessionId: 'pt-profile-' + ticker,
    });
    const raw = res.content.trim().replace(/^```(json)?/i, '').replace(/```$/, '');
    let j = {};
    try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { j = { summary: raw.slice(0, 400) }; }
    const tokens = res.usage?.completion_tokens || 0, ct = res.timeInfo?.completion_time;
    return {
      ticker, name: t.name, form: info.form, date: info.date, url: info.url,
      provider: providerConfig().label, tokens, tps: ct ? Math.round(tokens / ct) : null, ms: Date.now() - started, ...j,
      trace: { input: { label: `${ticker} ${info.form} · business section + start of risk factors`, chars: excerpt.length, preview: excerpt.slice(0, 700) }, raw: String(res.content || '').slice(0, 12000), queuedMs: res.first ? res.first - started : null, genMs: res.first ? res.end - res.first : null },
    };
  })();
  cache.set(ticker, job);
  job.catch(() => cache.delete(ticker));
  return job;
}

// Private companies have no SEC filing: one agent reads every paragraph in the session's filings that names it.
const pcache = new Map();
export async function privateProfile(name, findMentions) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) throw new Error('name required');
  if (pcache.has(key)) return pcache.get(key);
  const job = (async () => {
    const { root, hits } = await findMentions(name);
    const started = Date.now();
    const sources = [...new Set(hits.map(h => h.source))];
    const excerpt = hits.map((h, i) => `[${i + 1}] (${h.source}) ${h.text}`).join('\n\n');
    const system = `You are an analyst agent profiling ${name}, a company without SEC filings, for a terminal mapping ${root || 'a company'}.
Return ONE JSON object and nothing else:
{"summary":"<2 sentences: what ${name} is and how it connects to ${root || 'the mapped company'}>",
 "relationships":[{"with":"<company whose filing says it>","rel":"<customer|supplier|partner|investee|competitor|other>","q":"<verbatim quote, max 25 words>","source":"<the source label in brackets' parentheses>"}],
 "facts":[{"name":"","value":""}],
 "background":"<1-2 sentences of general knowledge about ${name}, ONLY if the excerpts say little; else empty>"}
Rules: relationships and facts only from the excerpts, quotes verbatim; background is general knowledge and will be labelled as such.`;
    const user = hits.length ? `Excerpts from SEC filings that name ${name}:\n\n${excerpt}` : `No loaded SEC filing names ${name}. Fill only "summary" and "background" from general knowledge; leave relationships and facts empty.`;
    const res = await streamChat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 1800, sessionId: 'pt-private-' + key.replace(/\W+/g, '-') });
    const j = parseProfile(res.content);
    const ct = res.timeInfo?.completion_time, tk = res.usage?.completion_tokens || 0;
    return { name, private: true, sources, mentions: hits.length, provider: providerConfig().label, ms: Date.now() - started, tokens: tk, tps: ct ? Math.round(tk / ct) : null, ...j,
      trace: { input: { label: hits.length ? `${hits.length} paragraphs naming ${name} across ${sources.length} filing${sources.length === 1 ? '' : 's'}` : `no loaded filing names ${name}`, chars: user.length, preview: user.slice(0, 700) }, raw: String(res.content || '').slice(0, 12000), queuedMs: res.first ? res.first - started : null, genMs: res.first ? res.end - res.first : null } };
  })();
  pcache.set(key, job);
  job.catch(() => pcache.delete(key));
  return job;
}
