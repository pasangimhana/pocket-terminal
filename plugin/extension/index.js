// Pocket Terminal, as an OpenClaw plugin: the terminal_* tools the main agent orchestrates its sub-agent
// waves with, and one Gateway page route (/terminal), all thin wrappers over ../engine. Plain ESM with no build step and no imports
// from openclaw: the default export is the same object definePluginEntry() would return.
//
// The engine is imported lazily, so the plugin loads (and the route answers 503) before the engine
// exists. Both engine modules are imported by their absolute file URL so http.mjs (SSE) and run.mjs
// share one module graph. Engine edits need a Gateway restart.
//
// OpenClaw runs a captured copy of this file, so import.meta.url does not point at the repo:
// plugin/oc exports POCKET_ENGINE_DIR (pocket-terminal/engine) for the Gateway.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_DIR = process.env.POCKET_ENGINE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "engine");
const PREFIX = "/terminal";
const PAGE_URL = process.env.POCKET_PAGE_URL || `${PREFIX}/ on this Gateway`;

// OpenClaw's loader also captures (copies) whatever this module imports, which would leave the
// engine's own import.meta.url (and so its web/ and runs/ paths) pointing into a temp copy. Importing
// through a data: module makes the engine's parent a non-plugin URL, so Node loads the real files.
let nativeImport;
async function loadEngine(name) {
  const file = resolve(ENGINE_DIR, name);
  if (!existsSync(file)) return null;
  nativeImport ??= (await import("data:text/javascript,export default (u) => import(u)")).default;
  return nativeImport(pathToFileURL(file).href);
}

function placeholder(res, status, message) {
  if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" });
  res.end(`Pocket Terminal: ${message}\n`);
  return true;
}

async function route(req, res) {
  // The page links its assets relatively (style.css, app.js), so it must be served at /terminal/.
  const url = new URL(req.url ?? "/", "http://gateway");
  if (url.pathname === PREFIX) {
    res.writeHead(302, { Location: `${PREFIX}/${url.search}` }).end();
    return true;
  }
  let http;
  try {
    http = await loadEngine("http.mjs");
  } catch (err) {
    return placeholder(res, 500, `engine/http.mjs failed to load (${err?.message ?? err}). Fix it and restart the Gateway.`);
  }
  if (typeof http?.handle !== "function") return placeholder(res, 503, "the engine is not built yet (engine/http.mjs is missing).");
  try {
    return (await http.handle(req, res, { prefix: PREFIX, mode: "openclaw" })) === true;
  } catch (err) {
    if (!res.headersSent) return placeholder(res, 500, `request failed: ${err?.message ?? err}`);
    res.end();
    return true;
  }
}

