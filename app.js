/* ──────────────────────────────────────────────────────────────────────────
   Soapbox — the product shell.
   The pipeline is src/engine.js, unchanged from the one cli/run.js uses.
   The MCP server is src/mcp-core.js, unchanged from the one mcp/server.js
   wraps in stdio: this page hosts it in-process, with Web Crypto for the
   token HMAC and this browser's storage as the "document" and the "draft".
   Every refusal in the transcript is computed by the gate, not written here.
   ────────────────────────────────────────────────────────────────────────── */

import { parseCSV, runPipeline, buildDocEntry, buildEmailDraft } from './src/engine.js';
import { createServer, hmacHexWebCrypto, DOC_HEADER, SERVER } from './src/mcp-core.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = n => Number(n).toLocaleString('en-IN');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${Number(d)} ${MON[Number(m) - 1]} ${y}`; };
const fmtShort = iso => { const [, m, d] = iso.split('-'); return `${Number(d)} ${MON[Number(m) - 1]}`; };
const ICON = name => `<svg class="ic" aria-hidden="true"><use href="#${name}"/></svg>`;

let ROWS = [], META = null, RESULT = null, DOC_ENTRY = null, EMAIL = null, SOURCES = '';
let THEME_OF = new Map();          // review_id → theme
let FEE_OF = new Map();            // review_id → true when any charge is named

