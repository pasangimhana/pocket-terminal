/* Pocket Terminal: an OpenClaw main agent births a swarm of sub-agents that read a company's filings,
   and every finding becomes a node the moment it streams in. */
'use strict';
const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const css = getComputedStyle(document.documentElement);
const C = k => css.getPropertyValue('--' + k).trim();
const COLORS = {
  supplier: '#c8a97e', customer: '#8fb996', competitor: '#c98a8a', partner: '#a39bc9', investee: '#a39bc9', acquired: '#a39bc9', other: '#a1a1aa',
  product: '#7fb3b0', segment: '#7fb3b0', risk: '#b98aa0', place: '#a1a1aa', hint: '#8fb996', agent: '#22c55e', agent2: '#22c55e', agent3: '#22c55e', agent4: '#22c55e', root: '#fafafa', bot: '#22c55e',
};
const P = { bg: '#09090b', accent: '#22c55e', acc: a => `rgba(34,197,94,${Math.max(0, Math.min(1, a)).toFixed(3)})` };
const GPU_TPS = 156;
const IMPACT = { negative: '#e5484d', mixed: '#e2a336', positive: '#46a758' };
const agentColor = w => w === 2 ? COLORS.agent2 : w === 3 ? COLORS.agent3 : w === 4 ? COLORS.agent4 : COLORS.agent;
const R1 = 400;
// clusters around the company, and the bot's hive of agents to the left
const RCX = 500, RCY = 370;
const HIVE = { x: 0, y: -(370 + 80) }; // the bot sits above the company, between Suppliers and Customers
const CLUSTERS = {
  supplier: { label: 'Suppliers', ang: -128 }, customer: { label: 'Customers', ang: -52 }, partner: { label: 'Partners', ang: 8 },
  competitor: { label: 'Competitors', ang: 64 }, product: { label: 'Products', ang: 124 }, risk: { label: 'Risks', ang: 180 },
};
for (const [k, c] of Object.entries(CLUSTERS)) { c.key = k; c.hx = Math.cos(c.ang * Math.PI / 180) * RCX; c.hy = Math.sin(c.ang * Math.PI / 180) * RCY; c.sx = c.hx; c.sy = c.hy; c.sr = 40; }
const REL2CL = { supplier: 'supplier', customer: 'customer', competitor: 'competitor', partner: 'partner', investee: 'partner', acquired: 'partner', other: 'other' };

// ---------- logos ----------
const LOGO_ALIAS = {
  tsmc: 'TSM', taiwansemiconductor: 'TSM', taiwansemiconductormanufacturing: 'TSM', microsoft: 'MSFT', microsoftazure: 'MSFT', azure: 'MSFT',
  alphabet: 'GOOGL', google: 'GOOGL', googlecloud: 'GOOGL', amazon: 'AMZN', amazonwebservices: 'AMZN', aws: 'AMZN', meta: 'META', metaplatforms: 'META',
  oracle: 'ORCL', intel: 'INTC', amd: 'AMD', advancedmicrodevices: 'AMD', broadcom: 'AVGO', micron: 'MU', microntechnology: 'MU', dell: 'DELL', delltechnologies: 'DELL',
  supermicro: 'SMCI', supermicrocomputer: 'SMCI', hpe: 'HPE', hewlettpackardenterprise: 'HPE', cisco: 'CSCO', ciscosystems: 'CSCO', arm: 'ARM', armholdings: 'ARM',
  marvell: 'MRVL', marvelltechnology: 'MRVL', apple: 'AAPL', tesla: 'TSLA', coreweave: 'CRWV', qualcomm: 'QCOM', ibm: 'IBM', samsung: 'SAMSUNG', samsungelectronics: 'SAMSUNG',
  skhynix: 'SKHYNIX', hynix: 'SKHYNIX', foxconn: 'FOXCONN', honhai: 'FOXCONN', honhaiprecision: 'FOXCONN', honhaiprecisionindustry: 'FOXCONN', openai: 'OPENAI', anthropic: 'ANTHROPIC',
  xai: 'XAI', wistron: 'WISTRON', quanta: 'QUANTA', quantacomputer: 'QUANTA', mediatek: 'MEDIATEK', huawei: 'HUAWEI', celestica: 'CELESTICA', jabil: 'JBL', flex: 'FLEX',
  amkor: 'AMKR', amkortechnology: 'AMKR', globalfoundries: 'GFS', umc: 'UMC', unitedmicroelectronics: 'UMC', synopsys: 'SNPS', cadence: 'CDNS', cadencedesignsystems: 'CDNS',
  equinix: 'EQIX', digitalrealty: 'DLR', nebius: 'NBIS', lumentum: 'LITE', coherent: 'COHR', ciena: 'CIEN', aristanetworks: 'ANET', arista: 'ANET', vertiv: 'VRT',
  appliedmaterials: 'AMAT', lamresearch: 'LRCX', kla: 'KLAC', asml: 'ASML', texasinstruments: 'TXN', analogdevices: 'ADI', nxp: 'NXPI', nxpsemiconductors: 'NXPI',
  onsemi: 'ON', westerndigital: 'WDC', seagate: 'STX', salesforce: 'CRM', netflix: 'NFLX', adobe: 'ADBE', palantir: 'PLTR', snowflake: 'SNOW', uber: 'UBER', sony: 'SONY',
  alibaba: 'BABA', servicenow: 'NOW', shopify: 'SHOP', paypal: 'PYPL', walmart: 'WMT', costco: 'COST', visa: 'V', mastercard: 'MA', coinbase: 'COIN', robinhood: 'HOOD',
  jpmorgan: 'JPM', jpmorganchase: 'JPM', goldmansachs: 'GS', bankofamerica: 'BAC', boeing: 'BA', pfizer: 'PFE', elililly: 'LLY', lilly: 'LLY', nike: 'NKE', disney: 'DIS',
};
const STRIP = /\b(the|corp|corporation|inc|incorporated|ltd|limited|plc|co|company|companies|holdings?|group|nv|sa|se|ag|llc|lp|technologies|technology)\b/g;
const norm = s => (s || '').toLowerCase().replace(/[.,&']/g, ' ').replace(STRIP, ' ').replace(/[^a-z0-9]/g, '');
const ALIAS_KEY = { taiwansemiconductormanufacturing: 'tsmc', taiwansemiconductor: 'tsmc', alphabet: 'google', amazonwebservices: 'amazon', aws: 'amazon', metaplatforms: 'meta',
  advancedmicrodevices: 'amd', honhai: 'foxconn', honhaiprecision: 'foxconn', honhaiprecisionindustry: 'foxconn', samsungelectronics: 'samsung', hewlettpackardenterprise: 'hpe',
  supermicrocomputer: 'supermicro', microsoftazure: 'microsoft', azure: 'microsoft', googlecloud: 'google', microntechnology: 'micron', ciscosystems: 'cisco', delltechnologies: 'dell' };
const companyKey = n => { const k = norm(n); return ALIAS_KEY[k] || k; };
const logoCache = new Map();
function logoFor(ticker, name) {
  const key = (ticker && ticker.toUpperCase()) || LOGO_ALIAS[norm(name)] || LOGO_ALIAS[companyKey(name)];
  const tries = [ticker && ticker.toUpperCase(), LOGO_ALIAS[norm(name)], LOGO_ALIAS[companyKey(name)]].filter(Boolean);
  if (!tries.length) return null;
  const k = tries.join('|');
  if (logoCache.has(k)) return logoCache.get(k);
  const holder = { img: null };
  logoCache.set(k, holder);
  const attempt = i => {
    if (i >= tries.length) return;
    const im = new Image();
    im.onload = () => { holder.img = im; };
    im.onerror = () => attempt(i + 1);
    im.src = 'logos/' + tries[i] + '.png';
  };
  attempt(0);
  return holder;
}

// ---------- stars ----------
const starsCv = $('#stars'), sctx = starsCv.getContext('2d');
let W = innerWidth, H = innerHeight, DPR = Math.min(2, devicePixelRatio || 1);
const stars = Array.from({ length: 520 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() ** 2, p: Math.random() * 6.28 }));
const STARS = Array.from({ length: 420 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() ** 2.2, p: Math.random() * 6.28 }));
function drawStars(now) {
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  sctx.fillStyle = '#050507'; sctx.fillRect(0, 0, W, H);
  if (!S.started) {
    for (const st of STARS) { const a = 0.15 + 0.6 * st.z + 0.18 * Math.sin(now * 0.0012 + st.p); const r = 0.5 + st.z * 1.1; sctx.fillStyle = `rgba(220,226,240,${a.toFixed(3)})`; sctx.fillRect(st.x * W, st.y * H, r, r); }
    return;
  }
  sctx.fillStyle = P.bg; sctx.fillRect(0, 0, W, H);
  const k = cam.k || 1, cx = cam.cx ?? W / 2, cy = cam.cy ?? H / 2;
  let step = 36 * k; while (step < 14) step *= 2;
  const ox = (((cx - cam.x * k) % step) + step) % step, oy = (((cy - cam.y * k) % step) + step) % step;
  sctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (let x = ox; x < W; x += step) for (let y = oy; y < H; y += step) sctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  const g = sctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(9,9,11,0)'); g.addColorStop(1, 'rgba(9,9,11,0.85)');
  sctx.fillStyle = g; sctx.fillRect(0, 0, W, H);
}

// ---------- glow sprites ----------
const spriteCache = new Map();
function glow(color) {
  if (spriteCache.has(color)) return spriteCache.get(color);
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, color); gr.addColorStop(0.18, color + 'aa'); gr.addColorStop(0.45, color + '30'); gr.addColorStop(1, color + '00');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  spriteCache.set(color, c);
  return c;
}

// ---------- state ----------
const cv = $('#graph'), ctx = cv.getContext('2d');
let S; // session state
function freshState() {
  return {
    nodes: [], links: [], byId: new Map(), agents: new Map(), started: false, t0: performance.now(),
    firstTokenAt: null, endAt: null, root: null, bot: null, scan: null, provider: null,
    findings: 0, tokensDone: 0, liveChars: new Map(), charsPerToken: new Map(), recentChars: [], sparks: [],
    gpuQueue: [], gpuShown: 0, selected: null, hover: null, metrics: new Map(), hints: [], relCount: {},
    financials: null, phase: 'idle', skipChips: [], byTicker: new Map(), agentTime: 0, lastLiveTick: null, kindCount: {}, extra: {}, agentFindings: new Map(), products: [], risks: [], seq: 0, news: [], peers: null, price: null, whatif: null, activeWave: 0, gpuShifts: {},
  };
}
S = freshState();

const sim = d3.forceSimulation([])
  .force('link', d3.forceLink([]).id(d => d.id).distance(l => l.dist).strength(l => l.str))
  .force('charge', d3.forceManyBody().strength(n => n.charge ?? -20).distanceMax(170))
  .force('collide', d3.forceCollide(n => n.kind === 'agent' ? 0 : n.r + (n.kind === 'company' ? 5 : 2.5)).strength(0.9))
  .force('hubX', d3.forceX(n => n.hx ?? 0).strength(n => n.hx == null ? 0 : n.kind === 'agent' ? 0.16 : 0.11))
  .force('hubY', d3.forceY(n => n.hy ?? 0).strength(n => n.hy == null ? 0 : n.kind === 'agent' ? 0.16 : 0.11))
  .alphaDecay(0.012).velocityDecay(0.32).stop();

function addNode(n) {
  if (S.byId.has(n.id)) return S.byId.get(n.id);
  n.born = performance.now();
  S.nodes.push(n); S.byId.set(n.id, n);
  sim.nodes(S.nodes);
  kick();
  return n;
}
function addLink(l) {
  l.born = performance.now();
  S.links.push(l);
  sim.force('link').links(S.links.filter(x => x.dist));
  kick();
  return l;
}
function kick(a = 0.45) { sim.alpha(Math.max(sim.alpha(), a)); }

function assignCluster(n) {
  let cl;
  if (n.kind === 'company') {
    if (n.outer) cl = 'outer';
    else { let best = 'partner', bv = -1; for (const [r, v] of Object.entries(n.relc || {})) { const c = REL2CL[r] || 'partner'; if (v > bv) { bv = v; best = c; } } cl = best; }
  } else if (n.kind === 'customer_hint') cl = 'customer';
  else if (n.kind === 'product' || n.kind === 'segment') cl = 'product';
  else if (n.kind === 'risk' || n.kind === 'place') cl = 'risk';
  if (cl === n.cl) return;
  n.cl = cl;
  if (cl === 'outer') { n.hx = n.ox; n.hy = n.oy; n.color = COLORS.other; }
  else if (CLUSTERS[cl]) { n.hx = CLUSTERS[cl].hx; n.hy = CLUSTERS[cl].hy; if (n.kind === 'company') n.color = COLORS[cl]; }
}

// ---------- filter keys ----------
let FILTER = 'all';
function matches(n) {
  if (FILTER === 'all') return true;
  if (n.kind === 'root' || n.kind === 'bot') return true;
  return n.cl === FILTER;
}
function setFilter(f) {
  FILTER = f; cam.user = false;
  document.querySelectorAll('#fkeys button').forEach(b => b.classList.toggle('on', b.dataset.f === f));
}
document.querySelectorAll('#fkeys button').forEach(b => b.addEventListener('click', () => { if (b.dataset.f === 'product' || b.dataset.f === 'risk') listModal(b.dataset.f); else setFilter(b.dataset.f); }));
addEventListener('keydown', ev => {
  if (document.activeElement === document.querySelector('#q')) return;
  const keys = ['all', 'supplier', 'customer', 'competitor', 'partner', 'product', 'risk'];
  const i = +ev.key - 1; if (i >= 0 && i < keys.length) { if (i >= 5) listModal(keys[i]); else setFilter(keys[i]); }
  if (ev.key === 'Escape') { S.selected = null; renderSide(); }
});

// ---------- camera ----------
const cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1, user: false };
function fitCamera(dt) {
  if (!cam.user && S.nodes.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const done = S.phase === 'done';
    for (const n of S.nodes) {
      if (n.x == null) continue;
      if (FILTER !== 'all' && !(n.cl === FILTER || n.kind === 'root')) continue;
      if (done && (n.kind === 'agent' || n.kind === 'bot')) continue;
      if (n.kind === 'agent') continue;
      const rr = n.kind === 'bot' ? n.r + 70 : n.r + 30;
      x0 = Math.min(x0, n.x - rr); y0 = Math.min(y0, n.y - rr); x1 = Math.max(x1, n.x + rr); y1 = Math.max(y1, n.y + rr);
    }
    const padL = W > 900 ? 360 : 40, padR = document.body.classList.contains('panels') && W > 900 ? 340 : 40, padT = 96, padB = 110;
    const k = Math.min((W - padL - padR) / Math.max(200, x1 - x0), (H - padT - padB) / Math.max(200, y1 - y0), 2.2);
    cam.tk = Math.max(0.18, k);
    cam.tx = (x0 + x1) / 2; cam.ty = (y0 + y1) / 2;
    cam.cx = padL + (W - padL - padR) / 2; cam.cy = padT + (H - padT - padB) / 2;
  }
  const f = 1 - Math.exp(-dt / 450);
  cam.k += (cam.tk - cam.k) * f; cam.x += (cam.tx - cam.x) * f; cam.y += (cam.ty - cam.y) * f;
  cam.cx ??= W / 2; cam.cy ??= H / 2;
}
const toScreen = (x, y) => [(x - cam.x) * cam.k + cam.cx, (y - cam.y) * cam.k + cam.cy];
const toWorld = (sx, sy) => [(sx - cam.cx) / cam.k + cam.x, (sy - cam.cy) / cam.k + cam.y];

// ---------- event handling ----------
const kindColor = f => f.k === 'company' ? (COLORS[f.rel] || COLORS.other) : f.k === 'customer_hint' ? COLORS.hint : (COLORS[f.k] || '#aab8d8');

// events go through a small queue so the story beats never overlap (bot birth → company → agents)
const EQ = []; let holdUntil = 0, eqTimer = null;
function dispatch(e) { EQ.push(e); pumpEQ(); }
function pumpEQ() {
  clearTimeout(eqTimer);
  while (EQ.length && performance.now() >= holdUntil) {
    const e = EQ.shift();
    onEvent(e);
    if (e.fast || window.PTHopFast) continue; // a saved or prefetched map arriving at once, or a hop in progress (hop.js): no story pauses
    if (e.type === 'ask' && e.mode !== 'whatif') holdUntil = performance.now() + 2100;
    else if (e.type === 'scan') holdUntil = performance.now() + 1100;
    else if (e.type === 'bot' && e.phase === 'tool') holdUntil = performance.now() + 450;
  }
  if (EQ.length) eqTimer = setTimeout(pumpEQ, holdUntil - performance.now() + 5);
}

function onEvent(e) {
  const now = performance.now();
  if (e.watch || e.type === 'watch') { X.onWatch(e); return; }
  switch (e.type) {
    case 'ask': if (e.mode === 'indexshock') break; if (e.mode === 'whatif') startWhatif(e); else if (X.STREAMS[e.mode]) X.startStream(e); else startSession(e); break;
    case 'rings': S.rings = e; renderSide(); break;
    case 'production': case 'trade': case 'routes': X.onData(e); break;
    case 'indexshock': break;
    case 'peers': S.peers = e.rows; renderSide(); renderView(); break;
    case 'price': S.price = e; renderSide(); break;
    case 'bot': {
      ensureBot();
      if (e.phase !== 'reply') (S.botLog ||= []).push(e);
      if (e.phase === 'tool_result' || e.phase === 'note') break;
      if (e.phase === 'tool') { agentsTool(e.tool, e.text); agentsStatus(e.text); }
      else if (e.phase === 'reply') {
        for (const t of AG.tools) t.classList.add('done'); agentsStatus(e.text); AG.el?.classList.add('idle');
        (S.botLog ||= []).push(e);
        if (S.phase === 'whatif' || S.chatPending) { if (S.lastQ) S.lastQ.done = true; S.chatPending = false; renderChat(); }
      }
      else agentsStatus(e.text && e.text.length < 60 ? 'Thinking: ' + e.text : 'Thinking…');
      if (e.phase === 'tool') tape(`<span class="ag">main</span> ⚙ ${esc(e.tool)} ${esc(e.text || '')}`);
      break;
    }
    case 'status': setStatus(e.text, true); break;
    case 'scan': onScan(e); break;
    case 'financials': S.financials = e; renderSide(); break;
    case 'spawn': onSpawn(e); agentsSpawn(e); break;
    case 'retry': { const a = S.agents.get(e.agent); if (a) a.retries = e.attempt; break; }
    case 'first': {
      const a = S.agents.get(e.agent);
      if (a) { a.state = 'live'; a.firstAt = now; const ang = Math.random() * 6.283; a.launch = { x: Math.cos(ang) * RCX * 0.55, y: Math.sin(ang) * RCY * 0.55 }; }
      if (!S.firstTokenAt) S.firstTokenAt = now;
      break;
    }
    case 'finding': onFinding(e, now); if (VIEW !== 'splc') renderView(); break;
    case 'done': {
      const a = S.agents.get(e.agent);
      if (a) { a.state = e.error ? 'error' : 'done'; a.doneAt = now; a.tokens = e.tokens; a.tps = e.tps; a.follow = null; a.raw = e.raw; a.reasoning = e.reasoning; a.queuedMs = e.queuedMs; a.genMs = e.genMs; a.error = e.error; if (a.target && a.target.working) a.target.working--; }
      S.tokensDone += e.tokens || 0;
      if (e.tokens && e.chars) S.charsPerToken.set(e.agent, e.chars / e.tokens);
      S.liveChars.delete(e.agent);
      break;
    }
    case 'candidates': for (const c of e.list || []) if (c.ticker) setTicker(S.byId.get('co:' + companyKey(c.name)) || entityNode(c.name), c.ticker); break;
    case 'end': {
      for (const t of AG.tools) t.classList.add('done'); AG.el?.classList.add('idle');
      S.endAt = now; const wasWhatif = S.phase === 'whatif'; S.phase = 'done';
      if (wasWhatif && S.lastQ) { S.lastQ.done = true; S.chatPending = false; renderChat(); }
      if (!wasWhatif) for (const n of S.nodes) if (n.kind === 'company' && !n.ticker && !n.route && groupOf(n)) lookupTicker(n);
      if (!wasWhatif && !REPLAY) { const priv = S.nodes.filter(n => groupOf(n) && n.kind === 'company' && !n.ticker && !n.route && !isAnon(n.name) && !isCategory(n.name) && !n.profile).slice(0, 12); let i = 0; const next = () => { const n = priv[i++]; if (n) loadProfile(n).finally(next); }; next(); next(); next(); } S.activeWave = 0; setStatus(''); document.body.classList.add('done'); updateCounters(true);
      renderView();
      setChatMode(true);
      break;
    }
    case 'error': setStatus('Error: ' + e.text); break;
  }
}

function startWhatif(e) {
  if (!S.chatPending) { chatPush('me', esc(e.q)); S.chatPending = true; }
  document.querySelector('#endcard')?.remove();
  for (const g of AG.groups) g.classList.add('collapsed');
  AG.el?.classList.remove('idle');
  agentsStatus('You asked: ' + e.q);
  S.phase = 'whatif'; S.streamMode = null; S.rings = null; S.whatif = { q: e.q, results: [] }; S.endAt = null;
  for (const n of S.nodes) delete n.impact;
  setFilter('all');
  $('#q').value = e.q;
  document.body.classList.remove('done');
  setStatus('What-if: ' + e.q, true);
  tape(`<span class="ag">you</span> ${esc(e.q)}`);
  renderSide();
}