const text = (t, details = {}) => ({ content: [{ type: "text", text: t }], details });
const fmtUsd = (v) => (Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`);
const tickerOf = (raw) => {
  const t = String(raw ?? "").trim().toUpperCase().replace(/^\$/, "");
  if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) throw new Error(`Need a stock ticker like NVDA, got "${raw ?? ""}"`);
  return t;
};

async function engineRun() {
  const run = await loadEngine("run.mjs");
  if (typeof run?.scan !== "function") throw new Error("Pocket Terminal's engine is not ready (engine/run.mjs is missing or old)");
  return run;
}

async function scanTool(_id, raw) {
  const run = await engineRun();
  const r = await run.scan({ ticker: tickerOf(raw?.ticker) });
  const sections = Object.entries(r.sections).map(([k, n]) => `${k} ${n}`).join(", ");
  const fin = r.financials
    .map((row) => {
      const last = row.values.at(-1);
      return last ? `${row.label} FY${last.fy} ${row.unit === "USD" ? fmtUsd(last.v) : last.v}` : null;
    })
    .filter(Boolean)
    .join("; ");
  return text(
    [
      `${r.name} (${r.ticker}): ${r.form} filed ${r.date}. ${r.chunks} excerpts ready (${sections}).`,
      fin ? `Financials: ${fin}.` : "No XBRL financials found.",
      `Next: call terminal_spawn with ticker ${r.ticker}.`,
    ].join("\n"),
    { ticker: r.ticker, chunks: r.chunks },
  );
}

async function spawnTool(_id, raw) {
  const run = await engineRun();
  const opts = { ticker: tickerOf(raw?.ticker) };
  if (typeof raw?.focus === "string" && raw.focus.trim()) opts.focus = raw.focus.trim().slice(0, 200);
  if (Number.isInteger(raw?.agents)) opts.agents = raw.agents;
  const r = await run.spawnWave1(opts);
  const rows = r.candidates.map((c, i) => `${i + 1}. ${c.name} | ${c.ticker ?? "private/foreign"} | ${c.count} | ${c.rels.join(", ") || "-"}`);
  return text(
    [
      `Wave 1 done: ${r.agents} agents, ${r.findings} findings, ${r.errors} errors.`,
      r.fill && Object.values(r.fill).some(Boolean) ? `The filing named few of some groups, so fill-in agents inferred ${r.fill.competitor} competitors, ${r.fill.supplier} suppliers, ${r.fill.customer} customers and ${r.fill.partner} partners (marked inferred); they are in the candidates.` : "",
      r.confirm && r.confirm.checked ? `Confirm agents checked ${r.confirm.checked} inferred companies against their own annual reports: ${r.confirm.yes} yes, ${r.confirm.no} no, ${r.confirm.unclear} unclear${r.confirm.noFiling ? ` (${r.confirm.noFiling} had no SEC filing to check)` : ""}.` : "",
      "Candidates (name | ticker | mentions | relationships):",
      ...rows,
      "Next: choose the 8-14 most important connected PUBLIC companies (they must have a ticker) and call terminal_expand with their tickers.",
    ].filter(Boolean).join("\n"),
    { agents: r.agents, findings: r.findings, candidates: r.candidates.length },
  );
}

async function expandTool(_id, raw) {
  const run = await engineRun();
  const tickers = Array.isArray(raw?.tickers) ? raw.tickers.map(String) : [];
  if (!tickers.length) throw new Error("terminal_expand needs a list of tickers from the terminal_spawn candidates");
  const r = await run.expand({ tickers });
  return text(
    [
      `Wave 2 done: ${r.agents} agents read the connected companies' filings, ${r.findings} findings, ${r.errors} errors.${r.skipped.length ? ` Skipped (no filing): ${r.skipped.join(", ")}.` : ""}`,
      `Totals: ${r.totalAgents} agents read ${r.filings} filings; ${r.crossLinkCount} cross-links.`,
      r.crossLinks.length ? `Cross-links found:\n${r.crossLinks.map((l) => `- ${l}`).join("\n")}` : "No cross-links found.",
      `Next: call terminal_news with ${r.newsTickers ?? "the root ticker and these tickers"} (max 15).`,
    ].join("\n"),
    { agents: r.agents, findings: r.findings, crossLinks: r.crossLinks.length },
  );
}

async function newsTool(_id, raw) {
  const run = await engineRun();
  const tickers = Array.isArray(raw?.tickers) ? raw.tickers.map(String) : [];
  const r = await run.news({ tickers });
  return text(
    [
      `News done: ${r.agents} agents read the latest 8-K/6-K filings.${r.skipped.length ? ` No current report for: ${r.skipped.join(", ")}.` : ""}`,
      ...r.items.map((x) => `- ${x}`),
      "Next: call terminal_profiles (no arguments needed).",
    ].join("\n"),
    { agents: r.agents },
  );
}

async function profilesTool(_id, raw) {
  const run = await engineRun();
  const tickers = Array.isArray(raw?.tickers) ? raw.tickers.map(String) : undefined;
  const r = await run.profiles({ tickers });
  return text(`Profiles done: ${r.agents} agents read the companies' annual reports, ${r.profiled} profiles built.\nNext: call terminal_resolve.`, { agents: r.agents });
}

async function privateTool(_id, raw) {
  const hop = await loadEngine("hop.mjs");
  if (typeof hop?.privateStep !== "function") throw new Error("Pocket Terminal's hop engine is not ready (engine/hop.mjs is missing)");
  const r = await hop.privateStep({ name: String(raw?.name ?? ""), terms: raw?.terms });
  const tickers = (r.candidates ?? []).filter((c) => c.ticker).slice(0, 12).map((c) => c.ticker);
  return text(
    [
      `${String(raw?.name ?? "The company")} has no SEC filings. ${r.filings ?? 0} annual reports name it; ${r.agents ?? 0} agents read them and found ${r.findings ?? 0} items.`,
      (r.candidates ?? []).length ? `Companies tied to it: ${(r.candidates ?? []).slice(0, 10).map((c) => `${c.name}${c.ticker ? ` (${c.ticker})` : ""}${c.rels?.length ? ` ${c.rels[0]}` : ""}`).join(", ")}.` : "",
      `Next: call terminal_news with the tickers ${tickers.join(", ") || "(none)"}, then terminal_profiles with no arguments.`,
    ].filter(Boolean).join("\n"),
    { filings: r.filings, agents: r.agents },
  );
}

