// News Wire overlay: window.PTWire.open(). Tape (left), sector board (centre), company panel (right), agent waves and "Ask the wire" (bottom).
// Talks to /api/wire/* (SSE at api/wire/events). Also plays back a saved session: ?wire=1&wr=wire-2026-11-20.json
(function () {
  'use strict';
  const UNIVERSE = [
    ['Semiconductors', 'NVDA AMD AVGO TSM INTC MU QCOM ASML AMAT'],
    ['Big Tech', 'AAPL MSFT GOOGL AMZN META NFLX ORCL CRM ADBE'],
    ['AI and software', 'PLTR SNOW NOW CRWD PANW SMCI DELL HPE IBM'],
    ['Autos and industrials', 'TSLA F GM BA CAT GE LMT RTX UPS'],
    ['Banks and finance', 'JPM BAC GS MS WFC C BLK V MA'],
    ['Energy', 'XOM CVX COP OXY SLB EOG MPC VLO HAL'],
    ['Healthcare', 'LLY PFE MRK UNH JNJ ABBV AMGN GILD MRNA'],
    ['Consumer', 'WMT COST HD NKE SBUX MCD TGT KO PG'],
    ['Telecom and media', 'T VZ TMUS CMCSA CHTR DIS WBD ROKU SPOT'],
    ['Crypto and fintech', 'COIN HOOD PYPL MSTR SOFI AFRM XYZ MARA RIOT'],
    ['Materials and utilities', 'FCX NEM LIN NEE DUK SO ALB MP DOW'],
    ['Macro and indexes', 'SPY QQQ IWM DIA GLD USO TLT UUP VXX'],
  ];
  const HALF_LIFE = 2 * 3600e3;
  const EV = {
    earnings: ['Earnings', '<path d="M2 13V7M6 13V3M10 13V8M14 13V5"/>'],
    guidance: ['Guidance', '<path d="M2 12l4-4 3 3 5-6M11 5h3v3"/>'],
    deal: ['Deals', '<path d="M6.5 9.5l3-3M5 8l-1.5 1.5a2.1 2.1 0 003 3L8 11M11 8l1.5-1.5a2.1 2.1 0 00-3-3L8 5"/>'],
    legal: ['Legal', '<path d="M8 2v11M4.5 14h7M3 4.5h10M3 4.5L1.5 9h3zM13 4.5L11.5 9h3z"/>'],
    supply: ['Supply', '<path d="M8 1.5l6 3v7l-6 3-6-3v-7zM2 4.5l6 3 6-3M8 7.5v7"/>'],
    macro: ['Macro', '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.4 2.4 2.4 9.6 0 12M8 2c-2.4 2.4-2.4 9.6 0 12"/>'],
    mgmt: ['People', '<circle cx="8" cy="5" r="2.5"/><path d="M3 14c0-3 2-5 5-5s5 2 5 5"/>'],
    product: ['Product', '<path d="M8 2l1.8 4.2L14 8l-4.2 1.8L8 14l-1.8-4.2L2 8l4.2-1.8z"/>'],
    other: ['Other', '<circle cx="8" cy="8" r="2"/>'],
  };
  const FILTERS = [['all', 'All'], ['earnings', 'Earnings'], ['guidance', 'Guidance'], ['deal', 'Deals'], ['legal', 'Legal'], ['supply', 'Supply'], ['macro', 'Macro']];
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = ms => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); } catch { return ''; } };
  const fmtDay = ms => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)); } catch { return ''; } };
  const secs = ms => (ms == null ? '–' : (ms / 1000 < 10 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + 's');
  const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const evIcon = ev => `<span class="wr-ev" title="${esc((EV[ev] || EV.other)[0])}"><svg viewBox="0 0 16 16">${(EV[ev] || EV.other)[1]}</svg></span>`;
  const SECTOR_OF = new Map();
  for (const [name, list] of UNIVERSE) for (const t of list.split(' ')) SECTOR_OF.set(t, name);

  let S = null, root = null, es = null, timers = [], boardQueued = false, playback = null;
  const params = new URLSearchParams(location.search);

  function fresh() {
    return { stories: new Map(), order: [], tiles: new Map(), agents: new Map(), agentOrder: [], names: {}, status: null, filter: 'all', mag: 1, facts: false, sel: null, tickerSel: null, clock: 0, replay: false, date: null, gpu: [], desk: null, summary: null, pending: 0, ans: null, nb: new Map(), spark: new Map(), tmpl: false, local: { in: [], lat: [], batches: [], hits: {} } };
  }

  // ------------------------------------------------------------ DOM
  function build() {
    root = document.createElement('div');
    root.id = 'wr';
    root.innerHTML = `
      <div class="wr-top">
        <div class="wr-brand"><i class="wr-sq off" id="wr-sq"></i><b>News Wire</b><span class="wr-mode idle" id="wr-mode">IDLE</span></div>
        <div class="wr-feeds" id="wr-feeds"></div>
        <div class="wr-met"><b id="m-spm">0</b><span>Stories / min</span></div>
        <div class="wr-met"><b id="m-back">0</b><span>Backlog</span></div>
        <div class="wr-met g"><b id="m-lat">–</b><span>Fetch to score</span></div>
        <div class="wr-met wide"><b id="m-qg">–</b><span>Queue + generation</span></div>
        <div class="wr-met"><b id="m-tps">–</b><span>Tokens / s</span></div>
        <div class="wr-met wide"><b id="m-hit">–</b><span id="m-hit-l">Hit rate, mag 2+</span></div>
        <div class="wr-model"><div id="wr-model">–</div><span id="wr-count"></span></div>
        <div class="wr-ctl" id="wr-ctl"></div>
        <button class="wr-x" id="wr-close" title="Close (Esc)">×</button>
      </div>
      <div class="wr-bar" id="wr-bar"></div>
      <div class="wr-main">
        <div class="wr-col"><div class="wr-h">Tape <b id="wr-tcount"></b></div><div class="wr-tape" id="wr-tape"></div></div>
        <div class="wr-col"><div class="wr-h">Board <b id="wr-clock"></b></div><div class="wr-board" id="wr-board"></div></div>
        <div class="wr-col"><div class="wr-h">Company</div><div class="wr-co" id="wr-co"></div></div>
      </div>
      <div class="wr-foot">
        <div class="wr-waves" id="wr-waves"></div>
        <div class="wr-ask"><div class="wr-ans ph" id="wr-ans">Ask the wire about what has been scored: which names did the news hit, and why.</div>
          <div class="wr-in"><span class="tg">Ask the wire</span><input id="wr-q" autocomplete="off" spellcheck="false" placeholder="What hit semis today?"><button class="wr-btn sm" id="wr-go">Ask</button></div></div>
      </div>`;
    document.body.appendChild(root);
    $('#wr-close').onclick = close;
    $('#wr-go').onclick = ask;
    $('#wr-q').addEventListener('keydown', e => { if (e.key === 'Enter') ask(); e.stopPropagation(); });
    $('#wr-q').addEventListener('keyup', e => e.stopPropagation());
    $('#wr-tape').addEventListener('click', onTapeClick);
    $('#wr-board').addEventListener('click', e => { const t = e.target.closest('.wr-tile'); if (t) selectTicker(t.dataset.t); });
    $('#wr-co').addEventListener('click', onCoClick);
    $('#wr-ans').addEventListener('click', e => { const c = e.target.closest('[data-t]'); if (c) selectTicker(c.dataset.t); });
    root.addEventListener('keydown', e => e.stopPropagation());
    document.addEventListener('keydown', e => { if (!root || !root.classList.contains('on')) return; if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (!root.contains(e.target)) e.stopPropagation(); }, true);
    renderBar();
    renderFeeds(null);
    buildBoard();
  }

  function renderBar() {
    const b = $('#wr-bar');
    b.innerHTML = FILTERS.map(([k, l]) => `<button class="wr-f ${S.filter === k ? 'on' : ''}" data-f="${k}">${k !== 'all' ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${EV[k][1]}</svg>` : ''}${l}</button>`).join('')
      + `<span class="wr-sep"></span><span class="wr-lbl">Magnitude</span>` + [1, 2, 3].map(m => `<button class="wr-f ${S.mag === m ? 'on' : ''}" data-m="${m}">${m === 3 ? '3' : m + '+'}</button>`).join('')
      + `<span class="wr-sep"></span><button class="wr-f ${S.facts ? 'on' : ''}" data-facts="1">Facts only</button>`
      + `<div class="wr-right" id="wr-right"></div>`;
    b.querySelectorAll('[data-f]').forEach(x => x.onclick = () => { S.filter = x.dataset.f; renderBar(); refilter(); });
    b.querySelectorAll('[data-m]').forEach(x => x.onclick = () => { S.mag = +x.dataset.m; renderBar(); refilter(); });
    b.querySelector('[data-facts]').onclick = () => { S.facts = !S.facts; renderBar(); refilter(); };
    renderRight();
  }

  function renderRight() {
    const r = $('#wr-right'); if (!r) return;
    const st = S.status || {}, parts = [];
    if (S.summary) parts.push(`<span>Replay done · <b>${S.summary.stories}</b> stories · <b>${S.summary.relevant}</b> relevant</span>`);
    else if (st.replay && st.replay.total) parts.push(`<span>Replay <b>${st.replay.done}</b> / ${st.replay.total}</span><div class="wr-prog"><i style="width:${Math.min(100, 100 * st.replay.done / st.replay.total)}%"></i></div>`);
    if (st.phase === 'preparing') parts.push(`<span>${esc(st.msg || 'Preparing')}</span>`);
    const g = st.gpu;
    if (g && g.n) parts.push(`<div class="wr-vs" title="Same batches, same prompts: ${esc(g.label)}"><em>Cerebras</em><span class="c">${secs(st.medLatMs)} / ${st.backlog} behind</span><em>GPU</em><span class="g">${secs(g.medLatMs)} / ${g.backlog} behind</span></div>`);
    r.innerHTML = parts.join('');
  }

  function renderFeeds(st) {
    const el = $('#wr-feeds'); if (!el) return;
    const list = st && st.feeds && st.feeds.length ? st.feeds : ['SEC', 'GN', 'YF', 'CNBC', 'PRN', 'INV', 'SA', 'FED'].map(b => ({ badge: b, ok: null, name: b }));
    if (st && S.replay) { // a replay reads SEC and Google News history
      el.innerHTML = [['SEC', 'SEC daily index'], ['GN', 'Google News']].map(([b, n]) => `<div class="wr-feed ok" title="${n}"><i></i>${b}</div>`).join('') + ['YF', 'CNBC'].map(b => `<div class="wr-feed"><i></i>${b}</div>`).join('');
      return;
    }
    el.innerHTML = list.map(f => `<div class="wr-feed ${f.ok === true ? 'ok' : f.ok === false ? 'bad' : ''}" title="${esc(f.name + (f.err ? ': ' + f.err : f.n ? ` · ${f.n} items` : ''))}"><i></i>${esc(f.badge)}</div>`).join('');
  }

  function buildBoard() {
    const b = $('#wr-board');
    const known = new Set(); const html = [];
    for (const [name, list] of UNIVERSE) {
      html.push(`<div class="wr-sec" data-sec="${esc(name)}"><h5>${esc(name)}<span data-cnt></span></h5><div class="wr-tiles">${list.split(' ').map(t => { known.add(t); return tileHtml(t); }).join('')}</div></div>`);
    }
    html.push(`<div class="wr-sec" data-sec="Other movers" style="display:none"><h5>Other movers<span data-cnt></span></h5><div class="wr-tiles" id="wr-other"></div></div>`);
    b.innerHTML = html.join('');
  }
  const tileHtml = t => `<div class="wr-tile" data-t="${esc(t)}" title="${esc(t)}"><b>${esc(t)}</b><span><i></i><em></em></span></div>`;

  // ------------------------------------------------------------ state from events
  function onEvent(e) {
    if (!S) return;
    switch (e.type) {
      case 'wire_status':
        if (e.phase === 'starting') { reset(e); }
        S.status = e; if (e.mode === 'replay') { S.replay = true; S.date = e.date; } else if (e.mode) S.replay = false;
        renderTop(); break;
      case 'wire_item': addItem(e); break;
      case 'wire_score': addScore(e); break;
      case 'wire_ripple': addRipple(e); break;
      case 'wire_price': addPrice(e); break;
      case 'spawn': for (const a of e.agents || []) { S.agents.set(a.id, { id: a.id, label: e.kind === 'ripple' ? `${e.label}` : a.label, kind: e.kind, t0: Date.now(), state: 'wait' }); S.agentOrder.push(a.id); } renderWaves(); break;
      case 'first': { const a = S.agents.get(e.agent); if (a) { a.state = 'live'; a.tfirst = Date.now(); renderWaves(); } break; }
      case 'done': { const a = S.agents.get(e.agent); if (a) { Object.assign(a, { state: e.error ? 'err' : 'done', queuedMs: e.queuedMs, genMs: e.genMs, tps: e.tps, tokens: e.tokens, findings: e.findings }); if (a.kind === 'wire' && !e.error) S.local.batches.push({ q: e.queuedMs, g: e.genMs, tps: e.tps }); renderWaves(); } break; }
      case 'wire_desk': S.desk = e; renderWaves(); break;
      case 'wire_summary': S.summary = e; renderRight(); break;
      case 'wire_gpu': S.gpu.push(e); break;
    }
  }

  function reset(e) {
    const keepSel = null; S = Object.assign(fresh(), { filter: S.filter, mag: S.mag, facts: S.facts });
    $('#wr-tape').innerHTML = ''; $('#wr-co').innerHTML = ''; buildBoard(); renderWaves(); renderBar();
  }

  function addItem(e) {
    const s = e.s;
    if (e.update) { const o = S.stories.get(s.id); if (o) { o.srcs = s.srcs; o.srcList = s.srcList; paintRow(o); } return; }
    const st = Object.assign({ touches: [], prices: {}, arrived: performance.now(), score: null, ripple: null }, s);
    S.stories.set(st.id, st); S.order.push(st.id);
    S.local.in.push(Date.now());
    S.clock = Math.max(S.clock, st.pub);
    S.pending++;
    const row = document.createElement('div');
    row.className = 'wr-row new un'; row.dataset.id = st.id;
    $('#wr-tape').prepend(row);
    paintRow(st);
    const rows = $('#wr-tape').children; while (rows.length > 400) rows[rows.length - 1].remove();
    applyRowFilter(st);
    scheduleBoard(); renderTop();
  }

  function addScore(e) {
    const s = S.stories.get(e.id); if (!s) return;
    if (!s.score) S.pending = Math.max(0, S.pending - 1);
    s.score = { rel: e.rel, f: e.f, ev: e.ev, c: e.c, imp: e.imp || [], lat: e.lat, batch: e.batch };
    S.local.lat.push(e.lat);
    s.touches = s.touches.filter(x => x.ripple);
    for (const x of s.score.imp) { S.names[x.t] = x.name || S.names[x.t]; s.touches.push({ t: x.t, d: x.d, m: x.m, fact: !!e.f, ripple: false }); }
    const row = rowOf(s.id); if (row) { row.classList.remove('un'); paintRow(s); applyRowFilter(s); }
    for (const x of s.score.imp) pulse(x.t);
    scheduleBoard(); if (S.tickerSel && s.score.imp.some(x => x.t === S.tickerSel)) renderCo();
  }

  function addRipple(e) {
    const s = S.stories.get(e.id); if (!s) return;
    s.ripple = e.imp;
    s.touches = s.touches.filter(x => !x.ripple);
    for (const x of s.score ? s.score.imp.map(i => ({ t: i.t, d: i.d, m: i.m, fact: !!s.score.f, ripple: false })) : []) s.touches.push(x);
    for (const x of e.imp) { S.names[x.t] = x.name || S.names[x.t]; s.touches.push({ t: x.t, d: x.d, m: x.m, fact: true, ripple: true, via: x.via, r: x.r }); pulse(x.t); }
    paintRow(s); scheduleBoard(); if (S.tickerSel) renderCo();
  }

  function addPrice(e) {
    const s = S.stories.get(e.id); if (!s) return;
    s.prices[e.t] = e;
    if (e.final && e.hit != null) { const h = (S.local.hits.m0 ||= { n: 0, h: 0 }); h.n++; if (e.hit) h.h++; if (e.m >= 2) { const k = (S.local.hits.m2 ||= { n: 0, h: 0 }); k.n++; if (e.hit) k.h++; } }
    paintRow(s); if (S.tickerSel === e.t) renderCo(); renderTop();
  }

  // ------------------------------------------------------------ tape rows
  const rowOf = id => $(`.wr-row[data-id="${CSS.escape(id)}"]`);
  function chip(x, ripple, opinion) {
    const cls = opinion ? 'o' : x.d > 0 ? 'u' : 'd';
    return `<span class="wr-chip ${cls}${ripple ? ' rp' : ''}" data-t="${esc(x.t)}" title="${esc(x.r || '')}">$${esc(x.t)} ${x.d > 0 ? '▲' : '▼'}${x.m}</span>`;
  }
  function paintRow(s) {
    const row = rowOf(s.id); if (!row) return;
    const sc = s.score, opinion = sc && !sc.f;
    row.classList.toggle('op', !!opinion);
    let ln = '', rs = '';
    if (!sc) ln = `<span class="wr-ev"><span class="wr-spin"></span></span><span class="wr-tag">${s.items ? 'reading the filing, then scoring' : 'scoring'}</span>`;
    else {
      ln = evIcon(sc.ev) + sc.imp.slice(0, 3).map(x => chip(x, false, opinion)).join('') + (sc.imp.length > 3 ? `<span class="wr-tag">+${sc.imp.length - 3}</span>` : '');
      if (opinion) ln += '<span class="wr-tag op">opinion</span>';
      if (s.ripple && s.ripple.length) ln += `<span class="wr-tag" title="${esc(s.ripple.map(x => x.t).join(', '))}">↳ ${s.ripple.length} ripple</span>`;
      const px = Object.values(s.prices).filter(p => !p.closed && p.r60 != null);
      if (px[0] && !opinion) ln += `<span class="wr-mk ${px[0].hit ? 'wr-up' : 'wr-dn'}" title="${(px[0].r60 * 100).toFixed(2)}% after 60 min">${px[0].hit ? '✓' : '✗'}</span>`;
      rs = sc.imp[0] ? esc(sc.imp[0].r) : '';
    }
    if (s.srcs > 1) ln += `<span class="wr-tag">${s.srcs} sources</span>`;
    const lat = sc ? secs(sc.lat) : '';
    row.innerHTML = `<div class="tm">${fmtTime(s.pub)}</div><div><div class="hd"><span class="wr-badge ${s.badge === 'SEC' ? 'sec' : ''}">${esc(s.badge)}</span> <a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.by || '')}">${esc(s.title)}</a></div><div class="ln">${ln}</div>${rs ? `<div class="rs">${rs}</div>` : ''}</div><div class="sc" data-lat>${sc ? lat : '…'}</div>`;
  }
  function rowPasses(s) {
    const sc = s.score;
    if (!sc) return S.filter === 'all' && S.mag <= 1 && !S.facts;
    if (!sc.rel) return false;
    if (S.filter !== 'all' && sc.ev !== S.filter) return false;
    if (S.facts && !sc.f) return false;
    if (Math.max(...sc.imp.map(x => x.m)) < S.mag) return false;
    return true;
  }
  function applyRowFilter(s) { const row = rowOf(s.id); if (row) row.style.display = rowPasses(s) ? '' : 'none'; }
  function refilter() { for (const s of S.stories.values()) applyRowFilter(s); scheduleBoard(); }
  function onTapeClick(e) {
    const c = e.target.closest('.wr-chip'); if (c) { selectTicker(c.dataset.t); return; }
    if (e.target.closest('a')) return;
    const row = e.target.closest('.wr-row'); if (!row) return;
    const s = S.stories.get(row.dataset.id); const t = s?.score?.imp?.[0]?.t || s?.tk;
    if (t) selectTicker(t, s.id);
  }

  // ------------------------------------------------------------ board
  function tileState(t) {
    const tc = S.tiles.get(t); if (!tc) return null;
    let net = 0, ripNet = 0, n = 0, via = null, last = 0;
    for (const id of tc.ids) {
      const s = S.stories.get(id); if (!s || !s.score) continue;
      if (S.filter !== 'all' && s.score.ev !== S.filter) continue;
      if (S.facts && !s.score.f) continue;
      if (Math.max(...s.score.imp.map(x => x.m)) < S.mag) continue;
      const w = Math.pow(0.5, Math.max(0, S.clock - s.pub) / HALF_LIFE);
      for (const x of s.touches) {
        if (x.t !== t || !x.fact) continue;
        const v = x.d * x.m * w * (x.ripple ? 0.5 : 1);
        if (x.ripple) { ripNet += v; via = via || x.via; } else net += v;
        n++; last = Math.max(last, s.pub);
      }
    }
    return { net: net + ripNet, direct: net, rip: ripNet, n, via: Math.abs(net) < 0.05 ? via : null };
  }
  function rebuildTiles() {
    S.tiles = new Map();
    for (const s of S.stories.values()) for (const x of s.touches || []) { let tc = S.tiles.get(x.t); if (!tc) { tc = { ids: new Set() }; S.tiles.set(x.t, tc); } tc.ids.add(s.id); }
  }
  function scheduleBoard() { if (boardQueued) return; boardQueued = true; requestAnimationFrame(() => { boardQueued = false; paintBoard(); }); }
  function paintBoard() {
    if (!root || !root.classList.contains('on')) return;
    rebuildTiles();
    const board = $('#wr-board'), other = $('#wr-other');
    for (const t of S.tiles.keys()) if (!SECTOR_OF.has(t) && !board.querySelector(`.wr-tile[data-t="${CSS.escape(t)}"]`)) { other.insertAdjacentHTML('beforeend', tileHtml(t)); other.parentElement.style.display = ''; }
    const counts = new Map();
    // other movers: hottest first, only the ones still coloured
    const oth = [...other.children].map(el => ({ el, st: tileState(el.dataset.t) })).sort((a, b) => Math.abs(b.st?.net || 0) - Math.abs(a.st?.net || 0));
    oth.forEach(({ el, st }, i) => { el.style.display = st && st.n && Math.abs(st.net) >= 0.04 && i < 30 ? '' : 'none'; other.appendChild(el); });
    board.querySelectorAll('.wr-tile').forEach(el => {
      if (el.style.display === 'none') return;
      const t = el.dataset.t, st = tileState(t);
      const sec = el.closest('.wr-sec').dataset.sec;
      const hot = st && st.n && Math.abs(st.net) >= 0.04;
      if (hot) counts.set(sec, (counts.get(sec) || 0) + 1);
      el.classList.toggle('hot', !!hot);
      el.classList.toggle('rip', !!(hot && Math.abs(st.direct) < 0.05));
      el.classList.toggle('sel', t === S.tickerSel);
      const [nameEl, spanEl] = [el.querySelector('b'), el.querySelector('span')];
      if (!hot) { el.style.background = ''; spanEl.innerHTML = '<i></i><em></em>'; el.title = S.names[t] ? `${t} · ${S.names[t]}` : t; return; }
      const k = Math.min(1, Math.abs(st.net) / 3), rip = Math.abs(st.direct) < 0.05;
      const a = (0.14 + 0.62 * k) * (rip ? 0.55 : 1);
      el.style.background = st.net > 0 ? `rgba(34,197,94,${a.toFixed(3)})` : `rgba(239,68,68,${a.toFixed(3)})`;
      el.style.borderColor = '';
      spanEl.innerHTML = rip && st.via ? `<span class="via">via ${esc(st.via)}</span><em>${st.net > 0 ? '▲' : '▼'}</em>` : `<i>${st.net > 0 ? '▲' : '▼'} ${Math.abs(st.net) >= 10 ? Math.abs(st.net).toFixed(0) : Math.abs(st.net).toFixed(1)}</i><em>${st.n}</em>`;
      el.title = `${t}${S.names[t] ? ' · ' + S.names[t] : ''}: net ${st.net > 0 ? '+' : ''}${st.net.toFixed(2)} from ${st.n} touch${st.n === 1 ? '' : 'es'}`;
    });
    board.querySelectorAll('.wr-sec').forEach(sec => { const c = counts.get(sec.dataset.sec) || 0; const el = sec.querySelector('[data-cnt]'); el.textContent = c ? `${c} moving` : ''; el.className = c ? 'hot' : ''; });
    $('#wr-clock').textContent = S.clock ? `${fmtDay(S.clock)} · ${fmtTime(S.clock)} ET` : '';
  }
  function pulse(t) {
    const el = $(`.wr-tile[data-t="${CSS.escape(t)}"]`); if (!el) { scheduleBoard(); return; }
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
  }

  // ------------------------------------------------------------ company panel
  function selectTicker(t, storyId) {
    S.tickerSel = t; S.sel = storyId || null;
    document.querySelectorAll('#wr .wr-row.sel').forEach(r => r.classList.remove('sel'));
    if (storyId) rowOf(storyId)?.classList.add('sel');
    renderCo(); scheduleBoard(); loadSpark(t); loadNb(t);
  }
  function loadSpark(t) {
    if (S.spark.has(t) && S.spark.get(t)) return;
    S.spark.set(t, null);
    fetch(`api/wire/price?ticker=${encodeURIComponent(t)}${S.replay && S.date ? '&date=' + S.date : ''}`).then(r => r.json()).then(j => { S.spark.set(t, j); if (S.tickerSel === t) renderCo(); }).catch(() => S.spark.set(t, { t: [], c: [] }));
  }
  function loadNb(t) {
    if (S.nb.has(t)) return;
    S.nb.set(t, []);
    fetch(`api/wire/neighbours?ticker=${encodeURIComponent(t)}`).then(r => r.json()).then(j => { S.nb.set(t, j.list || []); if (S.tickerSel === t) renderCo(); }).catch(() => {});
  }
  function sparkSvg(t, touches) {
    const sp = S.spark.get(t);
    if (!sp) return '<div class="wr-note"><span class="wr-spin"></span> loading prices</div>';
    if (!sp.t || sp.t.length < 4) return '<div class="wr-note">No price bars for this window (market closed or no data).</div>';
    const W = 320, H = 84, p = 4, xs = sp.t, ys = sp.c, mn = Math.min(...ys), mx = Math.max(...ys), span = mx - mn || 1;
    const X = ms => p + (W - 2 * p) * (ms - xs[0]) / ((xs.at(-1) - xs[0]) || 1), Y = v => H - 8 - (H - 18) * (v - mn) / span;
    const up = ys.at(-1) >= ys[0];
    const pts = xs.map((x, i) => `${X(x).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');
    const marks = touches.filter(x => x.pub >= xs[0] && x.pub <= xs.at(-1)).map(x => { const i = xs.findIndex(v => v >= x.pub), py = Y(ys[Math.max(0, i)]); return `<line x1="${X(x.pub).toFixed(1)}" x2="${X(x.pub).toFixed(1)}" y1="6" y2="${H - 4}" stroke="${x.d > 0 ? '#22c55e' : '#ef4444'}" stroke-opacity=".55" stroke-width="1" stroke-dasharray="2 3"/><rect x="${(X(x.pub) - 3).toFixed(1)}" y="${(py - 3).toFixed(1)}" width="6" height="6" fill="${x.d > 0 ? '#22c55e' : '#ef4444'}"/>`; }).join('');
    const ch = (ys.at(-1) / ys[0] - 1) * 100;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${up ? '#22c55e' : '#ef4444'}" stroke-width="1.4" stroke-linejoin="round"/>${marks}</svg><div class="lg"><span>${fmtTime(xs[0])} ET</span><span class="${ch >= 0 ? 'wr-up' : 'wr-dn'}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}% over window</span><span>${fmtTime(xs.at(-1))} ET</span></div>`;
  }
  function renderCo() {
    const el = $('#wr-co'); const t = S.tickerSel;
    if (!t) { el.innerHTML = '<div class="wr-empty">Pick a company on the board or a chip in the tape to see its stories, reasons, price and neighbours.</div>'; return; }
    rebuildTiles();
    const st = tileState(t) || { net: 0, n: 0 };
    const tc = S.tiles.get(t);
    const list = tc ? [...tc.ids].map(id => S.stories.get(id)).filter(s => s && s.score).sort((a, b) => b.pub - a.pub) : [];
    const touches = list.map(s => { const x = s.touches.find(q => q.t === t); return x ? { pub: s.pub, d: x.d } : null; }).filter(Boolean);
    const name = S.names[t] || '';
    const netC = st.net > 0.04 ? 'wr-up' : st.net < -0.04 ? 'wr-dn' : '';
    const nb = (S.nb.get(t) || []).map(n => ({ ...n, st: tileState(n.t) })).slice(0, 8);
    el.innerHTML = `<div class="ph"><div class="t"><h3>${esc(t)}</h3><span class="nm">${esc(name)}</span></div>
      <div class="net"><b class="${netC}">${st.net > 0.04 ? '▲ +' : st.net < -0.04 ? '▼ ' : ''}${Math.abs(st.net) < 0.04 ? '0.0' : st.net.toFixed(1)}</b><small>net score, facts only<br>half-life ~2 h · ${st.n} touch${st.n === 1 ? '' : 'es'}</small></div>
      <button class="wr-btn go" data-map="${esc(t)}">Map it</button></div>
      <div class="wr-sub"><span>Price · 5 min bars</span></div><div class="wr-spark">${sparkSvg(t, touches)}</div>
      <div class="wr-sub"><span>Stories</span><span>${list.length}</span></div>
      ${list.length ? list.slice(0, 14).map(s => storyCard(s, t)).join('') : '<div class="wr-note">No stories on the wire for this company yet.</div>'}
      <div class="wr-sub"><span>Neighbours · from saved maps</span></div>
      ${nb.length ? `<div class="wr-nb">${nb.map(n => { const v = n.st && n.st.n ? n.st.net : 0; return `<div class="wr-nbt" data-t="${esc(n.t)}"><span>${esc(n.t)}<br><small>${esc(n.rel)}</small></span><span class="${v > 0.04 ? 'wr-up' : v < -0.04 ? 'wr-dn' : ''}">${Math.abs(v) < 0.04 ? '–' : (v > 0 ? '▲ ' : '▼ ') + Math.abs(v).toFixed(1)}</span></div>`; }).join('')}</div>` : '<div class="wr-note">No saved map includes this company yet.</div>'}`;
  }
  function storyCard(s, t) {
    const x = s.touches.find(q => q.t === t) || {}; const sc = s.score;
    const px = s.prices[t]; let pxs = '';
    if (px && !x.ripple) pxs = px.closed ? '<div class="px">market closed, no price check</div>' : px.r60 != null ? `<div class="px"><span class="${px.hit ? 'wr-up' : 'wr-dn'}">${px.hit ? '✓ market agreed' : '✗ market disagreed'}</span> · ${px.r60 >= 0 ? '+' : ''}${(px.r60 * 100).toFixed(2)}% in 60 min${px.rs != null ? ` (SPY ${px.rs >= 0 ? '+' : ''}${(px.rs * 100).toFixed(2)}%)` : ''}</div>` : px.r15 != null ? `<div class="px">${px.r15 >= 0 ? '+' : ''}${(px.r15 * 100).toFixed(2)}% after 15 min</div>` : '';
    const reason = x.ripple ? x.r : (sc.imp.find(q => q.t === t) || {}).r;
    return `<div class="wr-st ${sc.f ? '' : 'op'}"><div class="a"><span>${fmtTime(s.pub)}</span><span class="wr-badge ${s.badge === 'SEC' ? 'sec' : ''}">${esc(s.badge)}</span>${evIcon(sc.ev)}${sc.f ? '' : '<span class="wr-tag op">opinion</span>'}${x.ripple ? `<span class="wr-tag">via ${esc(x.via)}</span>` : ''}<span style="margin-left:auto">${secs(sc.lat)}</span></div>
      <a class="h" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
      <div class="r"><b class="${!sc.f ? '' : x.d > 0 ? 'wr-up' : 'wr-dn'}">${x.d > 0 ? '▲' : '▼'}${x.m || ''}</b>${esc(reason || '')}</div>${pxs}</div>`;
  }
  function onCoClick(e) {
    const m = e.target.closest('[data-map]'); if (m) { const t = m.dataset.map; close(); const nm = S.names[t] || t; if (typeof window.choose === 'function') window.choose({ ticker: t, name: nm }); return; }
    const n = e.target.closest('[data-t]'); if (n) selectTicker(n.dataset.t);
  }

  // ------------------------------------------------------------ top bar, waves
  function localMetrics() {
    const now = Date.now(), L = S.local;
    const bs = L.batches.slice(-12);
    const live = S.status && S.status.running;
    return {
      spm: L.in.filter(x => now - x < 60e3).length, backlog: S.pending, medLatMs: median(L.lat.slice(-60)), medQueueMs: median(bs.map(b => b.q)), medGenMs: median(bs.map(b => b.g)), medTps: median(bs.map(b => b.tps)),
      hits: L.hits.m2 ? { p2: { n: L.hits.m2.n, hit: L.hits.m2.h } } : {}, live,
    };
  }
  function renderTop() {
    const st = S.status || {};
    const srv = Boolean(S.status && S.status.mode && !S.status.local && !playback);
    const m = srv ? { spm: st.spm, backlog: st.backlog, medLatMs: st.medLatMs, medQueueMs: st.medQueueMs, medGenMs: st.medGenMs, medTps: st.medTps, hits: st.hits || {} } : localMetrics();
    const running = srv ? st.running : Boolean(playback);
    const mode = srv ? (st.mode === 'replay' ? 'REPLAY' : 'LIVE') : playback ? 'RECORDING' : 'IDLE';
    $('#wr-mode').textContent = srv && st.phase === 'preparing' ? 'PREPARING' : running ? mode : srv ? (st.phase === 'stopped' ? 'STOPPED' : 'DONE') : mode;
    $('#wr-mode').classList.toggle('idle', !running);
    $('#wr-sq').classList.toggle('off', !running);
    $('#m-spm').textContent = m.spm ?? 0;
    $('#m-back').textContent = m.backlog ?? 0;
    $('#m-lat').innerHTML = m.medLatMs != null ? `${(m.medLatMs / 1000).toFixed(1)}<small>s</small>` : '–';
    $('#m-qg').innerHTML = m.medGenMs != null ? `${((m.medQueueMs || 0) / 1000).toFixed(1)}<small>s</small> + ${(m.medGenMs / 1000).toFixed(1)}<small>s</small>` : '–';
    $('#m-tps').innerHTML = m.medTps ? `${m.medTps}` : '–';
    const h = (m.hits || {}).p2;
    $('#m-hit').innerHTML = h && h.n ? `${Math.round(100 * h.hit / h.n)}<small>% · ${h.hit}/${h.n}</small>` : '–';
    { const [a, ...b] = String(st.model || '–').split(' · '); $('#wr-model').textContent = a; $('#wr-model').title = st.model || ''; $('#wr-count').textContent = b.join(' · '); }
    const c = st.counters;
    $('#wr-tcount').textContent = c ? `${c.in} stories · ${c.relevant} relevant · ${c.noise} filtered${c.dups ? ' · ' + c.dups + ' dup' : ''}` : (S.order.length ? `${S.order.length} stories` : '');
    renderFeeds(S.status ? st : null); renderRight(); renderControls(running, srv);
    if (srv && st.mode === 'replay') S.replay = true;
  }
  function renderControls(running, srv) {
    const el = $('#wr-ctl'); const key = `${running}|${srv}|${S.saved || ''}`;
    if (el.dataset.k === key) return; el.dataset.k = key;
    if (running && !playback) el.innerHTML = '<button class="wr-btn ghost" data-a="stop">Stop</button>';
    else if (playback) el.innerHTML = '<button class="wr-btn ghost" data-a="stopplay">Stop playback</button>';
    else el.innerHTML = `<button class="wr-btn" data-a="live">Start live</button><button class="wr-btn ghost" data-a="replay">Replay Fri 20 Nov</button>`;
    el.onclick = ev => { const a = ev.target.closest('[data-a]')?.dataset.a; if (a) control(a); };
  }
  function renderWaves() {
    const el = $('#wr-waves'); if (!el) return;
    const ids = S.agentOrder.slice(-14).reverse();
    const chips = ids.map(id => {
      const a = S.agents.get(id);
      const m = a.state === 'done' ? `${((a.queuedMs || 0) / 1000).toFixed(1)}s + ${((a.genMs || 0) / 1000).toFixed(1)}s${a.tps ? ' · ' + a.tps + ' tok/s' : ''}` : a.state === 'err' ? 'failed, retrying' : a.state === 'live' ? 'generating' : 'queued';
      return `<div class="wr-w ${a.state === 'live' || a.state === 'wait' ? 'live' : ''} ${a.kind === 'ripple' ? 'rip' : ''} ${a.state === 'err' ? 'err' : ''}">${a.state === 'live' || a.state === 'wait' ? '<span class="wr-spin"></span>' : '<i></i>'}<span>${esc(a.label)}</span><span class="m">${m}</span></div>`;
    });
    const d = S.desk;
    el.innerHTML = `<span class="lb">Agent waves</span>${chips.join('') || '<span class="wr-tag">no batches yet</span>'}${d ? `<div class="wr-desk" title="${esc(d.text)}"><b>Desk note</b>${esc(d.text.replace(/\s*\n+\s*/g, ' · '))}</div>` : ''}`;
  }

  // ------------------------------------------------------------ ask the wire
  async function ask() {
    const inp = $('#wr-q'), q = inp.value.trim(); if (!q) return;
    const ans = $('#wr-ans'); ans.className = 'wr-ans'; ans.innerHTML = `<span class="q">${esc(q)}</span><span class="a"><span class="wr-spin"></span></span>`;
    inp.value = '';
    try {
      const r = await fetch('api/wire/ask?q=' + encodeURIComponent(q)); const j = await r.json();
      if (j.error) throw new Error(j.error);
      let text = esc(j.answer).replace(/\b([A-Z]{2,5})\b/g, (m, t) => (j.tickers || []).includes(t) ? `<span class="wr-chip o" data-t="${t}">${t}</span>` : m);
      ans.innerHTML = `<span class="q">${esc(q)}</span><span class="a">${text}</span><span class="ms">${((j.ms || 0) / 1000).toFixed(1)}s</span>`;
    } catch (e) { ans.innerHTML = `<span class="q">${esc(q)}</span><span class="a wr-dn">${esc(e.message || e)}</span>`; }
  }

  // ------------------------------------------------------------ control and connection
  async function control(a) {
    if (a === 'stop') { await fetch('api/wire/stop').catch(() => {}); return; }
    if (a === 'stopplay') { stopPlayback(); return; }
    const q = a === 'replay' ? 'replay=2026-11-20' : '';
    const g = new URLSearchParams(location.search).get('gpu') === '1' ? (q ? '&' : '') + 'gpu=1' : '';
    const r = await fetch('api/wire/start?' + q + g).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { const a = $('#wr-ans'); a.className = 'wr-ans'; a.innerHTML = `<span class="a wr-dn">${esc(j.error || 'Could not start the wire')}</span>`; }
  }
  function connect() {
    if (es) return;
    es = new EventSource('api/wire/events');
    es.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch (err) { console.error(err); } };
    es.onerror = () => { /* the browser reconnects; the backlog replays into a fresh state below */ };
    es.onopen = () => { if (S.order.length) { const keep = { filter: S.filter, mag: S.mag, facts: S.facts }; S = Object.assign(fresh(), keep); $('#wr-tape').innerHTML = ''; $('#wr-co').innerHTML = ''; buildBoard(); renderWaves(); } };
  }
  async function idleCheck() {
    const st = await fetch('api/wire/status').then(r => r.json()).catch(() => null);
    S.saved = '';
    if (st && st.phase && st.phase !== 'idle') return;
    showIdle();
  }
  function showIdle() {
    if (S.order.length || playback) return;
    $('#wr-tape').innerHTML = '<div class="wr-empty">The wire is idle.<br>Start it to watch stories land.</div>';
    fetch('api/wire/saved').then(r => r.json()).then(list => {
      if (S.order.length || playback) return;
      const b = $('#wr-board'); if (b.querySelector('.wr-idle')) return;
      const gpuOn = new URLSearchParams(location.search).get('gpu') === '1';
      b.insertAdjacentHTML('afterbegin', `<div class="wr-idle"><h4>News Wire is idle</h4><p>Live mode polls SEC 8-Ks, Google News, Yahoo, CNBC and more. The weekend replay reads Friday 20 Nov 2026 from the SEC daily index and Google News, scores it in time order and checks every call against 1-minute prices.</p><div class="rw"><button class="wr-btn" data-i="live">Start live</button><button class="wr-btn" data-i="replay">Replay Fri 20 Nov</button>${list.length ? `<button class="wr-btn ghost" data-i="play">Play recording ${esc(list[0].replace('.json', '').replace('wire-', ''))}</button>` : ''}</div></div>`);
      b.querySelector('.wr-idle').onclick = ev => { const a = ev.target.closest('[data-i]')?.dataset.i; if (!a) return; b.querySelector('.wr-idle').remove(); if (a === 'play') play(list[0]); else control(a); };
    }).catch(() => {});
  }

  // ------------------------------------------------------------ playback of a saved file (no server session)
  async function play(file, speed = 1) {
    stopPlayback(true);
    let run; try { run = await (await fetch('runs/' + file)).json(); } catch { return; }
    S = fresh(); S.replay = true; S.date = run.date; $('#wr-tape').innerHTML = ''; buildBoard(); renderWaves();
    S.status = { model: String(run.provider || 'recorded'), mode: 'replay', date: run.date, running: false, local: true };
    playback = { timers: [], file };
    const ev = (run.events || []).filter(e => e.type !== 'wire_status');
    let at = 0, prev = ev[0] ? ev[0].t : 0;
    const t0 = ev[0] ? ev[0].t : 0;
    for (const e of ev) { at += Math.min(Math.max(0, e.t - prev), 900) / speed; prev = e.t; const when = at; playback.timers.push(setTimeout(() => onEvent(e), when)); }
    playback.timers.push(setTimeout(() => { playback = null; S.summary = run.summary ? Object.assign({ stories: run.summary.stories, relevant: run.summary.relevant }, run.summary) : null; renderTop(); }, at + 300));
    renderTop();
  }
  function stopPlayback(silent) { if (playback) { playback.timers.forEach(clearTimeout); playback = null; } if (!silent) renderTop(); }

  // ------------------------------------------------------------ open / close
  function open() {
    if (!root) { S = fresh(); build(); }
    root.classList.add('on');
    renderCo(); renderWaves();
    if (!timers.length) {
      timers.push(setInterval(() => { if (!root.classList.contains('on')) return; if (S.replay && !S.status?.running) { /* clock is data driven */ } else if (!S.replay) S.clock = Date.now(); scheduleBoard(); document.querySelectorAll('#wr .wr-row.un [data-lat]').forEach(el => { const s = S.stories.get(el.closest('.wr-row').dataset.id); if (s) el.textContent = secs(performance.now() - s.arrived); }); renderTop(); }, 1000));
    }
    const wr = params.get('wr');
    if (wr && !playback && !S.order.length) { play(wr, +(params.get('speed') || 1)); return; }
    connect();
    scheduleBoard();
    if (!S.order.length) setTimeout(idleCheck, 500);
  }
  function close() { if (root) root.classList.remove('on'); }

  window.PTWire = { open, close };
  if (params.get('wire') === '1' || params.get('wr')) { const go = () => open(); if (document.readyState === 'complete') go(); else addEventListener('load', go); }
})();