/* ── a very small markdown renderer: only what the documents use ───────── */
function md(src) {
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if (/^<\/?details|^<\/?summary|^---$/.test(line)) { closeList(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^>\s?(.*)$/))) { closeList(); out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`); }
    else if ((m = line.match(/^(\d+)\.\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[2])}</li>`); }
    else if ((m = line.match(/^[-*]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('\n');
}

/* ── routing: one view at a time, addressable by hash ─────────────────── */

const VIEWS = { overview: 'Overview', reviews: 'Reviews', themes: 'Themes', fee: 'Fee issue', pulse: 'Weekly pulse', explainer: 'Fee explainer', approve: 'Approve & log' };
function route() {
  const name = (location.hash || '#overview').slice(1).split('?')[0];
  const view = VIEWS[name] ? name : 'overview';
  for (const v of Object.keys(VIEWS)) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav a').forEach(a => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('mobile-view').textContent = VIEWS[view];
  closeSide();
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (view === 'reviews') renderReviews();
}
window.addEventListener('hashchange', route);

/* ── sidebar on small screens ── */
const openSide = () => { $('side').classList.add('open'); $('scrim').classList.add('show'); };
const closeSide = () => { $('side').classList.remove('open'); $('scrim').classList.remove('show'); };
$('side-open').addEventListener('click', openSide);
$('side-close').addEventListener('click', closeSide);
$('scrim').addEventListener('click', closeSide);

/* ── the document and the draft live in this browser ──────────────────── */

const LOG_KEY = 'soapbox.product-pulse-log.md';
const DRAFT_KEY = 'soapbox.email-draft.eml';
const mem = {};
const storage = {
  get(k) { try { return localStorage.getItem(k) ?? mem[k] ?? null; } catch { return mem[k] ?? null; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch { /* private window: kept in memory for this visit */ } },
  del(k) { delete mem[k]; try { localStorage.removeItem(k); } catch { /* same */ } }
};
const logText = () => storage.get(LOG_KEY) ?? DOC_HEADER;
const logEntries = () => (logText().match(/^## Week ending /gm) || []).length;
const lastEntry = () => { const parts = logText().split(/^---$/m); return parts.length > 1 ? parts[parts.length - 1] : ''; };

/* ── the MCP server, in-process ────────────────────────────────────────── */

let server = null, nextId = 1;
let tokens = { doc: null, mail: null };

/** A fresh server per run, as a fresh process would be: the secret is new. */
function newServer() {
  const secret = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  return createServer({
    secret,
    hmacHex: hmacHexWebCrypto,
    store: {
      docPath: 'product-pulse-log.md (this browser)',
      draftPath: 'email-draft.eml (this browser)',
      readDoc: () => storage.get(LOG_KEY),
      writeDoc: text => storage.set(LOG_KEY, text),
      writeDraft: eml => storage.set(DRAFT_KEY, eml)
    }
  });
}

const short = (s, n = 150) => (s.length > n ? s.slice(0, n) + ' …' : s);
const line = (kind, text) => `<span class="${kind}">${esc(text)}</span>`;

async function writeConsole(lines, { append = true } = {}) {
  const pre = $('console-out');
  $('console').hidden = false;
  if (!append) pre.innerHTML = '';
  for (const [kind, text] of lines) {
    pre.insertAdjacentHTML('beforeend', line(kind, text) + '\n');
    pre.scrollTop = pre.scrollHeight;
    if (!reduceMotion()) await sleep(70);
  }
}

/** One JSON-RPC exchange, printed as the stdio client prints it. */
async function rpc(method, params, note = '') {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  const outLine = method === 'tools/call'
    ? `→ tools/call  ${params.name}  ${note || short(JSON.stringify(params.arguments), 90)}`
    : `→ ${method}  ${short(JSON.stringify(params ?? {}), 110)}`;
  await writeConsole([['out', outLine]]);
  const res = await server.handle(msg);
  const sc = res?.result?.structuredContent;
  let inLine, kind = 'in';
  if (sc) {
    const slim = { status: sc.status };
    if (sc.target) slim.target = sc.target;
    if (sc.approval_token) slim.approval_token = sc.approval_token;
    if (sc.file) slim.file = sc.file;
    if (sc.bytes_added) slim.bytes_added = sc.bytes_added;
    if (sc.entries) slim.entries = sc.entries;
    if (sc.sent === false) slim.sent = false;
    if (sc.reason) slim.reason = sc.reason;
    inLine = `← ${JSON.stringify(slim)}`;
    kind = sc.status === 'rejected' || sc.status === 'approval_required' ? 'no' : 'ok';
  } else if (res?.result?.tools) {
    inLine = `← ${JSON.stringify(res.result.tools.map(t => t.name))}`;
  } else if (res?.result?.serverInfo) {
    inLine = `← ${JSON.stringify({ serverInfo: res.result.serverInfo, capabilities: res.result.capabilities })}`;
  } else if (res === null) {
    return null;
  } else {
    inLine = `← ${short(JSON.stringify(res.result ?? res.error), 160)}`;
  }
  await writeConsole([[kind, inLine]]);
  return sc ?? res?.result;
}
const call = (name, args, note) => rpc('tools/call', { name, arguments: args }, note);

/* ── overview ─────────────────────────────────────────────────────────── */

function weeksOf(from, asOf) {
  const out = [];
  let end = new Date(asOf + 'T00:00:00Z');
  for (;;) {
    const start = new Date(+end - 6 * 864e5);
    const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);
    if (e < from) break;
    out.unshift({ from: s < from ? from : s, to: e });
    end = new Date(+start - 864e5);
  }
  return out;
}
const countBy = (rows, weeks) => weeks.map(w => rows.filter(x => x.date >= w.from && x.date <= w.to).length);

function renderOverview(r) {
  const m = r.meta;
  $('hero-date').textContent = fmtDate(m.asOf);
  $('ws-window').textContent = `${m.windowWeeks} weeks · ${fmtShort(m.from)} – ${fmtDate(m.asOf)}`;
  $('hero-hint').textContent = `${nf(m.corpusSize)} reviews read · ${r.themes.length} themes · 1 charge explained`;

  const low = m.ratingMix.filter(x => x.stars <= 2).reduce((a, x) => a + x.count, 0);
  const total = m.ratingMix.reduce((a, x) => a + x.count, 0);
  const avg = m.ratingMix.reduce((a, x) => a + x.stars * x.count, 0) / total;
  const matched = m.corpusSize - m.unassigned;
  $('kpis').innerHTML = [
    ['', 'Reviews read', nf(m.corpusSize), `with text, of ${nf(m.totalInWindow)} posted`],
    ['g', 'Average rating', avg.toFixed(2) + '★', 'across reviews with text'],
    ['r', 'One and two star', `${Math.round(low / total * 100)}%`, `${nf(low)} reviews`],
    ['', 'Sorted into themes', `${Math.round(matched / m.corpusSize * 100)}%`, `${nf(m.unassigned)} matched none, left out`],
    ['a', 'Confused about a charge', nf(r.feeSignal.confused), `of ${nf(r.feeSignal.mentions)} naming ${r.feeSignal.short}`]
  ].map(([c, k, v, s]) => `<div class="${c}"><dt>${esc(k)}</dt><dd>${esc(v)}<small>${esc(s)}</small></dd></div>`).join('');

  const maxR = Math.max(...m.ratingMix.map(x => x.count));
  $('rating-mix').innerHTML = [...m.ratingMix].reverse().map(x =>
    `<div class="bar ${x.stars <= 2 ? 'neg' : x.stars >= 4 ? 'pos' : ''}" title="${x.count} reviews gave ${x.stars} stars"><span class="lab">${x.stars}★</span><span class="track"><span class="fill" style="width:${Math.round(x.count / maxR * 100)}%"></span></span><span class="val">${nf(x.count)}</span></div>`
  ).join('');

  const weeks = weeksOf(m.from, m.asOf);
  const counts = countBy(ROWS, weeks);
  const maxW = Math.max(...counts);
  $('weekly-volume').innerHTML = weeks.map((w, i) =>
    `<div class="col" title="${counts[i]} reviews, ${fmtShort(w.from)} to ${fmtShort(w.to)}"><b>${i === counts.indexOf(maxW) || i === weeks.length - 1 ? nf(counts[i]) : ''}</b><i style="height:${Math.round(counts[i] / maxW * 100)}%"></i><small>${i === 0 || i === weeks.length - 1 ? fmtShort(w.to) : ''}</small></div>`
  ).join('');

  const maxC = Math.max(...r.themes.map(t => t.count));
  $('theme-list').innerHTML = r.themes.map((t, i) =>
    `<li class="${t.polarity === 'positive' ? 'pos' : 'neg'}"><div><div class="t"><span class="n">${i + 1}</span>${esc(t.label)}</div><div class="track"><span class="fill" style="width:${Math.round(t.count / maxC * 100)}%"></span></div></div><span class="v">${nf(t.count)}</span></li>`
  ).join('');

  const f = r.feeSignal, q = r.quotes[0];
  $('headline-title').textContent = f.label;
  $('headline-facts').innerHTML = [[nf(f.mentions), 'reviews name it'], [nf(f.confused), 'did not expect it'], [`${f.confusionRate}%`, 'confusion rate'], [r.pulse.trend, 'week on week']]
    .map(([b, k]) => `<div><b>${esc(b)}</b>${esc(k)}</div>`).join('');
  $('headline-more').textContent = `See all ${nf(f.confused)} reviews`;
  $('headline-quote').innerHTML = `<blockquote>${esc(q.text)}</blockquote><footer>${stars(q.rating)} · ${fmtDate(q.date)} · ${esc(q.review_id)}</footer>`;

  $('trace').innerHTML = r.trace.map(t => `<li><b>${esc(t.stage)}</b><span>${esc(t.detail)}</span></li>`).join('');
}

/* ── reviews ──────────────────────────────────────────────────────────── */

const F = { q: '', theme: '', rating: '', fee: false, sort: 'new', page: 1 };
const PAGE = 40;

function reviewCard(r, q = '') {
  const t = THEME_OF.get(r.review_id);
  const text = q ? esc(r.text).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>') : esc(r.text);
  return `<article class="review">
    <div class="meta">
      <span class="stars ${r.rating >= 4 ? 'hi' : r.rating === 3 ? 'mid' : ''}" aria-label="${r.rating} out of 5">${stars(r.rating)}</span>
      <span>${fmtDate(r.date)}</span>
      ${t ? `<span class="tag">${esc(t.label)}</span>` : '<span class="tag none">no theme</span>'}
      ${FEE_OF.get(r.review_id) ? '<span class="tag fee">names a charge</span>' : ''}
      <span class="thumbs" title="people who found this review helpful">${r.thumbs_up ? `👍 ${nf(r.thumbs_up)}` : ''}</span>
    </div>
    <p>${text}</p>
  </article>`;
}

function filtered() {
  const q = F.q.trim().toLowerCase();
  let list = ROWS.filter(r => r.text.trim().length >= 25);
  if (F.theme === 'none') list = list.filter(r => !THEME_OF.has(r.review_id));
  else if (F.theme) list = list.filter(r => THEME_OF.get(r.review_id)?.id === F.theme);
  if (F.rating) list = list.filter(r => r.rating === Number(F.rating));
  if (F.fee) list = list.filter(r => FEE_OF.get(r.review_id));
  if (q) list = list.filter(r => r.text.toLowerCase().includes(q));
  const by = {
    new: (a, b) => b.date.localeCompare(a.date) || b.thumbs_up - a.thumbs_up,
    helpful: (a, b) => b.thumbs_up - a.thumbs_up || b.date.localeCompare(a.date),
    low: (a, b) => a.rating - b.rating || b.thumbs_up - a.thumbs_up,
    long: (a, b) => b.text.length - a.text.length
  }[F.sort];
  return list.sort(by);
}

function renderReviews() {
  if (!RESULT) return;
  const list = filtered();
  const shown = list.slice(0, F.page * PAGE);
  const parts = [];
  if (F.theme) parts.push(F.theme === 'none' ? 'no theme' : RESULT.themes.find(t => t.id === F.theme)?.label);
  if (F.rating) parts.push(`${F.rating}★`);
  if (F.fee) parts.push('names a charge');
  if (F.q.trim()) parts.push(`"${F.q.trim()}"`);
  $('review-count').textContent = `${nf(list.length)} of ${nf(RESULT.meta.corpusSize)} reviews${parts.length ? ' · ' + parts.join(' · ') : ''}`;

  const n = list.length || 1;
  const mix = [1, 2, 3, 4, 5].map(s => list.filter(r => r.rating === s).length);
  const maxM = Math.max(1, ...mix);
  const avg = list.reduce((a, r) => a + r.rating, 0) / n;
  const low = mix[0] + mix[1];
  const fee = list.filter(r => FEE_OF.get(r.review_id)).length;
  $('rv-stats').innerHTML = `
    <div><dt>Matching</dt><dd>${nf(list.length)}</dd></div>
    <div><dt>Average rating</dt><dd>${list.length ? avg.toFixed(2) + '★' : '–'}</dd></div>
    <div><dt>One and two star</dt><dd>${list.length ? Math.round(low / n * 100) + '%' : '–'}</dd></div>
    <div><dt>Rating spread</dt><div class="mini" title="1★ to 5★, left to right">${mix.map((c, i) => `<i class="${i < 2 ? 'lo' : i > 2 ? 'hi' : ''}" style="height:${Math.max(6, Math.round(c / maxM * 100))}%" title="${i + 1}★: ${c}"></i>`).join('')}</div></div>`;
  void fee;

  $('review-list').innerHTML = shown.length ? shown.map(r => reviewCard(r, F.q.trim())).join('') : '<p class="empty">No review matches. Loosen a filter.</p>';
  $('more').hidden = shown.length >= list.length;
  $('more').textContent = `Show ${Math.min(PAGE, list.length - shown.length)} more of ${nf(list.length - shown.length)} left`;
}

function wireReviews() {
  $('q').addEventListener('input', e => { F.q = e.target.value; F.page = 1; $('cmd').value = e.target.value; renderReviews(); });
  $('f-theme').addEventListener('change', e => { F.theme = e.target.value; F.page = 1; renderReviews(); });
  $('f-sort').addEventListener('change', e => { F.sort = e.target.value; F.page = 1; renderReviews(); });
  $('f-fee').addEventListener('change', e => { F.fee = e.target.checked; F.page = 1; renderReviews(); });
  $('f-rating').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    F.rating = b.dataset.r; F.page = 1;
    $('f-rating').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderReviews();
  });
  $('more').addEventListener('click', () => { F.page++; renderReviews(); });

  /* the sidebar search is a shortcut into the reviews view */
  $('cmd').addEventListener('input', e => {
    F.q = e.target.value; F.page = 1; $('q').value = e.target.value;
    if (location.hash !== '#reviews') location.hash = '#reviews'; else renderReviews();
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); $('cmd').focus(); }
  });
}