async function resolveTool() {
  const run = await engineRun();
  const r = await run.resolve();
  return text(
    [
      r.entities ? `Resolve done: ${r.entities} anonymous parties, ${r.proposals} proposals, ${r.validated} checked against the candidates' own filings.` : "No anonymous parties to resolve.",
      ...r.lines.map((x) => `- ${x}`),
      "Now give your final answer: at most 2 short sentences (about 35 words), plain text, no URL, no markdown.",
    ].join("\n"),
    { entities: r.entities },
  );
}

async function whatifTool(_id, raw) {
  const run = await engineRun();
  const r = await run.whatif({ question: String(raw?.question ?? "") });
  return text(
    [
      `What-if "${r.question}": ${r.agents} agents assessed the companies on the map. Negative ${r.tally.negative}, mixed ${r.tally.mixed}, positive ${r.tally.positive}.`,
      r.worst.length ? `Hit hardest:\n${r.worst.map((x) => `- ${x}`).join("\n")}` : "",
      r.best.length ? `Could gain:\n${r.best.map((x) => `- ${x}`).join("\n")}` : "",
      r.rings?.length ? `Shock rings:\n${r.rings.map((x) => `- ${x}`).join("\n")}` : "",
      "Now answer in at most 2 short sentences (about 35 words), plain text, no URL, no markdown.",
    ].filter(Boolean).join("\n"),
    { agents: r.agents, tally: r.tally },
  );
}


async function streams() {
  const st = await loadEngine("streams.mjs");
  if (typeof st?.named !== "function") throw new Error("Pocket Terminal's engine/streams.mjs is missing");
  return st;
}
const lines = (arr) => (arr || []).map((x) => `- ${x}`).join("\n");
const ANSWER = "Now answer in at most 2 short sentences (about 35 words), plain text, no URL, no markdown.";

async function namedTool(_id, raw) {
  const r = await (await streams()).named({ max: Number.isInteger(raw?.max) ? raw.max : undefined });
  const t = r.tally;
  return text([
    `Who names it: ${r.filings} annual reports filed this year name the company; ${r.agents} agents read one each. Customers ${t.customer}, suppliers ${t.supplier}, competitors ${t.competitor}, partners ${t.partner}, investors ${t.investor}, passing mentions ${t.other}.`,
    r.customers.length ? `Customers that say so in their own filings:\n${lines(r.customers)}` : "",
    r.suppliers.length ? `Suppliers:\n${lines(r.suppliers)}` : "",
    r.competitors.length ? `Competitors:\n${lines(r.competitors)}` : "",
    ANSWER,
  ].filter(Boolean).join("\n"), { agents: r.agents });
}

async function investigateTool(_id, raw) {
  const name = String(raw?.name || "").trim();
  if (!name) throw new Error("name is required");
  const inv = await loadEngine("investigate.mjs");
  const r = await inv.investigate({ name, ticker: raw?.ticker ? String(raw.ticker) : undefined });
  return text([
    `Investigated ${r.target}${r.ticker ? ` (${r.ticker})` : ""}: ${r.agents} agents read ${r.sources} sources.`,
    r.what ? `It is: ${r.what}.` : "The synthesis agent returned nothing.",
    r.relationship ? `Tie to the mapped company: ${r.relationship}.` : "",
    r.leads ? `${r.leads} newly connected companies were added to the map.` : "",
    ANSWER,
  ].filter(Boolean).join("\n"), { agents: r.agents });
}

async function changesTool() {
  const r = await (await streams()).changes();
  if (!r.agents) return text(`No comparison: ${r.note || "no earlier annual report"}. ${ANSWER}`);
  return text([`What changed between the annual reports of ${r.previous} and ${r.latest}: ${r.agents} agents found ${r.changes} changes (${Object.entries(r.byType).map(([k, n]) => `${k} ${n}`).join(", ")}).`, lines(r.top), ANSWER].join("\n"), { agents: r.agents });
}

async function earningsTool(_id, raw) {
  const r = await (await streams()).earnings({ tickers: Array.isArray(raw?.tickers) ? raw.tickers.map(String) : undefined });
  return text([`Earnings: ${r.agents} agents read the latest earnings press releases.`, lines(r.lines), ANSWER].join("\n"), { agents: r.agents });
}

