/* Pocket Terminal: Investigate (wave 17) and per-company News tagged good / bad.
   Loaded after wire.js. extra.js calls window.PTInvestigate.section / wire / onFinding / results.
   Everything here reads app.js globals at call time (S, esc, ic, chip, kpis, openModal, companyModal ...). */
'use strict';
window.PTInvestigate = (() => {
  const enc = encodeURIComponent;
  const words = (t, n) => String(t ?? '').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
  const spin = '<span class="ag-spin"></span>';
  const NEWS = new Map();          // company key -> { state: 'loading' | 'ready' | 'error', data, err }
  let LAST = null;                 // the node investigated last (Results opens it)
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateOf = d => { if (!d) return ''; const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d); return m ? `${MON[+m[2] - 1]} ${+m[3]}` : d; };
  const root = () => (typeof S !== 'undefined' ? S.root : null);
  const rootName = () => (S.scan?.short || S.scan?.name || root()?.name || 'the root');
  const isCommodityMap = () => S.scan?.kind === 'commodity';

  // ---------------------------------------------------------------- agents of one investigation
  const agentsOf = n => [...S.agents.values()].filter(a => a.wave === 17 && a.target === n);
  const liveOf = n => agentsOf(n).filter(a => a.state !== 'done' && a.state !== 'error');

  function thin(n) {
    const quotes = (n.quotes || []).filter(q => !isTableQuote(q.q)).length;
    const kind = n.ticker ? 'public' : isAnon(n.name) || n.kind === 'customer_hint' ? 'unnamed' : isCategory(n.name) ? 'category' : 'private';
    return { quotes, kind, thin: kind !== 'public' || quotes <= 1 };
  }
  function subLabel(n) {
    const t = thin(n);
    if (t.kind === 'unnamed') return `Unnamed party: ${t.quotes} quote${t.quotes === 1 ? '' : 's'}, who is it?`;
    if (t.kind === 'category') return `A category, not a company: ${t.quotes} quote${t.quotes === 1 ? '' : 's'}`;
    if (t.thin) return `Little is known: ${t.quotes} quote${t.quotes === 1 ? '' : 's'}, ${t.kind}`;
    return `Dig deeper: ${t.quotes} quotes, ${t.kind}`;
  }

  // ---------------------------------------------------------------- the Investigate button and block
  function agentDots(list) {
    return `<span class="ivd">${list.map(a => `<i class="${a.state === 'done' ? 'on' : a.state === 'error' ? 'er' : a.state === 'live' ? 'lv' : ''}" title="${esc(a.label || '')}"></i>`).join('')}</span>`;
  }
  function button(n) {
    const ags = agentsOf(n), live = liveOf(n);
    const pending = n._invAt && (Date.now() - n._invAt < 5000 || S.phase !== 'done');
    if (live.length || pending) {
      const srcs = ags.filter(a => !/y$/.test(a.id)).length;
      return `<div class="ivrun">${spin}<div><b>${ags.length ? `${ags.length} agent${ags.length === 1 ? '' : 's'} reading ${srcs} source${srcs === 1 ? '' : 's'}` : 'Gathering sources…'}</b><span>${live.length ? `${live.length} still working` : 'starting'} · ${esc(n.name)}</span></div>${ags.length ? agentDots(ags) : ''}</div>`;
    }
    const e = n.enriched;
    return `<button class="ivb" data-inv="1" ${S.phase !== 'done' || REPLAY ? 'disabled' : ''}>${ic('target')}<div><b>${e ? 'Investigate again' : 'Investigate'}</b><span>${e ? `${e.sources?.length || 0} finding${e.sources?.length === 1 ? '' : 's'} · ${e.agents || 'several'} agent${e.agents === 1 ? '' : 's'} · refresh` : esc(subLabel(n))}</span></div><em>›</em></button>`;
  }

  const rel2 = r => ({ customer: 'Customer', supplier: 'Supplier', competitor: 'Competitor', partner: 'Partner', investor: 'Investor', subsidiary: 'Subsidiary', parent: 'Parent', other: 'Connected' })[r] || 'Connected';
  const confPill = c => `<span class="ivc ${esc(c || 'low')}">${esc(c || 'low')} confidence</span>`;

  function block(n, big) {
    const e = n.enriched; if (!e) return '';
    const rt = e.relationship || {};
    let h = `<div class="ivx"><h5>${ic('target')} Investigation <span>${esc(e.sources?.length || 0)} findings${e.leads?.length ? ` · ${e.leads.length} added to the map` : ''}</span></h5>`;
    if (e.what) h += `<p class="one">${esc(e.what)}</p>`;
    if (rt.toRoot) h += `<div class="ivrel"><span class="pl">${ic('link')} ${esc(rel2(rt.rel))} of ${esc(rootName())}</span>${confPill(rt.confidence)}<span class="ivt">${esc(rt.toRoot)}</span>${rt.evidence ? `<div class="fq2">“${esc(rt.evidence)}”</div>` : ''}</div>`;
    const pills = [];
    if (e.hq) pills.push(`<span class="pl">${ic('globe')} ${esc(e.hq)}</span>`);
    if (e.ownership) pills.push(`<span class="pl ${/^public/i.test(e.ownership) ? 'pub' : 'priv'}">${ic(/^public/i.test(e.ownership) ? 'globe' : 'lock')} ${esc(cap1(e.ownership))}</span>`);
    if (e.parent) pills.push(`<span class="pl">${ic('users')} Parent: ${esc(e.parent)}</span>`);
    if (e.tickerHint) pills.push(`<span class="pl pub">${ic('hash')} ${esc(e.tickerHint)}</span>`);
    if (pills.length) h += `<div class="pls">${pills.join('')}</div>`;
    const ks = [];
    if (e.employees) ks.push(['Employees', esc(num(e.employees))]);
    if (e.revenue) ks.push(['Revenue', esc(num(e.revenue))]);
    for (const f of (e.facts || []).slice(0, 4)) ks.push([esc(words(f.name, 4)), esc(num(f.value))]);
    if (ks.length) h += kpis(ks.slice(0, big ? 6 : 4));
    if (big && e.identity?.length) {
      h += `<div class="igc ivid"><h6>${ic('target')} Who is it? <em>${e.identity.length}</em></h6>${e.identity.map(c => `<div class="ivi">${chip(c.name, { ticker: c.ticker, q: c.why })}${confPill(c.confidence)}<span class="ivt">${esc(c.why || '')}</span></div>`).join('')}</div>`;
    }
    const cols = [];
    if (e.products?.length) cols.push(`<div class="igc"><h6>${ic('box')} Products</h6><div class="tg">${e.products.map(x => `<span>${esc(cap1(words(x, 6)))}</span>`).join('')}</div></div>`);
    for (const [k, t, i] of [['customers', 'Customers', 'users'], ['suppliers', 'Suppliers', 'truck'], ['competitors', 'Competitors', 'target']]) {
      if (e[k]?.length) cols.push(`<div class="igc"><h6>${ic(i)} ${t} <em>${e[k].length}</em></h6><div class="lcs">${e[k].map(x => chip(x)).join('')}</div></div>`);
    }
    if (e.risks?.length) cols.push(`<div class="igc"><h6>${ic('alert')} Risks</h6><div class="tg warn">${e.risks.map(x => `<span>${esc(cap1(words(x, 8)))}</span>`).join('')}</div></div>`);
    if (cols.length) h += `<div class="igg">${cols.join('')}</div>`;
    if (e.leads?.length) h += `<div class="igc"><h6>${ic('link')} Added to the map <em>${e.leads.length}</em></h6><div class="lcs">${e.leads.map(l => chip(l.name, { ticker: l.ticker, q: `${l.rel}: ${l.why}`, node: S.byId.get(l.node) })).join('')}</div></div>`;
    if (e.sources?.length) {
      const rows = e.sources.map(s => `<div class="ivs">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(words(s.label, 9))} ↗</a>` : `<b>${esc(words(s.label, 9))}</b>`}<span>${esc(s.says || '')}</span></div>`).join('');
      h += big ? `<h5>${ic('news')} Sources <span>${e.sources.length}</span></h5>${rows}` : `<details class="evd"><summary>Sources · ${e.sources.length} finding${e.sources.length === 1 ? '' : 's'}</summary>${rows}</details>`;
    }
    return h + '</div>';
  }

  // ---------------------------------------------------------------- news
  const keyOf = n => norm(n.name || '') + '|' + (n.ticker || '');
  const newsOk = n => n === root() ? !isCommodityMap() : n.kind === 'company' && !n.route && !isAnon(n.name) && !isCategory(n.name);
  const TAGS = { good: ['▲', 'good'], bad: ['▼', 'bad'], neutral: ['•', 'neutral'] };

  function newsInner(n) {
    const rec = NEWS.get(keyOf(n));
    let h = `<h5>${ic('news')} News <span>good / bad · red flags</span></h5>`;
    if (!rec || rec.state === 'loading') return h + `<div class="pf-load">${spin}Reading recent headlines for ${esc(n.name)}…</div>`;
    if (rec.state === 'error') return h + `<div class="xk dim">News unavailable: ${esc(rec.err)} <button class="ivl" data-newsretry="1">Retry</button></div>`;
    const d = rec.data, c = d.counts || {}, items = d.items || [];
    if (!items.length) return h + `<div class="xk dim">No headlines in the last 90 days.${d.error ? ' ' + esc(d.error) : ''}</div>`;
    const tab = rec.tab || 'all';
    const shown = items.filter(x => tab === 'all' ? true : tab === 'red' ? x.red : x.tag === tab);
    const lim = rec.all ? 40 : 8;
    h += `<div class="ivch"><span class="nc good">▲ ${c.good || 0} good</span><span class="nc bad">▼ ${c.bad || 0} bad</span><span class="nc red">⚑ ${c.red || 0} red flag${c.red === 1 ? '' : 's'}</span>${c.neutral ? `<span class="nc">${c.neutral} neutral</span>` : ''}</div>`;
    h += `<div class="xtabs ivtabs">${[['all', 'All', items.length], ['good', 'Good', c.good || 0], ['bad', 'Bad', c.bad || 0], ['red', 'Red flags', c.red || 0]].map(([k, t, v]) => `<button data-ntab="${k}" class="${tab === k ? 'on' : ''}">${t} <em>${v}</em></button>`).join('')}</div>`;
    if (d.error) h += `<div class="xk dim">${esc(d.error)}: tags below are unscored.</div>`;
    h += shown.length ? `<div class="ivn-l">${shown.slice(0, lim).map(x => {
      const t = TAGS[x.tag] || TAGS.neutral;
      return `<div class="nr"><span class="nd">${esc(dateOf(x.date))}</span><span class="nb">${esc(words(x.source, 3))}</span><a class="nt" href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a><span class="ntg ${t[1]}">${t[0]} ${t[1]}</span><span class="nk ${x.red ? 'red' : ''}">${x.red ? '⚑ ' : ''}${esc(String(x.kind).replace('_', ' '))}</span>${x.reason ? `<span class="nrs">${esc(x.reason)}</span>` : ''}</div>`;
    }).join('')}</div>${shown.length > lim ? `<button class="ivl" data-nmore="1">Show all ${shown.length}</button>` : ''}` : `<div class="xk dim">Nothing under this filter.</div>`;
    return h;
  }

  function paintNews(n) {
    const el = document.querySelector(`#modal .ivn[data-nk="${CSS.escape(keyOf(n))}"]`);
    if (!el) return;
    el.innerHTML = newsInner(n);
    wireNews(n, el);
  }
  function wireNews(n, el) {
    const rec = NEWS.get(keyOf(n));
    el.querySelectorAll('[data-ntab]').forEach(b => b.onclick = () => { rec.tab = b.dataset.ntab; rec.all = false; paintNews(n); });
    el.querySelector('[data-nmore]')?.addEventListener('click', () => { rec.all = true; paintNews(n); });
    el.querySelector('[data-newsretry]')?.addEventListener('click', () => { NEWS.delete(keyOf(n)); loadNews(n); });
  }
  async function loadNews(n) {
    if (!newsOk(n)) return;
    const k = keyOf(n);
    if (NEWS.has(k)) return;
    const rec = { state: 'loading' };
    NEWS.set(k, rec);
    try {
      const r = await fetch(`api/companynews?name=${enc(n.name)}&ticker=${enc(n.ticker || '')}&root=${enc(rootName())}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      rec.state = 'ready'; rec.data = j;
    } catch (e) { rec.state = 'error'; rec.err = String(e.message || e); }
    paintNews(n);
  }

  // ---------------------------------------------------------------- hooks called from extra.js
  function section(n) {
    let h = '';
    if (n !== root() && (n.kind === 'company' || n.kind === 'customer_hint') && !n.route) h += button(n) + block(n);
    if (newsOk(n)) h += `<div class="ivn" data-nk="${esc(keyOf(n))}">${newsInner(n)}</div>`;
    return h;
  }

  function wire(n, m) {
    m.querySelector('[data-inv]')?.addEventListener('click', () => start(n));
    const el = m.querySelector('.ivn');
    if (el) { wireNews(n, el); loadNews(n); }
    if (n._invAt && Date.now() - n._invAt < 5000) setTimeout(() => { if (MODAL_NODE === n) companyModal(n, true); }, 5200);
  }

  async function start(n) {
    if (REPLAY || S.phase !== 'done') { setStatus('Wait for the current agents to finish'); return; }
    n._invAt = Date.now(); LAST = n;
    companyModal(n, true);
    const ctx = (n.quotes || []).filter(q => q.q && !isTableQuote(q.q)).slice(0, 3).map(q => q.q);
    if (!ctx.length) { const d = [n.detail, n.desc, n.guess?.length ? 'The filing agent guessed: ' + n.guess.join(', ') : ''].filter(Boolean).join('. '); if (d) ctx.push(`${n.name}: ${d}`); }
    const qs = ctx.map(q => '&q=' + enc(q.slice(0, 400))).join('');
    const r = await fetch(`api/investigate?name=${enc(n.name)}&ticker=${enc(n.ticker || '')}${qs}`).catch(() => null);
    if (!r || !r.ok) { const j = r ? await r.json().catch(() => ({})) : {}; n._invAt = 0; setStatus(j.error || 'Could not start'); if (MODAL_NODE === n) companyModal(n, true); }
  }

  function targetOf(f, a) {
    if (a?.wave === 17 && a.target) return a.target;
    return (f.targetTicker && S.byTicker.get(String(f.targetTicker).toUpperCase())) || entityNode(f.target || f.name) || null;
  }

  function onFinding(f, e, a) {
    const n = targetOf(f, a);
    if (!n) return;
    LAST = n;
    if (f.k === 'source') { (n.invSources ||= []).push(f); }
    else if (f.k === 'lead') addLead(n, f);
    else if (f.k === 'enrich') applyEnrich(n, f);
    // tape + side panel + popup
    if (typeof tapeFinding === 'function') tapeFinding(e, a);
    renderSide();
    if (typeof MODAL_NODE !== 'undefined' && MODAL_NODE === n) companyModal(n, true);
  }

  function addLead(n, f) {
    const e = (n.enriched ||= { leads: [] });
    e.leads ||= [];
    const had = S.byId.has('co:' + companyKey(f.name)) || (f.ticker && S.byTicker.has(String(f.ticker).toUpperCase()));
    const node = companyNodeFor(f.name, f.ticker || null);
    if (!node || node === S.root || node === n) return;
    if (!had) {
      const rel = ['customer', 'supplier', 'competitor', 'partner'].includes(f.rel) ? f.rel : 'partner';
      node.rel = rel; node.relc = { [rel]: 1 }; node.color = COLORS[REL2CL[rel]] || node.color;
      node.mentions = 1; node.quotes ||= []; node.agents ||= new Set();
      if (f.why) node.quotes.push({ q: f.why, agent: 'investigation of ' + n.name, rel, from: n.name });
      node.desc ||= f.why;
      node.fromInvestigation = n.name;
      assignCluster(node);
      if (!node.ticker) setTimeout(() => lookupTicker(node), 50);
    }
    if (!e.leads.some(l => l.node === node)) e.leads.push({ name: f.name, ticker: f.ticker, rel: f.rel, why: f.why, node: node.id });
  }

  function applyEnrich(n, f) {
    const prev = n.enriched || {};
    const e = n.enriched = {
      what: f.what, relationship: f.relationship, hq: f.hq, ownership: f.ownership, parent: f.parent, employees: f.employees, revenue: f.revenue,
      products: f.products || [], customers: f.customers || [], suppliers: f.suppliers || [], competitors: f.competitors || [], risks: f.risks || [],
      facts: f.facts || [], identity: f.identity || [], sources: f.sources || [], leads: prev.leads || [], agents: agentsOf(n).length || prev.agents || null,
    };
    if (f.what) n.desc = f.what;
    // a ticker only when the company itself is public (a subsidiary's parent ticker is shown as a hint)
    const tk = String(f.ticker || '').toUpperCase();
    if (tk) {
      const own = /^public/i.test(f.ownership || '') || (!f.parent && !/subsidiary|private|government/i.test(f.ownership || ''));
      if (own) setTicker(n, tk); else e.tickerHint = (f.parent ? f.parent + ' · ' : '') + tk;
    }
    // improve the existing popup sections too
    const pf = n.profile;
    if (!pf) n.profile = { summary: f.what, products: e.products, customers: e.customers.map(x => ({ name: x })), suppliers: e.suppliers.map(x => ({ name: x })), competitors: e.competitors, risks: e.risks, facts: e.facts, enriched: true };
    else if (!pf.loading && !pf.error) {
      if (!pf.summary) pf.summary = f.what;
      for (const k of ['products', 'competitors', 'risks']) if (!pf[k]?.length && e[k].length) pf[k] = e[k];
      for (const k of ['customers', 'suppliers']) if (!pf[k]?.length && e[k].length) pf[k] = e[k].map(x => ({ name: x }));
      if (!pf.facts?.length && e.facts.length) pf.facts = e.facts;
    }
    if (e.identity.length) {
      n.cands ||= [];
      for (const c of e.identity) if (!n.cands.some(x => (x.ticker && c.ticker && x.ticker === c.ticker) || norm(x.name) === norm(c.name))) n.cands.push({ name: c.name, ticker: c.ticker, why: c.why });
      const top = e.identity.find(c => c.confidence === 'high');
      if (top && !n.resolved) n.resolved = { name: top.name, ticker: top.ticker, confidence: top.confidence, why: top.why };
    }
    n._invAt = 0;
  }

  function results() {
    const n = LAST && S.nodes.includes(LAST) && LAST.enriched ? LAST : [...S.nodes].reverse().find(x => x.enriched);
    if (!n) { openModal('Investigation', '<div class="empty">No investigation yet.</div>'); return; }
    const g = thin(n);
    openModal(`${esc(n.name)}${n.ticker ? ` <span class="tk2">${esc(n.ticker)}</span>` : ''}`, block(n, true) + (newsOk(n) ? `<div class="ivn" data-nk="${esc(keyOf(n))}">${newsInner(n)}</div>` : ''),
      `Investigation · ${esc(g.kind)} · in the ${esc(rootName())} map`);
    $('#modal .mo')?.classList.add('wide');
    const el = document.querySelector('#modal .ivn');
    if (el) { wireNews(n, el); loadNews(n); }
  }

  // Agents dock on companyNodeFor(name). An unnamed party ("Customer A") lives on the map as a customer_hint node, so
  // point that lookup at the existing tile instead of letting it create a second one (live and in replays).
  try {
    const orig = window.companyNodeFor;
    if (typeof orig === 'function' && !orig._pti) {
      const wrapped = function (name, ticker) {
        if (!ticker && name && !S.byId.has('co:' + companyKey(name))) {
          const k = norm(name);
          const hint = S.nodes.find(x => x.kind === 'customer_hint' && norm(x.name) === k);
          if (hint) return hint;
        }
        return orig.apply(this, arguments);
      };
      wrapped._pti = true;
      window.companyNodeFor = wrapped;
    }
  } catch {}

  return { section, wire, onFinding, results };
})();