function startSession(e) {
  document.querySelector('#endcard')?.remove();
  agentsReset(S.provider || $('#model').textContent.split(' · via')[0]);
  S.lastQ = null; renderChat();
  setTimeout(() => agentsStatus('Thinking…'), 0);
  for (const n of S.nodes) n.dead = true;
  S = freshState(); sim.nodes([]); sim.force('link').links([]);
  S.started = true; S.phase = 'bot'; S.ask = e;
  X.relabel(e.commodity ? 'commodity' : 'company');

  setChatMode(false);
  cam.user = false;
  document.body.classList.add('running');
  document.body.classList.remove('done', 'panels');
  $('#model').classList.remove('hidden');
  if (e.ticker) $('#q').value = e.ticker + (e.name ? '  ·  ' + e.name : '');
  $('#side').innerHTML = ''; $('#tape').innerHTML = '';
  ensureBot();
  setStatus('Main Agent is waking up…', true);
}

const FX = []; // world-space particles and shockwaves
function burst(x, y, color, n, speed) { FX.push({ kind: 'ring', x, y, born: performance.now(), life: 700, color, r0: 4, r1: 34 }); }
function converge(x, y, color) { for (let i = 0; i < 3; i++) FX.push({ kind: 'ring', x, y, born: performance.now() + i * 220, life: 800, color, r0: 220 - i * 40, r1: 30 }); }
function ensureBot() {
  if (S.bot) return S.bot;
  S.bot = { id: 'bot', kind: 'bot', x: 0, y: 0, r: 30 }; // lives in the Agents panel, not on the canvas
  return S.bot;
  converge(0, 0, P.accent);
  setTimeout(() => FX.push({ kind: 'ring', x: 0, y: 0, born: performance.now(), life: 900, color: P.accent, r0: 30, r1: 110 }), 1000);
  S.bot = addNode({ id: 'bot', kind: 'bot', name: 'OpenClaw main agent', r: 30, fx: 0, fy: 0, x: 0, y: 0, charge: -400 });
  S.bot.born = performance.now() + 1000; // pops in after the particles arrive
  return S.bot;
}

function onScan(e) {
  S.scan = e; S.phase = 'scan';
  ensureBot();
  // the company sits at the centre; the bot moves above the ring
  S.root = addNode({ id: 'root', kind: 'root', name: e.short || e.name, ticker: e.ticker, r: 26, fx: 0, fy: 0, x: 0, y: 0, charge: -600, logo: logoFor(e.ticker, e.short || e.name), quotes: [], agents: new Set() });
  S.bot.move = { x0: S.bot.fx, y0: S.bot.fy, x1: HIVE.x, y1: HIVE.y, start: performance.now(), dur: 1100 };
  S.byId.set('co:' + companyKey(e.short || e.name), S.root);
  document.body.classList.add('panels');
  $('#fkeys').classList.remove('hidden'); setFilter('all');
  $('#chat').classList.remove('hidden');
  renderSide();
  tape(`<span class="ag">main</span> scanned ${e.filing.form} filed ${e.filing.date} · ${e.chunks.length} sections`);
}

function onSpawn(e) {
  ensureBot();
  const N = e.agents.length;
  e.agents.forEach((a, i) => {
    const wave = e.wave || 1;
    let target = null, ang;
    if (e.kind === 'resolve' || e.kind === 'validate') target = entityNode(a.entity);
    else if (wave >= 2 && !X.NO_TARGET.has(wave)) target = companyNodeFor(a.short || a.name, a.ticker);
    ang = (i / N) * Math.PI * 2 - Math.PI / 2;
    const ringN = Math.min(N, 16), inner = i < ringN;
    const sAng = inner ? (i / ringN) * Math.PI * 2 : ((i - ringN) / Math.max(1, N - ringN)) * Math.PI * 2 + 0.2;
    const sR = inner ? 92 : 140;
    const b = S.bot;
    const node = ({
      id: a.id, kind: 'agent', wave, label: a.label, name: a.label, state: 'queued', r: wave >= 2 ? 4.6 : 5.5, ticker: a.ticker, born: performance.now(),
      x: b.x + Math.cos(ang) * 10, y: b.y + Math.sin(ang) * 10, vx: Math.cos(ang) * 14, vy: Math.sin(ang) * 14 + 10, hx: null, hy: null,
      charge: -10, target, delay: i * 35, findings: 0,
      hx: null, hy: null, orbitA: sAng, orbitR: sR * 0.42 + 18,
    });
    node.input = a.input || null;
    node.work = { news: 'Latest 8-K', whatif: 'What-if', profile: 'Annual report', resolve: 'Unmask', validate: 'Validate', fill: 'Fill in gaps', confirm: 'Confirm inferred', ...X.WORK }[e.kind] || (wave === 2 ? 'Connected filing' : '10-K section');
    S.agents.set(a.id, node);
    node.gpuShift = S.gpuShifts[wave] ??= (wave === 2 || wave === 3 ? gpuWaveShift(wave - 1) : 0);
    if (wave >= 2 && target) { target.working = (target.working || 0) + 1; }
  });
  S.activeWave = e.wave || 1;
  if (S.phase !== 'whatif') S.phase = 'wave' + (e.wave || 1);
  const what = { 1: `${N} agents reading the filing`, 2: `${N} agents following the connected companies`, 3: `${N} agents reading the latest 8-Ks`, 4: `${N} agents answering: ${e.question || S.whatif?.q || ''}`, 5: `${N} agents reading every connected company's annual report`, 8: `${N} agents filling in rivals and suppliers the filing does not name`, 9: `${N} agents checking the inferred companies' own filings`, 6: `${N} agents working out who the unnamed parties are`, 7: `${N} agents checking the candidates' own filings`, ...X.spawnText(N, e) }[e.wave || 1] || `${N} agents working`;
  setStatus(what, true);
  tape(`<span class="ag">main</span> spawned ${what}${e.wave === 2 || e.wave === 3 ? ' → ' + e.agents.map(a => a.ticker).filter(Boolean).join(' ') : ''}`);
}

const ACR_STOP = new Set(['of', 'the', 'and', 'for', '&', 'inc', 'corp', 'corporation', 'co', 'llc', 'ltd', 'plc', 'na', 'n.a.']);
const acronym = name => (name || '').replace(/[,.()]/g, ' ').split(/\s+/).filter(w => w && !ACR_STOP.has(w.toLowerCase())).map(w => w[0]).join('').toUpperCase();
function acronymMatch(name) {
  const t = (name || '').trim();
  if (/^[A-Z]{2,6}$/.test(t)) return S.nodes.find(n => n.kind === 'company' && n.name && n.name.split(/\s+/).length >= 2 && acronym(n.name) === t) || null;
  const a = acronym(t);
  if (a.length >= 2 && t.split(/\s+/).length >= 2) return S.nodes.find(n => n.kind === 'company' && n.name && n.name.trim() === a) || null;
  return null;
}
function setTicker(n, tk) {
  if (!n || n.ticker || !tk) return;
  tk = tk.toUpperCase();
  if (S.scan && tk.split('-')[0] === S.scan.ticker.split('-')[0]) return;
  n.ticker = tk; n.logo = logoFor(tk, n.name) || n.logo;
  if (!S.byTicker.has(tk)) S.byTicker.set(tk, n);
  if (n.profile?.private) { n.profile = null; PROFILES.delete('name:' + norm(n.name)); }
  queueFA(tk);
}
const LOOKUP = new Set();
async function lookupTicker(n) {
  const key = norm(n.name); if (n.route || !key || key.length < 3 || LOOKUP.has(key) || isAnon(n.name) || isCategory(n.name)) return; LOOKUP.add(key);
  try {
    const list = await (await fetch('api/search?q=' + encodeURIComponent(n.name.replace(/[,.]/g, ' ').trim().split(/\s+/).slice(0, 3).join(' ')))).json();
    const hit = list.find(t => { const k2 = norm(t.name); return k2 === key || (key.length >= 4 && k2.startsWith(key)) || (k2.length >= 5 && key.startsWith(k2)); });
    if (hit && !n.ticker) setTicker(n, hit.ticker);
  } catch {}
}
function entityNode(name) {
  if (!name) return null;
  const k = norm(name);
  return S.nodes.find(n => (n.kind === 'customer_hint' || n.kind === 'company') && norm(n.name) === k) || S.byId.get('co:' + companyKey(name)) || null;
}
function companyNodeFor(name, ticker) {
  if (ticker && S.root && S.scan && ticker.toUpperCase() === S.scan.ticker) return S.root;
  if (ticker && S.byTicker.has(ticker.toUpperCase())) return S.byTicker.get(ticker.toUpperCase());
  const key = 'co:' + companyKey(name);
  if (S.byId.has(key)) return S.byId.get(key);
  // never seen in wave 1: give the agent a company to dock on
  const ang = Math.random() * 6.283;
  const n = addNode({ id: key, kind: 'company', name: prettyName(name), rel: 'other', relc: { partner: 1 }, ticker, color: COLORS.partner, r: 10, x: Math.cos(ang) * RCX, y: Math.sin(ang) * RCY, charge: -40, quotes: [], agents: new Set(), mentions: 1, logo: logoFor(ticker, name) });
  assignCluster(n);
  if (ticker) S.byTicker.set(ticker.toUpperCase(), n);
  return n;
}
const prettyName = s => /[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Com|Corp|Inc|Ltd|Co)\b\.?/g, '').trim();

function onFinding(e, now) {
  const a = S.agents.get(e.agent);
  const f = X.mapFinding(e.f, e, a, now);
  if (!f) { S.findings++; if (a) { a.findings++; a.pulse = now; } (S.agentFindings.get(e.agent) || S.agentFindings.set(e.agent, []).get(e.agent)).push(e.f); tapeFinding(e, a); renderSide(); if (MODAL_NODE) companyModal(MODAL_NODE, true); return; }
  S.findings++;
  S.liveChars.set(e.agent, e.chars);
  S.recentChars.push([now, e.chars, e.agent]);
  if (a?.firstAt != null) S.gpuQueue.push(a.firstAt + (a.gpuShift || 0) + tokOf(e) / GPU_TPS * 1000);
  if (a) { a.findings++; a.pulse = now; }
  (S.agentFindings.get(e.agent) || S.agentFindings.set(e.agent, []).get(e.agent)).push(e.f);
  if (f.k === 'metric') { addMetric(f, e.agent); tapeFinding(e, a); return; }
  if (f.k === 'confirm') {
    const n = (f.ticker && S.byTicker.get(f.ticker.toUpperCase())) || a?.target || companyNodeFor(f.name, f.ticker);
    if (n) n.confirm = { supports: f.supports, q: f.q, why: f.why };
    tapeFinding(e, a); renderSide(); if (MODAL_NODE === n) companyModal(n, true); return;
  }
  if (f.k === 'profile' || f.k === 'candidate' || f.k === 'evidence' || f.k === 'resolved') {
    if (f.k === 'profile') {
      const n = (f.ticker && S.byTicker.get(f.ticker.toUpperCase())) || a?.target;
      const rec = { ...f, loading: false };
      if (f.ticker) PROFILES.set(f.ticker.toUpperCase(), rec);
      if (n) { n.profile = rec; if (!n.desc && f.summary) n.desc = f.summary; }
    } else {
      const n = entityNode(f.entity) || a?.target;
      if (n) {
        n.cands ||= [];
        let c = n.cands.find(x => (x.ticker && f.ticker && x.ticker === f.ticker) || norm(x.name) === norm(f.name));
        if (f.k === 'candidate' && !c) n.cands.push({ name: f.name, ticker: f.ticker, why: f.why });
        if (f.k === 'evidence') { if (!c) { c = { name: f.name, ticker: f.ticker }; n.cands.push(c); } c.evidence = { supports: f.supports, q: f.q, why: f.why }; }
        if (f.k === 'resolved') n.resolved = { name: f.name, ticker: f.ticker, confidence: f.confidence, why: f.why };
      }
    }
    tapeFinding(e, a); renderSide(); if (MODAL_NODE) companyModal(MODAL_NODE, true); return;
  }
  if (f.k === 'about' || f.k === 'news' || f.k === 'impact') {
    const target = (f.ticker && companyNodeFor(f.name, f.ticker)) || (a && a.target) || companyNodeFor(f.name, f.ticker);
    if (f.k === 'about' && target) target.desc = f.desc;
    if (f.k === 'news') { S.news.push(f); if (target) target.news = f; }
    if (f.k === 'impact') { S.whatif?.results.push({ ...f, node: target }); if (target) { target.impact = f; target.impactAt = now; burst(target.x, target.y, IMPACT[f.impact] || '#fff', 10, 2); } }

    tapeFinding(e, a); renderSide(); return;
  }

  let key, node;
  if (f.k === 'company') key = 'co:' + companyKey(f.name);
  else if (f.k === 'customer_hint') key = 'hint:' + e.agent + ':' + norm(f.name);
  else key = f.k + ':' + norm(f.name);
  // wave-2 agents reporting about the root company link back to the centre
  if (f.k === 'company' && S.scan && (companyKey(f.name) === companyKey(S.scan.short || S.scan.name) || (f.ticker && f.ticker.toUpperCase() === S.scan.ticker))) node = S.root;
  node = node || S.byId.get(key) || (f.k === 'company' ? acronymMatch(f.name) : null);
  const src = a && a.wave === 2 && a.target ? a.target : a;
  const wave2 = a?.wave === 2;
  if (f.k === 'product' || f.k === 'segment') { if (!S.products.some(x => norm(x.name) === norm(f.name))) S.products.push({ ...f, agent: a?.label }); }
  if (f.k === 'risk' || f.k === 'place') { if (!S.risks.some(x => norm(x.name) === norm(f.name))) S.risks.push({ ...f, agent: a?.label }); }
  const CAP = { risk: 14, place: 6, product: 14, segment: 6 };
  if (!node && CAP[f.k] != null) {
    S.kindCount[f.k] = (S.kindCount[f.k] || 0) + 1;
    if (S.kindCount[f.k] > CAP[f.k]) { const cl = f.k === 'product' || f.k === 'segment' ? 'product' : 'risk'; S.extra[cl] = (S.extra[cl] || 0) + 1; if (a && a.wave === 1) { a.follow = CLUSTERS[cl]; a.fo = { x: (Math.random() - 0.5) * 60, y: (Math.random() - 0.5) * 60 }; } tapeFinding(e, a); return; }
  }
  if (!node) {
    const isCo = f.k === 'company';
    const outer = isCo && wave2;
    let ox = null, oy = null;
    if (outer && src) { const d = Math.hypot(src.x, src.y) || 1; ox = src.x / d * (d + 190); oy = src.y / d * (d + 150); }
    const jit = () => (Math.random() - 0.5) * 60;
    const cl0 = isCo ? (REL2CL[f.rel] || 'partner') : f.k === 'customer_hint' ? 'customer' : (f.k === 'product' || f.k === 'segment') ? 'product' : 'risk';
    const hub = CLUSTERS[cl0] || { sx: 0, sy: 0 };
    const sx = outer ? (src?.x || 0) + jit() : hub.sx + jit(), sy = outer ? (src?.y || 0) + jit() : hub.sy + jit();
    node = addNode({
      id: key, kind: f.k, name: f.name, rel: f.rel, relc: {}, ticker: f.ticker || null, color: kindColor(f), outer, ox, oy,
      r: outer ? 6 : isCo ? 8 : f.k === 'segment' ? 6 : f.k === 'customer_hint' ? 7 : f.k === 'risk' ? 3.4 : 4.2,
      x: sx + jit(), y: sy + jit(),
      charge: isCo ? -40 : -12, quotes: [], agents: new Set(), mentions: 0, logo: isCo ? logoFor(f.ticker, f.name) : null, detail: f.detail, guess: f.guess, wave: a?.wave || 1, inferred: !!f.inferred,
    });
    if (f.k === 'customer_hint') S.hints.push(f);
    if (isCo && !f.ticker && !outer) setTimeout(() => lookupTicker(node), 50);
  }
  if (node.kind === 'company' && node !== S.root && !(wave2 && !node.outer) && f.rel) node.relc[f.rel] = (node.relc[f.rel] || 0) + 1;
  if (node !== S.root) assignCluster(node);
  if (node.kind === 'company' && f.ticker && !node.ticker) node.ticker = f.ticker;
  if (node.kind === 'company' && typeof f.pct === 'number' && !wave2) node.pct = Math.max(node.pct || 0, f.pct);
  if (node.kind === 'company' && node.ticker && !S.byTicker.has(node.ticker.toUpperCase())) { S.byTicker.set(node.ticker.toUpperCase(), node); if (!node.outer) queueFA(node.ticker); }
  node.mentions = (node.mentions || 0) + 1;
  if (node.kind === 'company' && node !== S.root) node.r = node.outer ? Math.min(10, 6 + node.mentions) : Math.min(24, 9 + Math.sqrt(node.mentions) * 2.6);
  if (!node.rel && f.rel) node.rel = f.rel;
  if (node.quotes && f.q && node.quotes.length < 8) node.quotes.push({ q: f.q, agent: a?.label || e.agent, rel: f.rel, from: src?.name });
  node.agents?.add(e.agent);
  if (f !== e.f) X.decorate(node, e.f);
  if (src && src !== node) {
    const cross = a?.wave === 2;
    const exists = S.links.find(l => (l.source.id || l.source) === src.id && (l.target.id || l.target) === node.id);
    if (cross && !exists && node.kind === 'company') {
      addLink({ source: src, target: node, kind: 'cross', color: node === S.root ? '#ffffff' : COLORS.agent2 });
      if (node === S.root) src.confirms = true;
      else if (node.outer) { (src.second ||= []).push(node.name); }
      else { (src.links ||= new Set()).add(node); (node.links ||= new Set()).add(src); }
    }

  }
  if (f.k === 'customer_hint') for (const g of f.guess || []) {
    let gn = S.byId.get('co:' + companyKey(g));
    if (!gn) {
      gn = addNode({ id: 'co:' + companyKey(g), kind: 'company', name: g, rel: 'customer', relc: { customer: 1 }, inferred: true, color: COLORS.customer, r: 8, x: node.x + 20, y: node.y + 20, charge: -40, quotes: [], agents: new Set(), mentions: 0, logo: logoFor(null, g) });
      assignCluster(gn);
      setTimeout(() => lookupTicker(gn), 50);
    }
    addLink({ source: node, target: gn, kind: 'hint', color: COLORS.customer });
  }
  tapeFinding(e, a);
  if (S.findings % 4 === 0) renderSide();
  if (node.mentions === 1) FX.push({ kind: 'ring', x: node.x, y: node.y, born: now, life: 700, color: P.accent, r0: node.r, r1: node.r + (node.kind === 'company' ? 16 : 9) });
  else node.flash = now;
}

function tokOf(e) { return e.chars / (S.charsPerToken.get(e.agent) || 3.6); }
// when wave 2 starts, the GPU side is still busy with wave 1: shift its wave-2 clock by the difference
function gpuWaveShift(w = 1) {
  let gpuEnd = 0, realEnd = 0;
  for (const a of S.agents.values()) {
    if (a.wave !== w || a.firstAt == null) continue;
    gpuEnd = Math.max(gpuEnd, a.firstAt + (a.gpuShift || 0) + (a.tokens || (S.liveChars.get(a.id) || 0) / 3.6) / GPU_TPS * 1000);
    realEnd = Math.max(realEnd, a.doneAt || performance.now());
  }
  return Math.max(0, gpuEnd - realEnd);
}

function addMetric(f, agent) {
  const k = norm(f.name);
  if (!S.metrics.has(k) && S.metrics.size < 10) { S.metrics.set(k, { ...f, agent, flash: performance.now() }); renderSide(); }
}