async function commodityTool(_id, raw) {
  const r = await (await streams()).commodity({ commodity: String(raw?.commodity ?? ""), max: Number.isInteger(raw?.max) ? raw.max : undefined });
  const t = r.tally;
  return text([
    `${r.commodity} value chain${r.price ? ` (price ${r.price})` : ""}: ${r.agents} agents read ${r.filings} annual reports that mention it. Producers ${t.producer}, refiners ${t.refiner}, shippers ${t.shipper}, consumers ${t.consumer}, hedgers ${t.hedger}.`,
    r.producers.length ? `Producers: ${r.producers.join(", ")}` : "", r.refiners.length ? `Refiners: ${r.refiners.join(", ")}` : "",
    r.shippers.length ? `Shippers: ${r.shippers.join(", ")}` : "", r.consumers.length ? `Consumers: ${r.consumers.join(", ")}` : "",
    "Next: call terminal_profiles with no arguments, then answer in at most 2 short sentences (about 35 words), plain text, no URL, no markdown.",
  ].filter(Boolean).join("\n"), { agents: r.agents });
}

async function indexShockTool(_id, raw) {
  const r = await (await streams()).indexShock({ id: String(raw?.index ?? "SPX"), question: String(raw?.question ?? ""), source: "chat" });
  return text([`Index-wide what-if "${r.question}" across ${r.title}: ${r.assessed} of ${r.agents} agents reported.`, `By sector:\n${lines(r.sectors)}`, r.worst.length ? `Hit hardest:\n${lines(r.worst)}` : "", r.best.length ? `Could gain:\n${lines(r.best)}` : "", ANSWER].filter(Boolean).join("\n"), { agents: r.agents });
}

async function wireTool(_id, raw) {
  const mod = await loadEngine("wire.mjs");
  if (!mod?.wire) throw new Error("Pocket Terminal's wire engine is not ready (engine/wire.mjs is missing)");
  const action = String(raw?.action ?? "status");
  let st;
  if (action === "stop") st = await mod.wire.stop();
  else {
    if (action === "start") await mod.wire.start({ replay: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.replay ?? "")) ? raw.replay : "" });
    st = mod.wire.status();
  }
  const c = st.counters ?? {};
  const sec = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
  if (action === "stop") return text("The wire is stopped and the session is saved.", st);
  return text(
    [
      `News Wire ${st.phase ?? "idle"}${st.mode ? ` (${st.mode}${st.date ? " " + st.date : ""})` : ""}, model ${st.model ?? "n/a"}.`,
      st.counters ? `${c.in} stories in, ${c.scored} scored, ${c.relevant} relevant, ${c.ripples} ripple impacts; backlog ${st.backlog}; median ${sec(st.medLatMs)} from fetch to score (${sec(st.medQueueMs)} queue + ${sec(st.medGenMs)} generation).` : "",
      "The board is live at the page's News Wire (search box: wire). Reply in at most 2 short sentences.",
    ].filter(Boolean).join("\n"),
    st,
  );
}

