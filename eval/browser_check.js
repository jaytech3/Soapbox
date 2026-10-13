#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Drives the prototype in headless Chromium: runs the analysis, reads the
   transcript the in-page MCP server produced, approves, and checks that the
   document in the browser grew by exactly one entry while the moved and
   replayed tokens were refused. Also writes the screenshots the README shows.

     node eval/browser_check.js                 # needs playwright + chromium
     node eval/browser_check.js --shots         # also refresh docs/screenshots

   Exits 1 on any failure, 0 otherwise; exits 0 with a note if Playwright is
   not installed, so eval/run_eval.js stays dependency-free.
   ────────────────────────────────────────────────────────────────────────── */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs', 'screenshots');

let pw;
try { pw = await import('playwright'); }
catch {
  try { pw = await import(path.join(process.env.NODE_TOOLS || '/opt/node-tools', 'node_modules', 'playwright', 'index.mjs')); }
  catch { console.log('playwright not installed; skipping the browser check (npm i -D playwright && npx playwright install chromium)'); process.exit(0); }
}

/* ── a static server for the repo root ─────────────────────────────────── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  if (SHOTS) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, '1-hero.png'), clip: { x: 0, y: 0, width: 1280, height: 760 } }); }

  console.log('\nPrototype in headless Chromium');
  await page.click('#run');
  await page.waitForSelector('#approve', { timeout: 30000 });
  await page.waitForFunction(() => /waiting for a human/.test(document.querySelector('#console-out')?.textContent || ''), null, { timeout: 30000 });

  const transcript1 = await page.textContent('#console-out');
  check('page ran the pipeline without errors', errors.length === 0, errors.join(' | '));
  check('themes table rendered 5 rows', (await page.$$('#themes tbody tr')).length === 5);
  check('three quotes rendered', (await page.$$('#quotes .quote')).length === 3);
  check('pulse within budget', /^\d+ of 250 words$/.test((await page.textContent('#pulse-budget')).trim()) && !(await page.$('#pulse-budget.over')));
  check('server initialised in-page', /serverInfo.*nabz-mcp/.test(transcript1));
  check('both tools listed', /notes\.append_entry.*email\.create_draft/.test(transcript1));
  const tokens = [...transcript1.matchAll(/"approval_token":"([0-9a-f]{32})"/g)].map(m => m[1]);
  check('both calls refused with a computed token', tokens.length === 2 && tokens[0] !== tokens[1], tokens.map(t => t.slice(0, 8) + '…').join(' '));
  check('nothing written before approval', !/"status":"appended"/.test(transcript1));

  if (SHOTS) {
    await page.$eval('#s-intel', e => e.scrollIntoView());
    await page.screenshot({ path: path.join(OUT, '2-intelligence.png'), fullPage: false });
    await page.$eval('#s-pulse', e => e.scrollIntoView());
    await page.screenshot({ path: path.join(OUT, '3-pulse-and-explainer.png'), fullPage: false });
    await page.$eval('#s-gate', e => e.scrollIntoView());
    await page.screenshot({ path: path.join(OUT, '4-approval-gate.png'), fullPage: false });
  }

  const entriesBefore = await page.evaluate(() => ((localStorage.getItem('nabz.product-pulse-log.md') || '').match(/^## Week ending /gm) || []).length);
  await page.click('#approve');
  await page.waitForSelector('#results:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(() => /written once|unexpected/.test(document.querySelector('#console-out')?.textContent || ''), null, { timeout: 30000 });
  const transcript2 = await page.textContent('#console-out');
  const entriesAfter = await page.evaluate(() => ((localStorage.getItem('nabz.product-pulse-log.md') || '').match(/^## Week ending /gm) || []).length);

  check('append succeeded once approved', /"status":"appended"/.test(transcript2));
  check('draft created, not sent', /"status":"draft_created".*"sent":false/.test(transcript2));
  check('the document in the browser grew by one entry', entriesAfter === entriesBefore + 1, `${entriesBefore} → ${entriesAfter}`);
  check('an approved token moved to an edited payload was refused', /does not match these arguments/.test(transcript2));
  check('a replayed approval was refused', /already used/.test(transcript2));
  check('log entry rendered', /Week ending/.test(await page.textContent('#logentry')));
  check('email draft rendered with the subject from the brief', /Weekly Product Pulse \+ Customer Clarification — /.test(await page.textContent('#mail')));
  check('.eml download carries X-Unsent', /X-Unsent: 1/.test(await page.evaluate(() => localStorage.getItem('nabz.email-draft.eml') || '')));
  check('no page errors during the exchange', errors.length === 0, errors.join(' | '));

  if (SHOTS) {
    await page.$eval('#console', e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, '5-transcript.png'), fullPage: false });
    await page.$eval('#results', e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, '6-logged-and-drafted.png'), fullPage: false });
    await page.$eval('#mail', e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, '7-email-draft.png'), fullPage: false });
  }

  /* the reject path, on a fresh page, must leave the document alone */
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await page2.goto(base, { waitUntil: 'networkidle' });
  await page2.click('#run');
  await page2.waitForSelector('#reject', { timeout: 30000 });
  await page2.waitForFunction(() => /waiting for a human/.test(document.querySelector('#console-out')?.textContent || ''), null, { timeout: 30000 });
  const b2 = await page2.evaluate(() => ((localStorage.getItem('nabz.product-pulse-log.md') || '').match(/^## Week ending /gm) || []).length);
  await page2.click('#reject');
  await page2.waitForFunction(() => /no document was touched/.test(document.querySelector('#console-out')?.textContent || ''), null, { timeout: 30000 });
  const a2 = await page2.evaluate(() => ((localStorage.getItem('nabz.product-pulse-log.md') || '').match(/^## Week ending /gm) || []).length);
  const t2 = await page2.textContent('#console-out');
  check('reject: forged token refused by the server', /does not match these arguments/.test(t2));
  check('reject: document unchanged', a2 === b2, `${b2} → ${a2}`);
  if (SHOTS) { await page2.$eval('#console', e => e.scrollIntoView({ block: 'start' })); await page2.screenshot({ path: path.join(OUT, '8-rejected.png'), fullPage: false }); }
} catch (e) {
  check('browser run completed', false, e.message);
} finally {
  await browser.close();
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
