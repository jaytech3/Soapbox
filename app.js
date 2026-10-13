/* ──────────────────────────────────────────────────────────────────────────
   Nabz — prototype wiring.
   The pipeline is src/engine.js, unchanged from the one cli/run.js uses.
   This file only loads the CSV, reveals the result, and plays the part of an
   MCP client so the approval gate can be seen and used in a browser. The
   real server is mcp/server.js; the transcript below mirrors its messages.
   ────────────────────────────────────────────────────────────────────────── */

import { parseCSV, runPipeline, buildDocEntry, buildEmailDraft } from './src/engine.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = n => n.toLocaleString('en-IN');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);

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
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^>\s?(.*)$/))) { closeList(); out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`); }
    else if ((m = line.match(/^(\d+)\.\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[2])}</li>`); }
    else if ((m = line.match(/^[-*]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('\n');
}

/* ── render ───────────────────────────────────────────────────────────── */

function show(id) { const s = $(id); s.hidden = false; s.classList.add('reveal'); }

async function renderTrace(r) {
  show('s-trace');
  const ol = $('trace'); ol.textContent = '';
  for (const t of r.trace) {
    const li = el('li', 'in', `<b>${esc(t.stage)}</b> &nbsp;${esc(t.detail)}`);
    ol.appendChild(li);
    await sleep(window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 130);
  }
}

function renderIntel(r) {
  const m = r.meta;
  $('stats').textContent = '';
  const low = m.ratingMix.filter(x => x.stars <= 2).reduce((a, x) => a + x.count, 0);
  [
    ['Reviews with text, analysed', nf(m.corpusSize), ''],
    ['Window', '12', 'weeks'],
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
  show('s-gate');
  show('colophon');
}

/* ── the MCP exchange, as the server would answer it ──────────────────── */

const TOKEN = () => 'ap_' + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
let tokens = { doc: null, mail: null }, spent = new Set();

function line(kind, text) {
  const cls = { out: 'out', in: 'in', ok: 'ok', no: 'no', mk: 'mk' }[kind];
  return `<span class="${cls}">${esc(text)}</span>`;
}

async function writeConsole(lines, { append = false } = {}) {
  const pre = $('console-out');
  $('console').hidden = false;
  if (!append) pre.innerHTML = '';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const [kind, text] of lines) {
    pre.insertAdjacentHTML('beforeend', line(kind, text) + '\n');
    pre.scrollTop = pre.scrollHeight;
    if (!reduce) await sleep(70);
  }
}

async function requestWithoutApproval() {
  tokens = { doc: TOKEN(), mail: TOKEN() };
  $('console-note').textContent = 'stdio, JSON-RPC 2.0';
  await writeConsole([
    ['out', '→ initialize  {"protocolVersion":"2024-11-05","clientInfo":{"name":"nabz-web"}}'],
    ['in', '← {"serverInfo":{"name":"nabz-mcp","version":"1.0.0"},"capabilities":{"tools":{}}}'],
    ['out', '→ tools/list'],
    ['in', '← ["notes.append_entry","email.create_draft"]'],
    ['out', '→ tools/call  notes.append_entry  (no approval_token)'],
    ['no', `← {"status":"approval_required","target":"docs/product-pulse-log.md","approval_token":"${tokens.doc}"}`],
    ['out', '→ tools/call  email.create_draft  (no approval_token)'],
    ['no', `← {"status":"approval_required","target":"out/email-draft.eml","approval_token":"${tokens.mail}"}`],
    ['mk', '   both actions held. waiting for a human.']
  ]);
}

async function approve() {
  $('approve').disabled = true; $('reject').disabled = true;
  await writeConsole([
    ['mk', '   approved by the person at the keyboard'],
    ['out', `→ tools/call  notes.append_entry  {"approval_token":"${tokens.doc}", …}`],
    ['ok', '← {"status":"appended","file":"docs/product-pulse-log.md","bytes_added":3364,"entry_heading":"Week ending 2026-10-12"}'],
    ['out', `→ tools/call  email.create_draft  {"approval_token":"${tokens.mail}", …}`],
    ['ok', '← {"status":"draft_created","sent":false,"file":"out/email-draft.eml"}'],
    ['out', `→ tools/call  notes.append_entry  {"approval_token":"${tokens.doc}", …}   (replay)`],
    ['no', '← {"status":"rejected","reason":"This approval was already used. Approvals are single-use."}']
  ], { append: true });
  spent.add(tokens.doc);

  $('decide').classList.add('settled');
  $('decide').querySelector('.decide-q').textContent = 'Approved. One entry appended, one draft created, nothing sent.';
  $('decide').querySelector('.decide-b').innerHTML = '<button class="btn done" disabled>Logged</button>';

  const d = DOC_ENTRY;
  $('logentry').innerHTML = md(`## Week ending ${d.date}

**Top themes**

${d.top_themes.map((t, i) => `${i + 1}. ${t.theme} — ${nf(t.reviews)} reviews (${t.share_pct}%), ${t.avg_rating}★`).join('\n')}

**Fee issue identified from reviews:** ${d.identified_fee_issue.fee} — named in ${d.identified_fee_issue.reviews_naming_it} reviews, ${d.identified_fee_issue.reviews_signalling_confusion} of them signalling confusion (${d.identified_fee_issue.confusion_rate_pct}%), trend ${d.identified_fee_issue.trend}.

**Explanation issued to support**

${d.explanation_bullets.map(b => `- ${b}`).join('\n')}

**Sources**

${d.source_links.map(u => `- ${u}`).join('\n')}

_Logged via nabz-mcp after human approval._`);

  $('mail').innerHTML = `
    <dl>
      <dt>To</dt><dd>${esc(EMAIL.to.join(', '))}</dd>
      <dt>Cc</dt><dd>${esc(EMAIL.cc.join(', '))}</dd>
      <dt>Subject</dt><dd class="subject">${esc(EMAIL.subject)}</dd>
      <dt>Status</dt><dd><span class="draft-flag">Draft, not sent</span></dd>
    </dl>
    <pre id="mailbody">${esc(EMAIL.body)}</pre>`;

  const eml = ['To: ' + EMAIL.to.join(', '), 'Cc: ' + EMAIL.cc.join(', '), 'Subject: ' + EMAIL.subject,
    'X-Unsent: 1', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', EMAIL.body].join('\r\n');
  $('dl-eml').href = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }));
  $('gmail').href = 'https://mail.google.com/mail/?view=cm&fs=1'
    + '&to=' + encodeURIComponent(EMAIL.to.join(','))
    + '&cc=' + encodeURIComponent(EMAIL.cc.join(','))
    + '&su=' + encodeURIComponent(EMAIL.subject)
    + '&body=' + encodeURIComponent(EMAIL.body);

  $('results').hidden = false;
  $('results').classList.add('reveal');
}