const TOOLS = [
  {
    name: "terminal_scan",
    label: "Scan 10-K",
    description: "Step 1 of mapping a public company: fetch its latest SEC 10-K, split it into excerpts for the agent swarm, and pull 4 years of financials. Shows on the live graph page.",
    parameters: {
      type: "object",
      properties: { ticker: { type: "string", minLength: 1, maxLength: 12, description: "US stock ticker, e.g. NVDA. Turn a company name into its ticker first." } },
      required: ["ticker"],
      additionalProperties: false,
    },
    execute: scanTool,
  },
  {
    name: "terminal_spawn",
    label: "Spawn wave 1",
    description: "Step 2: spawn wave 1, one sub-agent per 10-K excerpt, all at once. They stream suppliers, customers, competitors, products, risks and numbers onto the graph. Returns the top candidate companies to expand on.",
    parameters: {
      type: "object",
      properties: {
        ticker: { type: "string", minLength: 1, maxLength: 12, description: "The ticker you scanned." },
        focus: { type: "string", maxLength: 200, description: "Optional angle for the agents, only if the user asked for one (e.g. 'supply chain in Asia')." },
        agents: { type: "integer", minimum: 4, maximum: 48, description: "Number of agents (default 32). Only if the user asked." },
      },
      required: ["ticker"],
      additionalProperties: false,
    },
    execute: spawnTool,
  },
  {
    name: "terminal_expand",
    label: "Spawn wave 2",
    description: "Step 3: spawn wave 2, one sub-agent per chosen connected company, each reading that company's own annual report for links back into the network. Pass 8-14 tickers chosen from terminal_spawn's candidates.",
    parameters: {
      type: "object",
      properties: {
        tickers: { type: "array", minItems: 1, maxItems: 14, items: { type: "string", minLength: 1, maxLength: 12 }, description: "Tickers of the connected public companies to read next." },
      },
      required: ["tickers"],
      additionalProperties: false,
    },
    execute: expandTool,
  },
  {
    name: "terminal_news",
    label: "Read latest 8-Ks",
    description: "Step 4: one sub-agent per company reads its most recent 8-K (6-K for foreign filers) and gives a headline and sentiment. Pass the mapped company's ticker plus the tickers you expanded (max 15).",
    parameters: {
      type: "object",
      properties: { tickers: { type: "array", minItems: 1, maxItems: 15, items: { type: "string", minLength: 1, maxLength: 12 }, description: "The mapped ticker first, then the expanded tickers." } },
      required: ["tickers"],
      additionalProperties: false,
    },
    execute: newsTool,
  },
  {
    name: "terminal_profiles",
    label: "Profile companies",
    description: "Step 5: one sub-agent per company on the map reads its latest annual report and builds a profile (business, segments, customers, suppliers, competitors, risks). Call with no arguments to profile every company on the map.",
    parameters: {
      type: "object",
      properties: { tickers: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 12 }, description: "Optional; default is every company on the map with a ticker." } },
      additionalProperties: false,
    },
    execute: profilesTool,
  },
  {
    name: "terminal_resolve",
    label: "Unmask anonymous parties",
    description: "Step 6: unmask anonymous parties in the filing ('Customer A', 'two vendors'): agents propose public companies, other agents check each proposal against that company's own annual report, then a verdict per entity.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: resolveTool,
  },
  {
    name: "terminal_private",
    label: "Map a private company",
    description: "Step 1 of a hop to a PRIVATE company (no ticker, no SEC filings, e.g. Carl Zeiss): SEC full-text search finds the annual reports that name it and one sub-agent per filing reads what they say. Then call terminal_news and terminal_profiles. Only for a message that says 'Hop to the private company ...'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2, maxLength: 80, description: "The private company's name, as in the hop message." },
        terms: { type: "string", maxLength: 120, description: "Optional other spellings to search, comma separated." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: privateTool,
  },
  {
    name: "terminal_whatif",
    label: "What-if",
    description: "For a what-if question about the company already mapped (e.g. 'What if Taiwan is blockaded?'): one sub-agent per company on the map judges the impact on that company, all at once.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", minLength: 3, maxLength: 300, description: "The user's what-if question, as asked." } },
      required: ["question"],
      additionalProperties: false,
    },
    execute: whatifTool,
  },
  {
    name: "terminal_named",
    label: "Who names it",
    description: "On a mapped company: SEC full-text search finds every annual report filed this year that names it (about 160 for NVIDIA), and one sub-agent per filing reads the paragraphs that mention it to say whether that filer is a customer, supplier, competitor, partner or investor. Finds real customers that the company's own filing leaves anonymous.",
    parameters: { type: "object", properties: { max: { type: "integer", minimum: 10, maximum: 200, description: "Cap on filings to read (default 200). Only if the user asked." } }, additionalProperties: false },
    execute: namedTool,
  },
  {
    name: "terminal_investigate",
    label: "Investigate a company",
    description: "On a mapped company map: investigate ONE company on it (a thin private one, an unnamed party like Customer A, or any tile). Sub-agents read the root's filings that name it, other filers' annual reports and 8-Ks that mention it, its own annual report, Wikipedia and recent headlines; a synthesis agent returns what it is, how it connects to the mapped company, headquarters, ownership, key facts, and new connected companies to add to the map.",
    parameters: { type: "object", properties: { name: { type: "string", minLength: 2, maxLength: 120, description: "Company name as it appears on the map." }, ticker: { type: "string", maxLength: 10, description: "Ticker if the map shows one." } }, required: ["name"], additionalProperties: false },
    execute: investigateTool,
  },
  {
    name: "terminal_changes",
    label: "What changed this year",
    description: "On a mapped company: compare its latest annual report with last year's. Sub-agents read the new and dropped paragraphs of the business, risk factors and MD&A sections and report new or lost suppliers and customers, new or dropped risks, new products and segment changes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: changesTool,
  },
  {
    name: "terminal_earnings",
    label: "Earnings releases",
    description: "On a mapped company: one sub-agent per company (the mapped one plus its biggest connections) reads its latest earnings press release (8-K exhibit 99.1) and pulls the KPIs and guidance.",
    parameters: { type: "object", properties: { tickers: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 12 }, description: "Optional; default is the mapped company plus the top connected tickers." } }, additionalProperties: false },
    execute: earningsTool,
  },
  {
    name: "terminal_commodity",
    label: "Map a commodity",
    description: "Map a commodity's value chain instead of a company: copper, crude oil, LNG, lithium, uranium, gold, iron ore, wheat, cocoa or rare earths. Live futures price, production by country (USGS), trade flows (UN Comtrade), shipping chokepoints, and one sub-agent per annual report that mentions the commodity, placing each company as producer, refiner, shipper, consumer or hedger. Afterwards terminal_whatif works on the commodity map (e.g. 'Chile copper output -10%').",
    parameters: { type: "object", properties: { commodity: { type: "string", minLength: 2, maxLength: 40, description: "The commodity, e.g. copper, crude, lng, lithium." }, max: { type: "integer", minimum: 10, maximum: 160, description: "Cap on filings to read (default 160). Only if the user asked." } }, required: ["commodity"], additionalProperties: false },
    execute: commodityTool,
  },
  {
    name: "terminal_indexshock",
    label: "Index-wide what-if",
    description: "One what-if across a whole index, sector map or ETF: one sub-agent per member company (500 for the S&P 500), then the result by sector. index: SPX, NDX, DJI, SEMIS, ENERGY, BANKS, or an ETF symbol like SMH, XLE, URA.",
    parameters: { type: "object", properties: { index: { type: "string", minLength: 2, maxLength: 12 }, question: { type: "string", minLength: 3, maxLength: 300 } }, required: ["index", "question"], additionalProperties: false },
    execute: indexShockTool,
  },
  {
    name: "terminal_wire",
    label: "News Wire",
    description: "Start, stop or check the live News Wire: public news feeds (SEC 8-K filings, Google News, Yahoo, CNBC, press releases) scored in batches by sub-agents, with companies on the page's board turning red or green and supply-chain neighbours lighting up second. It runs on its own stream beside any map. action: start (optional replay date YYYY-MM-DD to replay a past trading day), stop, or status.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["start", "stop", "status"] }, replay: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Optional date to replay instead of live, e.g. 2026-11-20." } }, required: ["action"], additionalProperties: false },
    execute: wireTool,
  },
];

