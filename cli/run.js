#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Headless run. Same engine as the web prototype; writes the deliverables.

     node cli/run.js            # analyse and write out/
     node cli/run.js --json     # print the whole result as JSON
   ────────────────────────────────────────────────────────────────────────── */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCSV, runPipeline, buildDocEntry, buildEmailDraft } from '../src/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'reviews.csv'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corpus-meta.json'), 'utf8'));

const result = runPipeline(rows, {
  asOf: meta.window.to,
  windowWeeks: meta.window.weeks,
  totalInWindow: meta.reviews_in_window_all,
  lastChecked: meta.pulled_on
});

if (process.argv.includes('--json')) {
  const slim = JSON.parse(JSON.stringify(result, (k, v) => k === 'members' || k === 'entity' ? undefined : v));
  console.log(JSON.stringify(slim, null, 2));
  process.exit(0);
}

const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });
const write = (f, s) => { fs.writeFileSync(path.join(OUT, f), s); return f; };

const docEntry = buildDocEntry(result);
const email = buildEmailDraft(result);

write('weekly-pulse.md', result.pulse.markdown);
write('fee-explainer.md', result.explainer.markdown);
write('doc-entry.json', JSON.stringify(docEntry, null, 2) + '\n');
write('email-draft.md', `**To:** ${email.to.join(', ')}\n**Cc:** ${email.cc.join(', ')}\n**Subject:** ${email.subject}\n**Status:** draft, not sent\n\n---\n\n${email.body}\n`);
write('themes.csv', ['theme,reviews,share_pct,avg_rating,low_star_share_pct,distinctive_terms']
  .concat(result.themes.map(t => [`"${t.label}"`, t.count, t.share, t.avgRating, t.lowStarShare, `"${t.terms.join(' ')}"`].join(','))).join('\n') + '\n');
write('fee-signals.csv', ['fee,mentions,confused_mentions,confusion_rate_pct,confusion_score,avg_rating']
  .concat(result.feeScores.map(f => [`"${f.label}"`, f.mentions, f.confused, f.confusionRate, f.confusionScore, f.avgRating].join(','))).join('\n') + '\n');
write('run-trace.txt', result.trace.map((t, i) => `${i + 1}. ${t.stage}: ${t.detail}`).join('\n') + '\n');

console.log(`Earful ${result.version} — ${result.meta.corpusSize} reviews, ${result.meta.from} to ${result.meta.asOf}`);
result.trace.forEach((t, i) => console.log(`  ${i + 1}. ${t.stage}: ${t.detail}`));
console.log(`\nWrote ${fs.readdirSync(OUT).length} files to out/`);
console.log(`Pulse ${result.pulse.words}/250 words · explainer ${result.explainer.bullets.length}/6 bullets · fee issue: ${result.feeSignal.label}`);
console.log(`\nTo log these outputs through MCP with an approval step: node mcp/client-demo.js`);