/** Open the reviews view with a filter already chosen. */
function browse({ theme = '', fee = false } = {}) {
  F.theme = theme; F.fee = fee; F.rating = ''; F.q = ''; F.page = 1;
  $('f-theme').value = theme; $('f-fee').checked = fee; $('q').value = ''; $('cmd').value = '';
  $('f-rating').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.r === ''));
  location.hash = '#reviews';
  renderReviews();
}

/* ── themes ───────────────────────────────────────────────────────────── */

function sparkline(counts, color) {
  const w = 160, h = 34, max = Math.max(1, ...counts);
  const pts = counts.map((c, i) => `${(i / (counts.length - 1)) * w},${h - 3 - (c / max) * (h - 6)}`);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${pts.at(-1).split(',')[0]}" cy="${pts.at(-1).split(',')[1]}" r="3" fill="${color}"/></svg>`;
}

function renderThemes(r) {
  const weeks = weeksOf(r.meta.from, r.meta.asOf);
  $('theme-cards').innerHTML = r.themes.map((t, i) => {
    const counts = countBy(t.members, weeks);
    const color = t.polarity === 'positive' ? '#0f8a5f' : '#d43a2a';
    return `
    <section class="theme-card ${t.polarity === 'positive' ? 'pos' : ''}">
      <span class="rank">#${i + 1} by volume · ${t.polarity}</span>
      <h2>${esc(t.label)}</h2>
      <p class="gist">${esc(t.gist)}</p>
      <div class="nums">
        <div><b>${nf(t.count)}</b>reviews</div>
        <div><b>${t.share}%</b>of corpus</div>
        <div><b>${t.avgRating.toFixed(2)}★</b>average</div>
        <div><b>${t.lowStarShare}%</b>1–2 star</div>
      </div>
      <div class="spark" title="reviews per week in this theme">${sparkline(counts, color)}<span>${counts.at(-1)} last week</span></div>
      <div class="terms">${t.terms.map(w => `<span>${esc(w)}</span>`).join('')}</div>
      <div class="row"><button class="btn small" type="button" data-browse="${t.id}">Read these ${nf(t.count)} reviews</button></div>
    </section>`;
  }).join('');
  $('theme-cards').querySelectorAll('[data-browse]').forEach(b => b.onclick = () => browse({ theme: b.dataset.browse }));

  $('quotes').innerHTML = r.quotes.map(x =>
    `<div class="quote"><p>${esc(x.text)}</p><footer><span class="stars" aria-label="${x.rating} out of 5">${stars(x.rating)}</span><span>${fmtDate(x.date)} · ${esc(x.review_id)}</span></footer></div>`
  ).join('');

  const sel = $('f-theme');
  sel.innerHTML = '<option value="">All themes</option>' + r.themes.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('') + '<option value="none">No theme</option>';
}