export default {
  id: "pocket-terminal",
  name: "Pocket Terminal",
  description: "Type a ticker: a swarm of Kimi K3.1 Pro agents on Cerebras reads the company's SEC 10-K in parallel and a live graph grows at /terminal.",
  // Same contract as openclaw's emptyPluginConfigSchema(): no plugin config.
  configSchema: {
    safeParse(value) {
      if (value === undefined) return { success: true, data: undefined };
      if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return { success: true, data: value };
      return { success: false, error: { issues: [{ path: [], message: "config must be empty" }] } };
    },
    jsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  register(api) {
    // auth "plugin": the Gateway does no token check, so the page opens in a plain browser.
    api.registerHttpRoute({ path: PREFIX, auth: "plugin", match: "prefix", handler: route });
    // every tool's result also goes to the page, so the main agent's trajectory is visible there
    for (const tool of TOOLS) {
      api.registerTool({
        ...tool,
        async execute(id, raw, signal) {
          let out;
          try {
            out = await tool.execute(id, raw, signal);
          } catch (err) {
            (await loadEngine("run.mjs").catch(() => null))?.toolResult?.(tool.name, `Error: ${err?.message ?? err}`);
            throw err;
          }
          (await loadEngine("run.mjs").catch(() => null))?.toolResult?.(tool.name, out?.content?.[0]?.text ?? "");
          return out;
        },
      });
    }
    // the agent's own text between tool calls (final answers arrive as the reply instead)
    if (typeof api.on === "function") {
      api.on("llm_output", async (ev) => {
        try {
          const texts = (ev?.assistantTexts ?? []).filter((t) => typeof t === "string" && t.trim());
          if (!texts.length || !/toolCall|tool_use|toolUse|tool_calls/.test(JSON.stringify(ev?.lastAssistant ?? {}))) return;
          (await loadEngine("run.mjs"))?.botNote?.(texts.join("\n"));
        } catch {}
      });
    }
  },
};