async function reject() {
  $('approve').disabled = true; $('reject').disabled = true;
  await writeConsole([
    ['mk', '   rejected by the person at the keyboard'],
    ['out', '→ tools/call  notes.append_entry  {"approval_token":"ap_forged00"}'],
    ['no', '← {"status":"rejected","reason":"The approval token does not match these arguments. Approve the payload you intend to write."}'],
    ['mk', '   no document was touched, no draft was created.']
  ], { append: true });
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

    $('bar-note').textContent = `Groww, Google Play, ${meta.window.weeks} weeks to ${meta.window.to}`;
    $('hero-hint').textContent = `${nf(RESULT.meta.corpusSize)} reviews analysed, ${RESULT.themes.length} themes, 1 fee issue`;
    btn.textContent = 'Run again';
    btn.disabled = false;

    await renderTrace(RESULT);
    renderIntel(RESULT);
    renderOutputs(RESULT);
    renderGate();
    wireDecision();
    await requestWithoutApproval();
    $('s-gate').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
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
      : key === 'mailbody' ? EMAIL.subject + '\n\n' + EMAIL.body : '';
  try {
    await navigator.clipboard.writeText(text);
    const was = b.textContent; b.textContent = 'Copied'; b.classList.add('done');
    setTimeout(() => { b.textContent = was; b.classList.remove('done'); }, 1600);
  } catch { b.textContent = 'Press Ctrl+C'; }
});

$('run').addEventListener('click', run);