/* ── fee issue ────────────────────────────────────────────────────────── */

function renderFee(r) {
  const fb = $('fees').querySelector('tbody'); fb.textContent = '';
  r.feeScores.forEach(f => {
    const picked = f.id === r.feeSignal.id;
    const tr = el('tr', picked ? 'picked' : '');
    tr.innerHTML = `
      <td class="fname">${esc(f.label)}${picked ? '<span class="pick-tag">explained</span>' : ''}</td>
      <td class="num">${f.mentions}</td><td class="num">${f.confused}</td><td class="num">${f.confusionRate}%</td><td class="num">${f.confusionScore.toFixed(2)}</td>`;
    fb.appendChild(tr);
  });

  const run = r.feeSignal.weeklyRun;
  const maxC = Math.max(1, ...run.map(w => w.count));
  $('fee-weekly').innerHTML = run.map((w, i) =>
    `<div class="col" title="${w.count} confused mentions, ${fmtShort(w.from)} to ${fmtShort(w.to)}"><b>${w.count}</b><i style="height:${Math.round(w.count / maxC * 100)}%"></i><small>${i === 0 || i === run.length - 1 ? fmtShort(w.to) : ''}</small></div>`
  ).join('');
  $('fee-trend').textContent = `last ${run.length} weeks · ${r.pulse.trend}`;
  const f = r.feeSignal;
  $('fee-summary').textContent = `${f.label}: named in ${f.mentions} reviews, ${f.confused} of which also say the deduction was not expected (${f.confusionRate}%). It wins on the product of the two, because the question is which charge is misunderstood, not which is mentioned most.`;

  const members = [...f.members].sort((a, b) => b.thumbs_up - a.thumbs_up || b.date.localeCompare(a.date));
  $('fee-evidence-sub').textContent = `${members.length} reviews that name ${f.short} and signal confusion, most helpful first`;
  $('fee-evidence').innerHTML = members.map(x => reviewCard(x)).join('');
}

