/* ──────────────────────────────────────────────────────────────────────────
   Nabz — prototype wiring.
   The pipeline is src/engine.js, unchanged from the one cli/run.js uses.
   The MCP server is src/mcp-core.js, unchanged from the one mcp/server.js
   wraps in stdio: this page hosts it in-process, with Web Crypto for the
   token HMAC and this browser's storage as the "document" and the "draft".
   So every refusal in the transcript below is computed by the gate, not
   written into this file.
   ────────────────────────────────────────────────────────────────────────── */

import { parseCSV, runPipeline, buildDocEntry, buildEmailDraft } from './src/engine.js';
import { createServer, hmacHexWebCrypto, DOC_HEADER, SERVER } from './src/mcp-core.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = n => n.toLocaleString('en-IN');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let RESULT = null, DOC_ENTRY = null, EMAIL = null;

/* ── a very small markdown renderer: only what the pulse uses ─────────── */
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

/* ── the document and the draft live in this browser ──────────────────── */

const LOG_KEY = 'nabz.product-pulse-log.md';
const DRAFT_KEY = 'nabz.email-draft.eml';
const mem = {};                                   // fallback when storage is blocked
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

function line(kind, text) {
  const cls = { out: 'out', in: 'in', ok: 'ok', no: 'no', mk: 'mk' }[kind];
  return `<span class="${cls}">${esc(text)}</span>`;
}

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

/* ── render ───────────────────────────────────────────────────────────── */

function show(id) { const s = $(id); s.hidden = false; s.classList.add('reveal'); }

async function renderTrace(r) {
  show('s-trace');
  const ol = $('trace'); ol.textContent = '';
  for (const t of r.trace) {
    const li = el('li', 'in', `<b>${esc(t.stage)}</b> &nbsp;${esc(t.detail)}`);
    ol.appendChild(li);
    await sleep(reduceMotion() ? 0 : 130);
  }
}

function renderIntel(r) {
  const m = r.meta;
  $('stats').textContent = '';
  const low = m.ratingMix.filter(x => x.stars <= 2).reduce((a, x) => a + x.count, 0);
  [
    ['Reviews with text, analysed', nf(m.corpusSize), ''],
    ['Window', String(m.windowWeeks), 'weeks'],
    ['One and two star', nf(low), `of ${nf(m.corpusSize)}`],
    ['Matched no theme', nf(m.unassigned), `${Math.round(m.unassigned / m.corpusSize * 100)}%`],
    ['Charge reviews signalling confusion', nf(r.feeSignal.confused), `of ${nf(r.feeSignal.mentions)}`]
  ].forEach(([k, v, s]) => {
    const d = el('div');
    d.appendChild(el('dt', null, esc(k)));
    d.appendChild(el('dd', null, `${esc(v)}${s ? `<small>${esc(s)}</small>` : ''}`));
    $('stats').appendChild(d);
  });

  const maxC = Math.max(...r.themes.map(t => t.count));
  const tb = $('themes').querySelector('tbody'); tb.textContent = '';
  r.themes.forEach((t, i) => {
    const tr = el('tr', `${t.polarity === 'positive' ? 'pos' : 'neg'}${i < 3 ? ' is-top' : ''}`);
    tr.innerHTML = `
      <td><span class="rank">${i + 1}</span><span class="tname">${esc(t.label)}</span><span class="tgist">${esc(t.gist)}</span></td>
      <td class="num">${nf(t.count)}</td>
      <td class="num bar-cell">${t.share}%<span class="bar-fill" style="width:${Math.round(t.count / maxC * 100)}%"></span></td>
      <td class="num">${t.avgRating.toFixed(2)}</td>
      <td class="terms">${esc(t.terms.join('  '))}</td>`;
    tb.appendChild(tr);
  });

  const fb = $('fees').querySelector('tbody'); fb.textContent = '';
  r.feeScores.forEach(f => {
    const picked = f.id === r.feeSignal.id;
    const tr = el('tr', picked ? 'picked' : '');
    tr.innerHTML = `
      <td class="fname">${esc(f.label)}${picked ? '<span class="pick-tag">explained below</span>' : ''}</td>
      <td class="num">${f.mentions}</td>
      <td class="num">${f.confused}</td>
      <td class="num">${f.confusionRate}%</td>
      <td class="num">${f.confusionScore.toFixed(2)}</td>`;
    fb.appendChild(tr);
  });

  const q = $('quotes'); q.textContent = '';
  r.quotes.forEach(x => {
    const c = el('div', 'quote');
    c.innerHTML = `<p>${esc(x.text)}</p><footer><span class="stars" aria-label="${x.rating} out of 5">${stars(x.rating)}</span><span>${esc(x.date)} · ${esc(x.review_id)}</span></footer>`;
    q.appendChild(c);
  });
  show('s-intel');
}

function renderOutputs(r) {
  $('pulse').innerHTML = md(r.pulse.markdown);
  const b = $('pulse-budget');
  b.textContent = `${r.pulse.words} of 250 words`;
  b.classList.toggle('over', !r.pulse.withinLimit);
  $('dl-pulse').href = URL.createObjectURL(new Blob([r.pulse.markdown], { type: 'text/markdown' }));
  show('s-pulse');

  const e = r.explainer;
  $('explainer').innerHTML = `
    <h2>${esc(e.title)}</h2>
    <ul>${e.bullets.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <div class="srcs"><strong>Sources</strong><ul>${e.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('')}</ul></div>
    <p class="checked">Last checked: ${esc(e.lastCheckedLabel)}</p>
    <p class="notice">Factual description of published charges. Not investment advice. Figures can change, which is what the date above is for.</p>`;
  const eb = $('exp-budget');
  eb.textContent = `${e.bullets.length} of 6 bullets, ${e.sources.length} official links`;
  eb.classList.toggle('over', !e.withinLimit);
  show('s-explainer');
}

