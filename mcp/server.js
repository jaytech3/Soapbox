#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Nabz MCP server — stdio, JSON-RPC 2.0, no dependencies.

   Two tools, both gated. Calling either one without an approval token does
   not perform the action: the server returns the exact payload it would
   write, plus a one-time token. The action happens only on a second call
   that carries that token, and a token is good for one call on one payload
   (it is a hash of the arguments, so an approved payload cannot be swapped
   for a different one before the write).

     notes.append_entry   → appends a dated entry to docs/product-pulse-log.md
     email.create_draft   → writes an .eml draft to out/ (never sends)

   Run:  node mcp/server.js
   Try:  node mcp/client-demo.js
   ────────────────────────────────────────────────────────────────────────── */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'product-pulse-log.md');
const OUT = path.join(ROOT, 'out');

const SERVER = { name: 'nabz-mcp', version: '1.0.0' };
const PROTOCOL = '2024-11-05';

/* ── approval ───────────────────────────────────────────────────────────── */

const SECRET = crypto.randomBytes(16).toString('hex');   // new each process
const spent = new Set();

const fingerprint = (tool, args) => {
  const { approval_token, ...rest } = args || {};
  return crypto.createHmac('sha256', SECRET).update(tool + '\u0000' + stable(rest)).digest('hex').slice(0, 32);
};
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  : JSON.stringify(v ?? null);

function gate(tool, args, preview) {
  const expected = fingerprint(tool, args);
  const given = args?.approval_token;
  if (!given) {
    return {
      blocked: true,
      payload: {
        status: 'approval_required',
        tool,
        what_will_happen: preview.what,
        target: preview.target,
        preview: preview.preview,
        approval_token: expected,
        how_to_proceed: `Show this to a human. If they approve, call ${tool} again with the same arguments plus approval_token.`
      }
    };
  }
  if (given !== expected) return { blocked: true, payload: { status: 'rejected', reason: 'The approval token does not match these arguments. Approve the payload you intend to write.' } };
  if (spent.has(given)) return { blocked: true, payload: { status: 'rejected', reason: 'This approval was already used. Approvals are single-use.' } };
  spent.add(given);
  return { blocked: false };
}

/* ── tools ──────────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'notes.append_entry',
    description: 'Append one dated weekly-pulse entry to the team product log. Requires human approval: call once to get the payload and a token, then again with approval_token to write.',
    inputSchema: {
      type: 'object',
      required: ['date', 'top_themes', 'weekly_pulse', 'identified_fee_issue', 'explanation_bullets', 'source_links'],
      properties: {
        date: { type: 'string', description: 'ISO date the pulse covers' },
        top_themes: { type: 'array', description: 'Top themes with counts' },
        weekly_pulse: { type: 'string', description: 'The note, markdown, 250 words or fewer' },
        identified_fee_issue: { type: 'object', description: 'The fee the reviews were confused about, with its evidence counts' },
        explanation_bullets: { type: 'array', items: { type: 'string' }, description: 'Fee explainer, 6 bullets or fewer' },
        source_links: { type: 'array', items: { type: 'string' }, description: 'Official source URLs' },
        approval_token: { type: 'string', description: 'Token from the approval_required response' }
      }
    },
    run(args) {
      const g = gate('notes.append_entry', args, {
        what: `Append a dated entry to ${path.relative(ROOT, DOC)}`,
        target: path.relative(ROOT, DOC),
        preview: renderEntry(args).slice(0, 700) + '…'
      });
      if (g.blocked) return g.payload;

      fs.mkdirSync(path.dirname(DOC), { recursive: true });
      if (!fs.existsSync(DOC)) fs.writeFileSync(DOC, '# Product pulse log\n\nOne entry per weekly run. Appended by the Nabz MCP server after human approval.\n');
      const entry = renderEntry(args);
      fs.appendFileSync(DOC, entry);
      const lines = fs.readFileSync(DOC, 'utf8').split('\n').length;
      return { status: 'appended', file: path.relative(ROOT, DOC), bytes_added: Buffer.byteLength(entry), document_lines: lines, entry_heading: `Week ending ${args.date}` };
    }
  },
  {
    name: 'email.create_draft',
    description: 'Create an email draft on disk as RFC-822 .eml, which any mail client can open. Never sends. Requires human approval, same two-call flow.',
    inputSchema: {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'array', items: { type: 'string' } },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        approval_token: { type: 'string', description: 'Token from the approval_required response' }
      }
    },
    run(args) {
      const file = path.join(OUT, 'email-draft.eml');
      const g = gate('email.create_draft', args, {
        what: `Write a draft (not send) to ${path.relative(ROOT, file)}`,
        target: path.relative(ROOT, file),
        preview: `To: ${(args.to || []).join(', ')}\nSubject: ${args.subject}\n\n${(args.body || '').slice(0, 500)}…`
      });
      if (g.blocked) return g.payload;

      fs.mkdirSync(OUT, { recursive: true });
      const eml = [
        `To: ${(args.to || []).join(', ')}`,
        args.cc?.length ? `Cc: ${args.cc.join(', ')}` : null,
        `Subject: ${args.subject}`,
        `X-Unsent: 1`,                        // opens as an editable draft
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        args.body
      ].filter(x => x !== null).join('\r\n');
      fs.writeFileSync(file, eml);
      return { status: 'draft_created', sent: false, file: path.relative(ROOT, file), to: args.to, subject: args.subject, bytes: Buffer.byteLength(eml) };
    }
  }
];

function renderEntry(a) {
  const themes = (a.top_themes || []).map((t, i) => `${i + 1}. ${t.theme} — ${t.reviews} reviews (${t.share_pct}%), ${t.avg_rating}★`).join('\n');
  const fee = a.identified_fee_issue || {};
  return `
---

## Week ending ${a.date}

**Top themes**

${themes}

**Fee issue identified from reviews:** ${fee.fee} — named in ${fee.reviews_naming_it} reviews, ${fee.reviews_signalling_confusion} of them signalling confusion (${fee.confusion_rate_pct}%), trend ${fee.trend}.

<details><summary>Weekly pulse</summary>

${a.weekly_pulse}

</details>

**Explanation issued to support**

${(a.explanation_bullets || []).map(b => `- ${b}`).join('\n')}

**Sources**

${(a.source_links || []).map(u => `- ${u}`).join('\n')}

_Logged via nabz-mcp after human approval._
`;
}

/* ── JSON-RPC over stdio ────────────────────────────────────────────────── */

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    let out;
    try { out = tool.run(params.arguments || {}); }
    catch (e) { return reply(id, { isError: true, content: [{ type: 'text', text: `${tool.name} failed: ${e.message}` }] }); }
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: out.status === 'rejected' });
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); }
    catch { fail(null, -32700, 'Parse error'); }
  }
});
process.stdin.on('end', () => process.exit(0));