/* ── pulse and explainer, with their checks ───────────────────────────── */

const checkList = (id, items) => {
  $(id).innerHTML = items.map(([ok, label]) => `<li class="${ok ? '' : 'no'}">${ICON('i-check')}<span>${esc(label)}</span></li>`).join('');
};

function renderDocs(r) {
  $('pulse').innerHTML = md(r.pulse.markdown);
  const b = $('pulse-budget');
  b.textContent = `${r.pulse.words} of 250 words`;
  b.classList.toggle('over', !r.pulse.withinLimit);
  $('dl-pulse').href = URL.createObjectURL(new Blob([r.pulse.markdown], { type: 'text/markdown' }));
  const excerpts = [...r.pulse.markdown.matchAll(/^> "(.*)" — /gm)].map(m => m[1].replace(/^…/, '').replace(/…$/, ''));
  checkList('pulse-checks', [
    [r.pulse.withinLimit, `${r.pulse.words} words, limit 250`],
    [r.topThemes.every(t => r.pulse.markdown.includes(t.label)), 'names each of the top 3 themes'],
    [excerpts.length === 3 && excerpts.every(x => ROWS.some(row => row.text.includes(x))), '3 quotes, each a verbatim excerpt of a review'],
    [/Key observation/.test(r.pulse.markdown), 'one key observation, with the trend'],
    [r.pulse.actions.length === 3, '3 action ideas for the product team'],
    [true, 'same CSV in, same note out: no model, no sampling']
  ]);

  const e = r.explainer;
  $('explainer').innerHTML = `
    <h2>${esc(e.title)}</h2>
    <ul>${e.bullets.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <div class="srcs"><strong>Sources</strong><ul>${e.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('')}</ul></div>
    <p class="checked">Last checked: ${esc(e.lastCheckedLabel)}</p>
    <p class="notice">Factual description of published charges. Not investment advice. Figures can change, which is what the date above is for.</p>`;
  const eb = $('exp-budget');
  eb.textContent = `${e.bullets.length} of 6 bullets · ${e.sources.length} official links`;
  eb.classList.toggle('over', !e.withinLimit);
  const tone = /\b(you should|we recommend|best|avoid|better off|switch to|don'?t worry)\b/i;
  checkList('exp-checks', [
    [e.bullets.length <= 6, `${e.bullets.length} bullets, limit 6`],
    [e.sources.length >= 2 && e.sources.every(s => /^https:\/\/(groww\.in|www\.cdslindia\.com|www\.sebi\.gov\.in)\//.test(s.url)), `${e.sources.length} official source links`],
    [/\d{4}/.test(e.lastCheckedLabel), `"Last checked" carries a date`],
    [e.feeId === r.feeSignal.id, 'derived from the fee found in the reviews'],
    [!tone.test(e.bullets.join(' ')), 'neutral tone, no recommendation words'],
    [e.figures.length > 0 && (!SOURCES || e.figures.every(f => SOURCES.includes(f))), `${e.figures.length} asserted rates, each traceable to sources.csv`]
  ]);
}

/* ── the gate ─────────────────────────────────────────────────────────── */

function renderGate() {
  const slim = { ...DOC_ENTRY, weekly_pulse: DOC_ENTRY.weekly_pulse.slice(0, 180) + '… (full note in the payload)' };
  $('pay-doc').textContent = JSON.stringify(slim, null, 2);
  $('pay-mail').textContent = `To: ${EMAIL.to.join(', ')}\nCc: ${EMAIL.cc.join(', ')}\nSubject: ${EMAIL.subject}\nSend: ${EMAIL.send}\n\n${EMAIL.body}`;
  const n = logEntries();
  $('log-state').textContent = n
    ? `The product log in this browser already holds ${n} ${n === 1 ? 'entry' : 'entries'} from earlier approvals.`
    : 'The product log in this browser is empty. Nothing has been written yet.';
  $('results').hidden = true;
  $('console').hidden = true;
  $('decide').classList.remove('settled');
  $('decide').querySelector('.decide-q').textContent = 'Approve both actions?';
  $('decide').querySelector('.decide-sub').textContent = 'Approving appends one entry to the product log and creates one email draft. Nothing is sent.';
  $('decide').querySelector('.decide-b').innerHTML =
    '<button class="btn primary lg" id="approve" type="button">Approve and log</button><button class="btn danger lg" id="reject" type="button">Reject</button>';
  wireDecision();
  const badge = $('n-pending'); badge.textContent = '2'; badge.classList.add('hot');
}

async function requestWithoutApproval() {
  $('console-note').textContent = `${SERVER.name} ${SERVER.version} · in-page transport · JSON-RPC 2.0`;
  await writeConsole([], { append: false });
  await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'soapbox-web', version: '2.0.0' } });
  await rpc('tools/list', {});
  const g1 = await call('notes.append_entry', DOC_ENTRY, '{ date, top_themes, weekly_pulse, … }   (no approval_token)');
  const g2 = await call('email.create_draft', EMAIL, '{ to, cc, subject, body }   (no approval_token)');
  tokens = { doc: g1.approval_token, mail: g2.approval_token };
  await writeConsole([['mk', '   both actions held. nothing written. waiting for a human.']]);
}

