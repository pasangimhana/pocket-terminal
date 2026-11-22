/* Pocket Terminal, map-side extras: commodity maps, shipping chokepoints, extra agent streams (who names you,
   what changed, earnings), shock rings, risk badges, scenario sliders, hidden links, earnings ripple, insiders,
   holders, contracts, macro, patents, Asian filings, watchlist and the analyst-note export.
   Loaded before app.js; app.js calls into X from its hooks. Everything here reads app.js globals at call time. */
'use strict';
const X = (() => {
  const enc = encodeURIComponent;
  const get = async (url) => { try { const r = await fetch(url); const j = await r.json(); return r.ok || j?.needsKey ? j : { error: j?.error || 'HTTP ' + r.status }; } catch (e) { return { error: String(e.message || e) }; } };
  const D = {}; // per-map data cache: key -> result | 'loading'
  const fmtN = (v, d = 1) => v == null || isNaN(v) ? '–' : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(d) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(d) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(d) + 'K' : (+v).toFixed(Math.abs(v) < 10 ? 2 : 0);
  const usd = v => v == null || isNaN(v) ? '–' : (v < 0 ? '-$' : '$') + fmtN(Math.abs(v));
  const sgn = (v, d = 1) => v == null || isNaN(v) ? '–' : (v > 0 ? '+' : '') + (+v).toFixed(d);
  const keyNote = j => j?.needsKey ? `<div class="xk">${ic('lock')} Add <code>${esc(j.needsKey)}</code> to <code>.env</code> to turn this on</div>` : `<div class="xk dim">${esc(j?.error || 'No data')}</div>`;
  const loadOnce = (key, url, after) => {
    if (D[key] !== undefined) return D[key];
    D[key] = 'loading';
    get(url).then(j => { D[key] = j; after ? after(j) : null; renderSide(); if (MODAL_NODE) companyModal(MODAL_NODE, true); });
    return 'loading';
  };
  const spin = '<span class="ag-spin"></span>';
  const isCommodity = () => S.scan?.kind === 'commodity';
  const MARK = { copper: 'CU', crude: 'CL', lng: 'NG', lithium: 'LI', uranium: 'U', gold: 'AU', ironore: 'FE', wheat: 'W', cocoa: 'CC', rareearths: 'RE' };
  const rootTicker = () => (S.scan && !isCommodity() ? S.scan.ticker : null);
  const mapTickers = (max = 30) => [...new Set(S.nodes.filter(n => n.kind === 'company' && n.ticker && groupOf(n)).sort((a, b) => (b.mentions || 0) - (a.mentions || 0)).map(n => n.ticker.toUpperCase()))].slice(0, max);

  // ---------- streams (extra agent waves on the current map) ----------
  const STREAMS = {
    named: { label: 'Who names you', icon: 'users', sub: 'Every annual report that names it, one agent each' },
    changes: { label: 'What changed', icon: 'alert', sub: 'This 10-K vs last year’s' },
    earnings: { label: 'Earnings', icon: 'hash', sub: 'KPIs from the latest press releases' },
    investigate: { label: 'Investigate', icon: 'target', sub: 'Enrich one company', perCompany: true },
  };
  const WORK = { investigate: 'Investigate', named: 'Names it', changes: 'Year over year', earnings: 'Earnings release', chain: 'Value chain', indexshock: 'Index what-if' };
  const GROUP_WORK = { investigate: 'investigating one company', named: 'annual reports that name it', changes: 'new and dropped paragraphs', earnings: 'earnings releases', chain: 'annual reports on it', indexshock: 'index members' };
  const NO_TARGET = new Set([11, 12, 14, 16]);
  function spawnText(N, e) {
    const c = S.scan?.name || 'it';
    return { 17: `${N} agents investigating ${e.target || 'a company'}`, 11: `${N} agents reading annual reports that name ${c}`, 12: `${N} agents comparing this year's annual report with last year's`, 13: `${N} agents reading the latest earnings releases`, 14: `${N} agents placing every company in the ${c.toLowerCase()} value chain`, 16: `${N} agents running the what-if across the index` };
  }
  async function runStream(kind) {
    if (!S.root || REPLAY) return;
    if (S.phase !== 'done') { setStatus('Wait for the current agents to finish'); return; }
    const r = await fetch('api/ask?mode=' + kind + '&q=' + enc(STREAMS[kind].label)).catch(() => null);
    if (!r || !r.ok) { const j = r ? await r.json().catch(() => ({})) : {}; setStatus(j.error || 'Could not start'); }
  }
  function startStream(e) {
    document.querySelector('#endcard')?.remove();
    for (const g of AG.groups) g.classList.add('collapsed');
    AG.el?.classList.remove('idle');
    agentsStatus('You asked: ' + e.q);
    chatPush('me', esc(e.q)); S.chatPending = true;
    S.phase = 'whatif'; S.streamMode = e.mode; S.endAt = null;
    document.body.classList.remove('done');
    setStatus(e.q + '…', true);
    renderSide();
  }

  // ---------- findings from the new waves ----------
  const STAGE_REL = { producer: 'supplier', refiner: 'supplier', shipper: 'partner', consumer: 'customer', hedger: 'competitor' };
  function mapFinding(f, e, a, now) {
    if (f.k === 'enrich' || f.k === 'source' || f.k === 'lead') { window.PTInvestigate?.onFinding?.(f, e, a); return null; }
    if (f.k === 'change') { (S.changes ||= []).push(f); return null; }
    if (f.k === 'kpi' || f.k === 'guide') { const t = (f.ticker || '').toUpperCase(); ((S.kpis ||= {})[t] ||= []).push(f); return null; }
    if (f.k === 'named') {
      (S.named ||= []).push(f);
      if (f.rel === 'other' || (f.strength || 1) < 2) return null;
      return { k: 'company', name: f.name, ticker: f.ticker || null, rel: f.rel === 'investor' ? 'partner' : f.rel, q: f.q };
    }
    if (f.k === 'chain') {
      (S.chain ||= []).push(f);
      if (f.stage === 'other') return null;
      return { k: 'company', name: f.name, ticker: f.ticker || null, rel: STAGE_REL[f.stage] || 'partner', q: f.q };
    }
    return f;
  }
  function decorate(node, f) {
    if (f.k === 'named') node.namedBy = { rel: f.rel, strength: f.strength, detail: f.detail, q: f.q, form: f.form, date: f.date, url: f.url };
    if (f.k === 'chain') { node.chain = { stage: f.stage, exposure: f.exposure, sens: f.margin_bps_per_10pct, routes: f.routes || [], detail: f.detail }; node.desc ||= f.detail; }
  }
  function tileInfo(n) {
    if (n.enriched?.what) return n.enriched.what;
    if (isCommodity() && n.chain) {
      if (S.scenario) { const bps = Math.round((n.chain.sens || 0) * S.scenario / 10); return `${S.scan.name} ${sgn(S.scenario, 0)}% → op. margin ${bps > 0 ? '+' : ''}${bps} bps`; }
      return `${cap1(n.chain.stage)} · ${n.chain.detail || ''}`;
    }
    if (n.namedBy) return `Names ${S.scan?.ticker || 'it'} as its ${n.namedBy.rel === 'customer' ? 'supplier' : n.namedBy.rel === 'supplier' ? 'customer' : n.namedBy.rel} · ${n.namedBy.detail || ''}`;
    return '';
  }

  // ---------- risk badges ----------
  const COUNTRY = { TSM: 'TW', UMC: 'TW', ASX: 'TW', FOXCONN: 'TW', WISTRON: 'TW', QUANTA: 'TW', MEDIATEK: 'TW', SAMSUNG: 'KR', SKHYNIX: 'KR', ASML: 'NL', NXPI: 'NL', SONY: 'JP', BABA: 'CN', HUAWEI: 'CN', ARM: 'UK', SHOP: 'CA', CLS: 'CA', CELESTICA: 'CA' };
  const countryOf = n => COUNTRY[(n.ticker || '').toUpperCase()] || COUNTRY[LOGO_ALIAS[norm(n.name)] || ''] || null;
  const SOLE = /\b(sole|single)[- ]source|\bonly (supplier|source)|limited number of suppliers|single supplier/i;
  const isSole = n => (n.quotes || []).some(q => SOLE.test(q.q || ''));
  function badges(n) {
    let b = '';
    if (n.pct) b += ` ${Math.round(n.pct)}%`;
    if (isSole(n)) b += ' SOLE';
    const c = countryOf(n); if (c) b += ' ' + c;
    if (isCommodity() && n.chain && S.scenario) { const bps = Math.round((n.chain.sens || 0) * S.scenario / 10); if (bps) b += ` ${bps > 0 ? '+' : ''}${bps}bp`; }
    return b;
  }
  function rootRisk() {
    const custs = S.nodes.filter(n => groupOf(n) === 'customer');
    let top = Math.max(0, ...custs.map(n => n.pct || 0));
    for (const h of S.hints || []) { const p = pctOf(h.detail); if (p) top = Math.max(top, p); }
    const sole = (S.risks || []).filter(r => SOLE.test((r.name || '') + ' ' + (r.q || ''))).length + S.nodes.filter(n => groupOf(n) === 'supplier' && isSole(n)).length;
    const places = (S.risks || []).filter(r => r.k === 'place');
    const cnt = {}; for (const p of places) { const k = p.name; cnt[k] = (cnt[k] || 0) + (p.rel === 'manufacturing' ? 2 : 1); }
    const country = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { top, sole, country };
  }
  function cardBadges(x, y, px) {
    if (!S.scan || isCommodity() || !S.findings) return;
    const r = rootRisk(), pills = [];
    if (r.top) pills.push([`TOP CUSTOMER ${Math.round(r.top)}%`, r.top >= 10 ? IMPACT.mixed : '#9fb3ba']);
    if (r.sole) pills.push([`SINGLE-SOURCE ×${r.sole}`, IMPACT.negative]);
    if (r.country) pills.push([`EXPOSURE ${r.country.toUpperCase().slice(0, 14)}`, '#9fb3ba']);
    if (!pills.length) return;
    ctx.font = `600 ${9}px "Geist Mono", monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    let cx = x, cy = y + CARD.h + 12;
    for (const [t, c] of pills) {
      const w = ctx.measureText(t).width + 12;
      if (cx < 0 && cx + w > -8) cx = 8; // keep clear of the line to the bottom hub
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.strokeStyle = c; ctx.lineWidth = px;
      ctx.beginPath(); ctx.roundRect(cx, cy - 7, w, 14, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = c; ctx.fillText(t, cx + 6, cy + 0.5);
      cx += w + 6;
    }
  }

  // ---------- commodity mode ----------
  const COMMODITY_GROUPS = { supplier: 'Producers & refiners', customer: 'Consumers', partner: 'Shippers & routes', competitor: 'Funds & hedgers' };
  const COMPANY_GROUPS = { supplier: 'Suppliers', customer: 'Customers', partner: 'Partners', competitor: 'Competitors' };
  function relabel(kind) {
    const cq = document.getElementById('chat-q'); if (cq && kind !== 'commodity') cq.placeholder = 'Ask what happens if… e.g. What if Taiwan is blockaded?';
    const L = kind === 'commodity' ? COMMODITY_GROUPS : COMPANY_GROUPS;
    for (const [k, G] of Object.entries(GROUPS)) G.label = L[k];
    const KEYS = kind === 'commodity' ? { supplier: 'Producers', customer: 'Consumers', competitor: 'Hedgers', partner: 'Shippers' } : { supplier: 'Supply', customer: 'Customers', competitor: 'Rivals', partner: 'Partners' };
    document.querySelectorAll('#fkeys button[data-f]').forEach(b => { const t = [...b.childNodes].find(x => x.nodeType === 3 && x.textContent.trim()); if (t && KEYS[b.dataset.f]) t.textContent = KEYS[b.dataset.f]; });
    S.scenario = 0;
  }
  function drawCommodityCard(now, px) {
    const r = S.root, x = -CARD.w / 2, y = -CARD.h / 2, s = S.scan, fu = s.futures || {};
    const imp = r.impact && IMPF[r.impact.impact];
    ctx.fillStyle = imp ? imp[0] : '#0f1316'; ctx.fillRect(x, y, CARD.w, CARD.h);
    ctx.strokeStyle = imp ? imp[1] : '#3a4a52'; ctx.lineWidth = (imp ? 1.6 : 1) * px; ctx.strokeRect(x, y, CARD.w, CARD.h);
    ctx.fillStyle = P.accent; ctx.fillRect(x, y, CARD.w, 2.5 * px);
    if (S.phase !== 'done' && S.phase !== 'idle') { const cx = x + CARD.w - 14, cy = y + 16, a0 = now / 140; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.6 * px; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = P.accent; ctx.beginPath(); ctx.arc(cx, cy, 5, a0, a0 + Math.PI * 1.2); ctx.stroke(); }
    // commodity mark: a gradient square with the symbol
    const g = ctx.createLinearGradient(x + 14, y + 16, x + 54, y + 56); g.addColorStop(0, '#22c55e'); g.addColorStop(1, '#15803d');
    ctx.fillStyle = g; ctx.fillRect(x + 14, y + 16, 40, 40);
    ctx.fillStyle = '#04110a'; ctx.font = `700 ${15}px "Geist Mono", monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(MARK[s.commodity] || (s.name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase(), x + 34, y + 36.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${14}px "Geist Mono", monospace`; ctx.fillStyle = '#fafafa'; ctx.fillText((s.name || '').toUpperCase().slice(0, 22), x + 66, y + 32);
    ctx.font = `400 ${11.5}px Geist, sans-serif`; ctx.fillStyle = '#8b98a0'; ctx.fillText(`${fu.symbol || ''} ${fu.proxy ? 'proxy · ' : ''}Comdty${fu.unit ? ' · ' + fu.unit : ''}`, x + 66, y + 50);
    const pts = S.price?.points, last = fu.last ?? pts?.at(-1)?.c;
    const ch = (k, n) => fu[k] != null ? fu[k] : (pts && pts.length > n ? (pts.at(-1).c / pts.at(-1 - n).c - 1) * 100 : null);
    const rows = [['Last', last != null ? (+last).toFixed(last < 10 ? 3 : 2) : '…'], ['1 day', ch('chg1d', 1)], ['1 month', ch('chg1m', 21)], ['1 year', ch('chg1y', Math.min(251, (pts?.length || 1) - 1))]];
    rows.forEach(([a, b], i) => {
      const cx = x + 14 + (i % 2) * 140, cy = y + 84 + Math.floor(i / 2) * 30;
      ctx.font = `400 ${10.5}px Geist, sans-serif`; ctx.fillStyle = '#7d8a92'; ctx.fillText(a, cx, cy);
      const isPct = i > 0 && typeof b === 'number';
      ctx.font = `500 ${13}px "Geist Mono", monospace`; ctx.fillStyle = isPct ? (b >= 0 ? IMPACT.positive : IMPACT.negative) : '#eef2f4';
      ctx.fillText(isPct ? sgn(b) + '%' : (b == null ? '–' : String(b)), cx, cy + 15);
    });
    if (r.impact) { ctx.font = `500 ${11}px Geist, sans-serif`; ctx.fillStyle = imp[1]; ctx.textAlign = 'right'; ctx.fillText(r.impact.impact === 'positive' ? 'PRICE UP' : r.impact.impact === 'negative' ? 'PRICE DOWN' : 'MIXED', x + CARD.w - 28, y + 22); }
  }
  function commodityTerm(spark) {
    const s = S.scan, fu = s.futures || {};
    const tally = {}; for (const c of S.chain || []) tally[c.stage] = (tally[c.stage] || 0) + 1;
    const st = [['Producers', (tally.producer || 0) + (tally.refiner || 0)], ['Shippers', tally.shipper || 0], ['Consumers', tally.consumer || 0], ['Hedgers', tally.hedger || 0], ['Filings read', (S.chain || []).length], ['Routes', (S.routes?.chokepoints || []).length]];
    return `<div class="card term"><div class="term-h"><b>${esc(fu.symbol || s.ticker)}</b> <span>${fu.proxy ? 'Proxy · ' : ''}Comdty</span></div><div class="term-n">${esc(s.name)}${fu.label ? ` <span class="dim">· ${esc(fu.label)}</span>` : ''}</div>${spark.replace(/<b>\$/, '<b>')}<div class="kst">${st.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div><div class="term-s">Value chain from SEC annual reports · prices from Yahoo · ${esc(fu.unit || '')}</div></div>`;
  }
  // chokepoints become tiles in the top group; shippers draw thin lines to the routes they run
  function onData(e) {
    if (isCommodity() && !S.chatSet) { S.chatSet = true; renderChat(); const cq = document.getElementById('chat-q'); if (cq) cq.placeholder = `Ask what happens if… e.g. ${examples()[0]}`; }
    if (e.type === 'production') S.production = e;
    if (e.type === 'trade') (S.trade ||= {})[e.flow || 'X'] = e;
    if (e.type === 'routes') {
      S.routes = e;
      for (const cp of e.chokepoints || []) {
        const id = 'route:' + norm(cp.name);
        if (S.byId.has(id)) continue;
        const n = addNode({ id, kind: 'company', name: cp.name, rel: 'partner', relc: { partner: 1 }, route: cp, color: COLORS.partner, r: 9, x: 0, y: -300, charge: -40, quotes: [], agents: new Set(), mentions: 1 });
        n.desc = routeLine(cp);
        assignCluster(n);
      }
    }
    renderSide();
  }
  const shareOf = o => o == null ? null : typeof o === 'object' ? (o.shareSeaborne ?? o.shareEst ?? o.share ?? o.shareGlobal ?? null) : o;
  const routeLine = cp => [cp.oil, cp.lng, cp.containers].map((o, i) => { const v = shareOf(o); return v != null && v !== '' ? `${['oil', 'LNG', 'containers'][i]} ~${v}%` : ''; }).filter(Boolean).join(' · ') || cp.oil?.note || cp.note || cp.label || '';
  const routeSource = cp => cp.oil?.source || cp.lng?.source || cp.containers?.source || cp.source || '';
  function drawRouteTile(t, now, px, a) {
    const { dx: x, dy: y, w, h } = t, n = t.n;
    const dim = FILTER !== 'all' && FILTER !== 'partner';
    const hit = S.whatif?.q && /hormuz|suez|red sea|panama|malacca|bosporus|strait|canal|cape/i.test(S.whatif.q) && S.whatif.q.toLowerCase().includes(n.name.toLowerCase().split(/\s+/).pop());
    ctx.globalAlpha = a * (dim ? 0.28 : 1);
    ctx.fillStyle = hit ? '#3a1215' : S.hover === n ? '#13161a' : '#0b0f10'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = hit ? IMPACT.negative : S.selected === n ? P.accent : '#2c4a3a'; ctx.lineWidth = px; ctx.setLineDash([5 * px, 3 * px]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    // anchor icon
    const lx = x + 7, ly = y + 8, ls = 26;
    ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.4 * px; ctx.strokeRect(lx, ly, ls, ls);
    ctx.beginPath(); ctx.arc(lx + 13, ly + 8, 2.4, 0, Math.PI * 2); ctx.moveTo(lx + 13, ly + 10.5); ctx.lineTo(lx + 13, ly + 21); ctx.moveTo(lx + 7, ly + 16); ctx.quadraticCurveTo(lx + 8, ly + 21, lx + 13, ly + 21); ctx.quadraticCurveTo(lx + 18, ly + 21, lx + 19, ly + 16); ctx.stroke();
    const tx = x + 40, tw = w - 48;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${11.5}px "Geist Mono", monospace`; ctx.fillStyle = '#e4e4e7'; ctx.fillText(fit(n.name.toUpperCase(), tw), tx, y + 17);
    ctx.font = `600 ${8.5}px "Geist Mono", monospace`; const lbl = 'CHOKEPOINT', pw = ctx.measureText(lbl).width + 10;
    ctx.fillStyle = 'rgba(74,222,128,0.08)'; ctx.strokeStyle = '#2f6b47'; ctx.beginPath(); ctx.roundRect(tx, y + 23, pw, 11, 5.5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#86efac'; ctx.textBaseline = 'middle'; ctx.fillText(lbl, tx + 5, y + 28.8); ctx.textBaseline = 'alphabetic';
    const users = S.nodes.filter(o => o.chain?.routes?.some(r => sameRoute(r, n.name))).length;
    ctx.font = `500 ${10}px "Geist Mono", monospace`; ctx.fillStyle = '#6b7277'; ctx.fillText(fit(users ? `${users} on the map use it` : '', tw - pw - 6), tx + pw + 6, y + 31);
    ctx.font = `400 ${10}px Geist, sans-serif`; ctx.fillStyle = '#8a969e'; ctx.fillText(fit(n.desc || '', tw), tx, y + 45);
    ctx.globalAlpha = 1;
  }
  const sameRoute = (a, b) => { const k = s => norm(s).replace(/strait|straitof|canal|of|the|sea/g, ''); return k(a) && k(b) && (k(a).includes(k(b)) || k(b).includes(k(a))); };
  function afterTiles(now, px) {
    // shipping layer: shipper → the chokepoints it runs (only for the hovered/selected one, or all when filtered to shippers)
    const routes = TILES.filter(t => t.n?.route);
    if (routes.length) {
      const focus = S.hover || S.selected;
      for (const t of TILES) {
        const n = t.n; if (!n?.chain?.routes?.length) continue;
        if (!(focus === n || FILTER === 'partner' || (focus?.route && n.chain.routes.some(r => sameRoute(r, focus.name))))) continue;
        for (const r of n.chain.routes) {
          const rt = routes.find(x => sameRoute(r, x.n.name)); if (!rt) continue;
          ctx.strokeStyle = 'rgba(74,222,128,0.55)'; ctx.lineWidth = 1.1 * px; ctx.setLineDash([3 * px, 3 * px]);
          ctx.beginPath(); ctx.moveTo(t.dx + t.w / 2, t.dy + t.h / 2); ctx.lineTo(rt.dx + rt.w / 2, rt.dy + rt.h / 2); ctx.stroke(); ctx.setLineDash([]);
        }
      }
    }
    // hidden links: dashed amber lines between tiles whose stocks move together without naming each other
    if (S.hidden?.show && S.hidden.pairs?.length) {
      ctx.strokeStyle = 'rgba(226,163,54,0.7)'; ctx.lineWidth = 1.2 * px; ctx.setLineDash([6 * px, 4 * px]);
      for (const p of S.hidden.pairs) {
        const A = TILES.find(t => t.n?.ticker?.toUpperCase() === p.a), B = TILES.find(t => t.n?.ticker?.toUpperCase() === p.b);
        if (!A || !B) continue;
        ctx.beginPath(); ctx.moveTo(A.dx + A.w / 2, A.dy + A.h / 2); ctx.lineTo(B.dx + B.w / 2, B.dy + B.h / 2); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // ---------- side blocks ----------
  const bar = (v, max, neg) => `<i class="xb ${neg ? 'neg' : ''}" style="width:${Math.max(2, Math.min(100, Math.abs(v || 0) / (max || 1) * 100)).toFixed(0)}%"></i>`;
  function streamsBlock() {
    if (isCommodity()) return '';
    const done = k => ({ named: S.named?.length, changes: S.changes?.length, earnings: S.kpis && Object.keys(S.kpis).length })[k];
    const btn = (k) => `<button class="xs" data-stream="${k}" ${S.phase !== 'done' ? 'disabled' : ''}>${ic(STREAMS[k].icon)}<b>${STREAMS[k].label}</b><span>${done(k) ? 'done ✓' : STREAMS[k].sub}</span></button>`;
    const tools = [['insiders', 'Insiders', 'Form 4'], ['holders', 'Holders', '13F'], ['contracts', 'Gov contracts', 'USASpending'], ['ripple', 'Earnings ripple', 'who moves'], ['hidden', 'Hidden links', 'stocks that co-move'], ['patents', 'Patents', 'tech overlap'], ['compare', 'Compare', 'side by side'], ['note', 'Analyst note', 'PNG / PDF']];
    return `<div class="card blk xs-blk"><h4>Agent streams <span>new waves on this map</span></h4><div class="xs-g">${Object.keys(STREAMS).filter(k => !STREAMS[k].perCompany).map(btn).join('')}</div><div class="xt-g">${tools.map(([k, t, s]) => `<button class="xt" data-tool="${k}"><b>${t}</b><span>${s}</span></button>`).join('')}</div></div>`;
  }
  function sideBlocks(parts) {
    const eco = parts.findIndex(p => p.includes('data-open="eco"'));
    const insertAt = eco >= 0 ? eco + 1 : Math.min(parts.length, 1);
    const extra = [];
    if (S.phase === 'done' || S.streamMode) extra.push(streamsBlock());
    if (isCommodity()) {
      if (S.chain?.length) {
        const sens = S.chain.filter(c => c.stage === 'consumer' && c.margin_bps_per_10pct).length + S.chain.filter(c => c.stage === 'producer' && c.margin_bps_per_10pct).length;
        const v = S.scenario || 0;
        const hits = S.nodes.filter(n => n.chain && n.chain.sens).map(n => ({ n, bps: Math.round(n.chain.sens * v / 10) })).filter(x => x.bps).sort((a, b) => a.bps - b.bps);
        const worst = hits.slice(0, 4), best = hits.slice(-3).reverse().filter(x => x.bps > 0);
        extra.push(`<div class="card blk xsc"><h4>Scenario <span>${esc(S.scan.name)} price</span></h4><div class="xsl"><input type="range" min="-50" max="50" step="5" value="${v}" data-scn><b>${sgn(v, 0)}%</b></div><div class="xm">${sens} companies gave a margin sensitivity</div>${v ? `<div class="xl">${worst.map(x => `<div class="xr" data-node="${esc(x.n.id)}"><span>${esc(shortTxt(x.n.name, 3))}</span>${bar(x.bps, Math.abs(worst[0]?.bps || 1), true)}<b class="neg">${x.bps} bp</b></div>`).join('')}${best.map(x => `<div class="xr" data-node="${esc(x.n.id)}"><span>${esc(shortTxt(x.n.name, 3))}</span>${bar(x.bps, Math.abs(best[0]?.bps || 1))}<b class="pos">+${x.bps} bp</b></div>`).join('')}</div>` : '<div class="xm">Drag to see the operating-margin hit for each company</div>'}</div>`);
      }
      const P0 = S.production;
      if (P0) extra.push(P0.rows?.length ? blk('x-prod', 'Where it comes from', `${esc(P0.source || '')} ${esc(String(P0.year || ''))}`, `<div class="xl">${P0.rows.slice(0, 6).map(r => `<div class="xr"><span>${esc(r.country)}</span>${bar(r.share ?? r.value, P0.rows[0].share ?? P0.rows[0].value)}<b>${r.share != null ? (+r.share).toFixed(r.share < 10 ? 1 : 0) + '%' : fmtN(r.value)}</b></div>`).join('')}</div>`) : `<div class="card blk"><h4>Where it comes from</h4>${keyNote(P0)}</div>`);
      for (const fl of ['X', 'M']) {
        const T = S.trade?.[fl];
        if (T?.rows?.length) extra.push(blk('x-trade-' + fl, fl === 'X' ? 'Top exporters' : 'Top importers', `UN Comtrade ${esc(String(T.year || ''))}`, `<div class="xl">${T.rows.slice(0, 5).map(r => `<div class="xr"><span>${esc(r.country)}</span>${bar(r.valueUSD, T.rows[0].valueUSD)}<b>${usd(r.valueUSD)}</b></div>`).join('')}</div>`));
      }
      const R = S.routes?.chokepoints;
      if (R?.length) extra.push(blk('x-routes', 'Shipping chokepoints', `${R.length}`, `<div class="xl">${R.slice(0, 6).map(cp => `<div class="xr"><span>${esc(cp.name)}</span><b class="dim">${esc(shortTxt(routeLine(cp), 4))}</b></div>`).join('')}</div>`));
    }
    if (S.rings?.rings?.length) extra.push(blk('x-rings', 'Shock rings', esc(shortTxt(S.rings.question, 6)), ringsMini()));
    if (S.named?.length) {
      const c = {}; for (const f of S.named) c[f.rel] = (c[f.rel] || 0) + 1;
      extra.push(blk('x-named', 'Who names it', `${S.named.length} filings`, `<div class="xkp">${['customer', 'supplier', 'competitor', 'partner'].map(k => `<div><b>${c[k] || 0}</b><span>${k === 'customer' ? 'customers' : k + 's'}</span></div>`).join('')}</div><div class="lcs">${S.named.filter(f => f.rel === 'customer' && f.strength >= 2).slice(0, 6).map(f => chip(f.name, { ticker: f.ticker, q: f.q })).join('')}</div>`));
    }
    if (S.changes?.length) {
      const tp = {}; for (const f of S.changes) tp[f.type] = (tp[f.type] || 0) + 1;
      extra.push(blk('x-changes', 'What changed', `${S.changes.length} changes`, `<div class="tg">${Object.entries(tp).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `<span class="${/lost|new_risk/.test(k) ? 'warnc' : ''}">${esc(k.replace('_', ' '))} <b>${v}</b></span>`).join('')}</div>${S.changes.filter(f => f.type !== 'other').slice(0, 3).map(f => `<div class="xm">${esc(f.name)}</div>`).join('')}`));
    }
    const rk = rootTicker() && S.kpis?.[rootTicker()];
    if (rk?.length) extra.push(blk('x-earn', 'Earnings', `${esc(rk[0].period || '')}`, `<div class="xkp">${rk.filter(f => f.k === 'kpi').slice(0, 4).map(f => `<div><b>${esc(shortTxt(num(f.value), 2).replace(/…$/, ''))}</b><span>${esc(shortTxt(f.name, 3))}${f.change ? ` <em class="${/^-|−|down/i.test(f.change) ? 'neg' : 'pos'}">${esc(f.change)}</em>` : ''}</span></div>`).join('')}</div>`));
    // non-agent data blocks for the mapped company, loaded once
    const tk = rootTicker();
    if (tk && S.phase === 'done') {
      const ins = loadOnce('ins:' + tk, 'api/insiders?ticker=' + enc(tk));
      if (ins !== 'loading' && ins?.summary) { const s = ins.summary; extra.push(blk('x-ins', 'Insiders', 'Form 4 · 90 days', `<div class="xkp"><div><b class="pos">${s.buys90 ?? 0}</b><span>buys</span></div><div><b class="neg">${s.sells90 ?? 0}</b><span>sells</span></div><div><b class="${(s.netValue90 || 0) < 0 ? 'neg' : 'pos'}">${usd(s.netValue90)}</b><span>net</span></div></div>${(s.topSellers || []).slice(0, 2).map(x => `<div class="xm">${esc(typeof x === 'string' ? x : `${x.name || x.owner}: ${usd(x.value)}`)}</div>`).join('')}`)); }
      const gov = loadOnce('gov:' + tk, 'api/contracts?ticker=' + enc(tk));
      if (gov !== 'loading' && gov && !gov.error && gov.total) extra.push(blk('x-gov', 'Gov contracts', 'USASpending · 3 yrs', `<div class="xkp"><div><b>${usd(gov.total)}</b><span>awarded</span></div><div><b>${gov.count ?? '–'}</b><span>awards</span></div></div><div class="xl">${(gov.topAgencies || []).slice(0, 3).map(a => `<div class="xr"><span>${esc(shortTxt(a.agency, 4))}</span>${bar(a.amount, gov.topAgencies[0].amount)}<b>${usd(a.amount)}</b></div>`).join('')}</div>`));
      const hold = loadOnce('hold:' + tk, 'api/holders?ticker=' + enc(tk));
      if (hold !== 'loading' && hold?.holders?.length) extra.push(blk('x-hold', 'Biggest holders', `13F ${esc(hold.quarter || '')}`, `<div class="xl">${hold.holders.slice(0, 5).map(h => `<div class="xr"><span>${esc(shortTxt(h.filer, 3))}</span>${bar(h.value, hold.holders[0].value)}<b>${usd(h.value)}</b></div>`).join('')}</div>`));
      if (S.byTicker?.has('TSM') || tk === 'TSM') { const ts = loadOnce('tsmc', 'api/tsmc'); if (ts !== 'loading' && Array.isArray(ts) && ts.length) extra.push(blk('x-tsmc', 'TSMC monthly revenue', '6-K', miniBars(ts.slice(-8).map(m => m.revenueNTD), ts.slice(-8).map(m => m.month.slice(5)), v => 'NT$' + (+v).toFixed(0) + 'B'))); }
    }
    const mac = S.phase === 'done' ? loadOnce('macro', 'api/macro') : null;
    if (mac && mac !== 'loading' && Array.isArray(mac) && mac.length) extra.push(blk('x-macro', 'Macro', 'FRED', `<div class="xkp">${mac.slice(0, 4).map(m => `<div><b>${esc(String(m.last != null ? (+m.last).toFixed(m.unit === '%' || Math.abs(m.last) < 100 ? 2 : 0) : '–'))}${m.unit === '%' ? '%' : ''}</b><span>${esc(shortTxt(m.label, 3))}${m.change != null ? ` <em class="${m.change < 0 ? 'neg' : 'pos'}">${sgn(m.change, 2)}</em>` : ''}</span></div>`).join('')}</div>`));
    if (S.hidden?.pairs) extra.push(blk('x-hidden', 'Hidden links', `${S.hidden.pairs.length} pairs`, S.hidden.pairs.length ? `<div class="xl">${S.hidden.pairs.slice(0, 5).map(p => `<div class="xr"><span>${esc(p.a)} ↔ ${esc(p.b)}</span>${bar(p.r, 1)}<b>${p.r.toFixed(2)}</b></div>`).join('')}</div>` : '<div class="xm">No strongly co-moving pairs without a filing link</div>'));
    if (S.ripple?.length) extra.push(blk('x-ripple', 'Earnings ripple', `when ${esc(rootTicker() || '')} reports`, `<div class="xl">${S.ripple.slice(0, 6).map(r => `<div class="xr"><span>${esc(r.peer)}</span>${bar(r.avgMove, S.ripple[0].avgMove)}<b>${(+r.avgMove).toFixed(1)}%</b></div>`).join('')}</div>`));
    if (W0.watch) extra.push(`<div class="card blk xw"><h4>Watchlist <span>${W0.watch.watching?.length || 0} companies · every ${W0.watch.everyMin || 5} min</span></h4><div class="xm">${W0.watch.lastCheck ? 'last check ' + new Date(W0.watch.lastCheck).toLocaleTimeString() : ''}</div>${(W0.found || []).slice(0, 4).map(f => `<div class="nw"><b>${esc(f.ticker)}</b><i style="background:${f.sentiment === 'negative' ? IMPACT.negative : f.sentiment === 'positive' ? IMPACT.positive : '#71717a'}"></i><span>${esc(f.form)} · ${esc(f.headline)}</span></div>`).join('')}<button class="xt" data-tool="unwatch"><b>Stop watching</b></button></div>`);
    else if (S.phase === 'done' && !isCommodity()) extra.push(`<div class="card blk xw"><h4>Watchlist <span>agents read new filings</span></h4><button class="xt wide" data-tool="watch"><b>Watch every company on this map</b><span>new 8-K, 10-Q, Form 4… read by an agent</span></button></div>`);
    parts.splice(insertAt, 0, ...extra.filter(Boolean));
  }
  function wireSide(side) {
    side.querySelectorAll('[data-stream]').forEach(b => b.onclick = ev => { ev.stopPropagation(); runStream(b.dataset.stream); });
    side.querySelectorAll('[data-tool]').forEach(b => b.onclick = ev => { ev.stopPropagation(); tool(b.dataset.tool); });
    side.querySelectorAll('[data-scn]').forEach(r => { r.onclick = ev => ev.stopPropagation(); r.oninput = ev => { S.scenario = +r.value; r.nextElementSibling.textContent = sgn(S.scenario, 0) + '%'; clearTimeout(r._t); r._t = setTimeout(renderSideNow, 120); }; });
    side.querySelectorAll('.xr[data-node]').forEach(el => el.onclick = ev => { ev.stopPropagation(); const n = S.byId.get(el.dataset.node); if (n) companyModal(n); });
  }
  async function tool(k) {
    const tk = rootTicker();
    if (k === 'note') return exportNote();
    if (k === 'compare') { const b = prompt('Compare ' + (tk || '') + ' with which ticker?', ''); if (b && window.PTViews) PTViews.open({ type: 'compare', a: tk, b: b.trim().toUpperCase() }); return; }
    if (k === 'watch') { const j = await get('api/watch?tickers=' + enc([tk, ...mapTickers(40)].filter(Boolean).join(','))); W0.watch = j; renderSide(); return; }
    if (k === 'unwatch') { await get('api/watch?off=1'); W0.watch = null; W0.found = []; renderSide(); return; }
    if (k === 'hidden') {
      setStatus('Pulling a year of daily prices…', true);
      const tks = [tk, ...mapTickers(28)].filter(Boolean);
      const j = await get('api/correlations?tickers=' + enc(tks.join(',')));
      setStatus('');
      if (j.error) { openModal('Hidden links', keyNote(j)); return; }
      const linked = (a, b) => { const A = S.byTicker.get(a), B = S.byTicker.get(b); return (A && B && (A.links?.has(B) || B.links?.has(A))) || a === tk || b === tk; };
      S.hidden = { show: true, pairs: (j.pairs || []).filter(p => p.r >= 0.6 && !linked(p.a, p.b)).slice(0, 12) };
      renderSide(); return openBlock('x-hidden');
    }
    if (k === 'ripple') {
      setStatus('Lining up earnings days…', true);
      const j = await get(`api/ripple?ticker=${enc(tk)}&peers=${enc(mapTickers(14).join(','))}`);
      setStatus('');
      if (j.error || !Array.isArray(j)) { openModal('Earnings ripple', keyNote(j)); return; }
      S.ripple = j; renderSide(); return openBlock('x-ripple');
    }
    const n = S.root; if (!n) return;
    MODAL_NODE = null;
    if (k === 'insiders' || k === 'holders' || k === 'contracts' || k === 'patents') return companyModal(n, false, k);
  }
  // full-size versions of the blocks
  function openBlock(id) {
    if (!String(id).startsWith('x-')) return false;
    if (id === 'x-rings') { whatifResults(); return true; }
    if (id === 'x-named') { namedModal(); return true; }
    if (id === 'x-changes') { changesModal(); return true; }
    if (id === 'x-earn') { earnModal(); return true; }
    if (id === 'x-hidden') {
      const ps = S.hidden?.pairs || [];
      openModal('Hidden links', `<div class="mx">Pairs on this map whose daily returns moved together over the past year (correlation ≥ 0.6) although neither filing names the other. Dashed amber lines on the map.</div><div class="xl big">${ps.map(p => `<div class="xr"><span>${chip(p.a, { ticker: p.a })} ↔ ${chip(p.b, { ticker: p.b })}</span>${bar(p.r, 1)}<b>${p.r.toFixed(2)}</b></div>`).join('') || '<div class="empty">None found.</div>'}</div><button class="xt" data-tool-m="toggle-hidden">${S.hidden?.show ? 'Hide lines' : 'Show lines'}</button>`, 'Yahoo daily closes · 250 trading days');
      $('#modal [data-tool-m]')?.addEventListener('click', () => { S.hidden.show = !S.hidden.show; closeModal(); });
      return true;
    }
    if (id === 'x-ripple') {
      const rs = S.ripple || [];
      openModal(`Earnings ripple · ${esc(rootTicker() || '')}`, `<div class="mx">Each peer's average move on the trading day after ${esc(rootTicker() || '')} reported (last 8 earnings releases), and how often it moved the same way.</div><div class="xl big">${rs.map(r => `<div class="xr"><span>${chip(r.peer, { ticker: r.peer })}</span>${bar(r.avgMove, rs[0]?.avgMove)}<b>${(+r.avgMove).toFixed(1)}%</b><em class="dim">${r.sameDirectionShare != null ? Math.round(r.sameDirectionShare * (r.sameDirectionShare <= 1 ? 100 : 1)) + '% same way' : ''}</em></div>`).join('')}</div>`, 'Earnings dates from 8-K item 2.02 · prices from Yahoo');
      return true;
    }
    if (id === 'x-prod' || id.startsWith('x-trade') || id === 'x-routes') { commodityModal(); return true; }
    if (id === 'x-ins' || id === 'x-gov' || id === 'x-hold') { MODAL_NODE = null; companyModal(S.root, false, { 'x-ins': 'insiders', 'x-gov': 'contracts', 'x-hold': 'holders' }[id]); return true; }
    if (id === 'x-macro') { macroModal(); return true; }
    if (id === 'x-tsmc') { const ts = D.tsmc; openModal('TSMC monthly revenue', Array.isArray(ts) ? `${miniBars(ts.map(m => m.revenueNTD), ts.map(m => m.month.slice(2)), v => (+v).toFixed(0))}<table class="mt"><tr><th>Month</th><th>Revenue (NT$ B)</th><th>MoM</th><th>YoY</th></tr>${ts.slice().reverse().map(m => `<tr><td>${esc(m.month)}</td><td>${(+m.revenueNTD).toFixed(1)}</td><td>${sgn(m.mom)}%</td><td>${sgn(m.yoy)}%</td></tr>`).join('')}</table>` : keyNote(ts), 'From TSMC’s monthly 6-K filings with the SEC'); return true; }
    return false;
  }
  function namedModal() {
    const L = S.named || [], order = ['customer', 'supplier', 'competitor', 'partner', 'investor', 'other'];
    const cols = order.map(k => { const list = L.filter(f => f.rel === k).sort((a, b) => b.strength - a.strength); return list.length ? `<div class="wc"><h6>${k === 'other' ? 'Passing mentions' : cap1(k) + 's'} <em>${list.length}</em></h6>${list.slice(0, 40).map(f => `<div class="wr" title="${esc(f.q || '')}">${logoUrl(f.name, f.ticker) ? `<img src="${logoUrl(f.name, f.ticker)}" onerror="this.remove()">` : ''}<span>${esc(f.ticker || shortTxt(f.name, 3))}</span>${sevBars(f.strength)}</div><div class="ww">${esc(shortTxt(f.detail, 8))}</div>`).join('')}</div>` : ''; }).join('');
    const c = {}; for (const f of L) c[f.rel] = (c[f.rel] || 0) + 1;
    openModal(`Who names ${esc(S.scan?.short || S.scan?.name || '')}`, `${kpis([['Filings read', L.length], ['Customers', c.customer || 0], ['Suppliers', c.supplier || 0], ['Competitors', c.competitor || 0], ['Partners', (c.partner || 0) + (c.investor || 0)]])}<div class="wcs">${cols}</div>`, 'SEC full-text search · one agent per annual report · hover for the quote');
    $('#modal .mo')?.classList.add('wide');
  }
  function changesModal() {
    const L = S.changes || [];
    const groups = {}; for (const f of L) (groups[f.type] ||= []).push(f);
    const order = ['new_customer', 'lost_customer', 'new_supplier', 'lost_supplier', 'new_risk', 'dropped_risk', 'new_product', 'segment', 'guidance', 'other'];
    const html = order.filter(k => groups[k]).map(k => `<div class="igc"><h6>${ic(/risk/.test(k) ? 'alert' : /customer/.test(k) ? 'users' : /supplier/.test(k) ? 'truck' : 'box')} ${esc(cap1(k.replace('_', ' ')))} <em>${groups[k].length}</em></h6>${groups[k].map(f => `<div class="xch" title="${esc(f.q || '')}"><b>${esc(f.name)}</b><span>${esc(f.detail || '')}</span><em>Item ${esc(f.item || '')}</em></div>`).join('')}</div>`).join('');
    openModal(`What changed · ${esc(S.scan?.ticker || '')}`, `<div class="igg">${html}</div>`, 'New and dropped paragraphs between the last two annual reports, read by agents · hover for the quote');
    $('#modal .mo')?.classList.add('wide');
  }
  function earnModal() {
    const K = S.kpis || {};
    const cards = Object.entries(K).map(([t, list]) => `<div class="igc"><h6>${logoUrl(null, t) ? `<img class="xlg" src="${logoUrl(null, t)}" onerror="this.remove()">` : ''}${esc(t)} <em>${esc(list[0]?.period || '')}</em></h6><div class="xkp">${list.filter(f => f.k === 'kpi').slice(0, 6).map(f => `<div><b>${esc(shortTxt(num(f.value), 2).replace(/…$/, ''))}</b><span>${esc(shortTxt(f.name, 3))}${f.change ? ` <em class="${/^-|−|down|decreas/i.test(f.change) ? 'neg' : 'pos'}">${esc(f.change)}</em>` : ''}</span></div>`).join('')}</div>${list.filter(f => f.k === 'guide').map(f => `<div class="xm">${ic('target')} Outlook · ${esc(f.name)}: <b>${esc(num(f.value))}</b></div>`).join('')}</div>`).join('');
    openModal('Earnings releases', `<div class="igg">${cards || '<div class="empty">No KPIs yet.</div>'}</div>`, 'One agent per company read its latest 8-K exhibit 99.1');
    $('#modal .mo')?.classList.add('wide');
  }
  function commodityModal() {
    const P0 = S.production, T = S.trade || {}, R = S.routes?.chokepoints || [];
    const col = (title, rows, fmt, src) => rows?.length ? `<div class="igc"><h6>${ic('globe')} ${title} <em>${esc(src || '')}</em></h6><div class="xl">${rows.slice(0, 10).map(r => `<div class="xr"><span>${esc(r.country)}</span>${bar(r.share ?? r.valueUSD ?? r.value, rows[0].share ?? rows[0].valueUSD ?? rows[0].value)}<b>${fmt(r)}</b></div>`).join('')}</div></div>` : '';
    const html = `<div class="igg">${col('Production', P0?.rows, r => r.share != null ? (+r.share).toFixed(1) + '%' : fmtN(r.value), `${P0?.source || ''} ${P0?.year || ''}`)}${col('Exporters', T.X?.rows, r => usd(r.valueUSD), `Comtrade ${T.X?.year || ''}`)}${col('Importers', T.M?.rows, r => usd(r.valueUSD), `Comtrade ${T.M?.year || ''}`)}${R.length ? `<div class="igc"><h6>${ic('link')} Chokepoints <em>${R.length}</em></h6>${R.map(cp => `<div class="xch"><b>${esc(cp.name)}</b><span>${esc(routeLine(cp))}</span><em>${esc(routeSource(cp))}</em></div>`).join('')}</div>` : ''}</div>${P0?.needsKey ? keyNote(P0) : ''}`;
    openModal(`${esc(S.scan?.name || '')} · where it comes from and where it goes`, html, 'USGS / FAOSTAT production · UN Comtrade trade flows · EIA and UNCTAD chokepoint shares');
    $('#modal .mo')?.classList.add('wide');
  }
  async function macroModal() {
    const mac = D.macro;
    const eia = await get('api/eia');
    const rows = Array.isArray(mac) ? mac : [];
    openModal('Macro and supply', `<div class="igg">${rows.map(m => `<div class="igc"><h6>${ic('hash')} ${esc(m.label)} <em>${esc(m.date || '')}</em></h6><div class="xbig">${esc(String(m.last != null ? (+m.last).toFixed(2) : '–'))}${m.unit === '%' ? '%' : ''} <span class="${(m.change || 0) < 0 ? 'neg' : 'pos'}">${sgn(m.change, 2)}</span></div>${m.series?.length ? spark(m.series.map(p => p.v)) : ''}</div>`).join('')}<div class="igc"><h6>${ic('box')} EIA inventories</h6>${eia?.needsKey || eia?.error ? keyNote(eia) : (Array.isArray(eia) ? eia : eia?.rows || []).map(r => `<div class="xr"><span>${esc(r.label || r.name)}</span><b>${esc(String(r.last ?? r.value ?? ''))}</b></div>`).join('')}</div></div>`, 'FRED (St. Louis Fed) · EIA');
    $('#modal .mo')?.classList.add('wide');
  }
  const spark = vals => { const v = vals.filter(x => x != null); if (v.length < 3) return ''; const lo = Math.min(...v), hi = Math.max(...v), w = 220, h = 34; return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${v.map((x, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - (x - lo) / (hi - lo || 1) * h).toFixed(1)}`).join(' ')}" fill="none" stroke="${P.accent}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`; };

  // ---------- shock rings (what-if results) ----------
  function ringsMini() {
    const R = S.rings.rings, max = Math.max(...R.map(r => Math.abs(r.usd || 0)), 1);
    return `<div class="xl">${R.map(r => `<div class="xr"><span>Ring ${r.ring} · ${esc(r.label)}</span>${bar(r.usd, max, r.usd < 0)}<b class="${r.usd < 0 ? 'neg' : 'pos'}">${r.usd ? '~' + usd(r.usd) : '–'}</b></div>`).join('')}</div>`;
  }
  function ringsHtml() {
    const Rg = S.rings; if (!Rg?.rings?.length || !S.whatif || Rg.question !== S.whatif.q) return '';
    const R = Rg.rings, max = Math.max(...R.map(r => Math.abs(r.usd || 0)), 1);
    const svg = (() => {
      const w = 220, h = 220, cx = 110, cy = 110;
      return `<svg class="xrings" viewBox="0 0 ${w} ${h}">${[2, 1, 0].filter(i => R.find(r => r.ring === i)).map(i => { const r = R.find(x => x.ring === i), rad = [26, 62, 100][i], neg = (r.usd || 0) < 0, a = Math.min(0.85, 0.18 + Math.abs(r.usd || 0) / max * 0.6); return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${neg ? `rgba(229,72,77,${a.toFixed(2)})` : `rgba(70,167,88,${a.toFixed(2)})`}" stroke="#09090b" stroke-width="2"/>`; }).join('')}<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="xrt">${esc(S.scan?.ticker || '')}</text></svg>`;
    })();
    const rows = R.map(r => `<div class="xrg"><b>Ring ${r.ring}</b><span>${esc(r.label)}</span><em>${r.companies} co · ${r.negative} hit · ${r.positive} gain</em><i class="${(r.usd || 0) < 0 ? 'neg' : 'pos'}">${r.usd ? '~' + usd(r.usd) : '–'}</i></div>`).join('');
    const worst = (Rg.companies || []).filter(c => c.usd).sort((a, b) => a.usd - b.usd).slice(0, 5);
    return `<div class="xringw">${svg}<div class="xrgs"><h6>Shock rings · ~$ revenue at stake over 12 months</h6>${rows}${worst.length ? `<div class="xm">Biggest $ hits: ${worst.map(c => `${esc(c.ticker || c.name)} ~${usd(c.usd)}`).join(' · ')}</div>` : ''}</div></div>`;
  }
  function streamResults(kind) { if (kind === 'investigate') return window.PTInvestigate?.results?.(); ({ named: namedModal, changes: changesModal, earnings: earnModal })[kind]?.(); }

  // ---------- company popup extras ----------
  function companyExtra(n) {
    let html = window.PTInvestigate?.section ? PTInvestigate.section(n) : '';
    if (n.namedBy) html += `<div class="xnb">${ic('link')} <b>Its own ${esc(n.namedBy.form || 'annual report')}</b> names ${esc(S.scan?.ticker || '')} as its ${esc(n.namedBy.rel === 'customer' ? 'supplier' : n.namedBy.rel === 'supplier' ? 'customer' : n.namedBy.rel)} ${sevBars(n.namedBy.strength)}${n.namedBy.q ? `<div class="fq2">“${esc(n.namedBy.q)}” ${n.namedBy.url ? `<a href="${esc(n.namedBy.url)}" target="_blank" rel="noopener">filing ↗</a>` : ''}</div>` : ''}</div>`;
    if (n.chain) html += `<div class="xnb">${ic('truck')} <b>${esc(cap1(n.chain.stage))}</b> in the ${esc((S.scan?.name || '').toLowerCase())} value chain · exposure ${sevBars(n.chain.exposure)} · ${n.chain.sens ? `${n.chain.sens > 0 ? '+' : ''}${n.chain.sens} bps op. margin per +10% price` : 'no margin estimate'}${n.chain.routes?.length ? ` · routes: ${n.chain.routes.map(esc).join(', ')}` : ''}</div>`;
    if (n.route) html += `<div class="xnb">${ic('globe')} <b>Shipping chokepoint</b> · ${esc(routeLine(n.route))}${routeSource(n.route) ? ` <span class="dim">(${esc(routeSource(n.route))})</span>` : ''}<div class="lcs">${S.nodes.filter(o => o.chain?.routes?.some(r => sameRoute(r, n.name))).map(o => chip(o.name, { ticker: o.ticker, node: o })).join('')}</div></div>`;
    const kp = n.ticker && S.kpis?.[n.ticker.toUpperCase()];
    if (kp?.length) html += `<h5>${ic('hash')} Latest earnings · ${esc(kp[0].period || '')}</h5><div class="xkp">${kp.filter(f => f.k === 'kpi').slice(0, 6).map(f => `<div><b>${esc(shortTxt(num(f.value), 2).replace(/…$/, ''))}</b><span>${esc(shortTxt(f.name, 3))}${f.change ? ` <em class="${/^-|−|down/i.test(f.change) ? 'neg' : 'pos'}">${esc(f.change)}</em>` : ''}</span></div>`).join('')}</div>`;
    if (n.route || isCommodity() && n === S.root) return html;
    // public-data tabs, loaded on click
    const tk = n.ticker && n.ticker.toUpperCase();
    const isKr = /samsung|sk ?hynix/i.test(n.name || '');
    const tabs = [tk && ['insiders', 'Insiders'], tk && ['holders', 'Holders'], ['contracts', 'Gov contracts'], ['patents', 'Patents'], isKr && ['dart', 'Korea filings'], (tk === 'TSM' || /tsmc|taiwan semi/i.test(n.name || '')) && ['tsmc', 'Monthly revenue']].filter(Boolean);
    if (!tabs.length) return html;
    const cur = n._xtab;
    html += `<div class="xtabs">${tabs.map(([k, t]) => `<button data-xtab="${k}" class="${cur === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    if (cur) html += `<div class="xtab">${tabBody(n, cur)}</div>`;
    return html;
  }
  function tabBody(n, k) {
    const tk = n.ticker && n.ticker.toUpperCase(), name = n.name;
    const url = { insiders: `api/insiders?ticker=${enc(tk)}`, holders: tk ? `api/holders?ticker=${enc(tk)}` : `api/holders?name=${enc(name)}`, contracts: tk ? `api/contracts?ticker=${enc(tk)}` : `api/contracts?name=${enc(name)}`, patents: `api/patents?assignee=${enc(name)}`, dart: `api/dart?company=${/hynix/i.test(name) ? 'skhynix' : 'samsung'}`, tsmc: 'api/tsmc' }[k];
    const key = k + ':' + (tk || name);
    const j = loadOnce(key, url);
    if (j === 'loading') return `<div class="pf-load">${spin}Loading…</div>`;
    if (!j || j.error || j.needsKey) return keyNote(j);
    if (k === 'insiders') { const s = j.summary || {}; return `${kpis([['Buys 90d', s.buys90 ?? 0], ['Sells 90d', s.sells90 ?? 0], ['Net 90d', usd(s.netValue90)], ['Net 1y', usd(s.netValue365)]])}<table class="mt"><tr><th>Date</th><th>Insider</th><th>Type</th><th>Shares</th><th>Value</th></tr>${(j.rows || []).slice(0, 14).map(r => `<tr><td>${esc(r.date || '')}</td><td>${esc(shortTxt(r.owner || r.name || '', 4))}<span class="dim"> ${esc(shortTxt(r.title || r.relationship || '', 3))}</span></td><td><span class="ip ${r.code === 'P' ? 'positive' : r.code === 'S' ? 'negative' : 'mixed'}">${esc({ P: 'buy', S: 'sell', A: 'award', M: 'exercise', F: 'tax', G: 'gift' }[r.code] || r.code || '')}</span></td><td>${fmtN(r.shares, 0)}</td><td>${usd(r.value)}</td></tr>`).join('')}</table>`; }
    if (k === 'holders') { const H = j.holders || []; const shared = S.nodes.length ? '' : ''; return `<div class="xl big">${H.slice(0, 12).map(h => `<div class="xr"><span>${esc(shortTxt(h.filer, 4))}</span>${bar(h.value, H[0]?.value)}<b>${usd(h.value)}</b></div>`).join('')}</div><div class="xm">13F ${esc(j.quarter || '')} · ${esc(j.issuer || '')}${shared}</div><button class="xt" data-xshared>Holders shared across the map</button><div class="xshared"></div>`; }
    if (k === 'contracts') return `${kpis([['Awarded', usd(j.total)], ['Awards', j.count ?? '–']])}<div class="xl big">${(j.topAgencies || []).slice(0, 6).map(a => `<div class="xr"><span>${esc(a.agency)}</span>${bar(a.amount, j.topAgencies[0].amount)}<b>${usd(a.amount)}</b></div>`).join('')}</div>${(j.top || []).slice(0, 5).map(a => `<div class="xch"><b>${usd(a.amount)}</b><span>${esc(shortTxt(a.description || '', 14))}</span><em>${esc(a.agency || '')} · ${esc(a.date || '')}</em></div>`).join('')}`;
    if (k === 'patents') { const by = j.byYear || {}; const yrs = Object.keys(by).sort(); return `${kpis([['Patents', j.total ?? '–'], ['Since', yrs[0] || '–']])}${yrs.length ? miniBars(yrs.map(y => by[y]), yrs, v => String(v)) : ''}<div class="tg">${(j.topCpc || []).slice(0, 10).map(c => `<span title="${esc(c.title || '')}">${esc(c.code)} · ${esc(shortTxt(c.title || '', 4))} <b>${c.count}</b></span>`).join('')}</div>${S.root && n !== S.root ? `<button class="xt" data-xoverlap>Tech overlap with ${esc(S.scan?.short || S.scan?.ticker || '')}</button><div class="xoverlap"></div>` : ''}`; }
    if (k === 'dart') { const F = j.financials || {}; const rows = F.rows || F.accounts || []; return `${rows.length ? kpis(rows.slice(0, 4).map(r => [esc(r.label || r.name), esc(String(r.value ?? r.current ?? '')), r.yoy != null ? `<span class="dl ${r.yoy >= 0 ? 'up' : 'dn'}">${sgn(r.yoy)}%</span>` : ''])) : ''}${(Array.isArray(j.filings) ? j.filings : j.filings?.rows || []).slice(0, 8).map(f => `<div class="xch"><b>${esc(f.date || '')}</b><span>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title || '')}</a>` : esc(f.title || '')}</span></div>`).join('')}`; }
    if (k === 'tsmc') return Array.isArray(j) ? miniBars(j.slice(-10).map(m => m.revenueNTD), j.slice(-10).map(m => m.month.slice(2)), v => (+v).toFixed(0)) : keyNote(j);
    return '';
  }
  function wireCompany(n) {
    const m = $('#modal'); if (!m) return;
    window.PTInvestigate?.wire?.(n, m);
    m.querySelectorAll('[data-xtab]').forEach(b => b.onclick = () => { n._xtab = n._xtab === b.dataset.xtab ? null : b.dataset.xtab; companyModal(n, true); });
    m.querySelector('[data-xshared]')?.addEventListener('click', async ev => {
      const box = m.querySelector('.xshared'); box.innerHTML = `<div class="pf-load">${spin}Matching holders across the map…</div>`;
      const names = [S.scan?.name, ...S.nodes.filter(o => groupOf(o) && o.ticker).slice(0, 14).map(o => o.name)].filter(Boolean);
      const j = await get('api/sharedholders?names=' + enc(names.join(',')));
      box.innerHTML = j.error || j.needsKey ? keyNote(j) : `<div class="xl big">${(j.holders || j || []).slice(0, 10).map(h => `<div class="xr"><span>${esc(shortTxt(h.filer, 4))}</span><em class="dim">${(h.companies || h.in || []).length} on the map</em><b>${usd(h.value || h.combined)}</b></div>`).join('')}</div>`;
    });
    m.querySelector('[data-xoverlap]')?.addEventListener('click', async () => {
      const box = m.querySelector('.xoverlap'); box.innerHTML = `<div class="pf-load">${spin}Comparing patent classes…</div>`;
      const j = await get(`api/overlap?a=${enc(S.scan?.short || S.scan?.name || '')}&b=${enc(n.name)}`);
      box.innerHTML = j.error || j.needsKey ? keyNote(j) : `${kpis([['Overlap (Jaccard)', j.jaccard != null ? (j.jaccard * 100).toFixed(0) + '%' : '–'], ['Shared classes', (j.shared || []).length]])}<div class="tg">${(j.shared || []).slice(0, 12).map(c => `<span title="${esc(c.title || '')}">${esc(c.code)} <b>${c.a}/${c.b}</b></span>`).join('')}</div>`;
    });
  }

  // ---------- watchlist ----------
  const W0 = { watch: null, found: [] };
  function onWatch(e) {
    if (e.type === 'watch' && e.phase === 'checked' && W0.watch) { W0.watch.lastCheck = e.at; renderSide(); return; }
    if (e.type === 'watch' && e.phase === 'new') { toast(`${e.agent.ticker}: new ${e.filing.form} filed ${e.filing.date}, an agent is reading it`); return; }
    if (e.type === 'finding' && e.f?.k === 'news') { W0.found.unshift({ ...e.f }); const n = e.f.ticker && S.byTicker.get(e.f.ticker); if (n) n.news = e.f; toast(`${e.f.ticker} ${e.f.form}: ${e.f.headline}`); renderSide(); }
  }
  function toast(t) {
    const el = document.createElement('div'); el.className = 'xtoast'; el.textContent = t; document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show')); setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 500); }, 6000);
  }

  // ---------- analyst note: the map plus key stats as a PNG, or a printable page for PDF ----------
  function noteStats() {
    const s = S.scan, pr = S.peers?.[0], cnt = Object.entries(GROUPS).map(([k, G]) => [G.label, S.nodes.filter(n => groupOf(n) === k).length]);
    const lines = [];
    if (pr) lines.push(['Revenue', pr.revenue ? fmtUSD(pr.revenue) : '–'], ['Growth', pctf(pr.growth)], ['Op. margin', pctf(pr.opMargin)]);
    for (const [k, v] of cnt) lines.push([k, String(v)]);
    lines.push(['Agents', String(S.agents.size)], ['Findings', String(S.findings)]);
    const r = rootRisk(); if (r.top) lines.push(['Top customer', Math.round(r.top) + '%']); if (r.country) lines.push(['Exposure', r.country]);
    const top = g => S.nodes.filter(n => groupOf(n) === g).sort((a, b) => (b.mentions || 0) - (a.mentions || 0)).slice(0, 5).map(n => n.ticker || n.name);
    return { title: `${s?.name || ''} ${s && !isCommodity() ? '(' + s.ticker + ')' : ''}`, sub: `${isCommodity() ? 'Value chain' : (s?.filing?.form || '') + ' filed ' + (s?.filing?.date || '')} · ${S.provider || ''}`, lines, tops: Object.keys(GROUPS).map(g => [GROUPS[g].label, top(g)]), whatif: S.whatif ? { q: S.whatif.q, c: S.whatif.results.reduce((m, r) => (m[r.impact] = (m[r.impact] || 0) + 1, m), {}) } : null, reply: (S.botLog || []).filter(e => e.phase === 'reply').pop()?.text || '' };
  }
  function exportNote() {
    const st = noteStats(), W2 = 1600, H2 = 1000, c = document.createElement('canvas'); c.width = W2; c.height = H2;
    const g = c.getContext('2d');
    g.fillStyle = '#09090b'; g.fillRect(0, 0, W2, H2);
    g.fillStyle = '#22c55e'; g.fillRect(0, 0, W2, 4);
    g.fillStyle = '#fafafa'; g.font = '600 30px Geist, sans-serif'; g.fillText(st.title, 40, 62);
    g.fillStyle = '#8b98a0'; g.font = '400 16px Geist, sans-serif'; g.fillText(st.sub + ' · Pocket Terminal · ' + new Date().toISOString().slice(0, 10), 40, 90);
    // the live map, scaled into the left area
    const mw = 1080, mh = 820, sx = cv.width / mw > cv.height / mh ? cv.width / mw : cv.height / mh;
    g.strokeStyle = '#26323a'; g.strokeRect(40, 130, mw, mh);
    g.drawImage(cv, 0, 0, cv.width, cv.height, 40 + (mw - cv.width / sx) / 2, 130 + (mh - cv.height / sx) / 2, cv.width / sx, cv.height / sx);
    // stats column
    let y = 150; const x0 = 1160;
    g.font = '600 13px "Geist Mono", monospace'; g.fillStyle = '#22c55e'; g.fillText('KEY STATS', x0, y); y += 26;
    for (const [k, v] of st.lines) { g.font = '400 15px Geist, sans-serif'; g.fillStyle = '#8b98a0'; g.fillText(k, x0, y); g.font = '500 15px "Geist Mono", monospace'; g.fillStyle = '#eef2f4'; g.textAlign = 'right'; g.fillText(v, W2 - 40, y); g.textAlign = 'left'; y += 24; }
    y += 14;
    for (const [k, list] of st.tops) { if (!list.length) continue; g.font = '600 13px "Geist Mono", monospace'; g.fillStyle = '#22c55e'; g.fillText(k.toUpperCase(), x0, y); y += 20; g.font = '400 14px Geist, sans-serif'; g.fillStyle = '#d4d4d8'; g.fillText(list.join(' · ').slice(0, 52), x0, y); y += 26; }
    if (st.whatif) { y += 6; g.font = '600 13px "Geist Mono", monospace'; g.fillStyle = '#e2a336'; g.fillText('WHAT-IF', x0, y); y += 20; g.font = '400 14px Geist, sans-serif'; g.fillStyle = '#d4d4d8'; g.fillText(st.whatif.q.slice(0, 50), x0, y); y += 20; g.fillText(`${st.whatif.c.negative || 0} hurt · ${st.whatif.c.mixed || 0} mixed · ${st.whatif.c.positive || 0} helped`, x0, y); y += 26; }
    if (st.reply) { g.font = '400 13px Geist, sans-serif'; g.fillStyle = '#a1a1aa'; const words = st.reply.split(' '); let line = ''; for (const w of words) { if (g.measureText(line + w).width > W2 - 40 - x0) { g.fillText(line, x0, y); y += 18; line = ''; } line += w + ' '; } g.fillText(line, x0, y); }
    const url = c.toDataURL('image/png');
    const name = `pocket-terminal-${(S.scan?.ticker || 'map').toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
    openModal('Analyst note', `<img class="xnote" src="${url}"><div class="xnb2"><a class="xt" download="${name}.png" href="${url}"><b>Download PNG</b></a><button class="xt" data-xpdf><b>Print / save as PDF</b></button></div>`, 'The map and its key stats, ready to share');
    $('#modal .mo')?.classList.add('wide');
    $('#modal [data-xpdf]')?.addEventListener('click', () => { const w = open('', '_blank'); if (!w) return; w.document.write(`<!doctype html><title>${name}</title><style>@page{size:landscape;margin:10mm}body{margin:0;background:#09090b}img{width:100%}</style><img src="${url}" onload="setTimeout(()=>print(),150)">`); w.document.close(); });
  }

  // ---------- search rows for commodities, index maps, ETFs, compare and memory ----------
  const TYPE_LABEL = { commodity: 'Commodity', web: 'Index map', etf: 'ETF', compare: 'Compare', memory: 'Memory', wire: 'Live' };
  function suggestRow(t, i, on) {
    const mark = t.type === 'commodity' ? (MARK[t.key] || (t.name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()) : t.type === 'web' ? '▦' : t.type === 'etf' ? '◫' : t.type === 'compare' ? '⇄' : t.type === 'wire' ? '≋' : '◎';
    return `<div class="sg xsg${on ? ' on' : ''}" data-i="${i}"><div class="lg xmark ${t.type}">${esc(mark)}</div><div class="tk">${esc(t.ticker)}</div><div class="nm">${esc(t.name)} <span class="xty">${TYPE_LABEL[t.type] || ''}</span></div><div class="go">${on ? 'open ↵' : ''}</div></div>`;
  }
  function examples() {
    if (isCommodity()) {
      const n = (S.scan?.name || '').toLowerCase();
      const ex = { copper: ['What if Chile copper output falls 10%?', 'What if the Panama Canal closes?', 'What if China stimulus doubles demand?'], crude: ['What if oil hits $120?', 'What if the Strait of Hormuz closes?', 'What if the Red Sea closes?'], lng: ['What if Qatar exports stop?', 'What if Europe bans Russian LNG?', 'What if the Red Sea closes?'] };
      return ex[S.scan?.commodity] || [`What if ${n} prices rise 30%?`, `What if the Red Sea closes?`, `What if China cuts ${n} imports?`];
    }
    return ['What if Taiwan is blockaded?', 'What if hyperscalers cut AI capex 30%?', 'What if the US bans chip exports to China?', 'What if interest rates fall 2 points?'];
  }

  // start screen: a second row of pills for the other modes
  const MODES = [
    { type: 'commodity', key: 'copper', ticker: 'COPPER', name: 'Copper', mark: 'CU' }, { type: 'commodity', key: 'crude', ticker: 'CRUDE', name: 'Crude oil', mark: 'CL' }, { type: 'commodity', key: 'lithium', ticker: 'LITHIUM', name: 'Lithium', mark: 'LI' },
    { type: 'web', ticker: 'SPX', name: 'S&P 500 web', mark: '▦' }, { type: 'etf', ticker: 'SMH', name: 'SMH look-through', mark: '◫' },
    { type: 'wire', ticker: 'WIRE', name: 'News Wire', mark: '≋' }, { type: 'memory', ticker: 'MEMORY', name: 'Shared memory', mark: '◎' },
  ];
  addEventListener('DOMContentLoaded', () => {
    const pills = document.getElementById('pills'); if (!pills || document.getElementById('xpills')) return;
    const row = document.createElement('div'); row.id = 'xpills';
    row.innerHTML = MODES.map((m, i) => `<button data-i="${i}" class="${m.type}"><i>${esc(m.mark)}</i><b>${esc(m.name)}</b></button>`).join('');
    pills.after(row);
    row.querySelectorAll('button').forEach(b => b.onclick = () => choose(MODES[+b.dataset.i]));
  });

  return { STREAMS, WORK, GROUP_WORK, NO_TARGET, spawnText, startStream, runStream, mapFinding, decorate, tileInfo, badges, cardBadges, relabel, drawCommodityCard, commodityTerm, onData, drawRouteTile, afterTiles, sideBlocks, wireSide, openBlock, ringsHtml, streamResults, companyExtra, wireCompany, onWatch, exportNote, suggestRow, examples };
})();