// ---------- end card: per-wave time on this run vs the same tokens at GPU speed ----------
function waveTimes(w) {
  const ag = [...S.agents.values()].filter(a => a.wave === w && a.firstAt != null);
  if (!ag.length) return null;
  // generation time only: each agent from its first token to done, agents in parallel; the GPU side gets the same tokens at GPU_TPS
  const real = Math.max(...ag.map(a => a.tokens && a.tps ? a.tokens / a.tps * 1000 : (a.doneAt || a.firstAt) - a.firstAt));
  const gpu = Math.max(...ag.map(a => (a.tokens || 0) / GPU_TPS * 1000));
  const tokens = ag.reduce((s, a) => s + (a.tokens || 0), 0);
  return { n: ag.length, real, gpu, tokens };
}
function endCard(waves = [1, 2, 3]) {
  const LABEL = { 1: 'Read the 10-K', 2: 'Followed the network', 3: 'Read the latest 8-Ks', 4: 'Answered the what-if' };
  const ws = waves.map(w => [w, waveTimes(w)]).filter(x => x[1]);
  if (!ws.length) return;
  const name = $('#race-name').textContent;
  const row = (label, w) => w ? `<div class="ec-row"><div class="ec-l">${label}<span>${w.n} agents · ${w.tokens.toLocaleString()} tokens</span></div><div class="ec-v ec-c">${(w.real / 1000).toFixed(1)}s</div><div class="ec-v ec-g">${(w.gpu / 1000).toFixed(1)}s</div></div>` : '';
  const el = document.createElement('div'); el.id = 'endcard';
  el.innerHTML = `<div class="ec-head"><div></div><div class="ec-c">${esc(name)}</div><div class="ec-g">GPU · ${GPU_TPS} tok/s</div></div>${ws.map(([w, t]) => row(LABEL[w], t)).join('')}<div class="ec-foot">Generation time after the first token, agents in parallel. GPU column: the same tokens at ${GPU_TPS} tok/s, the fastest GPU host measured for Kimi K3.1 Pro.</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 800); }, +(params.get('card') || 5000));
}

// ---------- Agents panel: the main agent, its tool calls and every sub-agent ----------
const AG = { el: null, rows: new Map(), tools: [], groups: [] };
const MARK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#4ade80" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v3"/><circle cx="12" cy="3" r="1" fill="#4ade80" stroke="none"/><rect x="4.5" y="6.5" width="15" height="12" rx="3.5"/><circle cx="9.3" cy="12.3" r="1.3" fill="#4ade80" stroke="none"/><circle cx="14.7" cy="12.3" r="1.3" fill="#4ade80" stroke="none"/><path d="M2.5 11.5v2.5M21.5 11.5v2.5"/></svg>';
function mainAgentModal() {
  const log = S.botLog || [];
  const rows = log.map(e => {
    if (e.phase === 'thinking') return `<div class="tj-s"><b>Asked</b> ${esc(e.text || '')}</div>`;
    if (e.phase === 'note') return `<div class="tj-s"><b>Thought</b> ${esc(e.text || '')}</div>`;
    if (e.phase === 'tool') return `<div class="tj-s"><b>Called</b> <code>${esc(e.tool)}</code> ${esc(e.text || '')}${e.args ? `<pre class="tj-p">${esc(JSON.stringify(e.args, null, 1))}</pre>` : ''}</div>`;
    if (e.phase === 'tool_result') return `<div class="tj-s"><b>Tool returned</b> <code>${esc(e.tool || '')}</code><pre class="tj-p raw">${esc(e.text || '')}</pre></div>`;
    if (e.phase === 'reply') return `<div class="tj-s"><b>Replied</b> ${esc(e.text || '')}</div>`;
    return '';
  }).join('');
  openModal('Main Agent', `<div class="tj">${rows || '<div class="empty">Nothing yet.</div>'}</div>`, `${esc(S.provider || '')} · orchestrates every sub-agent through tool calls (OpenClaw)`);
  $('#modal .mo')?.classList.add('wide');
}
function agentsReset(provider) {
  AG.el = $('#agents'); AG.rows.clear(); AG.tools = []; AG.groups = [];
  AG.el.innerHTML = `<div class="ag-main"><div class="ag-head">${MARK}<div><div class="ag-name">Main Agent</div><div class="ag-model">${esc(provider || '')}</div></div><span class="ag-spin"></span></div><div class="ag-status"></div><div class="ag-tools"></div></div>`;
  AG.el.classList.add('show');
  AG.el.querySelector('.ag-head').onclick = mainAgentModal;
  AG.el.querySelector('.ag-status').onclick = mainAgentModal;
}
function agentsStatus(text) { const el = AG.el?.querySelector('.ag-status'); if (el) { el.textContent = text; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }
const TOOL_LABEL = { terminal_scan: 'Read filing', terminal_spawn: '10-K agents', terminal_expand: 'Network', terminal_news: 'News', terminal_profiles: 'Profiles', terminal_resolve: 'Unmask', terminal_whatif: 'What-if', terminal_named: 'Who names it', terminal_changes: 'What changed', terminal_earnings: 'Earnings', terminal_commodity: 'Value chain', terminal_indexshock: 'Index what-if' };
const kfmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(Math.round(n));
function agentsTool(tool, text) {
  for (const t of AG.tools) t.classList.add('done');
  const el = document.createElement('div'); el.className = 'ag-tool';
  el.innerHTML = `<span class="tk"></span><b class="tl">${esc(TOOL_LABEL[tool] || tool)}</b><span class="tt" title="${esc(tool)}">${esc(text || '')}</span>`;
  el.groupsAfter = el;
  AG.el.querySelector('.ag-tools').appendChild(el); AG.tools.push(el);
  return el;
}
function agentsSpawn(e) {
  for (const g of AG.groups) g.classList.add('collapsed');
  const g = document.createElement('div'); g.className = 'ag-group';
  const n = e.agents.length;
  const work = { news: 'latest 8-Ks', whatif: e.ring != null ? `what-if · ring ${e.ring === 2 ? 2 : 1}` : 'what-if', profile: 'annual reports', resolve: 'unmask', validate: 'validate', fill: 'fill in rivals / suppliers', confirm: 'confirm inferred', ...X.GROUP_WORK }[e.kind] || (e.wave === 2 ? 'connected filings' : '10-K sections');
  g.innerHTML = `<div class="ag-ghead"><b>${ic('bot', 'bt')} ${n} sub-agents <span class="ag-work">· ${work}</span></b><span class="ag-gstat">waiting for first token</span></div><div class="ag-sum"></div><div class="ag-rows"></div>`;
  const rows = g.querySelector('.ag-rows');
  if (n > 12) rows.classList.add('two');
  e.agents.forEach((a, i) => {
    const r = document.createElement('div'); r.className = 'ag-row queued'; r.style.animationDelay = (i * 22) + 'ms';
    const label = (a.label || a.id).replace(' · ', ' ').replace('Financial Statements', 'Financials').replace(/\s+10-K$|\s+8-K$|\s+6-K$|\s+20-F$/, '');
    r.innerHTML = `<i></i><span class="l">${esc(label)}</span><span class="b"><em></em></span><span class="n">0</span>`;
    rows.appendChild(r); AG.rows.set(a.id, r);
  });
  const tl = AG.tools[AG.tools.length - 1];
  if (tl) { (tl.groupsAfter || tl).after(g); tl.groupsAfter = g; } else AG.el.querySelector('.ag-tools').appendChild(g);
  g.querySelector('.ag-ghead').onclick = () => groupModal(g);
  g.querySelector('.ag-sum').onclick = () => groupModal(g);
  rows.querySelectorAll('.ag-row').forEach((r, i) => r.onclick = () => agentModal(e.agents[i].id));
  AG.groups.push(g); g.wave = e.wave || 1; g.ids = e.agents.map(a => a.id);
  AG.el.scrollTop = AG.el.scrollHeight;
}
function agentsTick() {
  if (!AG.el) return;
  for (const g of AG.groups) {
    const ags = g.ids.map(id => S.agents.get(id)).filter(Boolean);
    const live = ags.filter(a => a.state === 'live').length, done = ags.filter(a => a.state === 'done' || a.state === 'error').length;
    const tok = ags.reduce((s, a) => s + (a.tokens || (S.liveChars.get(a.id) || 0) / 3.6), 0), finds = ags.reduce((s, a) => s + (a.findings || 0), 0);
    g.querySelector('.ag-gstat').textContent = done === ags.length ? `done · ${kfmt(tok)} tok` : live ? `${live} live · ${done}/${ags.length}` : 'queued';
    const wt = waveTimes(g.wave);
    g.querySelector('.ag-sum').textContent = `${ags.length} agents · ${finds} found · ${kfmt(tok)} tok${wt && done === ags.length ? ' · ' + (wt.real / 1000).toFixed(1) + 's' : ''}`;
    for (const a of ags) {
      const r = AG.rows.get(a.id); if (!r) continue;
      const st = a.state === 'error' ? 'error' : a.state;
      if (!r.classList.contains(st)) { r.classList.remove('queued', 'live', 'done', 'error'); r.classList.add(st); }
      const p = a.state === 'done' ? 1 : Math.min(0.94, (S.liveChars.get(a.id) || 0) / 4200);
      r.querySelector('em').style.width = (p * 100).toFixed(1) + '%';
      r.querySelector('.n').textContent = a.findings || 0;
    }
  }
}

// ---------- terminal functions: DES, FA, RV, SPLC, CN, ECO ----------
let VIEW = 'splc';
const VIEWS = ['des', 'fa', 'rv', 'splc', 'cn', 'eco'];
function setView(v) {
  // the old tabs now open as full-size panels on top of the terminal
  if (v === 'splc') { closeModal(); return; }
  if (v === 'eco') { $('#chat-q')?.focus(); return; }
  const f = { des: viewDES, fa: viewFA, rv: viewRV, cn: viewCN }[v];
  if (f) { openModal('', `<div class="vwrap">${f()}</div>`); $('#modal .mo')?.classList.add('wide'); }
}
function renderView() {}
function renderViewNow() {}
const vhead = (code, title, sub = '') => `<div class="vh"><span class="vc">${code}</span><div><div class="vt">${title}</div>${sub ? `<div class="vs">${sub}</div>` : ''}</div></div>`;
const nameOf = () => S.scan ? `${esc(S.scan.name)} · ${esc(S.scan.ticker)} US Equity` : '';
function viewDES() {
  if (!S.scan) return vhead('DES', 'Description', 'Map a company first');
  const segs = S.products.filter(p => p.k === 'segment'), prods = S.products.filter(p => p.k !== 'segment');
  const metrics = [...S.metrics.values()].filter(m => m.value);
  const places = S.risks.filter(r => r.k === 'place'), risks = S.risks.filter(r => r.k === 'risk');
  const tags = (list, cls = '') => `<div class="tg ${cls}">${list.map(p => `<span title="${esc(isTableQuote(p.q) ? '' : p.q || '')}">${esc(cap1(shortTxt(p.name, 5)))}</span>`).join('')}</div>`;
  const box = (icon, t, list, body) => list.length ? `<div class="igc"><h6>${ic(icon)} ${t} <em>${list.length}</em></h6>${body}</div>` : '';
  const unm = S.nodes.filter(n => n.resolved);
  return vhead('DES', nameOf(), `${esc(S.scan.filing.form)} filed ${esc(S.scan.filing.date)} · hover any item for the quote`) +
    (metrics.length ? `<div class="facts">${metrics.slice(0, 8).map(m => `<div title="${esc(isTableQuote(m.q) ? '' : m.q || '')}"><b>${esc(shortTxt(num(m.value), 3).replace(/…$/, ''))}</b><span>${esc(cap1(shortTxt(m.name, 5)))}</span></div>`).join('')}</div>` : '') +
    `<div class="igg">${box('seg', 'Segments', segs, tags(segs))}${box('box', 'Products & platforms', prods, tags(prods.slice(0, 30)))}${box('alert', 'Risks', risks, tags(risks.slice(0, 30), 'warn'))}${box('globe', 'Geography', places, tags(places.slice(0, 20)))}${box('users', 'Unnamed customers', S.hints, `<div class="cnds">${S.hints.map(h => `<div class="cnd"><span class="lc tg1">${esc(h.name)}</span><span class="ev unc">${esc(num(h.detail || '').slice(0, 28))}</span></div>`).join('')}</div>`)}${box('target', 'Unmasked', unm, `<div class="cnds">${unm.map(n => `<div class="cnd" data-node="${esc(n.id)}"><span class="lc tg1">${esc(shortTxt(n.name, 4))}</span>→ ${chip(n.resolved.name, { ticker: n.resolved.ticker })}<b class="cf">${esc(n.resolved.confidence)}</b></div>`).join('')}</div>`)}</div>`;
}
function viewFA() {
  if (!S.financials?.rows?.length) return vhead('FA', 'Financials', S.scan ? 'Loading from SEC XBRL…' : 'Map a company first');
  const rows = S.financials.rows, pr = S.peers?.[0];
  const charts = rows.map(r => `<div class="igc"><h6>${ic('hash')} ${esc(r.label)}</h6>${miniBars(r.values.map(v => v.v), r.values.map(v => 'FY' + String(v.fy).slice(-2)))}</div>`).join('');
  return vhead('FA', nameOf(), 'Annual figures from SEC XBRL') + (pr ? kpis([['Revenue', pr.revenue ? fmtUSD(pr.revenue) : '–', delta(pr.growth)], ['Gross margin', pctf(pr.grossMargin)], ['Op. margin', pctf(pr.opMargin)], ['Net margin', pctf(pr.netMargin)], ['R&D / rev', pctf(pr.rdPct)]]) : '') + `<div class="igg">${charts}</div>`;
}
function viewRV() {
  if (!S.peers?.length) return vhead('RV', 'Relative value', S.scan ? 'Peers arrive after the first wave of agents' : 'Map a company first');
  const P0 = S.peers, mx = k => Math.max(...P0.map(r => Math.abs(r[k] || 0)), 1e-9);
  const bar = (r, k, f) => `<div class="rvb"><i class="${(r[k] || 0) < 0 ? 'neg' : ''}" style="width:${(Math.abs(r[k] || 0) / mx(k) * 100).toFixed(0)}%"></i><b>${f(r[k])}</b></div>`;
  return vhead('RV', 'Relative value · competitors named in the filing', 'Latest fiscal year, SEC XBRL') +
    `<div class="rv2"><div class="rvh"><span></span><span>Revenue</span><span>Growth</span><span>Op. margin</span><span>Net margin</span><span>R&D / rev</span></div>${P0.map((r, i) => { const n = r.ticker && S.byTicker.get(r.ticker); return `<div class="rvr ${i === 0 ? 'me' : ''}"${n ? ` data-node="${esc(n.id)}"` : ''}><span>${chip(r.name || r.ticker, { ticker: r.ticker })}</span>${bar(r, 'revenue', v => v ? fmtUSD(v) : '–')}${bar(r, 'growth', pctf)}${bar(r, 'opMargin', pctf)}${bar(r, 'netMargin', pctf)}${bar(r, 'rdPct', pctf)}</div>`; }).join('')}</div>`;
}
function viewCN() {
  if (!S.news.length) return vhead('CN', 'News', S.scan ? 'News agents read each company\u2019s latest 8-K after the network wave' : 'Map a company first');
  const sorted = [...S.news].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return vhead('CN', 'Latest filings across the network', 'One agent per company read its most recent 8-K / 6-K') +
    `<div class="vnews">${sorted.map(n => { const node = n.ticker && S.byTicker.get(n.ticker.toUpperCase()); const c = n.sentiment === 'negative' ? IMPACT.negative : n.sentiment === 'positive' ? IMPACT.positive : '#71717a'; return `<div class="vn"${node ? ` data-node="${esc(node.id)}"` : ''}><span class="vd">${esc(n.date || '')}</span><span class="vk">${logoUrl(n.name, n.ticker) ? `<img src="${logoUrl(n.name, n.ticker)}" onerror="this.remove()">` : ''}${esc(n.ticker || '')}</span><i style="background:${c}"></i><span class="vhd">${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.headline)}</a>` : esc(n.headline)}</span></div>`; }).join('')}</div>`;
}
function viewECO() {
  const ex = ['What if Taiwan is blockaded?', 'What if hyperscalers cut AI capex 30%?', 'What if the US bans all chip exports to China?', 'What if memory prices double?'];
  let html = vhead('ECO', 'What-if', S.root ? 'One agent per company on the map answers at the same time' : 'Map a company first') +
    `<div class="eco-in"><input id="eco-q" placeholder="Ask a what-if about ${S.scan ? esc(S.scan.short || S.scan.name) : 'the company'}…" autocomplete="off"><button data-ask-go>Ask</button></div><div class="eco-ex">${ex.map(t => `<button data-ask="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
  if (S.whatif) {
    const order = { negative: 0, mixed: 1, positive: 2 };
    const rs = [...S.whatif.results].sort((a, b) => order[a.impact] - order[b.impact] || (b.severity || 0) - (a.severity || 0));
    html += `<div class="vb"><h5>${esc(S.whatif.q)} <span>${rs.length} answers${S.phase === 'whatif' ? ' · streaming' : ''}</span></h5><table class="vt2 eco"><tr><th>Company</th><th>Impact</th><th>Severity</th><th>Why</th></tr>${rs.map(r => `<tr${r.node ? ` data-node="${esc(r.node.id)}"` : ''}><td><b>${esc(r.ticker || '')}</b> ${esc(r.name || '')}</td><td><span class="ip ${esc(r.impact)}">${esc(r.impact)}</span></td><td>${'●'.repeat(r.severity || 1)}<span class="dim">${'●'.repeat(3 - (r.severity || 1))}</span></td><td class="why">${esc(r.why || '')}</td></tr>`).join('')}</table></div>`;
  }
  return html;
}

// ---------- side panel ----------
const fmtUSD = v => { const a = Math.abs(v); const s = a >= 1e12 ? (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? (a / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(0) + 'M' : a.toLocaleString(); return (v < 0 ? '-$' : '$') + s; };
const pctf = v => v == null || isNaN(v) ? '–' : (v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0) + '%';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let sideTimer = null;
function renderSide() {
  if (sideTimer) return;
  sideTimer = requestAnimationFrame(() => { sideTimer = null; renderSideNow(); });
}
function blk(id, title, meta, body) { return `<div class="card blk" data-open="${id}"><h4>${title}${meta ? ` <span>${meta}</span>` : ''}<i class="op">↗</i></h4>${body}</div>`; }
function renderSideNow() {
  const side = $('#side');
  const parts = [];
  if (S.scan) {
    const s = S.scan;
    let spark = '';
    if (S.price?.points?.length > 5) {
      const pts = S.price.points, cs = pts.map(p => p.c), lo = Math.min(...cs), hi = Math.max(...cs), w = 250, h = 40;
      const d = pts.map((p, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - (p.c - lo) / (hi - lo || 1) * h).toFixed(1)}`).join(' ');
      const ch = cs[cs.length - 1] / cs[0] - 1, col = ch >= 0 ? IMPACT.positive : IMPACT.negative;
      spark = `<div class="px"><b>$${cs[cs.length - 1].toFixed(2)}</b><span style="color:${col}">${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(1)}% 1y</span></div><svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${d}" fill="none" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
    }
    const pr = S.peers?.[0];
    const stats = pr ? [['Revenue', pr.revenue ? fmtUSD(pr.revenue) : '–'], ['Growth', pctf(pr.growth)], ['Gross m.', pctf(pr.grossMargin)], ['Op. m.', pctf(pr.opMargin)], ['Net m.', pctf(pr.netMargin)], ['R&D', pctf(pr.rdPct)]] : [];
    parts.push(s.kind === 'commodity' ? X.commodityTerm(spark) : `<div class="card term"><div class="term-h"><b>${esc(s.ticker)}</b> <span>US Equity</span></div><div class="term-n">${esc(s.name)}</div>${spark}${stats.length ? `<div class="kst">${stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>` : ''}<div class="term-s">${esc(s.filing.form)} · filed ${esc(s.filing.date)} · <a href="${esc(s.filing.url)}" target="_blank" rel="noopener">filing ↗</a></div></div>`);
    if (S.whatif) {
      const order = { negative: 0, mixed: 1, positive: 2 }, rs = [...S.whatif.results].sort((a, b) => order[a.impact] - order[b.impact] || (b.severity || 0) - (a.severity || 0));
      const c = { negative: 0, mixed: 0, positive: 0 }; for (const r of rs) c[r.impact] = (c[r.impact] || 0) + 1;
      parts.push(blk('eco', 'What-if', esc(S.whatif.q.replace(/^what if\s*/i, '')), `<div class="imp-sum"><span style="--c:${IMPACT.negative}">${c.negative} hurt</span><span style="--c:${IMPACT.mixed}">${c.mixed} mixed</span><span style="--c:${IMPACT.positive}">${c.positive} helped</span></div><div class="stk sm">${['negative', 'mixed', 'positive'].map(k => c[k] ? `<i style="flex:${c[k]};background:${IMPACT[k]}"></i>` : '').join('')}</div><div class="wgrid">${rs.slice(0, 8).map(r => `<div class="wr" title="${esc(r.why || '')}"><i class="dot" style="background:${IMPACT[r.impact]}"></i>${logoUrl(r.name, r.ticker) ? `<img src="${logoUrl(r.name, r.ticker)}" onerror="this.remove()">` : ''}<span>${esc(r.ticker || shortTxt(r.name, 1).replace(/…$/, ''))}</span>${sevBars(r.severity)}</div>`).join('')}</div>`));
    }
    if (S.financials?.rows?.length) {
      const rows = S.financials.rows, years = [...new Set(rows.flatMap(r => r.values.map(v => v.fy)))].sort().slice(-3);
      parts.push(blk('fa', 'Financials', 'SEC XBRL', `<table class="fin"><tr><th></th>${years.map(y => `<th>FY${String(y).slice(-2)}</th>`).join('')}</tr>${rows.slice(0, 5).map(r => `<tr><td>${esc(r.label)}</td>${years.map(y => { const v = r.values.find(x => x.fy === y); return `<td>${v ? fmtUSD(v.v) : '–'}</td>`; }).join('')}</tr>`).join('')}</table>`));
    }
    if (S.peers?.length > 1) parts.push(blk('rv', 'Peers', `${S.peers.length - 1} competitors`, `<table class="fin peers"><tr><th></th><th>Rev</th><th>Growth</th><th>Op m.</th></tr>${S.peers.slice(0, 6).map((r, i) => `<tr class="${i === 0 ? 'me' : ''}"><td>${esc(r.ticker)}</td><td>${r.revenue ? money(r.revenue, r.unit) : '–'}</td><td>${pctf(r.growth)}</td><td>${pctf(r.opMargin)}</td></tr>`).join('')}</table>`));
    if (S.news.length) parts.push(blk('cn', 'News', `${S.news.length} latest filings`, [...S.news].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5).map(n => `<div class="nw" title="${esc(n.headline)}">${logoUrl(n.name, n.ticker) ? `<img src="${logoUrl(n.name, n.ticker)}" onerror="this.remove()">` : ''}<b>${esc(n.ticker || n.name)}</b><i style="background:${n.sentiment === 'negative' ? IMPACT.negative : n.sentiment === 'positive' ? IMPACT.positive : '#71717a'}"></i><span>${esc(n.headline)}</span></div>`).join('')));
    const segs = S.products.filter(p => p.k === 'segment'), prods = S.products.filter(p => p.k !== 'segment');
    if (S.products.length) parts.push(blk('des', 'Business', `${segs.length} segments · ${prods.length} products`, `<div class="chips sm">${[...segs, ...prods].slice(0, 12).map(p => `<span class="${p.k === 'segment' ? 'seg' : ''}">${esc(cap1(shortTxt(p.name, 4)))}</span>`).join('')}</div>`));
    const rk = S.risks.filter(r => r.k === 'risk');
    if (rk.length) parts.push(blk('risk', 'Risks', `${rk.length}`, `<div class="tg warn">${rk.slice(0, 6).map(r => `<span>${esc(cap1(shortTxt(r.name, 5)))}</span>`).join('')}</div>`));
    const unm = S.nodes.filter(n => n.resolved);
    if (unm.length) parts.push(blk('des', 'Unmasked parties', `${unm.length}`, unm.map(n => `<div class="metric"><span>${esc(n.name)}</span><b>${esc(n.resolved.ticker || n.resolved.name)}</b></div>`).join('')));
    const counts = Object.entries(GROUPS).map(([k, G]) => [G.label, S.nodes.filter(n => groupOf(n) === k).length]);
    const others = S.nodes.filter(n => n.kind === 'company' && n.cl === 'other' && !n.outer && !isSelf(n));
    if (S.findings) parts.push(blk('other', 'Network', `${others.length} other entities`, counts.map(([k, v]) => `<div class="metric"><span>${k}</span><b>${v}</b></div>`).join('')));
  }
  if (S.scan) X.sideBlocks(parts);
  side.innerHTML = parts.join('');
  side.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openBlock(el.dataset.open));
  X.wireSide(side);
}
function whatifResults() {
  const W0 = S.whatif; if (!W0) return;
  const rs = W0.results, c = { negative: 0, mixed: 0, positive: 0 }; let sev = 0;
  for (const r of rs) { c[r.impact] = (c[r.impact] || 0) + 1; sev += r.severity || 1; }
  const n = rs.length || 1, avg = (sev / n).toFixed(1);
  const stack = `<div class="stk">${['negative', 'mixed', 'positive'].map(k => c[k] ? `<i style="flex:${c[k]};background:${IMPACT[k]}" title="${c[k]} ${k}"></i>` : '').join('')}</div>`;
  const groupOfR = r => r.node === S.root ? 'root' : r.node ? (groupOf(r.node) || 'other') : 'other';
  const colsDef = [['root', 'Company'], ['supplier', 'Suppliers'], ['customer', 'Customers'], ['competitor', 'Competitors'], ['partner', 'Partners'], ['other', 'Other']];
  const order = { negative: 0, mixed: 1, positive: 2 };
  const cols = colsDef.map(([k, label]) => {
    const list = rs.filter(r => groupOfR(r) === k).sort((a, b) => order[a.impact] - order[b.impact] || (b.severity || 0) - (a.severity || 0));
    if (!list.length) return '';
    const cc = { negative: 0, mixed: 0, positive: 0 }; for (const r of list) cc[r.impact]++;
    return `<div class="wc"><h6>${label} <em>${list.length}</em></h6><div class="stk sm">${['negative', 'mixed', 'positive'].map(x => cc[x] ? `<i style="flex:${cc[x]};background:${IMPACT[x]}"></i>` : '').join('')}</div>${list.map(r => `<div class="wr"${r.node ? ` data-node="${esc(r.node.id)}"` : ''} title="${esc(r.why || '')}"><i class="dot" style="background:${IMPACT[r.impact]}"></i>${logoUrl(r.name, r.ticker) ? `<img src="${logoUrl(r.name, r.ticker)}" onerror="this.remove()">` : ''}<span>${esc(r.ticker || shortTxt(r.name, 2))}</span>${sevBars(r.severity)}</div><div class="ww">${esc(shortTxt(r.why, 7))}</div>`).join('')}</div>`;
  }).join('');
  const reply = (S.botLog || []).filter(e => e.phase === 'reply').pop();
  const html = `${kpis([['Hurt', `<i class="kc" style="color:${IMPACT.negative}">${c.negative}</i>`], ['Mixed', `<i class="kc" style="color:${IMPACT.mixed}">${c.mixed}</i>`], ['Helped', `<i class="kc" style="color:${IMPACT.positive}">${c.positive}</i>`], ['Avg severity', avg + ' / 3'], ['Companies', rs.length]])}${stack}${reply ? `<div class="tk3">${ic('bot')} ${esc(shortTxt(reply.text, 22))}</div>` : ''}${X.ringsHtml()}<div class="wcs">${cols}</div>`;
  openModal(`What if… <span class="q2">${esc(W0.q.replace(/^what if\s*/i, ''))}</span>`, html, `${rs.length} agents answered at once · hover a company for its reason`);
  $('#modal .mo')?.classList.add('wide');
}
function openBlock(id) {
  if (X.openBlock(id)) return;
  if (id === 'eco') return whatifResults();
  if (id === 'risk') return listModal('risk');
  if (id === 'other') { const others = S.nodes.filter(n => n.kind === 'company' && n.cl === 'other' && !n.outer && !isSelf(n)); return openModal(`Other entities · ${others.length}`, `<div class="mx">Regulators, agencies and other entities named in the filing, not part of the supply chain.</div>` + others.map(n => `<div class="fi" data-node="${esc(n.id)}"><span class="fk">other</span><div><div class="fm">${esc(n.name)}</div>${n.quotes?.[0]?.q ? `<div class="fq">“${esc(n.quotes[0].q)}”</div>` : ''}</div></div>`).join('')); }
  if (id === 'eco') { openModal('', `<div class="vwrap">${viewECO()}</div>`); $('#modal .mo')?.classList.add('wide'); $('#modal .eco-in')?.remove(); $('#modal .eco-ex')?.remove(); return; }
  setView(id);
}
function detailCard(n) {
  const rel = n.kind === 'company' ? (n.inferred ? 'inferred ' : '') + (n.rel || 'company') : n.kind === 'agent' ? (n.wave === 2 ? 'wave-2 agent' : 'agent') : n.kind;
  const color = n.color || COLORS[n.kind] || '#fff';
  let body = '';
  if (n.kind === 'agent') {
    body = `<div class="metric"><span>state</span><b>${n.state}</b></div><div class="metric"><span>findings</span><b>${n.findings}</b></div>${n.tokens ? `<div class="metric"><span>tokens</span><b>${n.tokens}</b></div><div class="metric"><span>speed</span><b>${n.tps} tok/s</b></div>` : ''}`;
  } else if (n.kind === 'bot') {
    body = `<div class="tt-q">${esc(S.lastBot || '')}</div>`;
  } else {
    const links = S.links.filter(l => (l.kind === 'cross' || l.kind === 'hint') && (l.source.id === n.id || l.target.id === n.id)).map(l => (l.source.id === n.id ? l.target : l.source).name);
    const fa = n.ticker && FA.get(n.ticker.toUpperCase());
    body = (n.desc ? `<div class="desc">${esc(n.desc)}</div>` : '') +
      (n.impact ? `<div class="imp"><i style="--c:${IMPACT[n.impact.impact]}"></i><b>${esc(n.impact.impact)}</b><span>${esc(n.impact.why || '')}</span></div>` : '') +
      (fa && fa.ratios ? `<div class="fa"><div><span>Revenue</span><b>${fa.ratios.revenue ? fmtUSD(fa.ratios.revenue) : '–'}</b></div><div><span>Growth</span><b>${pctf(fa.ratios.growth)}</b></div><div><span>Gross m.</span><b>${pctf(fa.ratios.grossMargin)}</b></div><div><span>Op m.</span><b>${pctf(fa.ratios.opMargin)}</b></div><div><span>Net m.</span><b>${pctf(fa.ratios.netMargin)}</b></div><div><span>R&amp;D</span><b>${pctf(fa.ratios.rdPct)}</b></div></div>` : n.ticker && fa === undefined ? '<div class="src">loading financials…</div>' : '') +
      (n.news ? `<div class="news"><i style="--c:${n.news.sentiment === 'negative' ? IMPACT.negative : n.news.sentiment === 'positive' ? IMPACT.positive : '#9ca3af'}"></i><div><em>8-K ${esc(n.news.date || '')}</em><br>${esc(n.news.headline)}</div></div>` : '') +
      (n.detail ? `<div class="hint"><em>${esc(n.detail)}</em></div>` : '') +
      (n.quotes || []).slice(0, 4).map(q => `<div class="tt-q">“${esc(q.q)}”<div class="src">${esc(q.from && q.from !== S.root?.name ? q.from + ' filing' : 'agent ' + q.agent)}</div></div>`).join('') +
      (links.length ? `<div class="hint"><em>linked to:</em> ${esc([...new Set(links)].slice(0, 8).join(', '))}</div>` : '') +
      `<div class="src">${n.agents?.size || 0} agent${n.agents?.size === 1 ? '' : 's'} found this</div>`;
  }
  return `<div class="card detail" style="--c:${color}"><button class="x" aria-label="Close">×</button><div class="tt-r">${esc(rel)}</div><div class="tt-h">${esc(n.name)}${n.ticker ? ` <span class="tk">${esc(n.ticker)}</span>` : ''}</div>${body}</div>`;
}

// ---------- tape, status, bot bubble ----------
function tape(html) {
  const el = $('#tape'); const d = document.createElement('div'); d.innerHTML = html; el.appendChild(d);
  while (el.children.length > 9) el.firstChild.remove();
}
let tapeBudget = 0;
function tapeFinding(e, a) {
  const now = performance.now();
  if (now - tapeBudget < 60) return; tapeBudget = now;
  const f = e.f;
  if (f.k === 'impact') return tape(`<span class="ag">${esc(a?.label || e.agent)}</span> → <span class="k" style="--c:${IMPACT[f.impact]}">${esc(f.impact)}</span> ${esc(f.why || '')}`);
  if (f.k === 'news') return tape(`<span class="ag">${esc(f.ticker || '')} 8-K</span> ${esc(f.headline || '')}`);
  if (f.k === 'about') return;
  tape(`<span class="ag">${esc(a?.label || e.agent)}</span> → <span class="k" style="--c:${kindColor(f)}">${esc(f.k === 'company' ? f.rel || 'company' : f.k)}</span> ${esc(f.name)}${f.value ? ' ' + esc(num(f.value)) : ''} <span style="color:var(--faint)">“${esc((f.q || '').slice(0, 70))}”</span>`);
}
function setStatus(t, spin) { $('#status').innerHTML = t ? (spin ? '<span class="spin"></span>' : '') + esc(t) : ''; }
const bubble = document.createElement('div'); bubble.id = 'bubble'; document.body.appendChild(bubble);
let typing = null;
function botSay(e) {
  const text = e.text || '';
  S.lastBot = text;
  bubble.className = 'show ' + (e.phase || '');
  const label = e.phase === 'tool' ? `<div class="bb-tool">⚙ ${esc(e.tool)}</div>` : e.phase === 'reply' ? '<div class="bb-tool">reply</div>' : '';
  bubble.innerHTML = label + '<div class="bb-text"></div>';
  const el = bubble.querySelector('.bb-text');
  clearInterval(typing);
  let i = 0; const step = Math.max(1, Math.round(text.length / 60));
  typing = setInterval(() => { i += step; el.textContent = text.slice(0, i); if (i >= text.length) clearInterval(typing); }, 16);
  if (e.phase === 'tool') tape(`<span class="ag">main</span> ⚙ ${esc(e.tool)} ${esc(e.text || '')}`);
}

// ---------- counters + race ----------
let lastCounter = 0;
function updateCounters(force) {
  const now = performance.now();
  if (!force && now - lastCounter < 120) return; lastCounter = now;
  agentsTick();
}
function skippedSince(t) { let s = 0; for (const c of S.skipChips) if (c.at > t) s += 0; return s; }

// ---------- render loop ----------
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(64, now - lastFrame); lastFrame = now;
  drawStars(now);
  const mv = S.bot?.move;
  if (mv) { const p = Math.min(1, (now - mv.start) / mv.dur), e = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2; S.bot.fx = S.bot.x = mv.x0 + (mv.x1 - mv.x0) * e; S.bot.fy = S.bot.y = mv.y0 + (mv.y1 - mv.y0) * e; if (p >= 1) S.bot.move = null; }
  const tt = now / 1000;
  for (const a of S.agents.values()) {
    const b = S.bot || { x: 0, y: 0, r: 30 };
    if (a.state === 'queued') { const ang = (a.orbitA || 0) + tt * 0.9; const rr = b.r + 14 + (a.orbitR || 30); a.hx = b.x + Math.cos(ang) * rr; a.hy = b.y + Math.sin(ang) * rr; }
    else if (a.state === 'done' || a.state === 'error') { const ang = (a.orbitA || 0); a.hx = b.x + Math.cos(ang) * (b.r + 10); a.hy = b.y + Math.sin(ang) * (b.r + 10); }
    else if (a.wave >= 2 && a.target) { const ang = (a.delay || 0) / 35 * 2.4 + tt * 1.6; a.hx = a.target.x + Math.cos(ang) * (a.target.r + 12); a.hy = a.target.y + Math.sin(ang) * (a.target.r + 12); }
    else if (a.follow) { const f = a.follow, fx = f.x ?? f.sx, fy = f.y ?? f.sy; a.hx = fx + (a.fo?.x || 0); a.hy = fy + (a.fo?.y || 0); }
    else if (a.launch) { a.hx = a.launch.x; a.hy = a.launch.y; }
  }
  drawSplc(now, dt);
  updateCounters();
  positionBubble();
  requestAnimationFrame(frame);
}

function draw(now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const k = cam.k, px = 1 / k;
  ctx.save();
  ctx.translate(cam.cx, cam.cy); ctx.scale(k, k); ctx.translate(-cam.x, -cam.y);
  ctx.lineCap = 'round';
  drawClusters(now, k);

  // links
  for (const l of S.links) {
    const s = l.source, t = l.target;
    if (!s || !t || s.x == null || t.x == null) continue;
    const age = now - l.born;
    if (l.kind === 'dock') continue;
    if (l.kind === 'birth') { if (age > 1400) continue; ctx.strokeStyle = P.acc(0.45 * (1 - age / 1400)); ctx.lineWidth = px; line(s, t); continue; }
    if (l.kind === 'found') { if (age > 900) continue; ctx.strokeStyle = P.acc(0.22 * (1 - age / 900)); ctx.lineWidth = px; line(s, t); continue; }
    if (FILTER !== 'all' && !(matches(t) || matches(s))) continue;
    const hi = (S.selected && (s === S.selected || t === S.selected)) || (S.hover && (s === S.hover || t === S.hover));
    const fresh = Math.max(0, 1 - age / 900);
    if (l.kind === 'hint') { ctx.setLineDash([3 * px, 3 * px]); ctx.strokeStyle = hi ? '#e4e4e7' : 'rgba(161,161,170,0.3)'; ctx.lineWidth = px; line(s, t); ctx.setLineDash([]); continue; }
    if (l.kind === 'cross') {
      const outer = s.outer || t.outer;
      ctx.strokeStyle = hi ? P.accent : fresh > 0 ? P.acc(0.2 + 0.5 * fresh) : `rgba(161,161,170,${outer ? 0.09 : 0.2})`;
      ctx.lineWidth = (hi ? 1.6 : 1) * px; curve(s, t);
    }
  }

  // SPLC: stated share of revenue, thickness by share
  if (S.root) for (const n of S.nodes) {
    if (!n.pct || n.x == null || !matches(n)) continue;
    ctx.strokeStyle = 'rgba(250,250,250,0.32)'; ctx.lineWidth = (0.8 + n.pct / 3) * px; line(S.root, n);
  }

  // sparks: a short tracer from the agent to what it found
  S.sparks = S.sparks.filter(sp => now - sp.born < 650);
  for (const sp of S.sparks) {
    const p = (now - sp.born) / 650, e = 1 - (1 - p) ** 3, e0 = Math.max(0, e - 0.16);
    const dx = sp.to.x - sp.from.x, dy = sp.to.y - sp.from.y;
    ctx.strokeStyle = sp.color && sp.color !== '#fff' && IMPACT_SET.has(sp.color) ? sp.color : P.accent;
    ctx.globalAlpha = 1 - p * 0.5; ctx.lineWidth = 1.6 * px;
    ctx.beginPath(); ctx.moveTo(sp.from.x + dx * e0, sp.from.y + dy * e0); ctx.lineTo(sp.from.x + dx * e, sp.from.y + dy * e); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // nodes
  for (const n of S.nodes) {
    if (n.x == null) continue;
    const age = now - n.born;
    if (age < 0) continue;
    const pop = age < 380 ? 1 - (1 - age / 380) ** 3 : 1;
    if (n.kind === 'bot') drawBot(n, now, pop);
    else if (n.kind === 'root') drawRoot(n, now, pop);
    else if (n.kind === 'agent') drawAgent(n, now, pop, k);
    else drawEntity(n, now, pop, px);
  }

  // hairline rings (births, arrivals)
  for (let i = FX.length - 1; i >= 0; i--) {
    const f = FX[i], age = now - f.born;
    if (age < 0) continue;
    const p = age / f.life;
    if (p >= 1) { FX.splice(i, 1); continue; }
    if (f.kind !== 'ring') continue;
    const e = 1 - (1 - p) ** 3;
    ctx.globalAlpha = (1 - p) * 0.7; ctx.strokeStyle = f.color; ctx.lineWidth = px;
    circle(f.x, f.y, f.r0 + (f.r1 - f.r0) * e); ctx.stroke(); ctx.globalAlpha = 1;
  }

  // labels: biggest first, skip any that would overlap one already placed
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const placed = [];
  const order = S.nodes.filter(n => n.x != null && n.kind !== 'bot' && n.kind !== 'root' && n.kind !== 'agent').sort((a, b) => (S.selected === b || S.hover === b) - (S.selected === a || S.hover === a) || (b.kind === 'company') - (a.kind === 'company') || (b.outer ? 0 : 1) - (a.outer ? 0 : 1) || b.r - a.r || (b.mentions || 0) - (a.mentions || 0));
  if (S.root) placed.push([S.root.x - 70 * px, S.root.y - S.root.r, S.root.x + 70 * px, S.root.y + S.root.r + 34 * px]);
  for (const n of order) {
    const sel = S.selected === n || S.hover === n;
    let show = sel || (n.kind === 'company' && !n.outer) || (n.outer && k > 0.7) || n.kind === 'segment' || n.kind === 'customer_hint' || (n.kind === 'product' && k > 0.5) || (n.kind === 'risk' && k > 0.8);
    if (FILTER !== 'all') show = matches(n) || sel;
    if (S.whatif && n.kind === 'company' && !n.impact && !sel) show = false;
    if (!show) continue;
    const isCo = n.kind === 'company';
    const fs = (isCo ? 11.5 : 10.5) / Math.min(1.25, Math.max(0.6, k));
    ctx.font = `${isCo ? 500 : 400} ${fs}px Geist, sans-serif`;
    const label = n.name.length > 26 ? n.name.slice(0, 25) + '…' : n.name;
    const w = ctx.measureText(label).width, y0 = n.y + n.r + 4 * px;
    const box = [n.x - w / 2 - 4 * px, y0, n.x + w / 2 + 4 * px, y0 + fs + 4 * px];
    if (!sel && placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    ctx.globalAlpha = Math.min(1, (now - n.born) / 400);
    ctx.fillStyle = 'rgba(9,9,11,0.82)'; ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    ctx.fillStyle = sel ? '#fafafa' : isCo ? '#e4e4e7' : '#a1a1aa';
    ctx.fillText(label, n.x, y0 + 2 * px);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
const IMPACT_SET = new Set(Object.values(IMPACT));

function drawEntity(n, now, pop, px) {
  const r = n.r * pop;
  const sel = S.selected === n || S.hover === n;
  const dim = !matches(n) || (S.whatif && n.kind !== 'company' && n.kind !== 'customer_hint') || (S.whatif && n.kind === 'company' && !n.impact);
  ctx.globalAlpha = dim ? 0.16 : 1;
  if (n.kind === 'company') {
    if (n.logo?.img) {
      ctx.fillStyle = '#fafafa'; circle(n.x, n.y, r); ctx.fill();
      ctx.save(); circle(n.x, n.y, r * 0.97); ctx.clip(); const sz = r * 1.25; ctx.drawImage(n.logo.img, n.x - sz / 2, n.y - sz / 2, sz, sz); ctx.restore();
    } else {
      ctx.fillStyle = n.outer ? '#121214' : '#18181b'; circle(n.x, n.y, r); ctx.fill();
      if (!n.outer && r > 7) { ctx.fillStyle = '#a1a1aa'; ctx.font = `600 ${r * 0.85}px Geist, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((n.name || '?').replace(/^the /i, '')[0].toUpperCase(), n.x, n.y + 0.5 * px); }
    }
    ctx.strokeStyle = sel ? P.accent : n.outer ? '#2a2a30' : '#3f3f46'; ctx.lineWidth = (sel ? 1.6 : 1) * px;
    if (n.inferred) ctx.setLineDash([2.5 * px, 2.5 * px]);
    circle(n.x, n.y, r + 1.5 * px); ctx.stroke(); ctx.setLineDash([]);
  } else if (n.kind === 'customer_hint') {
    ctx.setLineDash([2.5 * px, 2.5 * px]); ctx.strokeStyle = sel ? P.accent : '#71717a'; ctx.lineWidth = px; circle(n.x, n.y, r); ctx.stroke(); ctx.setLineDash([]);
  } else if (n.kind === 'product' || n.kind === 'segment') {
    ctx.fillStyle = P.bg; circle(n.x, n.y, r); ctx.fill();
    ctx.strokeStyle = sel ? P.accent : n.kind === 'segment' ? '#a1a1aa' : '#71717a'; ctx.lineWidth = (n.kind === 'segment' ? 1.4 : 1) * px; circle(n.x, n.y, r); ctx.stroke();
  } else {
    ctx.fillStyle = sel ? P.accent : n.kind === 'place' ? '#71717a' : '#52525b'; circle(n.x, n.y, r * 0.8); ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (n.impact) {
    const c = IMPACT[n.impact.impact] || '#fafafa', sev = n.impact.severity || 1, g = Math.min(1, (now - (n.impactAt || 0)) / 500);
    ctx.strokeStyle = c; ctx.lineWidth = (1 + sev * 0.7) * px; circle(n.x, n.y, r + (3 + sev) * px * g + 1.5 * px); ctx.stroke();
    ctx.globalAlpha = 0.3; ctx.lineWidth = px; circle(n.x, n.y, r + (8 + sev * 3) * px * g); ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (n.working && S.phase !== 'done') { const t = now / 1000; ctx.strokeStyle = P.acc(0.5 + 0.3 * Math.sin(t * 6)); ctx.lineWidth = 1.2 * px; ctx.beginPath(); const a0 = t * 3; ctx.arc(n.x, n.y, r + 5 * px, a0, a0 + 4.2); ctx.stroke(); }
  if (n.flash && now - n.flash < 400) { ctx.strokeStyle = P.acc(0.6 * (1 - (now - n.flash) / 400)); ctx.lineWidth = px; circle(n.x, n.y, r + 3 * px); ctx.stroke(); }
  if (n.news && !dim) {
    const c = n.news.sentiment === 'negative' ? IMPACT.negative : n.news.sentiment === 'positive' ? IMPACT.positive : '#a1a1aa';
    const bx = n.x + r * 0.72, by = n.y - r * 0.72, br = Math.max(2.2 * px, r * 0.22);
    ctx.fillStyle = P.bg; circle(bx, by, br + 1.4 * px); ctx.fill(); ctx.fillStyle = c; circle(bx, by, br); ctx.fill();
  }
  if (n.pct && matches(n)) { ctx.font = `500 ${10 / Math.min(1.2, Math.max(0.5, cam.k))}px "Geist Mono", monospace`; ctx.fillStyle = '#fafafa'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(n.pct + '%', n.x, n.y - r - 3 * px); }
}

function drawClusters(now, k) {
  if (!S.root) return;
  const px = 1 / k;
  const mem = {};
  for (const n of S.nodes) if (n.cl && CLUSTERS[n.cl] && n.x != null) (mem[n.cl] ||= []).push(n);
  for (const c of Object.values(CLUSTERS)) {
    const m = mem[c.key];
    if (!m || !m.length) continue;
    let cx = 0, cy = 0; for (const n of m) { cx += n.x; cy += n.y; } cx /= m.length; cy /= m.length;
    const ds = m.map(n => Math.hypot(n.x - cx, n.y - cy) + n.r).sort((a, b) => a - b);
    const r = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.88))] + 22;
    c.sx += (cx - c.sx) * 0.08; c.sy += (cy - c.sy) * 0.08; c.sr += (r - c.sr) * 0.08;
    const on = FILTER === c.key, dim = (FILTER !== 'all' && !on) || !!S.whatif;
    const d = Math.hypot(c.sx, c.sy) || 1;
    ctx.strokeStyle = dim ? 'rgba(63,63,70,0.25)' : '#26262b'; ctx.lineWidth = px;
    ctx.beginPath(); ctx.moveTo(c.sx / d * (S.root.r + 8 * px), c.sy / d * (S.root.r + 8 * px)); ctx.lineTo(c.sx - c.sx / d * c.sr, c.sy - c.sy / d * c.sr); ctx.stroke();
    ctx.fillStyle = on ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.012)'; circle(c.sx, c.sy, c.sr); ctx.fill();
    ctx.strokeStyle = on ? '#71717a' : dim ? 'rgba(63,63,70,0.35)' : '#2a2a30'; ctx.lineWidth = px; circle(c.sx, c.sy, c.sr); ctx.stroke();
    const fs = 13 / Math.min(1.3, Math.max(0.5, k));
    const count = (m.filter(n => n.kind === 'company' || n.kind === 'customer_hint').length || m.length) + (S.extra[c.key] || 0);
    ctx.font = `500 ${fs}px Geist, sans-serif`; const w1 = ctx.measureText(c.label).width;
    ctx.font = `400 ${fs * 0.9}px "Geist Mono", monospace`; const cnt = '  ' + count; const w2 = ctx.measureText(cnt).width;
    const lx = c.sx - (w1 + w2) / 2, ly = c.sy - c.sr - 8 * px;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.font = `500 ${fs}px Geist, sans-serif`; ctx.fillStyle = dim ? 'rgba(228,228,231,0.3)' : '#e4e4e7'; ctx.fillText(c.label, lx, ly);
    ctx.font = `400 ${fs * 0.9}px "Geist Mono", monospace`; ctx.fillStyle = dim ? 'rgba(113,113,122,0.4)' : '#71717a'; ctx.fillText(cnt, lx + w1, ly);
    c.hit = { x: c.sx, y: c.sy, r: c.sr, ly };
  }
  ctx.textAlign = 'center';
}

function drawBot(n, now, pop) {
  const r = n.r * pop, t = now / 1000, px = 1 / cam.k;
  const busy = S.phase !== 'done' && S.phase !== 'idle';
  ctx.strokeStyle = P.acc(0.22); ctx.lineWidth = px; circle(n.x, n.y, r + 12 * Math.max(1, px * 0.6)); ctx.stroke();
  if (busy) {
    ctx.strokeStyle = P.accent; ctx.lineWidth = 1.6 * px;
    for (let i = 0; i < 2; i++) { const a0 = t * (i ? -1.3 : 0.9) + i * Math.PI; ctx.beginPath(); ctx.arc(n.x, n.y, r + (12 + i * 7) * Math.max(1, px * 0.6), a0, a0 + Math.PI * 0.55); ctx.stroke(); }
  }
  ctx.fillStyle = '#0c0c0e'; circle(n.x, n.y, r); ctx.fill();
  ctx.strokeStyle = P.accent; ctx.lineWidth = 1.6 * px; circle(n.x, n.y, r); ctx.stroke();
  // core: three nodes joined, a small mark for an orchestrator
  const cr = r * 0.42;
  const pts = [0, 1, 2].map(i => [n.x + Math.cos(-Math.PI / 2 + i * 2.094) * cr, n.y + Math.sin(-Math.PI / 2 + i * 2.094) * cr]);
  ctx.strokeStyle = P.acc(0.8); ctx.lineWidth = 1.3 * px; ctx.beginPath();
  for (const [x, y] of pts) { ctx.moveTo(n.x, n.y); ctx.lineTo(x, y); } ctx.stroke();
  ctx.fillStyle = P.accent; circle(n.x, n.y, r * 0.16); ctx.fill();
  for (const [x, y] of pts) { circle(x, y, r * 0.1); ctx.fill(); }
  const fs = 12 / Math.min(1.2, Math.max(0.6, cam.k));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = `600 ${fs}px Geist, sans-serif`; ctx.fillStyle = '#fafafa'; ctx.fillText('OpenClaw', n.x, n.y + r + 26 * Math.max(1, px * 0.6));
  ctx.font = `400 ${fs * 0.9}px "Geist Mono", monospace`; ctx.fillStyle = '#71717a'; ctx.fillText('main agent', n.x, n.y + r + 26 * Math.max(1, px * 0.6) + fs * 1.3);
}

function drawRoot(n, now, pop) {
  const r = n.r * pop, px = 1 / cam.k;
  ctx.fillStyle = '#fafafa'; circle(n.x, n.y, r); ctx.fill();
  if (n.logo?.img) { ctx.save(); circle(n.x, n.y, r * 0.98); ctx.clip(); const sz = r * 1.3; ctx.drawImage(n.logo.img, n.x - sz / 2, n.y - sz / 2, sz, sz); ctx.restore(); }
  else { ctx.fillStyle = '#09090b'; ctx.font = `700 ${r * 0.55}px Geist`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n.ticker || '?', n.x, n.y); }
  const c = n.impact ? (IMPACT[n.impact.impact] || '#fafafa') : '#a1a1aa';
  ctx.strokeStyle = c; ctx.lineWidth = (n.impact ? 2 + (n.impact.severity || 1) * 0.6 : 1.4) * px; circle(n.x, n.y, r + 3 * px); ctx.stroke();
  ctx.strokeStyle = 'rgba(161,161,170,0.25)'; ctx.lineWidth = px; circle(n.x, n.y, r + 12 * px); ctx.stroke();
  const fs = 15 / Math.min(1.2, Math.max(0.6, cam.k));
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = `600 ${fs}px Geist, sans-serif`; ctx.fillStyle = '#fafafa'; ctx.fillText(n.ticker || n.name, n.x, n.y + r + 16 * px);
}

function drawAgent(n, now, pop, k) {
  const px = 1 / k;
  const r = Math.max(3.4 * px, n.r * 0.8) * pop;
  const off = FILTER !== 'all' || (S.activeWave && n.wave !== S.activeWave);
  if (n.state === 'done' || n.state === 'error' || off) {
    const fade = n.doneAt ? Math.max(0, 1 - (now - n.doneAt) / 1400) : 0;
    if (fade <= 0 && (off || S.phase === 'done')) return;
    ctx.fillStyle = n.state === 'error' ? IMPACT.negative : `rgba(161,161,170,${0.25 + 0.5 * fade})`;
    circle(n.x, n.y, r * (0.6 + 0.4 * fade)); ctx.fill(); return;
  }
  const vx = n.vx || 0, vy = n.vy || 0, sp = Math.hypot(vx, vy);
  if (n.state === 'live' && sp > 0.3) {
    const tl = Math.min(26 * px * 3, sp * 5);
    const g = ctx.createLinearGradient(n.x - vx / sp * tl, n.y - vy / sp * tl, n.x, n.y);
    g.addColorStop(0, P.acc(0)); g.addColorStop(1, P.acc(0.6));
    ctx.strokeStyle = g; ctx.lineWidth = r * 1.4; ctx.beginPath(); ctx.moveTo(n.x - vx / sp * tl, n.y - vy / sp * tl); ctx.lineTo(n.x, n.y); ctx.stroke();
  }
  if (n.state === 'queued') {
    ctx.fillStyle = P.acc(0.35); circle(n.x, n.y, r * 0.8); ctx.fill();
  } else {
    ctx.fillStyle = P.accent; circle(n.x, n.y, r); ctx.fill();
    const pulse = n.pulse ? Math.max(0, 1 - (now - n.pulse) / 450) : 0;
    if (pulse > 0) { ctx.strokeStyle = P.acc(pulse * 0.7); ctx.lineWidth = px; circle(n.x, n.y, r + (1 - pulse) * 9 * px); ctx.stroke(); }
  }
}

// ---------- supply-chain view: centre card, hubs, straight lines, tiles ----------
const GROUPS = {
  supplier: { label: 'Suppliers', side: 'left', hub: { x: -340, y: 0 } },
  customer: { label: 'Customers', side: 'right', hub: { x: 340, y: 0 } },
  competitor: { label: 'Competitors', side: 'bottom', hub: { x: 0, y: 215 } },
  partner: { label: 'Partners', side: 'top', hub: { x: 0, y: -215 } },
};
const CARD = { w: 300, h: 150 }, TW = 228, TH = 52, TG = 6, GW = 196, COLCAP = 12, GRIDCAP = 12;
function isSelf(n) {
  if (!S.scan || n === S.root) return n === S.root;
  if (n.ticker && n.ticker.toUpperCase().split('-')[0] === S.scan.ticker.split('-')[0]) return true;
  const root = norm(S.scan.short || S.scan.name), first = norm((S.scan.short || S.scan.name).split(/[\s,.]+/)[0].replace(/^j\.?p\.?$/i, 'jpmorgan'));
  const k = norm(n.name);
  return k === root || (first.length >= 5 && k.startsWith(first)) || (root.length >= 6 && k.startsWith(root));
}
function groupOf(n) {
  if (n.kind === 'customer_hint') return 'customer';
  if (n.kind !== 'company' || n.outer || n === S.root || !String(n.name || '').replace(/[^a-z0-9]/gi, '') || isSelf(n)) return null;
  return GROUPS[n.cl] ? n.cl : null;
}
const REVEAL_MS = 110;
function layout(now) {
  const lists = { supplier: [], customer: [], competitor: [], partner: [] };
  for (const n of S.nodes) { const g = groupOf(n); if (g && n.seq == null) { n.seq = S.seq++; (S.revealQ ||= []).push(n); } }
  if (S.revealQ?.length && now - (S.lastReveal || 0) > REVEAL_MS) { const k = Math.max(1, Math.ceil(S.revealQ.length / 12)); for (let i = 0; i < k && S.revealQ.length; i++) S.revealQ.shift().revealed = true; S.lastReveal = now; }
  if (S.phase === 'done' && S.revealQ?.length > 3) { for (const n of S.revealQ) n.revealed = true; S.revealQ = []; }
  for (const n of S.nodes) { const g = groupOf(n); if (g && n.revealed) lists[g].push(n); }
  const tiles = [];
  for (const [g, list] of Object.entries(lists)) {
    list.sort((a, b) => a.seq - b.seq);
    const G = GROUPS[g];
    const items = list.map(n => ({ n }));
    if (!list.length) { G.count = 0; G.items = []; continue; }
    G.count = list.length; G.items = items;
    if (G.side === 'left' || G.side === 'right') {
      // as many columns as needed, growing outward from the hub, 12 tiles per column
      const PER = 12, ncol = Math.ceil(items.length / PER);
      items.forEach((it, i) => {
        const c = Math.floor(i / PER), inCol = Math.min(PER, items.length - c * PER), r = i % PER;
        const tot = inCol * (TH + TG) - TG;
        it.x = G.side === 'left' ? -450 - TW - c * (TW + 12) : 450 + c * (TW + 12);
        it.y = -tot / 2 + r * (TH + TG); it.w = TW; it.h = TH;
      });
    } else {
      const cols = Math.min(7, Math.max(1, items.length)), rows = Math.ceil(items.length / cols);
      const wtot = cols * (GW + 8) - 8, x0 = -wtot / 2;
      items.forEach((it, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        it.x = x0 + c * (GW + 8); it.w = GW; it.h = TH;
        it.y = G.side === 'bottom' ? 300 + r * (TH + TG) : -300 - TH - r * (TH + TG);
      });
    }
    for (const it of items) {
      const key = it.n || it; // tween towards the slot, starting at the hub
      if (key.px == null) { key.px = G.hub.x - it.w / 2; key.py = G.hub.y - it.h / 2; key.bornT = now; }
      key.px += (it.x - key.px) * 0.18; key.py += (it.y - key.py) * 0.18;
      it.dx = key.px; it.dy = key.py; it.born = key.bornT; tiles.push(it);
    }
  }
  return tiles;
}
function boundsOf(tiles) {
  let x0 = -CARD.w / 2 - 20, x1 = CARD.w / 2 + 20, y0 = -CARD.h / 2 - 40, y1 = CARD.h / 2 + 40;
  for (const t of tiles) { if (FILTER !== 'all' && groupOf(t.n || {}) !== FILTER && t.g !== FILTER) continue; x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x + t.w); y0 = Math.min(y0, t.y - 24); y1 = Math.max(y1, t.y + t.h + 10); }
  for (const [k, G] of Object.entries(GROUPS)) if (FILTER === 'all' || FILTER === k) { x0 = Math.min(x0, G.hub.x - 60); x1 = Math.max(x1, G.hub.x + 60); y0 = Math.min(y0, G.hub.y - 30); y1 = Math.max(y1, G.hub.y + 30); }
  return { x0, x1, y0, y1 };
}
const LINE = 'rgba(132,160,170,0.42)';
const IMPF = { negative: ['#3a1215', '#e5484d'], mixed: ['#33260d', '#e2a336'], positive: ['#0f2b1a', '#46a758'] };
let TILES = [];
function fitBounds(b, dt) {
  if (!cam.user) {
    const padL = W > 900 ? 380 : 30, padR = document.body.classList.contains('panels') && W > 900 ? 360 : 30, padT = 128, padB = 120;
    const k = Math.min((W - padL - padR) / (b.x1 - b.x0), (H - padT - padB) / (b.y1 - b.y0), 1.6);
    cam.tk = Math.max(0.3, k); cam.tx = (b.x0 + b.x1) / 2; cam.ty = (b.y0 + b.y1) / 2;
    cam.cx = padL + (W - padL - padR) / 2; cam.cy = padT + (H - padT - padB) / 2;
  }
  const f = 1 - Math.exp(-dt / 380);
  cam.k += (cam.tk - cam.k) * f; cam.x += (cam.tx - cam.x) * f; cam.y += (cam.ty - cam.y) * f;
}
function drawSplc(now, dt) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);
  if (!S.root) return;
  TILES = layout(now);
  fitBounds(boundsOf(TILES), dt);
  const k = cam.k, px = 1 / k;
  ctx.save(); ctx.translate(cam.cx, cam.cy); ctx.scale(k, k); ctx.translate(-cam.x, -cam.y);
  const hi = S.hover || S.selected;
  // lines: card → hub → tiles
  ctx.lineWidth = px;
  for (const [g, G] of Object.entries(GROUPS)) {
    const dim = FILTER !== 'all' && FILTER !== g;
    ctx.strokeStyle = dim || !G.count ? 'rgba(132,160,170,0.12)' : LINE;
    const e = G.side === 'left' ? [-CARD.w / 2, 0] : G.side === 'right' ? [CARD.w / 2, 0] : G.side === 'bottom' ? [0, CARD.h / 2] : [0, -CARD.h / 2];
    ctx.beginPath(); ctx.moveTo(e[0], e[1]); ctx.lineTo(G.hub.x, G.hub.y); ctx.stroke();
    for (const it of G.items) {
      const t = TILES.find(x => x === it); if (!t) continue;
      const tx = G.side === 'left' ? t.dx + t.w : G.side === 'right' ? t.dx : t.dx + t.w / 2;
      const ty = G.side === 'left' || G.side === 'right' ? t.dy + t.h / 2 : G.side === 'bottom' ? t.dy : t.dy + t.h;
      const on = hi && it.n === hi, le = it.n ? (it.n.en ?? 0) : 0.3;
      ctx.strokeStyle = on ? P.accent : dim ? 'rgba(132,160,170,0.08)' : `rgba(132,160,170,${(0.22 + 0.22 * le).toFixed(3)})`; ctx.lineWidth = (on ? 1.6 : 1) * px;
      ctx.beginPath(); ctx.moveTo(G.hub.x, G.hub.y); ctx.lineTo(tx, ty); ctx.stroke();
    }
  }
  // cross-links of the hovered/selected company
  if (hi && hi.links) {
    ctx.setLineDash([4 * px, 4 * px]); ctx.strokeStyle = P.acc(0.8); ctx.lineWidth = 1.2 * px;
    const a = TILES.find(t => t.n === hi);
    for (const o of hi.links) { const b = TILES.find(t => t.n === o); if (a && b) { ctx.beginPath(); ctx.moveTo(a.dx + a.w / 2, a.dy + a.h / 2); ctx.lineTo(b.dx + b.w / 2, b.dy + b.h / 2); ctx.stroke(); } }
    ctx.setLineDash([]);
  }
  // hubs (empty groups stay visible so it is clear the filing named none)
  for (const [g, G] of Object.entries(GROUPS)) {
    const dim = FILTER !== 'all' && FILTER !== g;
    ctx.globalAlpha = dim ? 0.3 : G.count ? 1 : 0.55;
    ctx.fillStyle = '#0e0e10'; ctx.fillRect(G.hub.x - 5 * px, G.hub.y - 5 * px, 10 * px, 10 * px);
    ctx.strokeStyle = '#9fb3ba'; ctx.lineWidth = px; ctx.strokeRect(G.hub.x - 5 * px, G.hub.y - 5 * px, 10 * px, 10 * px);
    const fs = 12.5 * px; ctx.font = `500 ${fs}px Geist, sans-serif`; ctx.fillStyle = '#e4e4e7'; ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    const lbl = `${G.count || 0} ${G.label}`, ly = G.hub.y - 10 * px;
    ctx.fillText(lbl, G.hub.x, ly);
    if (!G.count && S.phase !== 'bot' && S.phase !== 'scan') { ctx.font = `400 ${11 * px}px Geist, sans-serif`; ctx.fillStyle = '#71717a'; ctx.textBaseline = 'top'; ctx.fillText(S.phase === 'done' ? 'none named in the filing' : 'looking…', G.hub.x, G.hub.y + 10 * px); ctx.textBaseline = 'bottom'; }
    G.hit = { x: G.hub.x, y: ly - fs / 2, w: ctx.measureText(lbl).width, h: fs + 14 * px };
    ctx.globalAlpha = 1;
  }
  drawCard(now, px);
  for (const t of TILES) drawTile(t, now, px);
  X.afterTiles(now, px);
  ctx.restore();
}
function drawCard(now, px) {
  if (S.scan?.kind === 'commodity') return X.drawCommodityCard(now, px);
  const r = S.root, x = -CARD.w / 2, y = -CARD.h / 2;
  const imp = r.impact && IMPF[r.impact.impact];
  ctx.fillStyle = imp ? imp[0] : '#0f1316'; ctx.fillRect(x, y, CARD.w, CARD.h);
  ctx.strokeStyle = imp ? imp[1] : '#3a4a52'; ctx.lineWidth = (imp ? 1.6 : 1) * px; ctx.strokeRect(x, y, CARD.w, CARD.h);
  const ags = [...S.agents.values()], prog = ags.length ? ags.filter(a => a.state === 'done' || a.state === 'error').length / ags.length : 0;
  S.cardFill = (S.cardFill ?? 0) + (prog - (S.cardFill ?? 0)) * 0.05;
  ctx.fillStyle = P.accent; ctx.fillRect(x, y, CARD.w, 2.5 * px);
  if (S.phase !== 'done' && S.phase !== 'idle') { const cx = x + CARD.w - 14, cy = y + 16, a0 = now / 140; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.6 * px; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = P.accent; ctx.beginPath(); ctx.arc(cx, cy, 5, a0, a0 + Math.PI * 1.2); ctx.stroke(); }
  ctx.fillStyle = '#fafafa'; ctx.fillRect(x + 14, y + 16, 40, 40);
  if (r.logo?.img) ctx.drawImage(r.logo.img, x + 18, y + 20, 32, 32);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${14}px "Geist Mono", monospace`; ctx.fillStyle = '#fafafa'; ctx.fillText((S.scan?.name || r.name).toUpperCase().slice(0, 22), x + 66, y + 32);
  ctx.font = `400 ${11.5}px Geist, sans-serif`; ctx.fillStyle = '#8b98a0'; ctx.fillText(`${r.ticker} US Equity · ${S.scan?.filing.form || ''} ${S.scan?.filing.date || ''}`, x + 66, y + 50);
  const pr = S.peers?.[0], rows = [];
  if (pr) rows.push(['Revenue', pr.revenue ? fmtUSD(pr.revenue) : '–'], ['Growth', pctf(pr.growth)], ['Gross margin', pctf(pr.grossMargin)], ['Op. margin', pctf(pr.opMargin)]);
  else if (S.financials?.rows?.length) { const rv = S.financials.rows[0]; const last = rv.values[rv.values.length - 1]; rows.push([rv.label + ' FY' + String(last.fy).slice(-2), fmtUSD(last.v)]); }
  else rows.push(['Reading the filing', '…']);
  rows.slice(0, 4).forEach(([a, b], i) => {
    const cx = x + 14 + (i % 2) * 140, cy = y + 84 + Math.floor(i / 2) * 30;
    ctx.font = `400 ${10.5}px Geist, sans-serif`; ctx.fillStyle = '#7d8a92'; ctx.fillText(a, cx, cy);
    ctx.font = `500 ${13}px "Geist Mono", monospace`; ctx.fillStyle = '#eef2f4'; ctx.fillText(b, cx, cy + 15);
  });
  if (r.impact) { ctx.font = `500 ${11}px Geist, sans-serif`; ctx.fillStyle = imp[1]; ctx.textAlign = 'right'; ctx.fillText(r.impact.impact.toUpperCase(), x + CARD.w - 28, y + 22); }
  X.cardBadges(x, y, px);
}
const TINT = { supplier: [200, 150, 70], customer: [70, 170, 100], competitor: [210, 80, 85], partner: [150, 120, 210] };
// how far an agent has got analysing this company: 0 = untouched (black and white), 1 = an agent finished on it (full colour)
const EXPECT = { 2: 2400, 3: 600, 4: 480, 5: 1800, 6: 520, 7: 460, 8: 1400, 9: 460 };
let ANALYSIS = new Map(), analysisAt = 0;
function analysisMap(now) {
  if (now - analysisAt < 60) return ANALYSIS;
  analysisAt = now; const m = new Map();
  for (const a of S.agents.values()) {
    if (!a.target || a.state === 'queued') continue;
    const p = a.state === 'done' || a.state === 'error' ? 1 : Math.min(0.96, (S.liveChars.get(a.id) || 0) / (EXPECT[a.wave] || 2000));
    m.set(a.target, Math.max(m.get(a.target) || 0, p));
  }
  return (ANALYSIS = m);
}
function loadingOf(n) {
  if (n.profile?.loading) return true;
  for (const a of S.agents.values()) if (a.target === n && (a.state === 'queued' || a.state === 'live')) return true;
  return false;
}
function analysisOf(n, now) {
  let p = analysisMap(now).get(n) || 0;
  if (n.profile?.loading) p = Math.max(p, Math.min(0.92, (now - (n.profile.t0 || now)) / 5000));
  else if (n.profile && !n.profile.error) p = 1;
  return p;
}
function fit(text, maxW) { if (ctx.measureText(text).width <= maxW) return text; while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1); return text + '…'; }
const isCategory = name => /^(the\s+)?(oems?|odms?|aibs?|csps?|hyperscalers|startups?|.*\b(suppliers|customers|providers|manufacturers|partners|distributors|resellers|vendors|companies|startups|integrators|makers|developers|operators|carriers|banks|institutions|governments|agencies|enterprises|consumers|businesses)\b.*)$/i.test((name || '').trim()) && !/\b(inc|corp|ltd|llc|plc|co|group|holdings?)\b\.?$/i.test(name || '');
const isAnon = name => /^(customer|vendor|supplier|partner|distributor|direct customer|indirect customer)\s+[A-Z0-9]\b|unnamed|undisclosed/i.test(name || '');
function tileInfo(n) {
  if (n.impact) return n.impact.why || n.impact.impact;
  const xi = X.tileInfo(n); if (xi) return xi;
  if (n.resolved) return `→ ${n.resolved.name}${n.resolved.ticker ? ' (' + n.resolved.ticker + ')' : ''} · ${n.resolved.confidence} confidence`;
  if (n.cands?.length) return 'candidates: ' + n.cands.map(c => c.ticker || c.name).join(', ');
  if (n.kind === 'customer_hint') return [n.detail, n.guess?.length ? 'guess: ' + n.guess.join(', ') : ''].filter(Boolean).join(' · ');
  if (n.news) return 'News · ' + n.news.headline;
  if (n.inferred) {
    const c = n.confirm, tag = !c ? (!n.ticker ? 'Inferred · private, no SEC filing' : 'Inferred · checking its filing') : c.supports === 'yes' ? 'Inferred · confirmed by its own filing' : c.supports === 'no' ? 'Inferred · its filing does not mention it' : 'Inferred · its filing is unclear';
    return tag + (c?.q ? ' · “' + c.q + '”' : n.desc ? ' · ' + n.desc : '');
  }
  if (n.desc) return n.desc;
  const q = n.quotes?.[0]?.q; return q ? '“' + q + '”' : (n.rel || '');
}
function drawTile(t, now, px) {
  const { dx: x, dy: y, w, h } = t;
  const age = now - (t.born || 0), a = Math.min(1, age / 350);
  ctx.globalAlpha = a;
  if (t.more) {
    ctx.fillStyle = '#0c0f11'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#26323a'; ctx.lineWidth = px; ctx.strokeRect(x, y, w, h);
    ctx.font = `500 ${11.5}px Geist, sans-serif`; ctx.fillStyle = '#9fb3ba'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`+${t.more} more`, x + w / 2, y + h / 2);
    ctx.globalAlpha = 1; return;
  }
  const n = t.n, g = groupOf(n), dim = (FILTER !== 'all' && FILTER !== g) || (S.whatif && !S.streamMode && !n.impact);
  if (n.route) { ctx.globalAlpha = 1; return X.drawRouteTile(t, now, px, a); }
  const imp = n.impact && IMPF[n.impact.impact], sel = S.selected === n, hov = S.hover === n;
  ctx.globalAlpha = a * (dim ? 0.28 : 1);
  // black and white until an agent has explored this company, then full colour
  const explored = analysisOf(n, now) >= 1, loading = loadingOf(n);
  n.en = (n.en ?? 0) + ((explored ? 1 : 0) - (n.en ?? 0)) * 0.15; const en = n.en;
  ctx.fillStyle = imp ? imp[0] : hov ? '#13161a' : '#0d0f11'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = imp ? imp[1] : sel ? P.accent : hov ? '#5b6f78' : '#262c31'; ctx.lineWidth = (sel || imp ? 1.5 : 1) * px;
  if (n.kind === 'customer_hint' || (n.inferred && n.confirm?.supports !== 'yes')) ctx.setLineDash([3 * px, 3 * px]);
  ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  if (loading && S.phase !== 'done') { // small spinner, top right
    const cx = x + w - 9, cy = y + 9, r = 4.2, a0 = now / 140;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.4 * px; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = P.accent; ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + Math.PI * 1.2); ctx.stroke();
  }
  // logo
  const lx = x + 7, ly = y + 8, ls = 26;
  if (n.kind === 'customer_hint') { ctx.strokeStyle = '#5b6f78'; ctx.setLineDash([2 * px, 2 * px]); ctx.strokeRect(lx, ly, ls, ls); ctx.setLineDash([]); ctx.fillStyle = '#9fb3ba'; ctx.font = `600 ${11}px Geist`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', lx + ls / 2, ly + ls / 2 + 0.5); }
  else { ctx.fillStyle = `rgba(250,250,250,${(0.55 + 0.45 * en).toFixed(2)})`; ctx.fillRect(lx, ly, ls, ls); if (n.logo?.img) { ctx.filter = `grayscale(${(1 - en).toFixed(2)}) opacity(${(0.65 + 0.35 * en).toFixed(2)})`; ctx.drawImage(n.logo.img, lx + 2, ly + 2, ls - 4, ls - 4); ctx.filter = 'none'; } else { ctx.fillStyle = '#18181b'; ctx.font = `700 ${12}px Geist`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((n.name || '?')[0].toUpperCase(), lx + ls / 2, ly + ls / 2 + 0.5); } }
  // text
  const tx = x + 40, tw = w - 48;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const lum = Math.round(150 + 105 * Math.min(1, en * 1.3));
  ctx.font = `600 ${11.5}px "Geist Mono", monospace`; ctx.fillStyle = `rgb(${lum},${lum},${Math.min(255, lum + 4)})`;
  let badges = '';
  if (n.confirms) badges += ' ✓';
  if (n.links?.size) badges += ` ↔${n.links.size}`;
  badges += X.badges(n);
  const bw = badges ? (ctx.font = `500 ${10}px "Geist Mono", monospace`, ctx.measureText(badges).width + 4) : 0;
  ctx.font = `600 ${11.5}px "Geist Mono", monospace`;
  ctx.fillText(fit((n.name || '').toUpperCase(), tw - bw), tx, y + 17);
  if (badges) { ctx.font = `500 ${10}px "Geist Mono", monospace`; ctx.fillStyle = en > 0.5 ? (n.confirms ? '#46a758' : '#9fb3ba') : '#6b7277'; ctx.textAlign = 'right'; ctx.fillText(badges.trim(), x + w - (loading && S.phase !== 'done' ? 20 : 7), y + 17); ctx.textAlign = 'left'; }
  // line 2: numbers from SEC XBRL (or what we know about the relationship)
  const fa = n.ticker && FA.get(n.ticker.toUpperCase()), r2 = fa?.ratios;
  ctx.font = `500 ${10}px "Geist Mono", monospace`; ctx.fillStyle = en > 0.5 ? (r2 ? '#9fb3ba' : '#6b7277') : '#5a6166';
  const fin = r2 && r2.revenue ? [`${n.ticker}`, `REV ${fmtUSD(r2.revenue).replace('$', r2.unit && r2.unit !== 'USD' ? r2.unit + ' ' : '$')}`, r2.growth != null ? `${r2.growth >= 0 ? '+' : ''}${(r2.growth * 100).toFixed(0)}%` : '', r2.opMargin != null ? `OPM ${(r2.opMargin * 100).toFixed(0)}%` : ''].filter(Boolean).join('  ')
    : n.resolved ? `UNNAMED → ${(n.resolved.ticker || n.resolved.name).toUpperCase()}  ${n.resolved.confidence.toUpperCase()}`
    : [n.ticker || (n.kind === 'customer_hint' || isAnon(n.name) ? 'UNNAMED' : isCategory(n.name) ? 'CATEGORY' : LOOKUP.has(norm(n.name)) ? 'PRIVATE COMPANY' : 'PRIVATE?'), n.mentions ? `×${n.mentions}` : '', (n.rel || '').toUpperCase()].filter(Boolean).join('  ');
  const TYPES = ['PRIVATE COMPANY', 'PRIVATE?', 'CATEGORY', 'UNNAMED'];
  const tp = TYPES.find(t => fin.startsWith(t));
  if (tp) {
    const lbl = tp === 'PRIVATE COMPANY' || tp === 'PRIVATE?' ? 'PRIVATE' : tp;
    ctx.font = `600 ${8.5}px "Geist Mono", monospace`; const pw = ctx.measureText(lbl).width + 10;
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.strokeStyle = '#3a4046'; ctx.lineWidth = px;
    ctx.beginPath(); ctx.roundRect(tx, y + 23, pw, 11, 5.5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#a1a8ad'; ctx.textBaseline = 'middle'; ctx.fillText(lbl, tx + 5, y + 28.8); ctx.textBaseline = 'alphabetic';
    ctx.font = `500 ${10}px "Geist Mono", monospace`; ctx.fillStyle = en > 0.5 ? '#6b7277' : '#5a6166';
    ctx.fillText(fit(fin.slice(tp.length).trim(), tw - pw - 6), tx + pw + 6, y + 31);
  } else ctx.fillText(fit(fin, tw), tx, y + 31);
  ctx.font = `400 ${10}px Geist, sans-serif`; ctx.fillStyle = imp ? '#e6d6d6' : en > 0.5 ? '#8a969e' : '#545b60';
  ctx.fillText(fit(tileInfo(n), tw), tx, y + 45);
  if (n.news) { const c = n.news.sentiment === 'negative' ? IMPACT.negative : n.news.sentiment === 'positive' ? IMPACT.positive : '#7d8a92'; ctx.fillStyle = c; ctx.fillRect(x + w - 5, y + h - 5, 3, 3); }
  ctx.globalAlpha = 1;
}
function pickTile(sx, sy) {
  const [x, y] = toWorld(sx, sy);
  for (let i = TILES.length - 1; i >= 0; i--) { const t = TILES[i]; if (x >= t.dx && x <= t.dx + t.w && y >= t.dy && y <= t.dy + t.h) return t; }
  if (S.root && Math.abs(x) <= CARD.w / 2 && Math.abs(y) <= CARD.h / 2) return { n: S.root };
  for (const [g, G] of Object.entries(GROUPS)) if (G.hit && Math.abs(x - G.hit.x) < G.hit.w / 2 + 12 && Math.abs(y - G.hub.y) < 24 / cam.k + 10) return { hub: g };
  return null;
}

// ---------- profile agents: read a company's own annual report on demand ----------
const PROFILES = new Map();
function profileGroup() {
  let g = AG.el?.querySelector('.ag-group.profiles');
  if (!g && AG.el) {
    g = document.createElement('div'); g.className = 'ag-group profiles';
    g.innerHTML = `<div class="ag-ghead"><b>Profile agents</b><span class="ag-gstat">on demand</span></div><div class="ag-rows"></div>`;
    AG.el.querySelector('.ag-main').appendChild(g);
  }
  return g;
}
async function loadProfile(n) {
  const priv = !n.ticker;
  if (priv && (n.kind !== 'company' || isAnon(n.name) || isCategory(n.name) || n === S.root)) return;
  const tk = priv ? 'name:' + norm(n.name) : n.ticker.toUpperCase();
  if (PROFILES.has(tk)) { n.profile = PROFILES.get(tk); return; }
  const rec = { loading: true, t0: performance.now() }; PROFILES.set(tk, rec); n.profile = rec;
  const aid = 'pf-' + tk.replace(/\W+/g, '-');
  const ag = { id: aid, kind: 'agent', wave: 10, label: priv ? `${n.name} · filings` : `${tk} profile`, name: n.name, state: 'live', firstAt: performance.now(), findings: 0, target: n, work: priv ? 'Profile from filings that name it' : 'Profile from its own filing', ticker: priv ? null : tk };
  S.agents.set(aid, ag);
  const g = profileGroup(); let row = null;
  if (g) { row = document.createElement('div'); row.className = 'ag-row live'; row.innerHTML = `<i></i><span class="l">${esc(priv ? n.name : tk)} ${priv ? '· filings that name it' : 'annual report'}</span><span class="b"><em style="width:40%"></em></span><span class="n">…</span>`; row.onclick = () => agentModal(aid); g.querySelector('.ag-rows').appendChild(row); }
  try {
    const r = await fetch(priv ? 'api/profile?name=' + encodeURIComponent(n.name) : 'api/profile?ticker=' + encodeURIComponent(tk)); const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    Object.assign(rec, j, { loading: false });
    Object.assign(ag, { state: 'done', doneAt: performance.now(), tokens: j.tokens, tps: j.tps, findings: 1, input: j.trace?.input, raw: j.trace?.raw, queuedMs: j.trace?.queuedMs, genMs: j.trace?.genMs });
    S.agentFindings.set(aid, [{ k: 'profile', name: n.name, ticker: n.ticker, summary: j.summary }]);
    if (row) { row.className = 'ag-row done'; row.querySelector('em').style.width = '100%'; row.querySelector('.n').textContent = '✓'; }
  } catch (e) { Object.assign(rec, { loading: false, error: String(e.message || e) }); Object.assign(ag, { state: 'error', doneAt: performance.now(), error: String(e.message || e) }); if (row) { row.className = 'ag-row error'; row.querySelector('.n').textContent = '!'; } }
  if (MODAL_NODE === n) companyModal(n, true);
}

// ---------- infographic helpers ----------
const ICONS = {
  seg: '<path d="M8 2v6h6A6 6 0 1 1 8 2Z"/><path d="M10 1a5 5 0 0 1 5 5h-5Z"/>',
  box: '<path d="M2 5l6-3 6 3v6l-6 3-6-3Z"/><path d="M2 5l6 3 6-3M8 8v6"/>',
  users: '<circle cx="6" cy="5" r="2.5"/><path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><circle cx="11.5" cy="5.5" r="2"/><path d="M11 10c2 0 3.5 1.3 3.5 3.5"/>',
  truck: '<path d="M1 4h8v7H1Z"/><path d="M9 7h3l3 3v1H9Z"/><circle cx="4" cy="12.5" r="1.3"/><circle cx="12" cy="12.5" r="1.3"/>',
  target: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".8"/>',
  alert: '<path d="M8 2l6.5 11.5h-13Z"/><path d="M8 6.5v3M8 11.5v.1"/>',
  hash: '<path d="M3 6h10M3 10h10M6.5 2.5 5.5 13.5M10.5 2.5l-1 11"/>',
  link: '<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"/>',
  news: '<path d="M2 3h9v10H3a1 1 0 0 1-1-1Z"/><path d="M11 6h3v6a1 1 0 0 1-1 1h-2M4 6h5M4 8.5h5M4 11h3"/>',
  bot: '<path d="M8 1.8v2"/><rect x="2.8" y="3.8" width="10.4" height="8.6" rx="2.5"/><circle cx="6.1" cy="8" r=".6" fill="currentColor"/><circle cx="9.9" cy="8" r=".6" fill="currentColor"/><path d="M1.3 7.2v1.8M14.7 7.2v1.8"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
  tag: '<path d="M2 8.5V3h5.5l6 6-5.5 5.5Z"/><circle cx="5" cy="6" r=".8"/>',
};
const ic = (k, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ''}</svg>`;
const shortTxt = (t, words = 14) => { t = String(t || '').replace(/\s+/g, ' ').trim(); const first = t.split(/(?<=[.!?])\s/)[0]; const w = first.split(' '); return w.length > words ? w.slice(0, words).join(' ') + '…' : first; };
function logoUrl(name, ticker) { const k = (ticker && ticker.toUpperCase()) || LOGO_ALIAS[norm(name)] || LOGO_ALIAS[companyKey(name)]; return k ? `logos/${k}.png` : null; }
function chip(name, opts = {}) {
  if (!opts.ticker && (isCategory(name) || /\band\b|\bor\b|,/.test(name || '') || ((name || '').split(/\s+/).length > 3 && !logoUrl(name)))) return `<span class="lc tg1"${opts.q ? ` title="${esc(opts.q)}"` : ''}>${esc(cap1(shortTxt(name, 5).replace(/…$/, '')))}</span>`;
  const u = logoUrl(name, opts.ticker), node = opts.node || (opts.ticker && S.byTicker.get(opts.ticker.toUpperCase())) || S.byId.get('co:' + companyKey(name));
  return `<span class="lc"${node ? ` data-node="${esc(node.id)}"` : ''}${opts.q ? ` title="${esc(opts.q)}"` : ''}>${u ? `<img src="${u}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('b'),{textContent:'${esc((name || '?')[0].toUpperCase())}'}))">` : `<b>${esc((name || '?')[0].toUpperCase())}</b>`}${esc(shortTxt(name, 4).replace(/…$/, ''))}${opts.ticker ? `<em>${esc(opts.ticker)}</em>` : ''}</span>`;
}
const sevBars = n => `<span class="sev">${[1, 2, 3].map(i => `<i class="${i <= (n || 1) ? 'on' : ''}"></i>`).join('')}</span>`;
function miniBars(vals, labels, fmt = fmtUSD) {
  const max = Math.max(...vals.map(v => Math.abs(v || 0)), 1);
  return `<div class="mb">${vals.map((v, i) => `<div class="mb-c"><div class="mb-v">${v == null ? '–' : fmt(v)}</div><div class="mb-b"><i style="height:${Math.max(3, Math.abs(v || 0) / max * 100).toFixed(0)}%" class="${(v || 0) < 0 ? 'neg' : ''}"></i></div><div class="mb-l">${esc(labels[i])}</div></div>`).join('')}</div>`;
}
const delta = v => v == null || isNaN(v) ? '<span class="dl">–</span>' : `<span class="dl ${v >= 0 ? 'up' : 'dn'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%</span>`;
function kpis(list) { return `<div class="kp">${list.map(([k, v, extra]) => `<div><span>${k}</span><b>${v}</b>${extra || ''}</div>`).join('')}</div>`; }
// tidy a number written in words: "approximately $13.0 billion" -> "~$13.0B"
function num(v) {
  let t = String(v ?? '').trim();
  t = t.replace(/^(approximately|approx\.?|about|around|roughly|nearly|almost|circa|an estimated|estimated)\s+/i, '~')
    .replace(/^(over|more than|greater than|in excess of|above|exceeding)\s+/i, '>')
    .replace(/^(up to|less than|under|below|fewer than|not more than|at most)\s+/i, '≤')
    .replace(/^(at least|no less than)\s+/i, '≥');
  t = t.replace(/\s*\([^)]*\)/g, '');
  t = t.replace(/(\d)\s*(trillion)\b/gi, '$1T').replace(/(\d)\s*(billion|bn)\b/gi, '$1B').replace(/(\d)\s*(million|mn|mm)\b/gi, '$1M').replace(/(\d)\s*(thousand)\b/gi, '$1K')
    .replace(/(\d)\s*(percent|per cent)\b/gi, '$1%').replace(/\bapproximately\b/gi, '~').replace(/\s{2,}/g, ' ');
  // re-scale money: "$120,067M" -> "$120.1B", "$215.938B" -> "$215.9B"
  t = t.replace(/^([~><≤≥]?)(\$?)([\d,]+(?:\.\d+)?)\s*([KMBT])\b(.*)$/, (m0, pre, dol, n0, u, rest) => {
    const v = +n0.replace(/,/g, '') * { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[u.toUpperCase()];
    if (isNaN(v)) return m0;
    const f = v >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v);
    return pre + dol + f + rest;
  });
  // dates: "January 25, 2026" -> "Jan 25, 2026"
  t = t.replace(/\b(January|February|March|April|June|July|August|September|October|November|December)\b/g, m0 => m0.slice(0, 3));
  return t;
}
const money = (v, unit) => v == null ? '–' : (unit && unit !== 'USD' ? unit + ' ' + fmtUSD(v).replace('$', '') : fmtUSD(v));
const cap1 = t => String(t || '').replace(/^./, c => c.toUpperCase());
const isTableQuote = q => /\|/.test(q || '') || /^[\d$,.\s|%-]+$/.test(q || '');
const pctOf = t => { const m = String(t || '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? +m[1] : null; };

// ---------- popups ----------
function openModal(title, html, sub = '') {
  let m = $('#modal');
  if (!m) { m = document.createElement('div'); m.id = 'modal'; document.body.appendChild(m); m.addEventListener('mousedown', e => { if (e.target === m) closeModal(); }); }
  m.innerHTML = `<div class="mo"><div class="mo-h"><div><div class="mo-t">${title}</div>${sub ? `<div class="mo-s">${sub}</div>` : ''}</div><button class="mo-x" aria-label="Close">×</button></div><div class="mo-b">${html}</div></div>`;
  m.querySelector('.mo-x').onclick = closeModal;
  m.classList.add('show');
  m.querySelectorAll('[data-agent]').forEach(el => el.onclick = () => agentModal(el.dataset.agent));
  m.querySelectorAll('[data-node]').forEach(el => el.onclick = () => { const n = S.byId.get(el.dataset.node); if (n) companyModal(n); });
  // Focus is a hop (hop.js): the map on screen pauses, this company's map opens, the trail grows
  m.querySelectorAll('[data-focus]').forEach(el => el.onclick = () => { const nn = MODAL_NODE; closeModal(); if (window.PTHop && !REPLAY) PTHop.hop({ ticker: el.dataset.focus, name: el.dataset.name || '', node: nn, private: el.dataset.private === '1' }); else choose({ ticker: el.dataset.focus, name: el.dataset.name || '' }); });
  if (!title.includes('data-keep')) MODAL_NODE = null;
}
let MODAL_NODE = null;
function closeModal() { $('#modal')?.classList.remove('show'); MODAL_NODE = null; }
addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
const stLabel = a => a.state === 'live' ? '<span class="st live">streaming</span>' : a.state === 'done' ? '<span class="st done">done</span>' : a.state === 'error' ? '<span class="st err">error</span>' : '<span class="st q">queued</span>';
function groupModal(g) {
  const ags = g.ids.map(id => S.agents.get(id)).filter(Boolean);
  const rows = ags.map(a => { const tok = a.tokens || Math.round((S.liveChars.get(a.id) || 0) / 3.6); const gen = a.tokens && a.tps ? (a.tokens / a.tps).toFixed(2) + ' s' : '–';
    return `<tr data-agent="${esc(a.id)}"><td>${esc(a.label)}</td><td>${stLabel(a)}</td><td>${tok.toLocaleString()}</td><td>${a.tps ? a.tps + '' : '–'}</td><td>${gen}</td><td>${a.findings || 0}</td></tr>`; }).join('');
  const tok = ags.reduce((s, a) => s + (a.tokens || 0), 0), wt = waveTimes(g.wave);
  openModal(`${ags.length} sub-agents · ${esc(ags[0]?.work || '')}`, `<table class="mt"><tr><th>Agent</th><th>State</th><th>Tokens</th><th>tok/s</th><th>Gen. time</th><th>Findings</th></tr>${rows}</table>`,
    `${tok.toLocaleString()} tokens${wt ? ` · ${(wt.real / 1000).toFixed(1)} s generation (same tokens at ${GPU_TPS} tok/s: ${(wt.gpu / 1000).toFixed(1)} s)` : ''} · click an agent to open it`);
}
function agentModal(id) {
  const a = S.agents.get(id); if (!a) return;
  const fs = S.agentFindings.get(id) || [];
  const tok = a.tokens || Math.round((S.liveChars.get(a.id) || 0) / 3.6);
  const tps = a.tps || (a.tokens && a.genMs ? Math.round(a.tokens / (a.genMs / 1000)) : null);
  const gen = a.genMs != null ? (a.genMs / 1000).toFixed(2) + ' s' : a.tokens && a.tps ? (a.tokens / a.tps).toFixed(2) + ' s' : '–';
  const stats = [['State', stLabel(a)], ['Tokens', tok.toLocaleString()], ['Speed', tps ? tps + ' tok/s' : '–'], ['Generation', gen], ['Findings', fs.length]];
  const list = fs.map(f => {
    const tag = f.k === 'company' ? (f.rel || 'company') : f.k === 'customer_hint' ? 'unnamed customer' : f.k;
    const main = f.k === 'profile' ? `${esc(f.name || '')}: ${esc(shortTxt(f.summary || '', 20))}` : f.k === 'impact' ? `${esc(f.name)} · <b class="imp-${esc(f.impact)}">${esc(f.impact)}</b>` : f.k === 'news' ? `${esc(f.ticker || f.name)} · ${esc(f.headline || '')}` : f.k === 'about' ? `${esc(f.name)}: ${esc(f.desc || '')}` : `${esc(f.name)}${f.value ? ' · <b>' + esc(num(f.value)) + '</b>' : ''}${f.ticker ? ' <span class="tk2">' + esc(f.ticker) + '</span>' : ''}`;
    const q = f.q || f.why || (f.guess ? 'guess: ' + f.guess.join(', ') : '');
    const nodeId = f.k === 'company' ? 'co:' + companyKey(f.name) : null;
    return `<div class="fi"${nodeId && S.byId.has(nodeId) ? ` data-node="${esc(nodeId)}"` : ''}><span class="fk">${esc(tag)}</span><div><div class="fm">${main}</div>${q ? `<div class="fq">${f.q ? '“' + esc(q) + '”' : esc(q)}</div>` : ''}</div></div>`;
  }).join('') || '<div class="empty">No findings yet.</div>';
  const timing = [a.queuedMs != null ? `waited ${(a.queuedMs / 1000).toFixed(1)} s for the first token` : '', a.genMs != null ? `generated in ${(a.genMs / 1000).toFixed(2)} s` : ''].filter(Boolean).join(' · ');
  const traj = `<h5>Trajectory</h5><div class="tj">
    <div class="tj-s"><b>1 · Spawned</b> by the Main Agent${a.work ? ' · ' + esc(a.work) : ''}${a.ticker ? ' · ' + esc(a.ticker) : ''}</div>
    <div class="tj-s"><b>2 · Read</b> ${a.input ? `${esc(a.input.label || '')} · ${(a.input.chars || 0).toLocaleString()} chars` : 'its excerpt (not recorded in this run)'}${a.input?.preview ? `<pre class="tj-p">${esc(a.input.preview)}…</pre>` : ''}</div>
    <div class="tj-s"><b>3 · Streamed</b> ${tok.toLocaleString()} tokens${a.tps ? ' at ' + a.tps + ' tok/s' : ''}${timing ? ' · ' + timing : ''}${a.reasoning ? `<details><summary>reasoning</summary><pre class="tj-p">${esc(a.reasoning)}</pre></details>` : ''}${a.raw ? `<pre class="tj-p raw">${esc(a.raw)}</pre>` : (a.state === 'live' ? '<div class="mx">streaming…</div>' : '<div class="mx">raw output not recorded in this run</div>')}</div>
    <div class="tj-s"><b>4 · Reported</b> ${fs.length} finding${fs.length === 1 ? '' : 's'}${a.error ? ` · <span class="err">error: ${esc(a.error)}</span>` : ''}</div></div>`;
  openModal(esc(a.label), `<div class="ms">${stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>${traj}<h5>Findings</h5><div class="fl">${list}</div>`, [a.work, 'sub-agent', S.provider].filter(Boolean).map(esc).join(' · '));
  $('#modal .mo')?.classList.add('wide');
}
function companyModal(n, refresh) {
  if (!refresh) { if (n.ticker) loadFA(n.ticker); if (n !== S.root) loadProfile(n); }
  const fa = n.ticker && FA.get(n.ticker.toUpperCase()), pf = n.profile, r = fa?.ratios;
  const g0 = n === S.root ? 'Company on the map' : GROUPS[groupOf(n)]?.label.replace(/s$/, '') || (n.outer ? 'Second-degree' : 'Company');
  const kind = n.ticker ? `public · ${esc(n.ticker)}` : isCategory(n.name) ? 'category' : isAnon(n.name) || n.kind === 'customer_hint' ? 'unnamed in the filing' : 'private company';
  let html = '';
  // 1. numbers first
  if (fa?.rows?.length) {
    const rev = fa.rows.find(x => /revenue/i.test(x.label)), ni = fa.rows.find(x => /net income/i.test(x.label));
    const cur = r?.unit && r.unit !== 'USD' ? r.unit + ' ' : '';
    html += kpis([['Revenue' + (r?.fy ? ' FY' + String(r.fy).slice(-2) : ''), r?.revenue ? fmtUSD(r.revenue).replace('$', cur || '$') : '–', delta(r?.growth)], ['Gross margin', pctf(r?.grossMargin)], ['Op. margin', pctf(r?.opMargin)], ['Net margin', pctf(r?.netMargin)], ['R&D / rev', pctf(r?.rdPct)]]);
    if (rev) html += `<div class="ig2"><div class="igc"><h6>${ic('hash')} Revenue</h6>${miniBars(rev.values.map(v => v.v), rev.values.map(v => 'FY' + String(v.fy).slice(-2)))}</div>${ni ? `<div class="igc"><h6>${ic('hash')} Net income</h6>${miniBars(ni.values.map(v => v.v), ni.values.map(v => 'FY' + String(v.fy).slice(-2)))}</div>` : ''}</div>`;
  } else if (n.ticker && fa === undefined) html += '<div class="mx">Loading financials…</div>';
  // 2. one line on what it is
  const line = pf?.summary || n.desc;
  if (pf?.loading) html += `<div class="pf-load"><span class="ag-spin"></span>${n.ticker ? `An agent is reading ${esc(n.ticker)}'s ${esc(pf?.form || 'annual report')}…` : `An agent is reading every filing that names ${esc(n.name)}…`}</div>`;
  else if (line) html += `<p class="one">${esc(shortTxt(line, 24))}${pf?.form ? ` <a class="src2" href="${esc(pf.url)}" target="_blank" rel="noopener">${esc(pf.form)} ${esc(pf.date || '')} ↗</a>` : ''}</p>`;
  // 3. impact and relationship as compact pills
  const pills = [];
  if (n.ticker) pills.push(`<span class="pl pub">${ic('globe')} Public · ${esc(n.ticker)}</span>`);
  else if (isCategory(n.name)) pills.push(`<span class="pl">${ic('tag')} Category</span>`);
  else if (isAnon(n.name) || n.kind === 'customer_hint') pills.push(`<span class="pl">${ic('target')} Unnamed in the filing</span>`);
  else pills.push(`<span class="pl priv">${ic('lock')} Private company</span>`);
  if (n.impact) pills.push(`<span class="pl imp-${esc(n.impact.impact)}">${esc(n.impact.impact)} ${sevBars(n.impact.severity)}</span>`);
  if (n !== S.root && n.rel) pills.push(`<span class="pl">${ic(n.cl === 'supplier' ? 'truck' : n.cl === 'customer' ? 'users' : n.cl === 'competitor' ? 'target' : 'link')} ${esc(n.cl && GROUPS[n.cl] ? GROUPS[n.cl].label.replace(/s$/, '') : n.rel)} of ${esc(S.root?.ticker || '')}</span>`);
  if (n.mentions) pills.push(`<span class="pl">${ic('hash')} ${n.mentions} mention${n.mentions === 1 ? '' : 's'}</span>`);
  if (n.inferred) pills.push(`<span class="pl ${n.confirm?.supports === 'yes' ? 'ok' : ''}">${n.confirm?.supports === 'yes' ? ic('check') + ' confirmed by its filing' : 'inferred · ' + (!n.ticker ? 'private' : !n.confirm ? 'not checked' : n.confirm.supports === 'no' ? 'not in its filing' : 'unclear')}</span>`);
  if (n.confirms) pills.push(`<span class="pl ok">${ic('check')} names ${esc(S.root?.ticker || '')} back</span>`);
  if (n.news) pills.push(`<span class="pl" title="${esc(n.news.headline)}"><i class="dot" style="background:${n.news.sentiment === 'negative' ? IMPACT.negative : n.news.sentiment === 'positive' ? IMPACT.positive : '#71717a'}"></i>${ic('news')} 8-K ${esc(n.news.date || '')}</span>`);
  if (pills.length) html += `<div class="pls">${pills.join('')}</div>`;
  if (n.impact?.why) html += `<div class="why2">${esc(shortTxt(n.impact.why, 18))}</div>`;
  if (n === S.root) {
    const cnt = Object.entries(GROUPS).map(([k, G]) => [G.label, S.nodes.filter(x => groupOf(x) === k).length]);
    html += `<div class="facts">${cnt.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')}<div><b>${S.agents.size}</b><span>Agents</span></div><div><b>${S.findings}</b><span>Findings</span></div></div>`;
    const segs = S.products.filter(x => x.k === 'segment'), prods = S.products.filter(x => x.k !== 'segment');
    html += `<div class="igg">${segs.length ? `<div class="igc"><h6>${ic('seg')} Segments <em>${segs.length}</em></h6><div class="tg">${segs.slice(0, 8).map(x => `<span title="${esc(x.q || '')}">${esc(cap1(x.name))}</span>`).join('')}</div></div>` : ''}${prods.length ? `<div class="igc"><h6>${ic('box')} Products <em>${prods.length}</em></h6><div class="tg">${prods.slice(0, 12).map(x => `<span title="${esc(x.q || '')}">${esc(cap1(shortTxt(x.name, 4)))}</span>`).join('')}</div></div>` : ''}${S.risks.length ? `<div class="igc"><h6>${ic('alert')} Risks <em>${S.risks.filter(x => x.k === 'risk').length}</em></h6><div class="tg warn">${S.risks.filter(x => x.k === 'risk').slice(0, 8).map(x => `<span title="${esc(x.q || '')}">${esc(cap1(shortTxt(x.name, 5)))}</span>`).join('')}</div></div>` : ''}</div>`;
  }
  // 4. profile as columns of icons, bars and chips
  if (pf && !pf.loading && !pf.error && n !== S.root) {
    const cols = [];
    if (pf.segments?.length) { const hasPct = pf.segments.some(x => pctOf(x.note) != null);
      cols.push(`<div class="igc"><h6>${ic('seg')} Segments</h6>${hasPct ? pf.segments.slice(0, 5).map(x => { const v = pctOf(x.note); return `<div class="sg2" title="${esc(x.note || '')}"><span>${esc(shortTxt(x.name, 4))}</span>${v != null ? `<i style="width:${Math.min(100, v)}%"></i><b>${v}%</b>` : '<i class="na"></i><b></b>'}</div>`; }).join('') : `<div class="tg">${pf.segments.slice(0, 6).map(x => `<span title="${esc(x.note || '')}">${esc(shortTxt(x.name, 4))}</span>`).join('')}</div>`}</div>`); }
    if (pf.products?.length) cols.push(`<div class="igc"><h6>${ic('box')} Products</h6><div class="tg">${pf.products.slice(0, 8).map(x => `<span>${esc(cap1(shortTxt(x, 4)))}</span>`).join('')}</div></div>`);
    for (const [k, title, icn] of [['customers', 'Customers', 'users'], ['suppliers', 'Suppliers', 'truck']]) if (pf[k]?.length) cols.push(`<div class="igc"><h6>${ic(icn)} ${title} <em>${pf[k].length}</em></h6><div class="lcs">${pf[k].slice(0, 6).map(x => chip(x.name, { q: x.q })).join('')}</div></div>`);
    if (pf.competitors?.length) cols.push(`<div class="igc"><h6>${ic('target')} Competitors <em>${pf.competitors.length}</em></h6><div class="lcs">${pf.competitors.slice(0, 8).map(x => chip(x)).join('')}</div></div>`);
    const uniq = (list, f) => { const m = new Map(); for (const x of list || []) { const k = norm(f(x)); if (k && !m.has(k)) m.set(k, x); } return [...m.values()]; };
    const rels = uniq(pf.relationships, x => x.with);
    if (rels.length) cols.push(`<div class="igc"><h6>${ic('link')} Named in filings <em>${rels.length}</em></h6><div class="lcs">${rels.slice(0, 8).map(x => chip(x.with, { q: (x.rel ? x.rel + ': ' : '') + (x.q || '') })).join('')}</div></div>`);
    if (pf.risks?.length) cols.push(`<div class="igc"><h6>${ic('alert')} Risks</h6><div class="tg warn">${pf.risks.slice(0, 6).map(x => `<span>${esc(cap1(shortTxt(x, 5)))}</span>`).join('')}</div></div>`);
    if (cols.length) html += `<div class="igg">${cols.join('')}</div>`;
    if (pf.facts?.length) html += `<div class="facts">${pf.facts.slice(0, 6).map(f => `<div title="${esc(f.value)}"><b>${esc(shortTxt(num(f.value), 3).replace(/…$/, ''))}</b><span>${esc(shortTxt(f.name, 5))}</span></div>`).join('')}</div>`;
    if (pf.background) html += `<div class="mx">General knowledge, not from a filing: ${esc(shortTxt(pf.background, 22))}</div>`;
  } else if (pf?.error) html += `<div class="mx">Profile unavailable: ${esc(pf.error)}</div>`;
  // 5. unnamed party: candidates as a compact table
  if (n.cands?.length || n.resolved) {
    html += `<h5>${ic('target')} Who is it?</h5><div class="cnds">${(n.cands || []).map(c => { const ev = c.evidence, best = n.resolved && ((n.resolved.ticker && n.resolved.ticker === c.ticker) || norm(n.resolved.name) === norm(c.name));
      return `<div class="cnd ${best ? 'best' : ''}">${chip(c.name, { ticker: c.ticker, q: c.why })}<span class="ev ${ev ? (ev.supports === 'yes' ? 'yes' : ev.supports === 'no' ? 'no' : 'unc') : 'nc'}" title="${esc(ev?.q || ev?.why || '')}">${ev ? (ev.supports === 'yes' ? 'confirmed' : ev.supports === 'no' ? 'not in filing' : 'unclear') : (c.ticker ? 'checking' : 'no filing')}</span>${best ? `<b class="cf">${esc(n.resolved.confidence)}</b>` : ''}</div>`; }).join('')}</div>`;
  }
  // 6. links and evidence, folded
  const linked = [...(n.links || [])];
  if (linked.length || n.second?.length) html += `<div class="igg two">${linked.length ? `<div class="igc"><h6>${ic('link')} Linked on the map <em>${linked.length}</em></h6><div class="lcs">${linked.slice(0, 10).map(o => chip(o.name, { ticker: o.ticker, node: o })).join('')}</div></div>` : ''}${n.second?.length ? `<div class="igc"><h6>${ic('link')} Second-degree <em>${new Set(n.second).size}</em></h6><div class="lcs">${[...new Set(n.second)].slice(0, 10).map(x => chip(x)).join('')}</div></div>` : ''}</div>`;
  const ev = (n.quotes || []).filter(q => n !== S.root && !isTableQuote(q.q));
  if (isCategory(n.name) && ev.length) html += ev.slice(0, 3).map(q => `<div class="fq2">“${esc(q.q)}” <span>${esc(q.from && q.from !== S.root?.name ? q.from : 'agent ' + q.agent)}</span></div>`).join('');
  else if (n !== S.root && (ev.length || n.agents?.size)) html += `<details class="evd"><summary>Evidence · ${ev.length} quote${ev.length === 1 ? '' : 's'} · found by ${n.agents?.size || 0} agent${n.agents?.size === 1 ? '' : 's'}</summary>${ev.map(q => `<div class="fq2">“${esc(q.q)}” <span>${esc(q.from && q.from !== S.root?.name ? q.from : 'agent ' + q.agent)}</span></div>`).join('')}<div class="chips" style="margin-top:6px">${[...(n.agents || [])].map(id => `<span data-agent="${esc(id)}">${esc(S.agents.get(id)?.label || id)}</span>`).join('')}</div></details>`;
  html += X.companyExtra(n);
  const hopPriv = !n.ticker && n !== S.root && n.kind === 'company' && !n.route && groupOf(n) && !isAnon(n.name) && !isCategory(n.name) && n.kind !== 'customer_hint';
  const focus = n.ticker && n !== S.root ? `<button class="focus" data-focus="${esc(n.ticker)}" data-name="${esc(n.name)}">Focus ${esc(n.ticker)} →</button>` : hopPriv ? `<button class="focus" data-focus="" data-private="1" data-name="${esc(n.name)}">Map ${esc(shortTxt(n.name, 3))} →</button>` : '';
  const head = `<span data-keep></span>${n.ticker ? `<img class="mh-l" src="logos/${esc(n.ticker)}.png" onerror="this.remove()">` : ''}${esc(n.name)}${n.ticker ? ` <span class="tk2">${esc(n.ticker)}</span>` : ''}`;
  openModal(head, html || '<div class="empty">Nothing more yet.</div>', `${g0}${focus ? ' · ' + focus : ''}`);
  $('#modal .mo')?.classList.add('wide');
  MODAL_NODE = n;
  X.wireCompany(n);
}
function listModal(kind) {
  if (kind === 'product') return setView('des');
  const places = S.risks.filter(r => r.k === 'place'), risks = S.risks.filter(r => r.k === 'risk');
  openModal(`Risks · ${risks.length}`, `${places.length ? `<h5>${ic('globe')} Geography · ${places.length}</h5><div class="tg">${places.map(p => `<span title="${esc(p.q || '')}">${esc(p.name)}${p.rel ? ' · ' + esc(p.rel) : ''}</span>`).join('')}</div>` : ''}<h5>${ic('alert')} Risk factors</h5><div class="rk">${risks.map(r => `<div title="${esc(r.q || '')}"><i></i>${esc(cap1(r.name))}<span>${esc(r.agent || '')}</span></div>`).join('')}</div>`, 'Hover a risk for the quote from the filing');
}
function hubModal(g) {
  const G = GROUPS[g]; const list = S.nodes.filter(n => groupOf(n) === g);
  openModal(`${list.length} ${G.label}`, `<table class="mt"><tr><th>Company</th><th>Ticker</th><th>Mentions</th><th>Detail</th></tr>${list.map(n => `<tr data-node="${esc(n.id)}"><td>${esc(n.name)}</td><td>${esc(n.ticker || '–')}</td><td>${n.mentions || 0}</td><td class="trunc">${esc(tileInfo(n))}</td></tr>`).join('')}</table>`);
}

// ---------- canvas helpers ----------
function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.1, r), 0, Math.PI * 2); }
function line(a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
function curve(a, b) { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx - dy * 0.18, my + dx * 0.18, b.x, b.y); ctx.stroke(); }
function hexA(hex, a) { if (!hex || hex[0] !== '#') return `rgba(170,184,216,${a})`; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`; }
function easeOutBack(x) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; }

function positionBubble() {
  if (!S.bot || !bubble.classList.contains('show')) return;
  const [sx, sy] = toScreen(S.bot.x, S.bot.y);
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  const side = (S.bot.r + 40) * cam.k + 24;
  let x = sx - side - bw, y = sy - bh / 2;
  if (x < 16) x = sx + side;
  if (x + bw > W - 16) x = Math.max(16, W - bw - 16);
  bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.min(H - bh - 130, Math.max(80, y)))}px)`;
}

// ---------- interaction ----------
function pick(sx, sy) {
  const [x, y] = toWorld(sx, sy);
  let best = null, bd = Infinity;
  for (const n of S.nodes) {
    if (n.x == null) continue;
    const d = Math.hypot(n.x - x, n.y - y) - n.r;
    if (d < 8 / cam.k && d < bd) { bd = d; best = n; }
  }
  return best;
}
const tip = $('#tooltip');
let drag = null;
cv.addEventListener('mousemove', ev => {
  if (drag) { cam.user = true; cam.tx = cam.x = drag.x - (ev.clientX - drag.sx) / cam.k; cam.ty = cam.y = drag.y - (ev.clientY - drag.sy) / cam.k; return; }
  const hit = pickTile(ev.clientX, ev.clientY);
  const n = hit?.n || null;
  S.hover = n;
  cv.style.cursor = hit ? 'pointer' : 'default';
  tip.style.display = 'none';
  if (!n || true) return;
  const color = n.color || (n.kind === 'agent' ? COLORS.agent : '#fff');
  const q = n.quotes?.[0]?.q;
  tip.style.setProperty('--c', color);
  tip.innerHTML = `<div class="tt-r">${esc(n.kind === 'company' ? (n.inferred ? 'inferred ' : '') + (n.cl && CLUSTERS[n.cl] ? CLUSTERS[n.cl].label.replace(/s$/, '') : n.outer ? 'second-degree' : 'company') : n.kind === 'agent' ? 'agent · ' + n.state : n.kind)}</div><div class="tt-h">${esc(n.name)}${n.ticker ? ' <span style="color:var(--dim);font-weight:400">' + esc(n.ticker) + '</span>' : ''}</div>${n.desc ? `<div class="tt-d">${esc(n.desc)}</div>` : ''}${n.impact ? `<div class="tt-q" style="border-color:${IMPACT[n.impact.impact]}">${esc(n.impact.why || '')}</div>` : q ? `<div class="tt-q">“${esc(q)}”</div>` : ''}${n.agents ? `<div class="tt-s">${n.agents.size} agent(s) · click for detail</div>` : ''}`;
  tip.style.display = 'block';
  tip.style.left = Math.min(W - 350, ev.clientX + 16) + 'px'; tip.style.top = Math.min(H - 120, ev.clientY + 14) + 'px';
});
cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; S.hover = null; });
cv.addEventListener('mousedown', ev => { if (!pickTile(ev.clientX, ev.clientY)) drag = { sx: ev.clientX, sy: ev.clientY, x: cam.x, y: cam.y, moved: false }; });
addEventListener('mouseup', () => { drag = null; });
const FA = new Map(), FAQ = [];
let faBusy = 0;
function queueFA(tk) { if (!tk) return; tk = tk.toUpperCase(); if (FA.has(tk) || FAQ.includes(tk)) return; FAQ.push(tk); pumpFA(); }
function pumpFA() { while (faBusy < 3 && FAQ.length) { const tk = FAQ.shift(); faBusy++; loadFA(tk).finally(() => { faBusy--; pumpFA(); }); } }
async function loadFA(tk) {
  tk = tk.toUpperCase();
  if (FA.has(tk)) return;
  FA.set(tk, undefined);
  try { const r = await fetch('api/financials?ticker=' + encodeURIComponent(tk)); FA.set(tk, r.ok ? await r.json() : null); } catch { FA.set(tk, null); }
  if (MODAL_NODE && MODAL_NODE.ticker?.toUpperCase() === tk) companyModal(MODAL_NODE, true);
}
cv.addEventListener('click', ev => {
  const hit = pickTile(ev.clientX, ev.clientY);
  if (hit?.n) { S.selected = hit.n; companyModal(hit.n); return; }
  if (hit?.more) { hubModal(hit.g); return; }
  if (hit?.hub) { hubModal(hit.hub); return; }
  if (FILTER !== 'all') setFilter('all');
});
cv.addEventListener('dblclick', () => { cam.user = false; });
cv.addEventListener('wheel', ev => {
  ev.preventDefault(); cam.user = true;
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  const f = Math.exp(-ev.deltaY * 0.0015);
  cam.k = cam.tk = Math.max(0.2, Math.min(4, cam.k * f));
  cam.x = cam.tx = wx - (ev.clientX - cam.cx) / cam.k; cam.y = cam.ty = wy - (ev.clientY - cam.cy) / cam.k;
}, { passive: false });

// ---------- search box ----------
const q = $('#q'), sug = $('#suggest');
let items = [], on = 0, searchSeq = 0;
function renderSuggest() {
  if (!items.length) { sug.classList.remove('open'); return; }
  sug.innerHTML = items.map((t, i) => t.type ? X.suggestRow(t, i, i === on) : `<div class="sg${i === on ? ' on' : ''}" data-i="${i}">${t.logo ? `<div class="lg"><img src="logos/${esc(t.ticker)}.png" alt=""></div>` : `<div class="lg letter">${esc(t.ticker[0])}</div>`}<div class="tk">${esc(t.ticker)}</div><div class="nm">${esc(titleCase(t.name))}</div><div class="go">${i === on ? 'map ↵' : ''}</div></div>`).join('');
  sug.classList.add('open');
}
const titleCase = s => s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Corp|Inc|Ltd|Plc|Co)\b/g, m => m);
async function search(v) {
  const seq = ++searchSeq;
  if (!v.trim()) { items = []; renderSuggest(); return; }
  try { const r = await fetch('api/search?q=' + encodeURIComponent(v)); const list = await r.json(); if (seq !== searchSeq) return; items = list; on = 0; renderSuggest(); } catch { }
}
q.addEventListener('input', () => { const v = q.value.trim(); if ((chatMode && !/^[A-Za-z.&\- ]{1,24}$/.test(v)) || (S.root && VIEWS.includes(v.toLowerCase()))) { items = []; renderSuggest(); return; } search(q.value); });
q.addEventListener('keydown', ev => {
  if (ev.key === 'ArrowDown') { on = Math.min(items.length - 1, on + 1); renderSuggest(); ev.preventDefault(); }
  else if (ev.key === 'ArrowUp') { on = Math.max(0, on - 1); renderSuggest(); ev.preventDefault(); }
  else if (ev.key === 'Enter') {
    ev.preventDefault();
    const v = q.value.trim(), code = v.toLowerCase().replace(/\s*<go>$/, '');
    if (S.root && VIEWS.includes(code)) { q.value = ''; items = []; renderSuggest(); setView(code); return; }
    if (items[on]?.type) { choose(items[on]); return; }
    if (S.root && (v.includes(' ') || v.endsWith('?')) && !items.some(t => t.ticker === v.toUpperCase())) { items = []; renderSuggest(); q.value = ''; askWhatif(v); return; }
    choose(items[on] || { ticker: v.toUpperCase() });
  }
  else if (ev.key === 'Escape') { items = []; renderSuggest(); }
});
sug.addEventListener('mousedown', ev => { const el = ev.target.closest('.sg'); if (el) { ev.preventDefault(); choose(items[+el.dataset.i]); } });
async function choose(t) {
  if (!t || !t.ticker) return;
  items = []; renderSuggest(); q.blur();
  if (t.type === 'wire') { q.value = ''; if (window.PTWire) PTWire.open(); else setStatus('Loading…'); return; }
  if (t.type && t.type !== 'commodity') { q.value = ''; if (window.PTViews) PTViews.open(t); else setStatus('Loading…'); return; }
  if (t.type === 'commodity') { q.value = t.name; if (REPLAY) return; setStatus('Starting…', true); const r = await fetch('api/ask?kind=commodity&c=' + encodeURIComponent(t.key) + '&q=' + encodeURIComponent(t.name)).catch(() => null); if (!r || !r.ok) { const j = r ? await r.json().catch(() => ({})) : {}; setStatus(j.error || 'Could not start the run'); } return; }
  q.value = t.ticker + (t.name ? '  ·  ' + titleCase(t.name) : '');
  if (REPLAY) return; // replay drives itself
  setStatus('Starting…', true);
  const r = await fetch('api/ask?q=' + encodeURIComponent(t.ticker)).catch(() => null);
  if (!r || !r.ok) { const j = r ? await r.json().catch(() => ({})) : {}; setStatus(j.error || 'Could not start the run'); }
}

// ---------- what-if chat ----------
const WHATIF_EXAMPLES = ['What if Taiwan is blockaded?', 'What if hyperscalers cut AI capex 30%?', 'What if the US bans all chip exports to China?'];
let chatMode = false;
function setChatMode(on) {
  chatMode = on;
  q.placeholder = on ? 'Map another ticker… (DES FA RV CN open panels)' : 'Type a ticker or company…';
  if (on) q.value = '';
}
const CHAT = [];
function chatPush(role, html) { if (role === 'me') S.lastQ = { q: html.replace(/<[^>]+>/g, ''), done: false }; renderChat(); }
function renderChat() {
  const log = $('#chat-log'); if (!log) return;
  const q = S.lastQ;
  log.innerHTML = q ? `<div class="qchip"><span class="qq">${esc(q.q)}</span>${q.done ? `<button class="qres">${ic('hash')} Results</button>` : '<span class="ag-spin"></span><span class="qs">agents answering…</span>'}</div>` : '';
  log.classList.toggle('has', !!q);
  log.querySelector('.qres')?.addEventListener('click', () => (S.streamMode ? X.streamResults(S.streamMode) : whatifResults()));
  const ex = $('#chat-ex');
  if (ex) ex.innerHTML = q ? '' : X.examples().map(t => `<button>${esc(t)}</button>`).join('');
  ex?.querySelectorAll('button').forEach(b => b.onclick = () => askWhatif(b.textContent));
}
async function askWhatif(text) {
  if (!text.trim()) return;
  if (!S.root) { setStatus('Map a company first'); return; }
  chatPush('me', esc(text));
  S.chatPending = true;
  $('#chat-q').value = '';
  if (REPLAY) return;
  const r = await fetch('api/ask?mode=whatif&q=' + encodeURIComponent(text)).catch(() => null);
  if (!r || !r.ok) { const j = r ? await r.json().catch(() => ({})) : {}; S.lastQ = null; renderChat(); setStatus(j.error || 'Could not start the what-if'); S.chatPending = false; }
}
// ---------- start screen pills ----------
const TOP = [['NVDA', 'Nvidia'], ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['META', 'Meta'], ['TSLA', 'Tesla'], ['TSM', 'TSMC'], ['AMD', 'AMD'], ['JPM', 'JPMorgan']];
function renderPills() {
  const el = $('#pills'); if (!el) return;
  el.innerHTML = TOP.map(([t, n]) => `<button data-t="${t}" data-n="${esc(n)}"><img src="logos/${t}.png" alt="" onerror="this.style.display='none'"><b>${t}</b><span>${esc(n)}</span></button>`).join('');
  el.querySelectorAll('button').forEach(b => b.onclick = () => choose({ ticker: b.dataset.t, name: b.dataset.n }));
}

// ---------- live (SSE) + replay ----------
const REPLAY = params.get('replay');
function live() {
  const es = new EventSource('api/events?fresh=1');
  es.onmessage = m => { try { dispatch(JSON.parse(m.data)); } catch (err) { console.error(err); } };
}
async function replay(file) {
  const run = await (await fetch('runs/' + file)).json();
  S.provider = run.provider;
  $('#model').textContent = run.provider + ' · replay of a recorded run';
  const ev = run.events;
  // compress quiet stretches (queue waits) so the replay keeps moving; say how long was skipped
  const ACTIVE = new Set(['ask', 'bot', 'scan', 'financials', 'spawn', 'first', 'finding', 'done', 'candidates', 'end']);
  let offset = 0, lastActive = 0, lastNew = 0; const sched = [];
  const TOUR = params.get('tour') === '1';
  const PAUSE = +(params.get('pause') || (TOUR ? 10800 : 7000));
  for (const e of ev) {
    let nt;
    if (e.type === 'ask' && e.mode === 'whatif') {
      // give the viewer a beat on the finished map, then type the question into the chat box
      offset = e.t - (lastNew + PAUSE); sched.push({ at: lastNew + PAUSE - 2100, typeq: e.q });
      if (TOUR) {
        sched.push({ at: lastNew + 4700, tour: 'supplier' });
        sched.push({ at: lastNew + 5600, tour: 'pick:supplier' });
        sched.push({ at: lastNew + 7000, tour: 'customer' });
        sched.push({ at: lastNew + 8300, tour: 'all' });
      }
      lastActive = e.t; nt = e.t - offset; lastNew = nt; sched.push({ at: nt, e }); continue;
    }
    if (ACTIVE.has(e.type)) {
      const gap = e.t - lastActive;
      if (gap > 900) { const keep = gap > 4000 ? (e.type === 'first' ? 1100 : 700) : 350; offset += gap - keep; if (gap > 4000) sched.push({ at: e.t - offset - keep, chip: gap }); }
      nt = e.t - offset; lastActive = e.t; lastNew = nt;
    } else nt = Math.min(e.t - offset, lastNew + 800);
    sched.push({ at: nt, e });
  }
  sched.sort((a, b) => a.at - b.at);
  if (params.get('type') !== '0') await autotype(run.ticker);
  const start = performance.now();
  let i = 0;
  (function pump() {
    const now = performance.now() - start;
    while (i < sched.length && sched[i].at <= now) {
      const s = sched[i++];
      if (s.chip) { if (s.chip > 4000) showChip(`⏩ skipped ${(s.chip / 1000).toFixed(0)} s waiting in queue`); }
      else if (s.typeq) typeQuestion(s.typeq);
      else if (s.tour) tourStep(s.tour);
      else dispatch(s.e);
    }
    if (i < sched.length || EQ.length) requestAnimationFrame(pump);
    else if (params.get('outro') === '1' && !window.__outro) { window.__outro = 1; setTimeout(() => { outro(); setTimeout(() => { window.__replayDone = performance.now(); }, 3200); }, 4300); }
    else if (params.get('outro') !== '1') window.__replayDone = performance.now();
  })();
}
function showChip() {}
function tourStep(t) {
  if (t.startsWith('pick:')) {
    const cl = t.slice(5);
    const n = S.nodes.filter(n => n.cl === cl && n.kind === 'company' && n.ticker).sort((a, b) => b.r - a.r)[0];
    if (n) { S.selected = n; loadFA(n.ticker); renderSideNow(); }
    return;
  }
  if (t === 'all') { S.selected = null; renderSideNow(); }
  setFilter(t);
}
function outro() {
  const el = document.createElement('div'); el.id = 'outro';
  const agents = S.agents.size, f = S.findings;
  el.innerHTML = `<div class="o-t">Pocket Terminal</div><div class="o-s">${agents} Kimi K3.1 Pro agents on Cerebras, orchestrated by an OpenClaw main agent.<br>${f} findings, every one quoted from a filing.</div><div class="o-h">#KimiOnCerebras</div>`;
  document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('show'));
}
async function typeQuestion(text) {
  document.querySelector('#endcard')?.remove();
  q.value = ''; q.focus();
  const step = Math.max(18, 1400 / text.length);
  for (const ch of text) { q.value += ch; await sleep(step); }
  $('#chips')?.classList.remove('show');
  await sleep(250); q.blur();
}
async function autotype(ticker) {
  const word = (params.get('q') || ticker || '').slice(0, 2);
  q.focus();
  await sleep(700);
  for (const ch of word) { q.value += ch; search(q.value); await sleep(260); }
  await sleep(1100);
  const t = items.find(x => x.ticker === ticker) || items[0] || { ticker };
  on = Math.max(0, items.indexOf(t)); renderSuggest();
  await sleep(500);
  items = []; renderSuggest(); q.blur();
  q.value = t.ticker + (t.name ? '  ·  ' + titleCase(t.name) : '');
  await sleep(250);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- boot ----------
function resize() {
  W = innerWidth; H = innerHeight; DPR = Math.min(2, devicePixelRatio || 1);
  for (const c of [cv, starsCv]) { c.width = W * DPR; c.height = H * DPR; }
}
addEventListener('resize', resize); resize();
fetch('api/config').then(r => r.json()).then(c => { if (!REPLAY) { S.provider = c.label; $('#model').textContent = c.label + ' · via OpenClaw'; } }).catch(() => { });
renderPills();
$('#chat-go').onclick = () => askWhatif($('#chat-q').value);
$('#chat-q').addEventListener('keydown', ev => { if (ev.key === 'Enter') askWhatif($('#chat-q').value); });
renderChat();
requestAnimationFrame(frame);
if (REPLAY) replay(REPLAY); else { if (!params.has('nolive')) live(); q.focus(); }