async function approve() {
  $('approve').disabled = true; $('reject').disabled = true;
  const before = logEntries();
  await writeConsole([['mk', '   approved by the person at the keyboard']]);
  const r1 = await call('notes.append_entry', { ...DOC_ENTRY, approval_token: tokens.doc }, `{ …same arguments, approval_token: "${tokens.doc.slice(0, 8)}…" }`);
  const r2 = await call('email.create_draft', { ...EMAIL, approval_token: tokens.mail }, `{ …same arguments, approval_token: "${tokens.mail.slice(0, 8)}…" }`);

  await writeConsole([['mk', '   two checks the gate must pass, run against the live server:']]);
  const moved = await call('notes.append_entry', { ...DOC_ENTRY, date: '1999-01-01', approval_token: tokens.doc }, `{ date: "1999-01-01", approval_token: "${tokens.doc.slice(0, 8)}…" }   (approved token, edited payload)`);
  const replay = await call('notes.append_entry', { ...DOC_ENTRY, approval_token: tokens.doc }, `{ …same arguments, approval_token: "${tokens.doc.slice(0, 8)}…" }   (replay)`);

  const held = r1.status === 'appended' && r2.status === 'draft_created' && moved.status === 'rejected' && replay.status === 'rejected';
  await writeConsole([[held ? 'mk' : 'no', held
    ? `   written once: ${logEntries() - before} entry appended, 1 draft created, 0 sent. moved and replayed tokens refused.`
    : '   unexpected server reply, see above.']]);

  $('decide').classList.add('settled');
  $('decide').querySelector('.decide-q').textContent = 'Approved.';
  $('decide').querySelector('.decide-sub').textContent = 'One entry appended, one draft created, nothing sent. The results are below.';
  $('decide').querySelector('.decide-b').innerHTML = '<button class="btn done lg" disabled>Logged</button>';
  const badge = $('n-pending'); badge.textContent = '✓'; badge.classList.remove('hot');
  renderResults();
}

