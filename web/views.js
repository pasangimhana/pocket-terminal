/* Pocket Terminal · views.js
   Three full-screen views that open above the app: an index / sector / ETF web, a side-by-side compare and the
   shared-memory graph. Each has its own canvas or DOM; closing removes it and leaves the app untouched.
   Entry point: window.PTViews.open(item), item being a /api/search result of type web | etf | compare | memory.
   Hooks the app may set: PTViews.onPick(ticker, info) when a company is clicked (the view closes first),
   PTViews.onClose() after the overlay closes. Everything lives in this IIFE; every class name starts with pv-. */
(() => {
  'use strict';

  // ---------- helpers ----------
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dprOf = () => Math.min(2, window.devicePixelRatio || 1);
  const cap = s => String(s || '').replace(/^./, c => c.toUpperCase());
  const pct = v => v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(Math.abs(v) >= 10 || Number.isInteger(+v) ? 0 : 1) + '%';
  const pcls = v => v < 0 ? 'pv-neg' : v > 0 ? 'pv-pos' : '';
  const cleanName = s => {
    let t = String(s || '').replace(/\s*\(class [a-z]\)/gi, '').trim();
    for (let i = 0; i < 2; i++) t = t.replace(/[,\s]+(corp|corporation|inc|incorporated|co|company|ltd|limited|plc|n\.?v\.?|s\.?a\.?|ag|se)\.?$/i, '').trim();
    return t;
  };
  const SHORT = { 'Information Technology': 'Info Tech', 'Communication Services': 'Comm Services', 'Consumer Discretionary': 'Discretionary', 'Consumer Staples': 'Staples' };
  const shortSector = s => SHORT[s] || s;

  // relationship families and colours (same palette as the app's graph)
  // commodity runs add value-chain roles (copper's producers, refiners, shippers, consumers, hedgers)
  const FAM = { supplier: 'supplier', customer: 'customer', competitor: 'competitor', partner: 'partner', investee: 'partner', investor: 'partner', acquired: 'partner', acquirer: 'partner', producer: 'chain', refiner: 'chain', shipper: 'chain', consumer: 'chain', hedger: 'chain', commodity: 'chain' };
  const fam = r => FAM[r] || 'other';
  const FLIP = { supplier: 'customer', customer: 'supplier', competitor: 'competitor', partner: 'partner', investee: 'investor', investor: 'investee', acquired: 'acquirer', acquirer: 'acquired', producer: 'commodity', refiner: 'commodity', shipper: 'commodity', consumer: 'commodity', hedger: 'commodity' };
  const RC = { supplier: '#c8a97e', customer: '#8fb996', competitor: '#c98a8a', partner: '#a39bc9', chain: '#7fb3b0', other: '#a1a1aa' };
  const RL = { supplier: 'Suppliers', customer: 'Customers', competitor: 'Competitors', partner: 'Partners & stakes', chain: 'Value chain', other: 'Other' };
  const R1 = { supplier: 'supplier', customer: 'customer', competitor: 'rival', partner: 'partner', investee: 'stake', investor: 'investor', acquired: 'acquired', acquirer: 'acquirer', chain: 'value chain', producer: 'producer', refiner: 'refiner', shipper: 'shipper', consumer: 'consumer', hedger: 'hedger', commodity: 'commodity', other: 'other' };
  const PRI = ['supplier', 'customer', 'competitor', 'partner', 'investee', 'investor', 'acquired', 'acquirer', 'other'];
  const FAMS = ['supplier', 'customer', 'competitor', 'partner'];
  const IMP = { negative: [229, 72, 77], mixed: [226, 163, 54], positive: [70, 167, 88] };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${(+a).toFixed(3)})`;
  const mixRGB = (base, c, t) => `rgb(${base.map((b, i) => Math.round(b + (c[i] - b) * t)).join(',')})`;
  const TILE = [13, 15, 17];

  const I = {
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
    bolt: '<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z"/>',
    alert: '<path d="M8 2l6.5 11.5h-13Z"/><path d="M8 6.5v3M8 11.5v.1"/>',
    check: '<path d="M3 8.5l3 3 7-7"/>',
    eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
    reset: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/>',
    layers: '<path d="M8 2 1.5 5.5 8 9l6.5-3.5Z"/><path d="M1.5 8.5 8 12l6.5-3.5"/>',
    link: '<path d="M6.5 9.5l3-3"/><path d="M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"/>',
    target: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".8"/>',
    grid: '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
    hub: '<circle cx="8" cy="8" r="2"/><circle cx="3" cy="3.5" r="1.3"/><circle cx="13" cy="4" r="1.3"/><circle cx="12.5" cy="12.5" r="1.3"/><circle cx="3.5" cy="12" r="1.3"/><path d="M6.6 6.7 4 4.5M9.5 7 12 5M9.4 9.4l2.2 2.2M6.5 9.3l-2.1 1.8"/>',
    map: '<path d="M1.5 4 5.5 2l5 2 4-2v10l-4 2-5-2-4 2Z"/><path d="M5.5 2v10M10.5 4v10"/>',
  };
  const icon = (k, s = 14) => `<svg class="pv-ic" viewBox="0 0 16 16" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${I[k] || ''}</svg>`;
  const sev = n => `<span class="pv-sev">${[1, 2, 3].map(i => `<i class="${i <= (n || 1) ? 'on' : ''}"></i>`).join('')}</span>`;

  // ---------- logos: canvas images with a redraw callback; DOM logos fall back to a letter ----------
  const LOGO = new Map();
  function logo(tk, cb) {
    if (!tk) return null;
    tk = String(tk).toUpperCase();
    let L = LOGO.get(tk);
    if (!L) {
      L = { img: null, dead: false, cbs: new Set() }; LOGO.set(tk, L);
      const im = new Image();
      im.onload = () => { L.img = im; for (const f of L.cbs) f(); L.cbs.clear(); };
      im.onerror = () => { L.dead = true; L.cbs.clear(); };
      im.src = 'logos/' + encodeURIComponent(tk) + '.png';
    }
    if (!L.img && !L.dead && cb) L.cbs.add(cb);
    return L.img;
  }
  const letter = (name, tk) => h(String(name || tk || '?').trim()[0]?.toUpperCase() || '?');
  const logoHtml = (tk, name, cls = '') => tk && !LOGO.get(String(tk).toUpperCase())?.dead
    ? `<span class="pv-lg ${cls}" data-l="${letter(name, tk)}" data-tk="${h(String(tk).toUpperCase())}"><img src="logos/${h(encodeURIComponent(String(tk).toUpperCase()))}.png" alt=""></span>`
    : `<span class="pv-lg l ${cls}">${letter(name, tk)}</span>`;

  // ---------- data (window.PTViews._fixture.{web,compare,memory,correlations} overrides the API in tests) ----------
  async function getJSON(url, key, arg) {
    const F = window.PTViews && window.PTViews._fixture;
    if (F && F[key] != null) {
      const v = typeof F[key] === 'function' ? await F[key](arg) : F[key];
      if (!v || v.error) throw Object.assign(new Error((v && v.error) || 'no data'), { status: (v && v.status) || 422 });
      return JSON.parse(JSON.stringify(v));
    }
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && j.error)) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { status: r.status });
    return j;
  }
  const tidyErr = e => String(e && e.message || e || '').replace(/(['"]?)\/[^\s'"]*\/([^/\s'"]+)\1/g, '$1$2$1').slice(0, 220);

  // ---------- overlay shell ----------
  let ROOT = null, VIEW = null, TIP = null;
  function shell(code, title) {
    close(true);
    ROOT = document.createElement('div');
    ROOT.className = 'pv-root';
    ROOT.tabIndex = -1;
    ROOT.innerHTML = `<canvas class="pv-stars"></canvas>
      <header class="pv-head"><span class="pv-code">${h(code)}</span><div class="pv-ttl"><div class="pv-t">${h(title)}</div><div class="pv-s"></div></div>
      <div class="pv-kpis"></div><button class="pv-x" type="button" aria-label="Close">${icon('x', 13)}<kbd>Esc</kbd></button></header>
      <main class="pv-body"></main><div class="pv-tip"></div>`;
    document.body.appendChild(ROOT);
    TIP = ROOT.querySelector('.pv-tip');
    ROOT.querySelector('.pv-x').onclick = () => close();
    ROOT.addEventListener('keydown', ev => ev.stopPropagation()); // keys typed here never reach the app's shortcuts
    ROOT.addEventListener('error', ev => { // broken DOM logo -> letter tile
      const im = ev.target; if (!im || im.tagName !== 'IMG') return;
      const lg = im.closest('.pv-lg'); if (!lg) return;
      lg.classList.add('l'); im.remove(); lg.textContent = lg.dataset.l || '?';
      const tk = lg.dataset.tk; if (tk) { const L = LOGO.get(tk) || { img: null, dead: false, cbs: new Set() }; L.dead = true; LOGO.set(tk, L); } // never request it again
    }, true);
    addEventListener('keydown', onKeyCapture, true);
    addEventListener('resize', onResize);
    stars();
    ROOT.focus({ preventScroll: true });
    return ROOT.querySelector('.pv-body');
  }
  function setHead({ title, sub, kpis } = {}) {
    if (!ROOT) return;
    if (title != null) ROOT.querySelector('.pv-t').textContent = title;
    if (sub != null) ROOT.querySelector('.pv-s').textContent = sub;
    if (kpis) ROOT.querySelector('.pv-kpis').innerHTML = kpis.map(([v, l]) => `<div class="pv-k"><b>${h(v)}</b><span>${h(l)}</span></div>`).join('');
  }
  function close(silent) {
    if (!ROOT) return;
    try { VIEW && VIEW.destroy && VIEW.destroy(); } catch (e) { console.error(e); }
    VIEW = null;
    removeEventListener('keydown', onKeyCapture, true);
    removeEventListener('resize', onResize);
    ROOT.remove(); ROOT = null; TIP = null;
    if (!silent) try { window.PTViews.onClose && window.PTViews.onClose(); } catch (e) { console.error(e); }
  }
  function onKeyCapture(ev) {
    if (!ROOT) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (VIEW && VIEW.onEsc && VIEW.onEsc()) return; close(); return; }
    if (!ROOT.contains(ev.target)) ev.stopPropagation(); // app shortcuts stay quiet while a view is open
  }
  let resizeT = 0;
  function onResize() { clearTimeout(resizeT); resizeT = setTimeout(() => { if (!ROOT) return; stars(); VIEW && VIEW.resize && VIEW.resize(); }, 60); }
  function stars() {
    const c = ROOT.querySelector('.pv-stars'), d = dprOf(), w = innerWidth, hh = innerHeight;
    c.width = w * d; c.height = hh * d;
    const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0);
    x.fillStyle = '#050507'; x.fillRect(0, 0, w, hh);
    let s = 20261122; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 420; i++) { const px = rnd() * w, py = rnd() * hh, z = rnd() ** 2.2; x.fillStyle = `rgba(220,226,240,${(0.1 + 0.5 * z).toFixed(3)})`; const r = 0.5 + z * 1.1; x.fillRect(px, py, r, r); }
  }
  function tipShow(html, x, y) {
    if (!TIP) return;
    TIP.innerHTML = html; TIP.style.display = 'block';
    const r = TIP.getBoundingClientRect();
    let px = x + 16, py = y + 16;
    if (px + r.width > innerWidth - 10) px = x - r.width - 16;
    if (py + r.height > innerHeight - 10) py = innerHeight - r.height - 10;
    TIP.style.transform = `translate(${Math.round(Math.max(8, px))}px, ${Math.round(Math.max(8, py))}px)`;
  }
  const tipHide = () => { if (TIP) TIP.style.display = 'none'; };
  function stateHtml(kind, msg, opts = {}) {
    if (kind === 'loading') return `<div class="pv-load"><span class="pv-spin"></span>${h(msg)}</div>`;
    return `<div class="pv-err"><div class="pv-err-ic">${icon('alert', 16)}</div><div class="pv-err-t">${h(msg)}</div>${opts.sub ? `<div class="pv-err-s">${h(opts.sub)}</div>` : ''}${opts.retry ? `<button class="pv-btn ghost" type="button" data-act="retry">${icon('reset')}Retry</button>` : ''}${opts.code ? `<div class="pv-err-c">${h(opts.code)}</div>` : ''}</div>`;
  }
  // a company was clicked: hand it to the app (which maps it) and get out of the way
  function pickCompany(ticker, info) {
    const f = window.PTViews.onPick;
    if (!ticker || typeof f !== 'function') return false;
    close(); try { f(String(ticker).toUpperCase(), info || {}); } catch (e) { console.error(e); }
    return true;
  }
  const canPick = () => typeof window.PTViews.onPick === 'function';

  // ---------- canvas plumbing: on-demand redraw + pan/zoom camera ----------
  function scheduler(fn) { let raf = 0; const req = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(); }); }; req.cancel = () => { cancelAnimationFrame(raf); raf = 0; }; return req; }
  function camera(cv, redraw, { min = 0.3, max = 8, bound = null } = {}) {
    const cam = { k: 1, tx: 0, ty: 0, min, max, dragged: false, dragging: false, anim: 0 };
    const fix = () => { if (bound) bound(cam); };
    cam.zoomAt = (sx, sy, f) => { const k = clamp(cam.k * f, cam.min, cam.max); cam.tx = sx - (sx - cam.tx) * k / cam.k; cam.ty = sy - (sy - cam.ty) * k / cam.k; cam.k = k; fix(); redraw(); };
    cam.to = (t, ms = 520) => {
      cancelAnimationFrame(cam.anim);
      const s = { k: cam.k, tx: cam.tx, ty: cam.ty }, t0 = performance.now();
      const step = now => { const p = Math.min(1, (now - t0) / ms), e = 1 - (1 - p) ** 3; cam.k = s.k + (t.k - s.k) * e; cam.tx = s.tx + (t.tx - s.tx) * e; cam.ty = s.ty + (t.ty - s.ty) * e; redraw(); if (p < 1) cam.anim = requestAnimationFrame(step); };
      cam.anim = requestAnimationFrame(step);
    };
    cv.addEventListener('wheel', ev => { ev.preventDefault(); const r = cv.getBoundingClientRect(); cam.zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018))); }, { passive: false });
    let drag = null;
    cv.addEventListener('pointerdown', ev => { if (ev.button !== 0) return; drag = { x: ev.clientX, y: ev.clientY, tx: cam.tx, ty: cam.ty, id: ev.pointerId }; cam.dragged = false; });
    cv.addEventListener('pointermove', ev => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!cam.dragged && Math.abs(dx) + Math.abs(dy) > 4) { cam.dragged = cam.dragging = true; try { cv.setPointerCapture(drag.id); } catch { } cv.style.cursor = 'grabbing'; }
      if (cam.dragging) { cam.tx = drag.tx + dx; cam.ty = drag.ty + dy; fix(); redraw(); }
    });
    const up = () => { drag = null; if (cam.dragging) { cam.dragging = false; cv.style.cursor = ''; } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    return cam;
  }
  function sizeCanvas(cv) {
    const r = cv.parentElement.getBoundingClientRect(), d = dprOf();
    cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d));
    return { w: r.width, h: r.height, d };
  }
  function fitText(ctx, t, max) {
    t = String(t); if (max <= 4) return '';
    if (ctx.measureText(t).width <= max) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t.length > 1 ? t + '…' : '';
  }
  const setLS = (ctx, v) => { if ('letterSpacing' in ctx) ctx.letterSpacing = v; };
  function wrapText(ctx, t, max, lines) {
    const words = String(t || '').split(/\s+/), out = []; let cur = '';
    for (const wd of words) {
      const next = cur ? cur + ' ' + wd : wd;
      if (ctx.measureText(next).width <= max || !cur) { cur = next; continue; }
      out.push(cur); cur = wd;
      if (out.length === lines) break;
    }
    if (out.length < lines && cur) out.push(cur);
    else if (out.length === lines && cur) out[lines - 1] = fitText(ctx, out[lines - 1] + ' ' + cur, max);
    return out.slice(0, lines).map(l => fitText(ctx, l, max));
  }

  // ======================================================================
  // 1. Index / sector / ETF web
  // ======================================================================
  const EXAMPLES = ['Taiwan is blockaded', 'oil spikes to $150', 'rates rise 2 points', 'the US bans chip exports to China'];
  const LINK_STYLE = { supply: { c: '#c8a97e', a: 0.5, dash: [] }, partner: { c: '#a39bc9', a: 0.3, dash: [] }, rival: { c: '#8b8b94', a: 0.22, dash: [3, 3] } };

  function webView(item, body) {
    const id = String(item.ticker || item.id || 'SPX').toUpperCase();
    const isEtf = item.type === 'etf';
    const title0 = isEtf ? `${id} ETF` : String(item.name || id).replace(/\s+(web|map)$/i, '');
    setHead({ title: title0, sub: isEtf ? 'ETF look-through' : 'Index web' });
    body.classList.add('pv-web');
    body.innerHTML = `<section class="pv-stage"><canvas></canvas><div class="pv-tools"></div><div class="pv-state"></div></section><aside class="pv-side"></aside><footer class="pv-ask"></footer>`;
    const stage = body.querySelector('.pv-stage'), cv = stage.querySelector('canvas'), ctx = cv.getContext('2d');
    const tools = stage.querySelector('.pv-tools'), stateEl = stage.querySelector('.pv-state');
    const side = body.querySelector('.pv-side'), ask = body.querySelector('.pv-ask');

    let alive = true, D = null, M = [], GROUPS = [], LINKS = [], weighted = false;
    const byT = new Map();
    let vw = 0, vh = 0, dpr = 1;
    const SHOW = { supply: true, rival: true, partner: true, hidden: false };
    let HID = null, hidState = '';       // correlated pairs with no filing link
    let hover = null, focus = null;      // focus = { set:Set<member>, links:Set<link>, spoke?:member }
    let SH = null, es = null, uiTimer = 0, loopOn = false, toastT = 0;
    const redraw = scheduler(() => alive && draw());
    const cam = camera(cv, redraw, { min: 1, max: 8, bound: c => { if (c.k <= 1.0005) { c.k = 1; c.tx = 0; c.ty = 0; return; } const m = 80; c.tx = clamp(c.tx, vw - vw * c.k - m, m); c.ty = clamp(c.ty, vh - vh * c.k - m, m); } });

    // ---- load ----
    async function load() {
      stateEl.innerHTML = stateHtml('loading', `Loading ${title0} members…`);
      try { D = await getJSON('api/web?id=' + encodeURIComponent(id), 'web', id); }
      catch (e) {
        if (!alive) return;
        stateEl.innerHTML = stateHtml('error', `${title0} members are not available yet`, { sub: e.status === 422 ? 'The member list for this index or ETF could not be loaded. Try again in a moment.' : 'The server did not answer.', retry: true, code: tidyErr(e) });
        stateEl.querySelector('[data-act=retry]').onclick = load;
        setHead({ sub: 'Members unavailable', kpis: [] });
        body.classList.add('pv-failed');
        return;
      }
      if (!alive) return;
      body.classList.remove('pv-failed');
      build();
      if (!M.length) { stateEl.innerHTML = stateHtml('error', `No members came back for ${id}`, { retry: true }); stateEl.querySelector('[data-act=retry]').onclick = load; return; }
      stateEl.innerHTML = '';
      head(); resize(); buildAsk(); renderTools(); renderSide();
    }

    function build() {
      M = []; byT.clear();
      for (const [i, m] of (D.members || []).entries()) {
        const t = String(m.ticker || '').toUpperCase(); if (!t || byT.has(t)) continue;
        const o = { i, ticker: t, name: cleanName(m.name) || t, sector: m.sector || null, sub: m.subIndustry || null, weight: m.weight != null ? +m.weight : null, mapped: !!m.mapped, links: [], deg: 0, x: 0, y: 0, w: 0, h: 0 };
        M.push(o); byT.set(t, o);
      }
      // links: "b is a's <rel>"; supply keeps a direction (supplier -> customer), the rest are deduped as pairs
      const seen = new Map();
      for (const l of D.links || []) {
        const A = byT.get(String(l.a).toUpperCase()), B = byT.get(String(l.b).toUpperCase());
        if (!A || !B || A === B) continue;
        let kind = 'partner', from = A, to = B;
        if (l.rel === 'supplier') { kind = 'supply'; from = B; to = A; } else if (l.rel === 'customer') kind = 'supply';
        else if (l.rel === 'competitor') kind = 'rival';
        const key = kind === 'supply' ? `s|${from.ticker}|${to.ticker}` : `${kind}|${[A.ticker, B.ticker].sort().join('|')}`;
        const cur = seen.get(key);
        if (cur) { cur.n += l.n || 1; continue; }
        seen.set(key, { kind, a: from, b: to, n: l.n || 1 });
      }
      LINKS = [...seen.values()];
      for (const L of LINKS) { L.a.links.push(L); L.b.links.push(L); }
      for (const m of M) m.deg = new Set(m.links.map(L => (L.a === m ? L.b : L.a))).size;
      weighted = M.filter(m => m.weight > 0).length >= M.length * 0.6;
      // groups by sector; inside a sector, busiest sub-industries first so related companies sit together
      const g = new Map();
      for (const m of M) { const k = m.sector || (isEtf ? 'Holdings' : 'Members'); if (!g.has(k)) g.set(k, []); g.get(k).push(m); }
      GROUPS = [...g.entries()].map(([name, items]) => {
        if (weighted) items.sort((a, b) => (b.weight || 0) - (a.weight || 0));
        else {
          const sw = new Map(); for (const m of items) sw.set(m.sub, (sw.get(m.sub) || 0) + m.deg * 3 + 1);
          items.sort((a, b) => (sw.get(b.sub) - sw.get(a.sub)) || String(a.sub).localeCompare(String(b.sub)) || b.deg - a.deg || a.ticker.localeCompare(b.ticker));
        }
        return { name, items, x: 0, y: 0, w: 0, hh: 0 };
      }).sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
    }

    function head() {
      const t = String(D.title || '').replace(/\s*\(\[object Object\]\)/g, '').replace(/^the\s+/i, '').trim();
      const title = isEtf ? `${id} ETF` : cap(t) || title0;
      const kp = [[M.length, isEtf ? 'holdings' : 'members']];
      if (GROUPS.length > 1) kp.push([GROUPS.length, 'sectors']);
      else if (weighted) { const top = [...M].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 10).reduce((s, m) => s + (m.weight || 0), 0); kp.push([top.toFixed(0) + '%', 'top 10 weight']); }
      kp.push([LINKS.length, 'filing links'], [M.filter(m => m.mapped).length, 'mapped']);
      setHead({ title, sub: `${isEtf ? `Look-through of ${M.length} holdings` : `${M.length} members by sector`} · links between members from ${D.memoryRuns ?? 'all'} saved runs`, kpis: kp });
    }

    // ---- layout: uniform sector grid (masonry columns), or a treemap when weights are known ----
    const PAD = 18, TOP = 52, GAP = 3, SG = 16;
    function resize() {
      const s = sizeCanvas(cv); vw = s.w; vh = s.h; dpr = s.d;
      if (!M.length) return;
      cam.k = 1; cam.tx = 0; cam.ty = 0;
      const W = vw - PAD * 2, H = vh - TOP - PAD;
      if (weighted && window.d3) treemap(W, H); else grid(W, H);
      redraw();
    }
    function grid(W, H) {
      const HEAD = GROUPS.length > 1 ? 22 : 0, AR = M.length > 200 ? 0.68 : 0.62;
      const pack = (cols, tw, place) => {
        const colW = (W - SG * (cols - 1)) / cols, per = Math.max(1, Math.floor((colW + GAP) / (tw + GAP)));
        const tW = (colW - GAP * (per - 1)) / per, th = tw * AR, colY = new Array(cols).fill(0), out = [];
        for (const g of GROUPS) {
          const rows = Math.ceil(g.items.length / per), gh = HEAD + rows * (th + GAP) - GAP;
          let c = 0; for (let i = 1; i < cols; i++) if (colY[i] < colY[c] - 0.5) c = i;
          if (place) out.push({ g, x: c * (colW + SG), y: colY[c], per, tW, th, colW });
          colY[c] += gh + SG;
        }
        const used = Math.max(...colY) - SG;
        return place ? { out, used } : used <= H;
      };
      let best = null;
      for (let cols = 1; cols <= Math.min(7, GROUPS.length); cols++) {
        let lo = 12, hi = 240;
        for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (pack(cols, mid)) lo = mid; else hi = mid; }
        if (!best || lo > best.tw + 0.5) best = { cols, tw: lo };
      }
      const { out, used } = pack(best.cols, best.tw, true);
      const oy = TOP + Math.max(0, (H - used) / 2) * 0.5;
      for (const p of out) {
        Object.assign(p.g, { x: PAD + p.x, y: oy + p.y, w: p.colW, hh: HEAD });
        p.g.items.forEach((m, j) => { m.x = PAD + p.x + (j % p.per) * (p.tW + GAP); m.y = oy + p.y + HEAD + Math.floor(j / p.per) * (p.th + GAP); m.w = p.tW; m.h = p.th; });
      }
    }
    function treemap(W, H) {
      const HEAD = GROUPS.length > 1 ? 22 : 0;
      // tiny holdings and one-member groups still get a readable tile (and room for their sector header)
      const tot = M.reduce((s, m) => s + (m.weight || 0), 0) || 1, floor = tot * 0.012, gfloor = tot * 0.035;
      const root = d3.hierarchy({ children: GROUPS.map(g => { const gs = g.items.reduce((s, m) => s + Math.max(floor, m.weight || 0), 0); const lift = gs < gfloor ? gfloor / gs : 1; return { g, children: g.items.map(m => ({ m, v: Math.max(floor, m.weight || 0) * lift })) }; }) })
        .sum(d => d.m ? d.v : 0).sort((a, b) => b.value - a.value);
      d3.treemap().size([W, H]).round(false).paddingInner(d => d.depth === 0 ? SG : GAP).paddingTop(d => d.depth === 1 ? HEAD : 0)(root);
      for (const n of root.descendants()) {
        if (n.depth === 1) Object.assign(n.data.g, { x: PAD + n.x0, y: TOP + n.y0, w: n.x1 - n.x0, hh: HEAD });
        if (n.data.m) Object.assign(n.data.m, { x: PAD + n.x0, y: TOP + n.y0, w: n.x1 - n.x0, h: n.y1 - n.y0 });
      }
    }

    // ---- drawing (screen space, so text and hairlines stay crisp at any zoom) ----
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vw, vh);
      if (!M.length) return;
      const now = performance.now(), k = cam.k;
      for (const m of M) {
        m.sx = Math.round(m.x * k + cam.tx); m.sy = Math.round(m.y * k + cam.ty);
        m.sw = Math.round((m.x + m.w) * k + cam.tx) - m.sx; m.sh = Math.round((m.y + m.h) * k + cam.ty) - m.sy;
        m.vis = m.sx < vw && m.sy < vh && m.sx + m.sw > 0 && m.sy + m.sh > 0;
      }
      for (const g of GROUPS) if (g.hh) drawHeader(g, g.x * k + cam.tx, g.y * k + cam.ty, g.w * k);
      for (const m of M) if (m.vis) tileBody(m, now);
      drawLinks();
      for (const m of M) if (m.vis) tileText(m);
      if (focus && focus.ring) { const m = focus.ring; ctx.strokeStyle = '#fafafa'; ctx.lineWidth = 1.5; ctx.strokeRect(m.sx - 2.5, m.sy - 2.5, m.sw + 5, m.sh + 5); }
    }
    function drawHeader(g, x, y, w) {
      const cy = y + 8;
      ctx.textBaseline = 'middle';
      ctx.font = '600 10.5px "Geist Mono", monospace';
      const sa = SH && SH.secAvg && SH.secAvg.get(g.name);
      const right = String(g.items.length), pTxt = sa != null ? pct(sa) : '';
      const rw = ctx.measureText(right).width, pw = pTxt ? ctx.measureText(pTxt).width + 10 : 0;
      ctx.font = '500 10.5px Geist, sans-serif'; setLS(ctx, '0.06em');
      const label = fitText(ctx, (w < 170 ? shortSector(g.name) : g.name).toUpperCase(), w - rw - pw - 24);
      ctx.fillStyle = '#a1a1aa'; ctx.textAlign = 'left'; ctx.fillText(label, x, cy);
      const lw = ctx.measureText(label).width; setLS(ctx, '0px');
      ctx.fillStyle = '#1f1f23'; ctx.fillRect(Math.round(x + lw + 8), Math.round(cy), Math.max(0, w - lw - rw - pw - 16), 1);
      ctx.font = '600 10.5px "Geist Mono", monospace'; ctx.textAlign = 'right';
      ctx.fillStyle = '#52525b'; ctx.fillText(right, x + w, cy);
      if (pTxt) { ctx.fillStyle = sa < 0 ? '#ff8a8e' : sa > 0 ? '#7fd18c' : '#a1a1aa'; ctx.fillText(pTxt, x + w - rw - 10, cy); }
    }
    const stOf = m => SH && SH.byT.get(m.ticker);
    const dimmed = m => focus && !focus.set.has(m);
    function tileBody(m, now) {
      const st = stOf(m), f = st && st.f;
      ctx.globalAlpha = dimmed(m) ? 0.22 : 1;
      let fill = 'rgb(13,15,17)', stroke = '#22282d';
      if (f) { const c = IMP[f.impact] || IMP.mixed, a = f.impact === 'mixed' ? 0.3 : [0, 0.3, 0.5, 0.74][f.severity || 1]; fill = mixRGB(TILE, c, a); stroke = rgba(c, 0.85); }
      else if (st && st.state === 'done') { fill = '#0a0b0c'; stroke = '#1a1d20'; }
      else if (m === hover) fill = '#151a1d';
      ctx.fillStyle = fill; ctx.fillRect(m.sx, m.sy, m.sw, m.sh);
      ctx.lineWidth = 1; ctx.strokeStyle = m === hover ? '#a1a1aa' : stroke;
      ctx.strokeRect(m.sx + 0.5, m.sy + 0.5, m.sw - 1, m.sh - 1);
      if (m.mapped) { ctx.fillStyle = '#22c55e'; ctx.fillRect(m.sx, m.sy, m.sw, m.sh > 30 ? 2 : 1.5); }
      if (st && st.state === 'live' && !f && SH.running) {
        const a = 0.35 + 0.4 * Math.sin(now / 150 + m.i * 0.9);
        ctx.strokeStyle = `rgba(228,228,231,${a.toFixed(2)})`; ctx.lineWidth = 1.5; ctx.strokeRect(m.sx + 1.25, m.sy + 1.25, m.sw - 2.5, m.sh - 2.5);
      }
      ctx.globalAlpha = 1;
    }
    function tileText(m) {
      const x = m.sx, y = m.sy, w = m.sw, hh = m.sh;
      if (w < 18 || hh < 11) return;
      const st = stOf(m), f = st && st.f;
      ctx.globalAlpha = dimmed(m) ? 0.3 : 1;
      const tcol = f ? '#fafafa' : st && st.state === 'done' ? '#4b4f54' : (m.deg || m.mapped) ? '#e4e4e7' : '#9ba2a7';
      const sub = f ? pct(f.pct) : weighted && m.weight ? m.weight.toFixed(m.weight >= 10 ? 0 : 1) + '%' : '';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      if (w >= 92 && hh >= 46) { // large: logo, ticker, name, weight / impact, link mix
        const ls = clamp(Math.min(hh - 18, w * 0.28), 18, 30), img = logo(m.ticker, redraw);
        let tx = x + 8;
        if (img) { ctx.fillStyle = '#fafafa'; ctx.fillRect(x + 8, y + 9, ls, ls); ctx.drawImage(img, x + 10, y + 11, ls - 4, ls - 4); tx = x + 8 + ls + 8; }
        // the ticker always wins: the weight / impact label sits top-right only when both fit, else bottom-right
        ctx.font = '600 13px "Geist Mono", monospace';
        const tkw = ctx.measureText(m.ticker).width;
        let rw = 0, subLow = false;
        if (sub) {
          ctx.font = `600 ${f ? 13 : 11.5}px "Geist Mono", monospace`;
          const sw0 = ctx.measureText(sub).width, top = tx + tkw + sw0 + 14 <= x + w;
          if (top) rw = sw0 + 8; else subLow = true;
          ctx.textAlign = 'right'; ctx.fillStyle = f ? '#fafafa' : '#c4c4cc'; ctx.fillText(sub, x + w - 8, top ? y + 17 : y + hh - 11); ctx.textAlign = 'left';
        }
        ctx.font = '600 13px "Geist Mono", monospace'; ctx.fillStyle = tcol; ctx.fillText(fitText(ctx, m.ticker, x + w - tx - 6 - rw), tx, y + 17);
        ctx.font = '400 11px Geist, sans-serif'; ctx.fillStyle = f ? '#e6dede' : '#8b98a0'; ctx.fillText(fitText(ctx, m.name, x + w - tx - 8), tx, y + 32);
        if (hh >= 70) {
          const by = y + hh - 11, iw = w - 16;
          if (f && f.why) { // the agent's one-line reason, wrapped to two lines
            ctx.font = '400 10.5px Geist, sans-serif'; ctx.fillStyle = '#ece4e4';
            const lines = wrapText(ctx, f.why, iw, hh >= 96 ? 2 : 1);
            lines.forEach((ln, i) => ctx.fillText(ln, x + 8, by - 16 - (lines.length - 1 - i) * 13));
          } else if (m.sub && hh >= 84) { ctx.font = '400 10.5px Geist, sans-serif'; ctx.fillStyle = '#5f6a70'; ctx.fillText(fitText(ctx, m.sub, iw), x + 8, by - 16); }
          if (m.links.length) { // mini stacked bar of this member's links: supply / rivals / partners
            const n = { supply: 0, rival: 0, partner: 0 }; for (const L of m.links) n[L.kind]++;
            const bw = Math.min(64, iw * (subLow ? 0.35 : 0.45)), tot = m.links.length; let bx = x + 8;
            for (const kk of ['supply', 'rival', 'partner']) if (n[kk]) { const sw = Math.max(2, bw * n[kk] / tot); ctx.fillStyle = LINK_STYLE[kk].c; ctx.fillRect(bx, by - 1.5, sw - 1, 3); bx += sw; }
            ctx.font = '500 10px "Geist Mono", monospace'; ctx.fillStyle = '#6b7277'; if (!subLow) ctx.fillText(`${m.deg} linked`, x + 8 + bw + 7, by);
          }
        }
      } else if (w >= 58 && hh >= 24) { // medium: small logo + ticker (+ second line)
        const two = hh >= 38 && sub, ls = clamp(two ? 14 : hh - 10, 11, 16), img = logo(m.ticker, redraw);
        let tx = x + 6;
        const ly = two ? y + 6 : y + (hh - ls) / 2;
        if (img) { ctx.fillStyle = '#fafafa'; ctx.fillRect(x + 6, ly, ls, ls); ctx.drawImage(img, x + 7, ly + 1, ls - 2, ls - 2); tx = x + 6 + ls + 5; }
        ctx.font = `600 ${hh >= 30 ? 11 : 10.5}px "Geist Mono", monospace`; ctx.fillStyle = tcol;
        ctx.fillText(fitText(ctx, m.ticker, x + w - tx - 4), tx, two ? ly + ls / 2 : y + hh / 2);
        if (two) { ctx.font = '500 10.5px "Geist Mono", monospace'; ctx.fillStyle = f ? '#fafafa' : '#8b98a0'; ctx.fillText(sub, x + 6, y + hh - 9); }
        else if (sub && w >= 96) { ctx.font = '500 10px "Geist Mono", monospace'; ctx.textAlign = 'right'; ctx.fillStyle = f ? '#fafafa' : '#8b98a0'; ctx.fillText(sub, x + w - 5, y + hh / 2); }
      } else { // small: ticker centred (logo above it when there is room); one type size for the whole grid
        const base = Math.min((w - 6) / (4 * 0.62), hh * 0.42);
        if (base < 6) { ctx.globalAlpha = 1; return; }
        const fs = clamp(Math.min(base, (w - 4) / (m.ticker.length * 0.62)), 6, 10.5);
        const img = hh >= 34 && w >= 30 ? logo(m.ticker, redraw) : null;
        ctx.textAlign = 'center';
        if (img) {
          const ls = clamp(hh * 0.36, 10, 16), ly = y + (hh - ls - fs - 4) / 2;
          ctx.fillStyle = '#fafafa'; ctx.fillRect(x + (w - ls) / 2, ly, ls, ls); ctx.drawImage(img, x + (w - ls) / 2 + 1, ly + 1, ls - 2, ls - 2);
          ctx.font = `600 ${fs}px "Geist Mono", monospace`; ctx.fillStyle = tcol; ctx.fillText(m.ticker, x + w / 2, ly + ls + 3 + fs / 2);
        } else { ctx.font = `600 ${fs}px "Geist Mono", monospace`; ctx.fillStyle = tcol; ctx.fillText(m.ticker, x + w / 2, y + hh / 2 + 0.5); }
      }
      ctx.globalAlpha = 1;
    }
    const ctr = m => [m.sx + m.sw / 2, m.sy + m.sh / 2];
    function arrowAt(ax, ay, b, color) { // small head where the line enters the customer tile
      const [bx, by] = ctr(b), dx = ax - bx, dy = ay - by, d = Math.hypot(dx, dy) || 1;
      const t = Math.min(b.sw / 2 / (Math.abs(dx) || 1e-6), b.sh / 2 / (Math.abs(dy) || 1e-6), 1);
      const px = bx + dx * t, py = by + dy * t, ux = dx / d, uy = dy / d, s = 5;
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + ux * s * 1.6 - uy * s * 0.75, py + uy * s * 1.6 + ux * s * 0.75); ctx.lineTo(px + ux * s * 1.6 + uy * s * 0.75, py + uy * s * 1.6 - ux * s * 0.75); ctx.closePath(); ctx.fill();
    }
    function drawLinks() {
      const fl = focus && focus.links, quiet = SH && SH.total;
      for (const L of LINKS) {
        if (!SHOW[L.kind] || (!L.a.vis && !L.b.vis)) continue;
        const on = fl && fl.has(L);
        if (fl && !on && focus.spoke) continue;
        const S = LINK_STYLE[L.kind], [ax, ay] = ctr(L.a), [bx, by] = ctr(L.b);
        const far = clamp(1.35 - Math.hypot(bx - ax, by - ay) / (cam.k * 700), 0.35, 1); // long cross-sector spokes recede
        ctx.globalAlpha = fl ? (on ? 0.95 : 0.04) : S.a * far * (quiet ? 0.45 : 1) * (M.length > 150 ? 0.8 : 1);
        ctx.strokeStyle = S.c; ctx.lineWidth = on ? 1.5 : 1; ctx.setLineDash(S.dash);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        if (L.kind === 'supply' && (on || !fl) && !quiet) { ctx.setLineDash([]); arrowAt(ax, ay, L.b, S.c); }
      }
      ctx.setLineDash([]);
      if (SHOW.hidden && HID) {
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 4]);
        for (const p of HID) {
          const on = focus && focus.set.has(p.a) && focus.set.has(p.b);
          ctx.globalAlpha = focus ? (on ? 0.95 : 0.06) : 0.75;
          const [ax, ay] = ctr(p.a), [bx, by] = ctr(p.b); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      if (focus && focus.spoke) { // a bottleneck that is itself a member: spokes to every member depending on it
        const s = focus.spoke, [ax, ay] = ctr(s);
        ctx.strokeStyle = '#c8a97e'; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.95;
        for (const m of focus.set) if (m !== s) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(...ctr(m)); ctx.stroke(); arrowAt(ax, ay, m, '#c8a97e'); }
      }
      if (focus && focus.outline) { ctx.globalAlpha = 1; ctx.strokeStyle = focus.outline; ctx.lineWidth = 1.5; for (const m of focus.set) if (m.vis) ctx.strokeRect(m.sx + 0.75, m.sy + 0.75, m.sw - 1.5, m.sh - 1.5); }
      ctx.globalAlpha = 1;
    }

    // ---- interaction ----
    const pick = (sx, sy) => { for (const m of M) if (m.vis && sx >= m.sx && sx <= m.sx + m.sw && sy >= m.sy && sy <= m.sy + m.sh) return m; return null; };
    function focusMember(m) {
      if (!m) { focus = null; return; }
      const set = new Set([m]), links = new Set();
      for (const L of m.links) if (SHOW[L.kind]) { links.add(L); set.add(L.a === m ? L.b : L.a); }
      if (SHOW.hidden && HID) for (const p of HID) if (p.a === m || p.b === m) { set.add(p.a); set.add(p.b); }
      focus = set.size > 1 ? { set, links } : null; // a tile with no links keeps the rest of the map lit
    }
    cv.addEventListener('pointermove', ev => {
      if (cam.dragging) { tipHide(); return; }
      const r = cv.getBoundingClientRect(), m = pick(ev.clientX - r.left, ev.clientY - r.top);
      if (m !== hover) { hover = m; focusMember(m); redraw(); }
      if (m) tipShow(tileTip(m), ev.clientX, ev.clientY); else tipHide();
      cv.style.cursor = pickable(m) ? 'pointer' : cam.k > 1 ? 'grab' : 'default';
    });
    cv.addEventListener('pointerleave', () => { if (cam.dragging) return; hover = null; focus = null; tipHide(); redraw(); });
    // only members with a saved map open one (a click never starts a paid run), and never while a what-if streams
    const pickable = m => !!(m && m.mapped && canPick() && !(SH && SH.running));
    const pickMember = m => { if (pickable(m)) pickCompany(m.ticker, { name: m.name, mapped: true, source: 'web', index: id }); };
    cv.addEventListener('click', ev => {
      if (cam.dragged) return;
      const r = cv.getBoundingClientRect();
      pickMember(pick(ev.clientX - r.left, ev.clientY - r.top));
    });
    function tileTip(m) {
      const st = stOf(m), f = st && st.f, g = { out: [], in: [], rival: [], partner: [] };
      for (const L of m.links) { const o = L.a === m ? L.b : L.a; if (L.kind === 'supply') (L.a === m ? g.out : g.in).push(o.ticker); else g[L.kind].push(o.ticker); }
      const row = (label, list, c, dash) => list.length ? `<div class="pv-tt-l"><i class="${dash ? 'dash' : ''}" style="--c:${c}"></i><span>${label}</span><b>${h(list.slice(0, 7).join(', '))}${list.length > 7 ? ` +${list.length - 7}` : ''}</b></div>` : '';
      const corr = SHOW.hidden && HID ? HID.filter(p => p.a === m || p.b === m).map(p => `${(p.a === m ? p.b : p.a).ticker} ${p.r.toFixed(2)}`) : [];
      const links = row('Sells to', g.out, '#c8a97e') + row('Buys from', g.in, '#c8a97e') + row('Rivals', g.rival, '#8b8b94', true) + row('Partners', g.partner, '#a39bc9') + row('Moves with', corr, '#22c55e', true);
      const meta = [m.sector, m.sub, m.weight ? `${m.weight.toFixed(2)}% weight` : ''].filter(Boolean).join(' · ');
      const imp = f ? `<div class="pv-tt-i ${h(f.impact)}"><div><b class="${pcls(f.pct) || 'pv-mix'}">${pct(f.pct)}</b>revenue · ${h(f.impact)}${sev(f.severity)}</div>${f.why ? `<p>${h(f.why)}</p>` : ''}</div>`
        : st ? `<div class="pv-tt-f">${st.state === 'live' ? 'Agent is assessing…' : st.state === 'done' ? 'Assessed, no answer' : 'Queued'}</div>` : '';
      const foot = pickable(m) ? '<div class="pv-tt-f">Click to open its map</div>' : '';
      return `<div class="pv-tt-h">${logoHtml(m.ticker, m.name)}<div><b>${h(m.ticker)}</b><span>${h(m.name)}</span></div>${m.mapped ? '<em class="pv-pill ok">Mapped</em>' : ''}</div>${meta ? `<div class="pv-tt-s">${h(meta)}</div>` : ''}${links || '<div class="pv-tt-n">No filing links to other members yet</div>'}${imp}${foot}`;
    }

    // ---- toolbar: link toggles (they double as the legend), hidden links, zoom reset ----
    function renderTools() {
      const n = { supply: 0, rival: 0, partner: 0 }; for (const L of LINKS) n[L.kind]++;
      const tg = (k, label, c, dash) => `<span class="pv-tg${SHOW[k] ? '' : ' off'}" data-k="${k}"><i class="pv-sw${dash ? ' dash' : ''}" style="--c:${c}"></i>${label}<b>${n[k]}</b></span>`;
      const hid = hidState === 'off' ? '' : `<span class="pv-tg${SHOW.hidden ? ' act' : ''}${hidState === 'loading' ? ' busy' : ''}" data-k="hidden" title="Members whose share prices move together but no filing links them">${hidState === 'loading' ? '<span class="pv-spin"></span>' : `<i class="pv-sw dot" style="--c:#22c55e"></i>`}Hidden links${HID ? `<b>${HID.length}</b>` : ''}</span>`;
      tools.innerHTML = `${tg('supply', 'Supply chain', '#c8a97e')}${tg('rival', 'Rivals', '#8b8b94', true)}${tg('partner', 'Partners', '#a39bc9')}${hid}<span class="pv-slot"></span><span class="pv-sp"></span>${M.length > 120 && cam.k <= 1 ? '<span class="pv-hint">Scroll to zoom · drag to pan</span>' : ''}
        <span class="pv-lgd"><span><i class="sq"></i>Mapped</span>${SH ? '<span><i style="--c:#e5484d"></i>Hit</span><span><i style="--c:#e2a336"></i>Mixed</span><span><i style="--c:#46a758"></i>Gains</span>' : ''}</span>
        <span class="pv-tg" data-k="reset" title="Reset zoom" style="${cam.k > 1 ? '' : 'display:none'}">${icon('reset', 13)}</span>`;
    }
    tools.addEventListener('click', ev => {
      const t = ev.target.closest('[data-k]'); if (!t) return;
      const k = t.dataset.k;
      if (k === 'hidden') return toggleHidden();
      if (k === 'reset') { cam.to({ k: 1, tx: 0, ty: 0 }); setTimeout(renderTools, 560); return; }
      SHOW[k] = !SHOW[k]; renderTools(); redraw();
    });
    cv.addEventListener('wheel', () => { clearTimeout(toastT); toastT = setTimeout(renderTools, 120); }, { passive: true });
    function toast(msg) { const s = tools.querySelector('.pv-slot'); if (!s) return; s.innerHTML = `<span class="pv-toast">${h(msg)}</span>`; setTimeout(() => { if (s.isConnected) s.innerHTML = ''; }, 3200); }
    async function toggleHidden() {
      if (hidState === 'loading') return;
      if (HID) { SHOW.hidden = !SHOW.hidden; focusMember(hover); renderTools(); redraw(); return; }
      hidState = 'loading'; renderTools();
      const list = [...M].sort((a, b) => (b.weight || 0) - (a.weight || 0) || b.deg - a.deg || (b.mapped - a.mapped)).slice(0, 40).map(m => m.ticker);
      try {
        // price history can be slow (or rate-limited) upstream: give up after 25 s and let the user retry
        const d = await Promise.race([getJSON('api/correlations?tickers=' + encodeURIComponent(list.join(',')), 'correlations', list), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { slow: true })), 25000))]);
        if (!alive) return;
        const linked = new Set(LINKS.map(L => [L.a.ticker, L.b.ticker].sort().join('|')));
        HID = (d.pairs || []).filter(p => p.r >= 0.7 && byT.has(String(p.a).toUpperCase()) && byT.has(String(p.b).toUpperCase()) && !linked.has([String(p.a).toUpperCase(), String(p.b).toUpperCase()].sort().join('|')))
          .sort((a, b) => b.r - a.r).slice(0, 60).map(p => ({ a: byT.get(String(p.a).toUpperCase()), b: byT.get(String(p.b).toUpperCase()), r: +p.r }));
        hidState = 'ok'; SHOW.hidden = true;
        if (!HID.length) toast('No strongly correlated pairs without a filing link');
      } catch (e) {
        hidState = e.slow ? '' : 'off';
        if (alive) { renderTools(); toast(e.slow ? 'Price data is slow to load, try again in a moment' : 'Price correlations are not available yet'); }
        return;
      }
      if (alive) { renderTools(); redraw(); }
    }

    // ---- side panel: what-if results (once a run starts), bottlenecks, composition ----
    function renderSide() {
      side.innerHTML = `<div class="pv-res-slot"></div>${bottlenecksHtml()}${compositionHtml()}`;
      renderResults();
    }
    function bottlenecksHtml() {
      const bn = (D.bottlenecks || []).filter(b => b.dependents > 0).slice(0, 10);
      if (!bn.length) return `<div class="pv-blk"><h5>${icon('target')}Bottlenecks</h5><div class="pv-sub">No shared suppliers found in the saved runs yet. Map a few members to find them.</div></div>`;
      const max = Math.max(...bn.map(b => b.dependents));
      return `<div class="pv-blk"><h5>${icon('target')}Bottlenecks<em>${M.length} ${isEtf ? 'holdings' : 'members'}</em></h5><div class="pv-sub">Suppliers the most ${isEtf ? 'holdings' : 'members'} depend on</div>
        ${bn.map((b, i) => `<div class="pv-rk${b.ticker && byT.get(String(b.ticker).toUpperCase())?.mapped && canPick() ? ' pk' : ''}" data-bn="${i}"><span class="pv-n">${i + 1}</span>${logoHtml(b.ticker, b.name)}<div class="pv-rk-n"><b>${h(b.ticker || cleanName(b.name).split(' ')[0])}<span class="pv-tag${b.member ? ' in' : ''}">${b.member ? 'in ' + (isEtf ? 'ETF' : 'index') : 'outside'}</span></b><span>${h(cleanName(b.name))}</span></div><div class="pv-bar"><i style="width:${(b.dependents / max * 100).toFixed(0)}%"></i></div><b>${b.dependents}</b></div>`).join('')}
        <div class="pv-more">Hover to see who depends on it</div></div>`;
    }
    function compositionHtml() {
      const n = { supply: 0, rival: 0, partner: 0 }; for (const L of LINKS) n[L.kind]++;
      const tot = LINKS.length || 1;
      const mix = `<div class="pv-stk">${n.supply ? `<i style="--c:#c8a97e;width:${n.supply / tot * 100}%"></i>` : ''}${n.rival ? `<i style="--c:#8b8b94;width:${n.rival / tot * 100}%"></i>` : ''}${n.partner ? `<i style="--c:#a39bc9;width:${n.partner / tot * 100}%"></i>` : ''}</div>
        <div class="pv-leg"><span style="--c:#c8a97e">Supply <b>${n.supply}</b></span><span style="--c:#8b8b94">Rivals <b>${n.rival}</b></span><span style="--c:#a39bc9">Partners <b>${n.partner}</b></span></div>`;
      const top = [...M].filter(m => m.deg).sort((a, b) => b.deg - a.deg).slice(0, 6), tmax = top[0]?.deg || 1;
      const hubs = top.length ? `<h6>Most linked ${isEtf ? 'holdings' : 'members'}</h6>${top.map(m => `<div class="pv-cb${m.mapped && canPick() ? ' pk' : ''}" data-t="${h(m.ticker)}"><span><b style="text-align:left;margin-right:6px">${h(m.ticker)}</b>${h(m.name)}</span><div class="pv-bar"><i style="width:${(m.deg / tmax * 100).toFixed(0)}%"></i></div><b>${m.deg}</b></div>`).join('')}` : '';
      let comp = '';
      if (weighted) {
        const w = [...M].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 8), wm = w[0]?.weight || 1;
        comp = `<h6>Top weights</h6>${w.map(m => `<div class="pv-cb${m.mapped && canPick() ? ' pk' : ''}" data-t="${h(m.ticker)}"><span><b style="margin-right:6px">${h(m.ticker)}</b>${h(m.name)}</span><div class="pv-bar"><i style="width:${(m.weight / wm * 100).toFixed(0)}%;background:#22c55e"></i></div><b>${m.weight.toFixed(1)}</b></div>`).join('')}`;
      } else if (GROUPS.length > 1) {
        const gm = Math.max(...GROUPS.map(g => g.items.length));
        comp = `<h6>Sectors</h6>${GROUPS.map(g => `<div class="pv-cb"><span>${h(shortSector(g.name))}</span><div class="pv-bar"><i style="width:${(g.items.length / gm * 100).toFixed(0)}%"></i></div><b>${g.items.length}</b></div>`).join('')}`;
      }
      return `<div class="pv-blk"><h5>${icon('link')}Filing links<em>${LINKS.length}</em></h5><div class="pv-sub">Links between ${isEtf ? 'holdings' : 'members'} named in annual reports</div>${mix}${hubs}${comp}</div>`;
    }
    side.addEventListener('mouseover', ev => {
      const bnEl = ev.target.closest('[data-bn]'), tEl = ev.target.closest('[data-t]');
      let next = null;
      if (bnEl) {
        const b = (D.bottlenecks || [])[+bnEl.dataset.bn]; if (!b) return;
        const set = new Set((b.from || []).map(t => byT.get(String(t).toUpperCase())).filter(Boolean)), self = b.ticker && byT.get(String(b.ticker).toUpperCase());
        if (self) set.add(self);
        next = { set, links: new Set(), spoke: self || null, outline: '#c8a97e', key: 'bn' + bnEl.dataset.bn };
      } else if (tEl) {
        const m = byT.get(tEl.dataset.t); if (!m) return;
        focusMember(m); next = { ...focus, ring: m, key: 't' + m.ticker };
      }
      if ((next && next.key) !== (focus && focus.key)) { focus = next; redraw(); }
    });
    side.addEventListener('mouseleave', () => { if (focus) { focus = null; redraw(); } });
    side.addEventListener('click', ev => {
      const bnEl = ev.target.closest('[data-bn]'), tEl = ev.target.closest('[data-t]');
      if (bnEl) { const b = (D.bottlenecks || [])[+bnEl.dataset.bn]; if (b && b.ticker) pickMember(byT.get(String(b.ticker).toUpperCase())); }
      else if (tEl) pickMember(byT.get(tEl.dataset.t));
    });

    // ---- what-if across every member ----
    function buildAsk() {
      ask.innerHTML = `<div class="pv-ask-w"><div class="pv-prog-slot"></div><div class="pv-ex">${EXAMPLES.map(e => `<button type="button" data-ex="${h(e)}">${h(cap(e))}</button>`).join('')}</div>
        <form class="pv-bar2" autocomplete="off"><span class="pv-wtag">What if</span><input name="q" spellcheck="false" maxlength="280" placeholder="… e.g. Taiwan is blockaded"><span class="pv-across">across all <b>${M.length}</b></span><button class="pv-run" type="submit">${icon('bolt', 13)}Run</button></form></div>`;
      const form = ask.querySelector('form'), input = form.querySelector('input');
      form.onsubmit = ev => { ev.preventDefault(); runShock(input.value); };
      ask.querySelector('.pv-ex').onclick = ev => { const b = ev.target.closest('[data-ex]'); if (b) { input.value = b.dataset.ex; input.focus(); } };
      ask.querySelector('.pv-prog-slot').onclick = ev => { if (ev.target.closest('[data-act=clear]')) { SH = null; renderAll(); } };
    }
    const normQ = t => { t = String(t || '').trim().replace(/^what\s+if\s+/i, '').replace(/\?+$/, '').trim(); return t ? `What if ${t}?` : ''; };
    function shockStart(q) {
      SH = { q, byT: new Map(), agents: new Map(), total: 0, done: 0, found: 0, t0: performance.now(), t1: 0, running: true, result: null, error: null, status: 'Starting the agents…', feed: [], seen: new Set(), secAvg: null, dirty: true };
      clearInterval(uiTimer); uiTimer = setInterval(uiTick, 250);
      startLoop(); renderAll();
    }
    function onShock(e) {
      if (!SH || !e || !e.type) return;
      const tk = SH.agents.get(e.agent);
      switch (e.type) {
        case 'bot': if (e.text && (e.tool === 'terminal_indexshock' || e.phase === 'tool')) SH.status = e.text; break;
        case 'status': if (e.text) SH.status = e.text; break;
        case 'spawn':
          if (e.kind !== 'indexshock') return;
          for (const a of e.agents || []) {
            const t = String(a.ticker || a.label || '').toUpperCase(); if (!t) continue;
            SH.agents.set(a.id, t); if (!SH.byT.has(t)) SH.byT.set(t, { state: 'queued', f: null });
          }
          SH.total = SH.agents.size; break;
        case 'first': if (!tk) return; if (SH.byT.get(tk).state === 'queued') SH.byT.get(tk).state = 'live'; break;
        case 'finding': {
          if (!tk || !e.f || e.f.k !== 'impact') return;
          const s = SH.byT.get(tk); if (!s.f) { SH.found++; SH.feed.unshift({ ...e.f, ticker: tk }); SH.feed.length = Math.min(SH.feed.length, 4); }
          s.f = e.f; if (s.state === 'queued') s.state = 'live'; break;
        }
        case 'done': { if (!tk) return; const s = SH.byT.get(tk); if (s.state !== 'done') { s.state = 'done'; SH.done++; } if (e.error) s.err = e.error; break; }
        case 'indexshock': SH.result = e; break;
        case 'error': SH.error = e.text || 'The run failed'; break;
        case 'end': if (!SH.running) return; SH.running = false; SH.t1 = performance.now(); stopES(); break;
        default: return;
      }
      SH.dirty = true; redraw();
    }
    function stopES() { if (es) { es.onmessage = es.onerror = es.onopen = null; es.close(); es = null; } }
    async function runShock(text) {
      if (SH && SH.running) return;
      const q = normQ(text); if (!q || !M.length) return;
      shockStart(q);
      try {
        es = new EventSource('api/events?fresh=1');
        es.onmessage = m => { let e; try { e = JSON.parse(m.data); } catch { return; } onShock(e); };
        await new Promise(res => { es.onopen = res; setTimeout(res, 1500); });
        if (!alive || !SH) return;
        const r = await fetch(`api/ask?mode=indexshock&index=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}`);
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status }); }
        // watchdog: the ask was accepted but no agent ever spawned
        const mine = SH; setTimeout(() => { if (alive && SH === mine && SH.running && !SH.total) { SH.running = false; SH.t1 = performance.now(); SH.error = 'The run was accepted but no agents started. Try again.'; stopES(); SH.dirty = true; uiTick(); } }, 45000);
      } catch (err) {
        stopES(); if (!SH) return;
        SH.running = false; SH.t1 = performance.now(); SH.error = err.status === 409 ? 'busy' : (err.message || 'Could not start the run'); SH.dirty = true; uiTick();
      }
    }
    function startLoop() { // pulse the tiles that are being assessed while the run is live
      if (loopOn) return; loopOn = true;
      const f = () => { if (!alive || !SH || !SH.running) { loopOn = false; redraw(); return; } draw(); requestAnimationFrame(f); };
      requestAnimationFrame(f);
    }
    function uiTick() {
      if (!alive || !SH) { clearInterval(uiTimer); return; }
      if (SH.dirty) { SH.dirty = false; renderResults(); }
      renderProg();
      if (!SH.running) { clearInterval(uiTimer); renderTools(); redraw(); }
    }
    function renderAll() { renderProg(); renderResults(); renderTools(); redraw(); }
    function shockStats() {
      const f = []; for (const [t, s] of SH.byT) if (s.f) f.push({ ...s.f, ticker: t });
      const cnt = { negative: 0, mixed: 0, positive: 0 }; for (const x of f) cnt[x.impact in cnt ? x.impact : 'mixed']++;
      const avg = f.length ? f.reduce((s, x) => s + (+x.pct || 0), 0) / f.length : null;
      let sectors = SH.result && SH.result.sectors;
      if (!sectors) {
        const g = new Map();
        for (const x of f) { const k = x.sector || byT.get(x.ticker)?.sector || 'Other'; const o = g.get(k) || { sector: k, n: 0, negative: 0, positive: 0, s: 0 }; o.n++; if (x.impact === 'negative') o.negative++; if (x.impact === 'positive') o.positive++; o.s += +x.pct || 0; g.set(k, o); }
        sectors = [...g.values()].map(o => ({ ...o, avgPct: Math.round(o.s / o.n * 10) / 10 })).sort((a, b) => a.avgPct - b.avgPct);
      }
      const worst = (SH.result && SH.result.worst) || f.filter(x => x.impact === 'negative').sort((a, b) => (a.pct || 0) - (b.pct || 0)).slice(0, 8);
      const best = (SH.result && SH.result.best) || f.filter(x => x.impact === 'positive').sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 5);
      return { f, cnt, avg, sectors, worst, best };
    }
    function renderProg() {
      const slot = ask.querySelector('.pv-prog-slot'), ex = ask.querySelector('.pv-ex'), input = ask.querySelector('input'), run = ask.querySelector('.pv-run');
      if (!slot) return;
      const running = !!(SH && SH.running);
      ex.style.display = SH ? 'none' : ''; input.disabled = running; run.disabled = running;
      if (!SH) { slot.innerHTML = ''; return; }
      const total = SH.total || M.length, secs = Math.round(((SH.t1 || performance.now()) - SH.t0) / 1000);
      let html;
      if (SH.error === 'busy') html = `<div class="pv-prog warn">${icon('alert')}Another session is running on the server. Try again when it finishes.<button type="button" data-act="clear">Dismiss</button></div>`;
      else if (SH.error && !SH.found) html = `<div class="pv-prog bad">${icon('alert')}<span>${h(tidyErr(SH.error))}</span><button type="button" data-act="clear">Dismiss</button></div>`;
      else if (running) html = `<div class="pv-prog"><span class="pv-spin"></span>${SH.total ? `<span>Assessed</span><span><b>${SH.done}</b><i class="sl">/</i><b>${total}</b></span>` : `<span class="pv-qq">${h(SH.status)}</span>`}<div class="pv-pbar"><i style="width:${(SH.total ? SH.done / total * 100 : 2).toFixed(1)}%"></i></div><span class="pv-mono">${secs}s</span><span class="pv-qq">${h(SH.q)}</span></div>`;
      else {
        const s = shockStats();
        html = `<div class="pv-prog ok">${icon('check')}<span><b>${s.f.length}</b><i class="sl">/</i><b>${total}</b> assessed in <b>${secs}s</b></span><span class="pv-neg">${s.cnt.negative} hit</span><span class="pv-pos">${s.cnt.positive} gain</span>${SH.result ? '' : '<span class="pv-mix">ended early</span>'}<span class="pv-qq">${h(SH.q)}</span><button type="button" data-act="clear">Clear</button></div>`;
      }
      if (slot.innerHTML !== html) slot.innerHTML = html;
    }
    function renderResults() {
      const slot = side.querySelector('.pv-res-slot'); if (!slot) return;
      if (!SH || (SH.error && !SH.found && !SH.running)) { slot.innerHTML = ''; if (SH) SH.secAvg = null; return; }
      const s = shockStats(), total = SH.total || M.length, n = s.f.length || 1;
      SH.secAvg = new Map(s.sectors.map(x => [x.sector, x.avgPct]));
      const smax = Math.max(1, ...s.sectors.map(x => Math.abs(x.avgPct)));
      const sectors = s.sectors.length > 1 || (s.sectors[0] && s.sectors[0].sector !== 'Other')
        ? `<h6>Sectors<em>avg revenue impact</em></h6>${s.sectors.map(x => `<div class="pv-sb" title="${h(x.sector)}: ${x.negative}/${x.n} hit"><span>${h(shortSector(x.sector))}</span><div class="pv-ax">${x.avgPct ? `<i class="${x.avgPct < 0 ? 'n' : 'p'}" style="width:${(Math.abs(x.avgPct) / smax * 50).toFixed(1)}%"></i>` : '<i class="m"></i>'}</div><b class="${pcls(x.avgPct)}">${pct(x.avgPct)}</b></div>`).join('')}` : '';
      const row = x => `<div class="pv-wr${byT.get(String(x.ticker || '').toUpperCase())?.mapped && canPick() && !SH.running ? ' pk' : ''}${SH.seen && !SH.seen.has(x.ticker) ? ' new' : ''}" data-t="${h(String(x.ticker || '').toUpperCase())}">${logoHtml(x.ticker, x.name, 's')}<b>${h(x.ticker)}</b><em class="${pcls(x.pct) || 'pv-mix'}">${pct(x.pct)}</em><span class="${x.impact === 'negative' ? 'pv-neg' : x.impact === 'positive' ? 'pv-pos' : 'pv-mix'}" style="overflow:visible">${sev(x.severity)}</span><span title="${h(x.why)}">${h(x.why || '')}</span></div>`;
      const live = SH.running && SH.feed.length ? `<h6>Latest</h6><div class="pv-feed">${SH.feed.map(row).join('')}</div>` : '';
      slot.innerHTML = `<div class="pv-blk pv-res${SH.running ? ' live' : ''}"><h5>${icon('bolt')}What-if across ${isEtf ? 'holdings' : 'the index'}<em>${SH.running ? 'live' : 'done'}</em></h5><div class="pv-q">${h(SH.q)}</div>
        <div class="pv-kp3"><div><span>Assessed</span><b>${s.f.length}<small>/${total}</small></b></div><div><span>Avg revenue</span><b class="${pcls(s.avg)}">${pct(s.avg == null ? null : Math.round(s.avg * 10) / 10)}</b></div><div><span>Hit hard</span><b>${s.f.filter(x => x.impact === 'negative' && x.severity >= 2).length}</b></div></div>
        <div class="pv-stk">${s.cnt.negative ? `<i style="--c:#e5484d;width:${s.cnt.negative / n * 100}%"></i>` : ''}${s.cnt.mixed ? `<i style="--c:#e2a336;width:${s.cnt.mixed / n * 100}%"></i>` : ''}${s.cnt.positive ? `<i style="--c:#46a758;width:${s.cnt.positive / n * 100}%"></i>` : ''}</div>
        <div class="pv-leg"><span style="--c:#e5484d">Hit <b>${s.cnt.negative}</b></span><span style="--c:#e2a336">Mixed <b>${s.cnt.mixed}</b></span><span style="--c:#46a758">Gains <b>${s.cnt.positive}</b></span></div>
        ${live}${sectors}${s.worst.length ? `<h6>Hit hardest</h6>${s.worst.map(row).join('')}` : ''}${s.best.length ? `<h6>Gains</h6>${s.best.map(row).join('')}` : ''}</div>`;
      for (const x of SH.feed) SH.seen.add(x.ticker); // a feed row fades in once, not on every re-render
    }

    load();
    return {
      resize: () => { if (alive && M.length) { resize(); renderTools(); } },
      destroy: () => { alive = false; stopES(); clearInterval(uiTimer); redraw.cancel(); cancelAnimationFrame(cam.anim); tipHide(); },
      feed: e => { if (e && e.type === '_start') { if (M.length) shockStart(normQ(e.q) || e.q); return; } onShock(e); },
      onEsc: () => false,
    };
  }

  // ======================================================================
  // 2. Compare two companies side by side
  // ======================================================================
  function compareView(item, body) {
    const a = String(item.a || '').toUpperCase(), b = String(item.b || '').toUpperCase();
    setHead({ title: `${a} vs ${b}`, sub: 'Side by side, from every saved run' });
    body.classList.add('pv-cmp');
    body.innerHTML = `<div class="pv-state"></div>`;
    let alive = true, wireRaf = 0;
    const stateEl = body.querySelector('.pv-state');

    async function load() {
      stateEl.innerHTML = stateHtml('loading', `Comparing ${a} and ${b}…`);
      let d;
      try { d = await getJSON(`api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, 'compare', { a, b }); }
      catch (e) { if (!alive) return; stateEl.innerHTML = stateHtml('error', `Could not compare ${a} and ${b}`, { retry: true, code: tidyErr(e) }); stateEl.querySelector('[data-act=retry]').onclick = load; return; }
      if (alive) render(d);
    }
    const primary = rels => PRI.find(r => (rels || []).includes(r)) || 'other';
    const relTag = (r, extra) => `<span class="pv-rt" style="--c:${RC[fam(r)]}">${h(R1[r] || r)}${extra ? ` +${extra}` : ''}</span>`;

    function render(d) {
      const A = d.a || { nodes: [] }, B = d.b || { nodes: [] };
      A.nodes = A.nodes || []; B.nodes = B.nodes || [];
      const nA = new Map(A.nodes.map(n => [n.id, n])), nB = new Map(B.nodes.map(n => [n.id, n]));
      const sharedIds = new Set((d.shared || []).map(s => s.id));
      const aOnly = A.nodes.filter(n => n.id !== B.id && !sharedIds.has(n.id));
      const bOnly = B.nodes.filter(n => n.id !== A.id && !sharedIds.has(n.id));
      // shared: grouped by the role both have in common (suppliers first), else "different roles"
      const SG_ORDER = ['supplier', 'customer', 'competitor', 'partner', 'mixed'];
      const SG_LABEL = { supplier: 'Shared suppliers', customer: 'Shared customers', competitor: 'Shared rivals', partner: 'Shared partners', mixed: 'Different roles' };
      const shared = (d.shared || []).filter(s => s.id !== A.id && s.id !== B.id).map(s => {
        const fa = new Set((s.relA || []).map(fam)), both = FAMS.filter(f => fa.has(f) && (s.relB || []).map(fam).includes(f));
        return { ...s, both, g: both[0] || 'mixed', n: (nA.get(s.id)?.n || 0) + (nB.get(s.id)?.n || 0) };
      });
      const cnt = Object.fromEntries(FAMS.map(f => [f, shared.filter(s => s.both.includes(f)).length]));
      const groupsOf = list => { const g = new Map(); for (const n of list) { const k = fam(primary(n.rels)); if (!g.has(k)) g.set(k, []); g.get(k).push(n); } return [...FAMS, 'other'].filter(k => g.has(k)).map(k => ({ k, items: g.get(k).sort((x, y) => y.n - x.n) })); };

      // KPI strip
      const dir = d.direct || [];
      const dirTile = dir.length
        ? `<div class="pv-kt dir"><span>${icon('link', 12)}Direct link · ${h(b)} is ${h(a)}'s</span><b>${dir.slice(0, 3).map(r => relTag(r)).join('')}</b></div>`
        : `<div class="pv-kt dir none"><span>${icon('link', 12)}Direct link</span><b>None in the saved runs</b></div>`;
      const kt = (f, label) => `<div class="pv-kt"><span><i style="--c:${RC[f]}"></i>${label}</span><b>${cnt[f]}</b></div>`;
      const famCount = side => { const c = { supplier: 0, customer: 0, competitor: 0, partner: 0 }; for (const n of side.nodes) { const f = fam(primary(n.rels)); if (f in c) c[f]++; } return c; };
      const card = (S, other, cls) => {
        const c = famCount(S), tot = Object.values(c).reduce((x, y) => x + y, 0) || 1;
        return `<div class="pv-ccard ${cls}"><div class="pv-cc-top">${logoHtml(S.ticker, S.name, 'xl')}<div><b>${h(S.ticker)}</b><span>${h(cleanName(S.name))}</span></div></div>
          <div class="pv-cc-st">${S.mapped ? `<span class="pv-pill ok">${icon('check', 11)} Mapped</span>` : '<span class="pv-pill">Not mapped yet</span>'}<span class="pv-pill">${shared.length} shared with ${h(other)}</span></div>
          <div class="pv-cc-n"><b>${S.nodes.length}</b><span>companies linked</span></div>
          <div class="pv-stk">${FAMS.map(f => c[f] ? `<i style="--c:${RC[f]};width:${c[f] / tot * 100}%"></i>` : '').join('')}</div>
          <div class="pv-leg">${FAMS.map(f => `<span style="--c:${RC[f]}">${RL[f].split(' ')[0]}<b>${c[f]}</b></span>`).join('')}</div>${S.mapped && canPick() ? `<button class="pv-btn ghost pv-cc-go" type="button" data-pick="${h(S.ticker)}">${icon('map', 13)}Open ${h(S.ticker)} map</button>` : ''}</div>`;
      };
      const rowHtml = n => `<div class="pv-row"${n.ticker ? ` data-t="${h(n.ticker)}"` : ''} data-id="${h(n.id)}" title="${h(cleanName(n.name))}: ${h((n.rels || []).map(r => R1[r] || r).join(', '))}">${logoHtml(n.ticker, n.name, 's')}${n.ticker ? `<b>${h(n.ticker)}</b><span class="pv-nm">${h(cleanName(n.name))}</span>` : `<b class="nt">${h(cleanName(n.name))}</b>`}<em>×${n.n}</em></div>`;
      const sideCol = (S, list, gid) => {
        if (!S.nodes.length) return `<div class="pv-empty">No saved run mentions <b>${h(S.ticker)}</b> yet.${canPick() ? `<br><button class="pv-btn" type="button" data-pick="${h(S.ticker)}">${icon('map', 13)}Map ${h(S.ticker)}</button>` : ''}</div>`;
        const gs = groupsOf(list);
        if (!gs.length) return `<div class="pv-empty">Every company linked to ${h(S.ticker)} is shared</div>`;
        return gs.map(g => `<div class="pv-grp" data-w="${gid}-${g.k}" data-c="${RC[g.k]}"><h6><i style="--c:${RC[g.k]}"></i>${RL[g.k]}<em>${g.items.length}</em></h6>${g.items.slice(0, 7).map(rowHtml).join('')}${g.items.length > 7 ? `<div class="pv-more">+${g.items.length - 7} more</div>` : ''}</div>`).join('');
      };
      const sgroups = SG_ORDER.map(k => ({ k, items: shared.filter(s => s.g === k).sort((x, y) => y.n - x.n) })).filter(g => g.items.length);
      const srow = s => { const ra = primary(s.both.length ? s.both : s.relA), rb = primary(s.both.length ? s.both : s.relB); return `<div class="pv-srow"${s.ticker ? ` data-t="${h(s.ticker)}"` : ''} data-w="s-${h(s.id)}" data-ca="${RC[fam(ra)]}" data-cb="${RC[fam(rb)]}" title="${h(cleanName(s.name))} · to ${h(a)}: ${h((s.relA || []).map(r => R1[r] || r).join(', '))} · to ${h(b)}: ${h((s.relB || []).map(r => R1[r] || r).join(', '))}">${relTag(ra, (s.relA || []).length - 1)}${logoHtml(s.ticker, s.name, 's')}${s.ticker ? `<b>${h(s.ticker)}</b><span class="pv-nm">${h(cleanName(s.name))}</span>` : `<b class="nt">${h(cleanName(s.name))}</b>`}${relTag(rb, (s.relB || []).length - 1)}</div>`; };
      const sharedCol = sgroups.length ? sgroups.map(g => `<div class="pv-grp sh"><h6><i style="--c:${g.k === 'mixed' ? '#a1a1aa' : RC[g.k]}"></i>${SG_LABEL[g.k]}<em>${g.items.length}</em></h6>${g.items.map(srow).join('')}</div>`).join('')
        : `<div class="pv-empty">No companies in common yet</div>`;

      body.innerHTML = `<div class="pv-kstrip">${kt('supplier', 'Shared suppliers')}${kt('customer', 'Shared customers')}${kt('competitor', 'Shared rivals')}${kt('partner', 'Shared partners')}${dirTile}</div>
        <div class="pv-cwrap"><div class="pv-cgrid"><svg class="pv-wires"></svg>
          <div class="pv-col pv-ca"><div class="pv-ch">${h(a)} only<b>${aOnly.length}</b></div>${sideCol(A, aOnly, 'a')}</div>
          <div class="pv-mid">${card(A, b, 'pv-cardA')}</div>
          <div class="pv-col pv-cs"><div class="pv-ch"><span>${icon('layers', 12)} In common</span><b>${shared.length}</b></div>${sharedCol}</div>
          <div class="pv-mid">${card(B, a, 'pv-cardB')}</div>
          <div class="pv-col pv-cb2"><div class="pv-ch">${h(b)} only<b>${bOnly.length}</b></div>${sideCol(B, bOnly, 'b')}</div>
        </div></div>`;
      setHead({ title: `${a} vs ${b}`, sub: `${cleanName(A.name || a)} and ${cleanName(B.name || b)} · ${shared.length} companies in common`, kpis: [[A.nodes.length, `${a} links`], [B.nodes.length, `${b} links`], [shared.length, 'shared']] });
      const grid = body.querySelector('.pv-cgrid');
      grid.addEventListener('mouseover', ev => { const r = ev.target.closest('[data-w]'); hl(r ? r.dataset.w : null); });
      grid.addEventListener('mouseleave', () => hl(null));
      grid.addEventListener('click', ev => {
        const p = ev.target.closest('[data-pick]'); if (p) { pickCompany(p.dataset.pick, { source: 'compare' }); return; }
      });
      document.fonts && document.fonts.ready.then(() => alive && wires());
      requestAnimationFrame(wires);
    }
    // orthogonal "bus" wiring like the app: card -> hub square -> trunk -> a stub into every target
    function wires() {
      cancelAnimationFrame(wireRaf);
      const grid = body.querySelector('.pv-cgrid'); if (!grid) return;
      const svg = grid.querySelector('.pv-wires'), G = grid.getBoundingClientRect();
      const box = e => { const r = e.getBoundingClientRect(); return { x0: r.left - G.left, x1: r.right - G.left, y0: r.top - G.top, y1: r.bottom - G.top, cy: (r.top + r.bottom) / 2 - G.top }; };
      const cA = grid.querySelector('.pv-cardA'), cB = grid.querySelector('.pv-cardB'); if (!cA || !cB) return;
      const A = box(cA), B = box(cB);
      let out = '';
      const bus = (fromX, fromY, hubX, targets) => {
        if (!targets.length) return;
        const ys = targets.map(t => t.y), y0 = Math.min(fromY, ...ys), y1 = Math.max(fromY, ...ys);
        out += `<path class="w0" d="M${fromX} ${fromY}H${hubX}"/><path class="w0" d="M${hubX} ${y0}V${y1}"/>`;
        for (const t of targets) out += `<path class="w" data-w="${h(t.key)}" stroke="${t.c}" d="M${hubX} ${t.y}H${t.x}"/>`;
        out += `<rect class="hub" x="${hubX - 4}" y="${fromY - 4}" width="8" height="8"/>`;
      };
      const rows = [...grid.querySelectorAll('.pv-cs .pv-srow')].map(e => ({ e, b: box(e) }));
      const gap = (cA.closest('.pv-mid').nextElementSibling.getBoundingClientRect().left - G.left) - A.x1;
      bus(A.x1, A.cy, A.x1 + gap / 2, rows.map(r => ({ x: r.b.x0, y: r.b.cy, c: r.e.dataset.ca, key: r.e.dataset.w })));
      bus(B.x0, B.cy, B.x0 - gap / 2, rows.map(r => ({ x: r.b.x1, y: r.b.cy, c: r.e.dataset.cb, key: r.e.dataset.w })));
      const gA = [...grid.querySelectorAll('.pv-ca .pv-grp')].map(e => { const b = box(e); return { x: b.x1, y: b.y0 + 17, c: e.dataset.c, key: e.dataset.w }; });
      const gB = [...grid.querySelectorAll('.pv-cb2 .pv-grp')].map(e => { const b = box(e); return { x: b.x0, y: b.y0 + 17, c: e.dataset.c, key: e.dataset.w }; });
      bus(A.x0, A.cy, A.x0 - gap / 2, gA);
      bus(B.x1, B.cy, B.x1 + gap / 2, gB);
      svg.setAttribute('width', grid.scrollWidth); svg.setAttribute('height', grid.scrollHeight);
      svg.innerHTML = out;
    }
    function hl(key) {
      const svg = body.querySelector('.pv-wires'); if (!svg) return;
      svg.classList.toggle('hl', !!key);
      svg.querySelectorAll('.w.on').forEach(p => p.classList.remove('on'));
      if (key) svg.querySelectorAll(`.w[data-w="${CSS.escape(key)}"]`).forEach(p => p.classList.add('on'));
    }
    load();
    return { resize: () => { wireRaf = requestAnimationFrame(wires); }, destroy: () => { alive = false; cancelAnimationFrame(wireRaf); tipHide(); } };
  }

  // ======================================================================
  // 3. Shared memory: every saved run folded into one graph
  // ======================================================================
  function memoryView(item, body) {
    setHead({ title: 'Shared memory', sub: 'Every saved run folded into one graph' });
    body.classList.add('pv-mem');
    body.innerHTML = `<section class="pv-stage"><canvas></canvas><div class="pv-tools"></div><div class="pv-state"></div></section><aside class="pv-side"></aside>`;
    const stage = body.querySelector('.pv-stage'), cv = stage.querySelector('canvas'), ctx = cv.getContext('2d');
    const tools = stage.querySelector('.pv-tools'), stateEl = stage.querySelector('.pv-state'), side = body.querySelector('.pv-side');
    let alive = true, D = null, N = [], E = [], byId = new Map(), NS = [], sel = null, hover = null, fitK = 1;
    let vw = 0, vh = 0, dpr = 1, ddOn = 0, ddList = [];
    const redraw = scheduler(() => alive && draw());
    const cam = camera(cv, redraw, { min: 0.15, max: 10 });

    async function load() {
      stateEl.innerHTML = stateHtml('loading', 'Folding every saved run into one graph…');
      try { D = await getJSON('api/memory', 'memory'); }
      catch (e) { if (!alive) return; stateEl.innerHTML = stateHtml('error', 'Shared memory is not available', { retry: true, code: tidyErr(e) }); stateEl.querySelector('[data-act=retry]').onclick = load; return; }
      if (!alive) return;
      build();
      if (!N.length) { stateEl.innerHTML = stateHtml('error', 'No saved runs yet', { sub: 'Map a company first; every finished run lands here.' }); return; }
      stateEl.innerHTML = '';
      const mapped = N.filter(n => n.maps).length;
      setHead({ sub: `${D.runs} runs · ${N.length} companies · ${E.length} links`, kpis: [[D.runs, 'runs'], [N.length, 'companies'], [E.length, 'links'], [mapped, 'mapped']] });
      layout(); renderTools(); renderSide(); size(true);
    }
    function build() {
      N = (D.nodes || []).map(n => ({ id: n.id, name: cleanName(n.name) || String(n.id).slice(2), ticker: n.ticker || null, maps: n.maps || 0, degree: n.degree || 0, desc: n.desc || null, commodity: n.commodity || (String(n.id).startsWith('C:') ? String(n.id).slice(2) : null), role: { supplier: 0, customer: 0, competitor: 0, partner: 0, chain: 0, other: 0 }, nb: new Map(), x: 0, y: 0 }));
      byId = new Map(N.map(n => [n.id, n]));
      E = [];
      const addNb = (n, o, r) => { if (!n.nb.has(o)) n.nb.set(o, new Set()); n.nb.get(o).add(r); };
      for (const e of D.edges || []) {
        const s = byId.get(e.a), t = byId.get(e.b); if (!s || !t || s === t) continue;
        const f = fam(e.rel), fb = fam(FLIP[e.rel] || e.rel), w = e.n || 1;
        E.push({ s, t, rel: e.rel, fam: f, n: w });
        t.role[f] += w; s.role[fb] += w;             // t is s's <rel>; s is t's flipped rel
        addNb(s, t, f); addNb(t, s, fb);
      }
      for (const n of N) {
        n.dom = Object.entries(n.role).sort((x, y) => y[1] - x[1])[0][1] ? Object.entries(n.role).sort((x, y) => y[1] - x[1])[0][0] : 'other';
        n.r = 2.4 + Math.sqrt(n.nb.size || n.degree) * 1.55;
        n.lg = !!n.ticker && (n.maps > 0 || n.nb.size >= 10);
        if (n.lg) n.r = Math.max(n.r + 1.5, n.maps ? 11 : 8.5);
        n.lmono = !!(n.ticker || n.commodity);
        n.label = n.ticker || (n.commodity ? n.name.toUpperCase() : shortName(n.name));
      }
      NS = [...N].sort((x, y) => x.r - y.r);
      [...N].sort((x, y) => y.nb.size - x.nb.size).forEach((n, i) => { n.rank = i; });
      // connected components: small islands get pulled in next to the main graph instead of drifting off
      const seen = new Set(); let biggest = 0;
      for (const n of N) {
        if (seen.has(n)) continue;
        const comp = [], st = [n]; seen.add(n);
        while (st.length) { const x = st.pop(); comp.push(x); for (const o of x.nb.keys()) if (!seen.has(o)) { seen.add(o); st.push(o); } }
        for (const x of comp) x.comp = comp.length;
        biggest = Math.max(biggest, comp.length);
      }
      for (const n of N) n.island = n.comp < biggest;
      MF = E.some(e => e.fam === 'chain') ? [...FAMS, 'chain'] : FAMS;
    }
    let MF = FAMS;
    const shortName = s => { // "Koninklijke Philips Electronics" -> "Koninklijke Philips"
      const w = String(s || '').split(/\s+/); let t = w[0] || '';
      for (let i = 1; i < w.length && (t + ' ' + w[i]).length <= 20; i++) t += ' ' + w[i];
      return t.length > 20 ? t.slice(0, 19) + '…' : cap(t);
    };
    function layout() {
      const pairs = new Map();
      for (const e of E) { const k = e.s.id < e.t.id ? e.s.id + '|' + e.t.id : e.t.id + '|' + e.s.id; if (!pairs.has(k)) pairs.set(k, { source: e.s, target: e.t }); }
      if (!window.d3) { N.forEach((n, i) => { const a = i * 2.39996, r = 14 * Math.sqrt(i); n.x = Math.cos(a) * r; n.y = Math.sin(a) * r; }); return; }
      const sim = d3.forceSimulation(N)
        .force('link', d3.forceLink([...pairs.values()]).distance(l => 16 + l.source.r + l.target.r).strength(l => 0.9 / Math.min(l.source.nb.size || 1, l.target.nb.size || 1)))
        .force('charge', d3.forceManyBody().strength(n => -16 - n.r * 5.5).distanceMax(520).theta(0.9))
        .force('collide', d3.forceCollide(n => n.r + 2.5).iterations(2))
        .force('x', d3.forceX(0).strength(n => n.island ? 0.3 : 0.03)).force('y', d3.forceY(0).strength(n => n.island ? 0.45 : 0.055))
        .stop();
      sim.tick(340);
    }
    function size(refit) {
      const s = sizeCanvas(cv); vw = s.w; vh = s.h; dpr = s.d;
      if (refit) fit(false); redraw();
    }
    function fit(anim) {
      if (!N.length) return;
      // robust bounds: a few stray leaves should not shrink the whole graph
      const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
      const xs = N.map(n => n.x).sort((a, b) => a - b), ys = N.map(n => n.y).sort((a, b) => a - b), lo = N.length > 60 ? 0.006 : 0, hi = 1 - lo;
      const x0 = q(xs, lo) - 20, x1 = q(xs, hi) + 20, y0 = q(ys, lo) - 20, y1 = q(ys, hi) + 28;
      const top = 56, pad = 28, k = Math.min((vw - pad * 2) / (x1 - x0), (vh - top - pad) / (y1 - y0));
      fitK = k;
      const t = { k, tx: vw / 2 - (x0 + x1) / 2 * k, ty: top + (vh - top - pad) / 2 - (y0 + y1) / 2 * k };
      if (anim) cam.to(t); else Object.assign(cam, t);
    }
    function focusSet() {
      const c = sel || hover; if (!c) return null;
      return { c, set: new Set([c, ...c.nb.keys()]) };
    }
    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vw, vh);
      const k = cam.k, X = x => x * k + cam.tx, Y = y => y * k + cam.ty, F = focusSet();
      // edges
      ctx.lineWidth = 1;
      for (const e of E) {
        const on = F && (F.c === e.s || F.c === e.t);
        ctx.globalAlpha = F ? (on ? 0.9 : 0.03) : 0.16;
        ctx.strokeStyle = RC[e.fam];
        ctx.beginPath(); ctx.moveTo(X(e.s.x), Y(e.s.y)); ctx.lineTo(X(e.t.x), Y(e.t.y)); ctx.stroke();
      }
      // nodes (small first, hubs on top)
      for (const n of NS) {
        const x = X(n.x), y = Y(n.y), r = Math.max(1.4, n.r * k);
        if (x < -40 || y < -40 || x > vw + 40 || y > vh + 40) continue;
        const dim = F && !F.set.has(n);
        ctx.globalAlpha = dim ? 0.12 : 1;
        const img = n.lg && r >= 5 ? logo(n.ticker, redraw) : null;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        if (img) {
          ctx.fillStyle = '#fafafa'; ctx.fill();
          ctx.save(); ctx.clip(); const s = r * 1.25; ctx.drawImage(img, x - s / 2, y - s / 2, s, s); ctx.restore();
          ctx.lineWidth = 1.5; ctx.strokeStyle = RC[n.dom]; ctx.beginPath(); ctx.arc(x, y, r + 0.75, 0, Math.PI * 2); ctx.stroke();
        } else { ctx.fillStyle = RC[n.dom]; ctx.fill(); if (r > 3) { ctx.lineWidth = 1; ctx.strokeStyle = '#09090b'; ctx.stroke(); } }
        if (n.maps) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#22c55e'; ctx.beginPath(); ctx.arc(x, y, r + 3.5, 0, Math.PI * 2); ctx.stroke(); }
        if (n === sel || n === hover) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#fafafa'; ctx.beginPath(); ctx.arc(x, y, r + (n.maps ? 6.5 : 3.5), 0, Math.PI * 2); ctx.stroke(); }
      }
      // labels: priority order, skipped where they would collide
      const cand = N.filter(n => F ? F.set.has(n) : (n.maps || n.rank < 30 || n.r * k >= 12)).sort((x, y) => pri(y, F) - pri(x, F));
      const placed = []; // big discs count as obstacles so labels never sit on a logo
      for (const n of NS) { const r = n.r * k; if (r >= 7 && !(F && !F.set.has(n))) { const x = X(n.x), y = Y(n.y); if (x > -20 && y > -20 && x < vw + 20 && y < vh + 20) placed.push([x - r, y - r, r * 2, r * 2]); } }
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      for (const n of cand) {
        const x = X(n.x), y = Y(n.y) + Math.max(1.4, n.r * k) + (n.maps ? 12 : 9);
        if (x < 0 || y < 0 || x > vw || y > vh) continue;
        const main = n === sel || n === hover || n.maps;
        ctx.font = n.lmono ? `${main ? 600 : 500} ${main ? 11 : 10}px "Geist Mono", monospace` : `${main ? 600 : 500} ${main ? 11.5 : 10.5}px Geist, sans-serif`;
        const t = n.label, w = ctx.measureText(t).width, bx = [x - w / 2 - 3, y - 7, w + 6, 14];
        if (placed.some(p => bx[0] < p[0] + p[2] && bx[0] + bx[2] > p[0] && bx[1] < p[1] + p[3] && bx[1] + bx[3] > p[1])) continue;
        placed.push(bx);
        ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(5,5,7,0.82)'; ctx.fillRect(bx[0], bx[1], bx[2], bx[3]);
        ctx.fillStyle = main ? '#fafafa' : F ? '#d4d4d8' : '#a1a1aa'; ctx.fillText(t, x, y + 0.5);
      }
      ctx.globalAlpha = 1;
    }
    const pri = (n, F) => (n === sel ? 1e6 : 0) + (n === hover ? 5e5 : 0) + (F && F.c.nb.has(n) ? 1e4 : 0) + (n.maps ? 5e3 : 0) + n.nb.size;
    function pick(sx, sy) {
      const k = cam.k; let best = null, bd = Infinity;
      for (const n of N) { const d = Math.hypot(n.x * k + cam.tx - sx, n.y * k + cam.ty - sy) - Math.max(1.4, n.r * k); if (d < 5 && d < bd) { bd = d; best = n; } }
      return best;
    }
    function select(n, fly) {
      sel = n || null; renderSide(); redraw();
      if (sel && fly) { const k = Math.max(cam.k, fitK * 2.2); cam.to({ k, tx: vw / 2 - sel.x * k, ty: (vh + 56) / 2 - sel.y * k }); }
    }
    cv.addEventListener('pointermove', ev => {
      if (cam.dragging) { tipHide(); return; }
      const r = cv.getBoundingClientRect(), n = pick(ev.clientX - r.left, ev.clientY - r.top);
      if (n !== hover) { hover = n; redraw(); }
      if (n) tipShow(nodeTip(n), ev.clientX, ev.clientY); else tipHide();
      cv.style.cursor = n ? 'pointer' : 'grab';
    });
    cv.addEventListener('pointerleave', () => { if (cam.dragging) return; hover = null; tipHide(); redraw(); });
    cv.addEventListener('click', ev => { if (cam.dragged) return; const r = cv.getBoundingClientRect(); select(pick(ev.clientX - r.left, ev.clientY - r.top), false); });
    cv.addEventListener('dblclick', ev => { const r = cv.getBoundingClientRect(); if (!pick(ev.clientX - r.left, ev.clientY - r.top)) fit(true); });
    const roleBar = n => { const tot = MF.reduce((s, f) => s + n.role[f], 0) || 1; return `<div class="pv-stk" style="margin-top:8px">${MF.map(f => n.role[f] ? `<i style="--c:${RC[f]};width:${n.role[f] / tot * 100}%"></i>` : '').join('')}</div>`; };
    function nodeTip(n) {
      const top = [...n.nb.keys()].sort((x, y) => y.nb.size - x.nb.size).slice(0, 6).map(o => o.ticker || shortName(o.name));
      return `<div class="pv-tt-h">${logoHtml(n.ticker, n.name)}<div><b>${h(n.ticker || n.name)}</b><span>${h(n.ticker ? n.name : n.commodity ? 'Commodity value chain' : 'Private or unlisted')}</span></div>${n.maps ? `<em class="pv-pill ok">Mapped ×${n.maps}</em>` : ''}</div>
        <div class="pv-tt-k"><div><b>${n.nb.size}</b><span>links</span></div><div><b style="color:${RC[n.dom]}">${h(R1[n.dom] || n.dom)}</b><span>mostly a</span></div></div>${roleBar(n)}
        ${n.desc ? `<div class="pv-tt-d">${h(String(n.desc).slice(0, 140))}</div>` : ''}${top.length ? `<div class="pv-tt-l" style="grid-template-columns:62px 1fr"><span>Linked to</span><b>${h(top.join(', '))}</b></div>` : ''}<div class="pv-tt-f">Click to focus</div>`;
    }

    // ---- toolbar: search + legend ----
    function renderTools() {
      tools.innerHTML = `<div class="pv-srch"><div class="pv-srch-in">${icon('search', 13)}<input spellcheck="false" placeholder="Find a company…"><kbd>↵</kbd></div><div class="pv-dd"></div></div><span class="pv-sp"></span>
        <span class="pv-lgd">${MF.map(f => `<span><i style="--c:${RC[f]}"></i>${cap(R1[f])}</span>`).join('')}<span><i class="ring"></i>Mapped</span></span>
        <span class="pv-tg" data-k="fit" title="Fit the whole graph">${icon('reset', 13)}</span>`;
      const inp = tools.querySelector('input'), dd = tools.querySelector('.pv-dd');
      const show = () => {
        const q = inp.value.trim().toLowerCase();
        if (!q) { dd.classList.remove('open'); ddList = []; return; }
        ddList = N.map(n => { const t = (n.ticker || '').toLowerCase(), nm = n.name.toLowerCase(); const s = t === q ? 4 : t.startsWith(q) ? 3 : nm.startsWith(q) ? 2 : nm.includes(q) || t.includes(q) ? 1 : 0; return [s, n]; })
          .filter(x => x[0]).sort((x, y) => y[0] - x[0] || y[1].nb.size - x[1].nb.size).slice(0, 7).map(x => x[1]);
        ddOn = 0;
        dd.innerHTML = ddList.length ? ddList.map((n, i) => `<div class="${i === ddOn ? 'on' : ''}" data-i="${i}">${logoHtml(n.ticker, n.name, 's')}${n.ticker ? `<b>${h(n.ticker)}</b><span>${h(n.name)}</span>` : `<span class="pv-dd-n">${h(n.name)}</span>`}<em>${n.nb.size}</em></div>`).join('') : `<div class="pv-none">No company matches “${h(inp.value.trim())}”</div>`;
        dd.classList.add('open');
      };
      const choose = i => { const n = ddList[i]; if (!n) return; dd.classList.remove('open'); inp.value = n.ticker || n.name; inp.blur(); select(n, true); };
      inp.addEventListener('input', show);
      inp.addEventListener('focus', () => { if (inp.value.trim()) show(); });
      inp.addEventListener('blur', () => setTimeout(() => dd.classList.remove('open'), 120));
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (!ddList.length) return; ddOn = clamp(ddOn + (ev.key === 'ArrowDown' ? 1 : -1), 0, ddList.length - 1); dd.querySelectorAll('[data-i]').forEach((d, i) => d.classList.toggle('on', i === ddOn)); }
        else if (ev.key === 'Enter') { ev.preventDefault(); choose(ddOn); }
      });
      dd.addEventListener('mousedown', ev => { const d = ev.target.closest('[data-i]'); if (d) { ev.preventDefault(); choose(+d.dataset.i); } });
      tools.querySelector('[data-k=fit]').onclick = () => { select(null); fit(true); };
    }

    // ---- side panel ----
    function renderSide() {
      const top = [...N].sort((x, y) => y.nb.size - x.nb.size).slice(0, 10), tmax = top[0]?.nb.size || 1;
      const fc = { supplier: 0, customer: 0, competitor: 0, partner: 0, chain: 0 }; for (const e of E) if (e.fam in fc) fc[e.fam]++;
      const tot = E.length || 1;
      const mapped = N.filter(n => n.maps).sort((x, y) => y.maps - x.maps);
      side.innerHTML = `${sel ? selHtml(sel) : ''}
        <div class="pv-blk"><h5>${icon('hub')}Most connected<em>links</em></h5><div class="pv-sub">The companies every run keeps running into</div>
          ${top.map((n, i) => `<div class="pv-rk" data-id="${h(n.id)}"><span class="pv-n">${i + 1}</span>${logoHtml(n.ticker, n.name)}<div class="pv-rk-n"><b>${h(n.ticker || shortName(n.name))}</b><span>${h(n.name)}</span></div><div class="pv-bar"><i style="width:${(n.nb.size / tmax * 100).toFixed(0)}%;--c:${RC[n.dom]}"></i></div><b>${n.nb.size}</b></div>`).join('')}</div>
        <div class="pv-blk"><h5>${icon('link')}Relationship mix<em>${E.length}</em></h5><div class="pv-sub">What the filings say each link is</div>
          <div class="pv-stk">${MF.map(f => fc[f] ? `<i style="--c:${RC[f]};width:${fc[f] / tot * 100}%"></i>` : '').join('')}</div>
          <div class="pv-leg">${MF.map(f => `<span style="--c:${RC[f]}">${cap(R1[f])} <b>${fc[f]}</b></span>`).join('')}</div></div>
        <div class="pv-blk"><h5>${icon('map')}Mapped companies<em>${mapped.length}</em></h5><div class="pv-sub">Roots of the ${D.runs} saved runs</div>
          <div class="pv-chips">${mapped.map(n => `<span class="pv-chip" data-id="${h(n.id)}">${logoHtml(n.ticker, n.name)}${h(n.ticker || n.name)}<em>×${n.maps}</em></span>`).join('')}</div></div>`;
    }
    function selHtml(n) {
      const groups = MF.map(f => ({ f, items: [...n.nb.entries()].filter(([, rs]) => rs.has(f)).map(([o]) => o).sort((x, y) => y.nb.size - x.nb.size) })).filter(g => g.items.length);
      const mentions = E.filter(e => e.s === n || e.t === n).reduce((s, e) => s + e.n, 0);
      const chip = o => o.ticker ? `<span class="pv-chip" data-id="${h(o.id)}">${logoHtml(o.ticker, o.name)}${h(o.ticker)}</span>` : `<span class="pv-chip nl" data-id="${h(o.id)}">${h(o.name)}</span>`;
      return `<div class="pv-blk" style="border-color:#3f3f46"><div class="pv-tt-h">${logoHtml(n.ticker, n.name)}<div><b>${h(n.ticker || n.name)}</b><span>${h(n.ticker ? n.name : n.commodity ? 'Commodity value chain' : 'Private or unlisted')}</span></div><em class="pv-pill${n.maps ? ' ok' : ''}">${n.maps ? `Mapped ×${n.maps}` : 'Not mapped'}</em></div>
        ${n.desc ? `<div class="pv-sel-d">${h(n.desc)}</div>` : ''}
        <div class="pv-sel-k"><div><span>Links</span><b>${n.nb.size}</b></div><div><span>Mentions</span><b>${mentions}</b></div><div><span>Mostly a</span><b style="color:${RC[n.dom]};font-size:13px">${h(R1[n.dom] || n.dom)}</b></div></div>${roleBar(n)}
        ${groups.map(g => `<div class="pv-sel-g"><i style="--c:${RC[g.f]}"></i>${RL[g.f]}<em>${g.items.length}</em></div><div class="pv-chips">${g.items.slice(0, 10).map(chip).join('')}${g.items.length > 10 ? `<span class="pv-chip nl" style="cursor:default">+${g.items.length - 10}</span>` : ''}</div>`).join('')}
        ${n.ticker && canPick() ? `<button class="pv-btn" type="button" data-pick="${h(n.ticker)}">${icon('map', 13)}${n.maps ? 'Open its map' : `Map ${h(n.ticker)}`}</button>` : ''}</div>`;
    }
    side.addEventListener('click', ev => {
      const p = ev.target.closest('[data-pick]'); if (p) { pickCompany(p.dataset.pick, { source: 'memory' }); return; }
      const d = ev.target.closest('[data-id]'); if (d) select(byId.get(d.dataset.id), true);
    });

    load();
    return {
      resize: () => { if (alive && N.length) size(false); },
      destroy: () => { alive = false; redraw.cancel(); cancelAnimationFrame(cam.anim); tipHide(); },
      onEsc: () => { // Esc closes the dropdown, then clears the focus, then closes the view
        const dd = tools.querySelector('.pv-dd.open'); if (dd) { dd.classList.remove('open'); return true; }
        if (sel) { select(null); return true; }
        return false;
      },
    };
  }

  // ---------- entry point ----------
  function open(item) {
    if (!item) return;
    if (typeof item === 'string') item = { type: item };
    const type = item.type;
    if (type === 'web' || type === 'etf') { const body = shell(type === 'etf' ? 'ETF' : 'WEB', item.name || item.ticker || ''); VIEW = webView(item, body); }
    else if (type === 'compare') { const body = shell('CMP', `${item.a || ''} vs ${item.b || ''}`); VIEW = compareView(item, body); }
    else if (type === 'memory') { const body = shell('MEM', 'Shared memory'); VIEW = memoryView(item, body); }
    else return false;
    if (document.fonts) document.fonts.ready.then(() => { if (VIEW && VIEW.resize) VIEW.resize(); });
    return true;
  }
  const PT = window.PTViews = Object.assign(window.PTViews || {}, {
    open, close: () => close(), isOpen: () => !!ROOT,
    _feed: e => VIEW && VIEW.feed && VIEW.feed(e), // tests: replay index-shock events without spending a run
  });
  if (!('onPick' in PT)) PT.onPick = null;
})();