function renderGate() {
  const slim = { ...DOC_ENTRY, weekly_pulse: DOC_ENTRY.weekly_pulse.slice(0, 180) + '… (full note in the payload)' };
  $('pay-doc').textContent = JSON.stringify(slim, null, 2);
  $('pay-mail').textContent = `To: ${EMAIL.to.join(', ')}\nCc: ${EMAIL.cc.join(', ')}\nSubject: ${EMAIL.subject}\nSend: ${EMAIL.send}\n\n${EMAIL.body}`;
  $('log-state').textContent = logEntries()
    ? `The product log in this browser already holds ${logEntries()} ${logEntries() === 1 ? 'entry' : 'entries'} from earlier approvals.`
    : 'The product log in this browser is empty. Nothing has been written yet.';
  show('s-gate');
  show('colophon');
}

/* ── the exchange ─────────────────────────────────────────────────────── */

async function requestWithoutApproval() {
  $('console-note').textContent = `${SERVER.name} ${SERVER.version}, in-page transport, JSON-RPC 2.0`;
  await writeConsole([], { append: false });
  await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'nabz-web', version: '1.1.0' } });
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
  $('decide').querySelector('.decide-q').textContent = 'Approved. One entry appended, one draft created, nothing sent.';
  $('decide').querySelector('.decide-b').innerHTML = '<button class="btn done" disabled>Logged</button>';

  renderResults();
}

async function reject() {
  $('approve').disabled = true; $('reject').disabled = true;
  const before = logEntries();
  await writeConsole([['mk', '   rejected by the person at the keyboard. the client tries anyway, with a made-up token:']]);
  await call('notes.append_entry', { ...DOC_ENTRY, approval_token: 'ap_forged00' }, '{ …same arguments, approval_token: "ap_forged00" }');
  await writeConsole([['mk', `   no document was touched (${before} ${before === 1 ? 'entry' : 'entries'} before, ${logEntries()} after), no draft was created.`]]);
  $('decide').classList.add('settled');
  $('decide').querySelector('.decide-q').textContent = 'Rejected. Nothing was written.';
  $('decide').querySelector('.decide-b').innerHTML = '<button class="btn" id="again">Start the decision again</button>';
  $('again').onclick = async () => {
    $('decide').classList.remove('settled');
    $('decide').querySelector('.decide-q').textContent = 'Approve both actions?';
    $('decide').querySelector('.decide-b').innerHTML =
      '<button class="btn primary" id="approve">Approve and log</button><button class="btn danger" id="reject">Reject</button>';
    wireDecision();
    await requestWithoutApproval();
  };
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
      <dt>Status</dt><dd><span class="draft-flag">Draft, not sent</span></dd>
    </dl>
    <pre id="mailbody">${esc(EMAIL.body)}</pre>`;
  $('dl-eml').href = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }));
  $('gmail').href = 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(EMAIL.to.join(','))
    + '&cc=' + encodeURIComponent(EMAIL.cc.join(','))
    + '&su=' + encodeURIComponent(EMAIL.subject)
    + '&body=' + encodeURIComponent(EMAIL.body);

  $('results').hidden = false;
  $('results').classList.add('reveal');
}

function wireDecision() {
  $('approve').onclick = approve;
  $('reject').onclick = reject;
}

/* ── run ──────────────────────────────────────────────────────────────── */

async function run() {
  const btn = $('run');
  btn.disabled = true; btn.textContent = 'Reading reviews…';
  try {
    const [csv, meta] = await Promise.all([
      fetch('data/reviews.csv').then(r => { if (!r.ok) throw new Error('reviews.csv ' + r.status); return r.text(); }),
      fetch('data/corpus-meta.json').then(r => r.json())
    ]);
    const rows = parseCSV(csv);
    btn.textContent = `Clustering ${nf(rows.length)} reviews…`;
    await sleep(40);

    RESULT = runPipeline(rows, {
      asOf: meta.window.to,
      windowWeeks: meta.window.weeks,
      totalInWindow: meta.reviews_in_window_all,
      lastChecked: meta.pulled_on
    });
    DOC_ENTRY = buildDocEntry(RESULT);
    EMAIL = buildEmailDraft(RESULT);
    server = newServer(); nextId = 1;

    $('bar-note').textContent = `Groww, Google Play, ${meta.window.weeks} weeks to ${meta.window.to}`;
    $('hero-hint').textContent = `${nf(RESULT.meta.corpusSize)} reviews analysed, ${RESULT.themes.length} themes, 1 fee issue`;
    btn.textContent = 'Run again';
    btn.disabled = false;

    $('results').hidden = true;
    $('decide').classList.remove('settled');
    $('decide').querySelector('.decide-q').textContent = 'Approve both actions?';
    $('decide').querySelector('.decide-b').innerHTML =
      '<button class="btn primary" id="approve">Approve and log</button><button class="btn danger" id="reject">Reject</button>';

    await renderTrace(RESULT);
    renderIntel(RESULT);
    renderOutputs(RESULT);
    renderGate();
    wireDecision();
    await requestWithoutApproval();
    $('s-gate').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    btn.textContent = 'Run the analysis'; btn.disabled = false;
    const f = $('fallback');
    f.hidden = false;
    f.textContent = `Could not load the review data (${err.message}). This page reads data/reviews.csv over HTTP, so it needs a server: run "python3 -m http.server 8000" in the project folder and open http://localhost:8000. Opening index.html straight from disk will not work.`;
  }
}

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