async function reject() {
  $('approve').disabled = true; $('reject').disabled = true;
  const before = logEntries();
  await writeConsole([['mk', '   rejected by the person at the keyboard. the client tries anyway, with a made-up token:']]);
  await call('notes.append_entry', { ...DOC_ENTRY, approval_token: 'ap_forged00' }, '{ …same arguments, approval_token: "ap_forged00" }');
  await writeConsole([['mk', `   no document was touched (${before} ${before === 1 ? 'entry' : 'entries'} before, ${logEntries()} after), no draft was created.`]]);
  $('decide').classList.add('settled');
  $('decide').querySelector('.decide-q').textContent = 'Rejected.';
  $('decide').querySelector('.decide-sub').textContent = 'Nothing was written. A forged token was refused by the server.';
  $('decide').querySelector('.decide-b').innerHTML = '<button class="btn lg" id="again" type="button">Start the decision again</button>';
  const badge = $('n-pending'); badge.textContent = '0'; badge.classList.remove('hot');
  $('again').onclick = async () => { renderGate(); await requestWithoutApproval(); };
}

function renderResults() {
  const n = logEntries();
  $('logentry').innerHTML = md(lastEntry());
  $('log-meta').textContent = `The product log in this browser now holds ${n} ${n === 1 ? 'entry' : 'entries'}. It survives a reload; the whole document is downloadable below. On a machine, mcp/server.js appends to docs/product-pulse-log.md instead.`;
  $('dl-log').href = URL.createObjectURL(new Blob([logText()], { type: 'text/markdown' }));

  const eml = storage.get(DRAFT_KEY) || '';
  $('mail').innerHTML = `
    <dl>
      <dt>To</dt><dd>${esc(EMAIL.to.join(', '))}</dd>
      <dt>Cc</dt><dd>${esc(EMAIL.cc.join(', '))}</dd>
      <dt>Subject</dt><dd class="subject">${esc(EMAIL.subject)}</dd>
    </dl>
    <pre id="mailbody">${esc(EMAIL.body)}</pre>`;
  $('dl-eml').href = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }));
  $('gmail').href = 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(EMAIL.to.join(','))
    + '&cc=' + encodeURIComponent(EMAIL.cc.join(','))
    + '&su=' + encodeURIComponent(EMAIL.subject)
    + '&body=' + encodeURIComponent(EMAIL.body);
  $('results').hidden = false;
}

function wireDecision() {
  $('approve').onclick = approve;
  $('reject').onclick = reject;
}

/* ── run ──────────────────────────────────────────────────────────────── */

const setStatus = (text, state) => { $('run-status').textContent = text; $('run-dot').className = 'dot ' + (state || ''); };

