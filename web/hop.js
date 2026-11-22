/* Chain hopping, page side. A trail of the maps you hopped through (NVDA > TSM > ASML), the link that led to this one, and two
   clocks per hop: click to first tile, click to core map (with queue and generation time apart). The engine does the work
   (engine/hop.mjs): a hop pauses the map on screen, a crumb brings a saved map back at once, Resume runs its remaining waves.
   Hooks the page's own onEvent / companyModal, so app.js stays almost untouched. */
(() => {
  'use strict';
  if (typeof S === 'undefined') return;
  const HOP = { items: [], active: null, cur: null, tick: null, paused: false };
  const root = document.createElement('div');
  root.id = 'hop';
  root.innerHTML = '<div id="hop-trail"></div><div id="hop-ctx"></div><div id="hop-clock"></div>';
  document.body.appendChild(root);
  const trailEl = root.querySelector('#hop-trail'), ctxEl = root.querySelector('#hop-ctx'), clockEl = root.querySelector('#hop-clock');
  const sec = ms => (ms / 1000).toFixed(ms < 9950 ? 1 : 0) + ' s';
  const label = it => it.private ? String(it.name || it.ticker).split(' ').slice(0, 2).join(' ') : (it.ticker || it.name);

  // ---- trail ----
  function renderTrail() {
    const items = HOP.items;
    root.classList.toggle('on', items.length >= 2 && !REPLAY);
    const act = items.find(x => x.id === HOP.active);
    trailEl.innerHTML = items.map((it, i) => {
      const tip = `${it.name || it.ticker}${it.from ? ` · ${it.fromName || it.from}'s ${it.rel || 'connection'}` : ''}${it.state === 'paused' ? ' · paused' : ''}`;
      return `${i ? '<span class="sep">›</span>' : ''}<button class="crumb ${it.state} ${it.id === HOP.active ? 'on' : ''}" data-id="${esc(it.id)}" title="${esc(tip)}"><i></i>${esc(label(it))}${it.state === 'paused' ? '<em>‖</em>' : ''}</button>`;
    }).join('') + (act && act.state === 'paused' ? '<button class="rs">Resume</button>' : '');
    trailEl.querySelectorAll('.crumb').forEach(b => b.onclick = () => { if (b.dataset.id !== HOP.active) goTo(b.dataset.id); });
    const rs = trailEl.querySelector('.rs');
    if (rs) rs.onclick = () => { rs.disabled = true; rs.textContent = 'Resuming…'; fetch('api/hop/resume?id=' + encodeURIComponent(HOP.active)).catch(() => {}); };
  }

  // ---- the link that led here ----
  function renderCtx(h, name) {
    if (!h || !h.from) { ctxEl.style.display = 'none'; return; }
    const rel = h.rel ? `${esc(h.fromName || h.from)}'s ${esc(h.rel)}` : `reached from ${esc(h.fromName || h.from)}`;
    ctxEl.innerHTML = `<b>${esc(h.toName || name)}</b>: ${rel}${h.quote ? `<span class="q" title="${esc(h.quote)}">“${esc(h.quote)}”</span>` : ''}`;
    ctxEl.style.display = 'block';
  }

  // ---- two clocks ----
  function newClock(kind, note) { window.PTHopFast = true; clearInterval(HOP.tick); HOP.cur = { t0: performance.now(), kind, note, first: null, core: null, queued: null, gen: null, orig: null }; HOP.tick = setInterval(renderClock, 100); renderClock(); }
  function renderClock() {
    const c = HOP.cur;
    if (!c || REPLAY) { clockEl.style.display = 'none'; return; }
    const now = performance.now() - c.t0;
    const one = (name, v, cls = '') => `<span class="hc ${v == null ? 'live' : 'ok'} ${cls}">${name}<b>${v == null ? sec(now) : sec(v)}</b></span>`;
    let h = one('first tile', c.first) + one('core map', c.core);
    if (c.core != null && (c.queued != null || c.gen != null)) h += `<span class="hc dim" title="the slowest wave-1 agent: time waiting in the provider's queue, then time generating">${c.note ? 'was ' : ''}queue<b>${c.queued != null ? sec(c.queued) : '–'}</b>+ gen<b>${c.gen != null ? sec(c.gen) : '–'}</b></span>`;
    if (c.note) h += `<span class="hc dim"><b>${esc(c.note === 'saved map' ? 'saved' : c.note)}</b></span>`;
    clockEl.title = 'Two clocks, both from the click: first company tile on screen, and the core map (wave 1 read, financials and price in).';
    clockEl.innerHTML = h;
    clockEl.style.display = 'flex';
    if (c.core != null && c.first != null) { clearInterval(HOP.tick); HOP.tick = null; }
  }

  // ---- talking to the engine ----
  async function call(url) {
    const r = await fetch(url).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { setStatus(j.error || 'Could not hop'); clearInterval(HOP.tick); HOP.cur = null; renderClock(); return null; }
    return j;
  }
  async function hop(o) {
    if (REPLAY) return;
    const n = o.node, from = S.scan?.ticker || '';
    const rel = n && ((n.cl && GROUPS[n.cl] ? n.cl : null) || n.rel) || '';
    const quote = (n?.quotes || []).map(q => q.q).find(q => q && !isTableQuote(q)) || '';
    const name = o.name || o.ticker;
    q.value = name; items = []; renderSuggest(); q.blur();
    setStatus(`Hopping to ${name}…`, true);
    newClock('hop');
    const j = await call('api/hop?q=' + encodeURIComponent(o.private ? name : o.ticker) + '&from=' + encodeURIComponent(from) + '&fromName=' + encodeURIComponent(S.scan?.short || S.scan?.name || '') + '&rel=' + encodeURIComponent(rel) + '&quote=' + encodeURIComponent(quote) + (o.private ? '&private=1' : ''));
    if (j && j.same) { setStatus(''); HOP.cur = null; renderClock(); }
  }
  async function goTo(id) {
    if (REPLAY) return;
    const it = HOP.items.find(x => x.id === id);
    setStatus(`Back to ${it ? label(it) : 'the map'}…`, true);
    newClock('back', 'saved map');
    await call('api/hop/go?id=' + encodeURIComponent(id));
  }

  // ---- events ----
  const baseOnEvent = window.onEvent;
  window.onEvent = function (e) {
    const out = baseOnEvent.apply(this, arguments);
    try { onHopEvent(e); } catch (err) { console.error(err); }
    return out;
  };
  function onHopEvent(e) {
    const c = HOP.cur;
    switch (e.type) {
      case 'trail': HOP.items = e.items || []; HOP.active = e.active; renderTrail(); break;
      case 'ask':
        if (e.mode) break;
        if (e.hop) {
          renderCtx(e.hop, e.name ? pretty0(e.name) : e.ticker);
          if (!HOP.cur) newClock('remote'); // started elsewhere (the chat, another tab)
          HOP.cur.note = e.hop.prefetched ? 'prefetched' : HOP.cur.kind === 'back' ? 'saved map' : '';
        } else { renderCtx(null); if (HOP.cur?.kind !== 'back') { HOP.cur = null; window.PTHopFast = false; } }
        document.body.classList.remove('done');
        renderClock();
        break;
      case 'finding':
        if (c && c.first == null && e.f && e.f.k === 'company') { c.first = performance.now() - c.t0; renderClock(); }
        break;
      case 'core':
        if (c && c.core == null) { c.core = performance.now() - c.t0; c.queued = e.queuedMs; c.gen = e.genMs; if (c.first == null) c.first = c.core; renderClock(); }
        break;
      case 'profile': if (e.private && e.summary) { const it = ctxEl.querySelector('.q'); ctxEl.dataset.priv = e.summary; if (!it) { ctxEl.insertAdjacentHTML('beforeend', `<span class="q" title="${esc(e.summary)}">${esc(e.summary)}</span>`); } } break;
      case 'resumed': document.body.classList.remove('done'); AG.el?.classList.remove('idle'); setStatus('Resuming the remaining waves…', true); break;
      case 'end': setStatus(''); window.PTHopFast = false; break;
    }
  }
  const pretty0 = n => String(n).replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => a + b.toLowerCase());

  // opening a company popup tells the engine which hop to prefetch
  const baseModal = window.companyModal;
  window.companyModal = function (n, refresh) {
    if (!refresh && !REPLAY && n && n.ticker && n !== S.root && HOP.items.length < 12) fetch('api/hop/hint?ticker=' + encodeURIComponent(n.ticker)).catch(() => {});
    return baseModal.apply(this, arguments);
  };

  // a page reload keeps the trail: it lives on the server
  if (!REPLAY) fetch('api/hop/state').then(r => r.json()).then(j => { if (!HOP.items.length) { HOP.items = j.trail || []; HOP.active = j.active; renderTrail(); } }).catch(() => {});
  window.PTHop = { hop, goTo, state: HOP };
})();