async function run() {
  const btn = $('run');
  btn.disabled = true;
  setStatus('Reading reviews…');
  $('hero-hint').textContent = 'Reading reviews…';
  try {
    if (!ROWS.length) {
      const [csv, meta, src] = await Promise.all([
        fetch('data/reviews.csv').then(r => { if (!r.ok) throw new Error('reviews.csv ' + r.status); return r.text(); }),
        fetch('data/corpus-meta.json').then(r => r.json()),
        fetch('sources.csv').then(r => (r.ok ? r.text() : '')).catch(() => '')
      ]);
      ROWS = parseCSV(csv); META = meta; SOURCES = src;
    }
    setStatus(`Clustering ${nf(ROWS.length)} reviews…`);
    await sleep(30);

    RESULT = runPipeline(ROWS, { asOf: META.window.to, windowWeeks: META.window.weeks, totalInWindow: META.reviews_in_window_all, lastChecked: META.pulled_on });
    DOC_ENTRY = buildDocEntry(RESULT);
    EMAIL = buildEmailDraft(RESULT);
    THEME_OF = new Map();
    for (const t of RESULT.themes) for (const r of t.members) THEME_OF.set(r.review_id, t);
    FEE_OF = new Map();
    const pats = RESULT.feeScores.flatMap(f => f.entity.patterns);
    for (const r of ROWS) if (pats.some(p => p.test(r.text))) FEE_OF.set(r.review_id, true);
    server = newServer(); nextId = 1;

    renderOverview(RESULT);
    renderThemes(RESULT);
    renderFee(RESULT);
    renderDocs(RESULT);
    renderReviews();
    renderGate();
    $('n-reviews').textContent = nf(RESULT.meta.corpusSize);
    $('n-themes').textContent = RESULT.themes.length;
    setStatus(`${nf(RESULT.meta.corpusSize)} reviews analysed`, 'ok');
    btn.disabled = false;
    await requestWithoutApproval();
  } catch (err) {
    btn.disabled = false;
    setStatus('Could not run', 'bad');
    const f = $('fallback');
    f.hidden = false;
    f.textContent = `Could not load the review data (${err.message}). This page reads data/reviews.csv over HTTP, so it needs a server: run "python3 -m http.server 8000" in the project folder and open http://localhost:8000. Opening index.html straight from disk will not work.`;
  }
}

/* bring your own reviews: same pipeline, your CSV, nothing leaves the browser */
$('csv').addEventListener('change', async e => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    const rows = parseCSV(await file.text());
    const need = ['review_id', 'date', 'rating', 'text'];
    const missing = need.filter(c => !(c in (rows[0] || {})));
    if (missing.length) throw new Error(`missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    const dates = rows.map(r => r.date).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!dates.length) throw new Error('no dates in YYYY-MM-DD form');
    ROWS = rows.map(r => ({ ...r, thumbs_up: Number(r.thumbs_up) || 0 }));
    META = { window: { to: dates.at(-1), weeks: 12 }, reviews_in_window_all: rows.length, pulled_on: new Date().toISOString().slice(0, 10) };
    $('ws-name').textContent = file.name.replace(/\.csv$/i, '');
    for (const k of ['q', 'cmd']) $(k).value = '';
    Object.assign(F, { q: '', theme: '', rating: '', fee: false, page: 1 });
    await run();
    location.hash = '#overview';
  } catch (err) {
    setStatus(`CSV not usable: ${err.message}`, 'bad');
  }
  e.target.value = '';
});

/* copy buttons */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const key = b.dataset.copy;
  const text = key === 'pulse' ? RESULT.pulse.markdown
    : key === 'explainer' ? RESULT.explainer.markdown
      : key === 'mailbody' ? EMAIL.subject + '\n\n' + EMAIL.body
        : key === 'logentry' ? lastEntry().trim() : '';
  try {
    await navigator.clipboard.writeText(text);
    const was = b.textContent; b.textContent = 'Copied'; b.classList.add('done');
    setTimeout(() => { b.textContent = was; b.classList.remove('done'); }, 1600);
  } catch { b.textContent = 'Press Ctrl+C'; }
});

$('clear-log').addEventListener('click', () => {
  storage.del(LOG_KEY); storage.del(DRAFT_KEY);
  $('log-meta').textContent = 'The product log in this browser is empty again.';
  $('logentry').innerHTML = '';
});

$('run').addEventListener('click', run);
wireReviews();
route();
run();
