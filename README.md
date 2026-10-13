# Nabz — from app reviews to a weekly pulse, a fee explainer, and an approval gate

**Live prototype:** https://jaytech3.github.io/nabz/

Twelve weeks of public Groww reviews from the Google Play listing go in. Out come two things a real team would use on a Monday: a **weekly product pulse** for the product team, and a **facts-only explanation of the charge users keep misreading** for support to paste. Neither reaches an internal tool until a person approves it — the MCP server refuses both calls the first time and returns what it *would* write, with a single-use token.

Built for the **NextLeap PM Fellowship, Milestone 5 (RAGs & Context Engineering)**. The product is **Groww**, carried forward from Milestone 1 and used in [Milestone 4](https://github.com/jaytech3/pramaan).

| Deliverable | Where |
|---|---|
| Working prototype | https://jaytech3.github.io/nabz/ |
| Weekly product pulse | [out/weekly-pulse.md](out/weekly-pulse.md) |
| Doc snippet showing the appended entry | [docs/product-pulse-log.md](docs/product-pulse-log.md) |
| Email draft | [out/email-draft.md](out/email-draft.md), [out/email-draft.eml](out/email-draft.eml) |
| Reviews CSV | [data/reviews.csv](data/reviews.csv) (3,220 rows) |
| Source list | [sources.csv](sources.csv) (6 URLs) |
| Fee explainer | [out/fee-explainer.md](out/fee-explainer.md) |
| Machine-readable payloads | [out/doc-entry.json](out/doc-entry.json), [out/fee-signals.csv](out/fee-signals.csv), [out/themes.csv](out/themes.csv) |

---

## 1. How to run it

**The prototype.** It reads the CSV over HTTP, so it needs a server; opening `index.html` from disk will not work.

```bash
git clone https://github.com/jaytech3/nabz.git
cd nabz
python3 -m http.server 8000     # then open http://localhost:8000
```

**The same pipeline, headless.** Writes every deliverable into `out/`:

```bash
node cli/run.js          # requires Node 18+, no dependencies
node cli/run.js --json   # the whole result object
```

**The MCP server and the approval gate**, over stdio, with the JSON-RPC traffic printed:

```bash
node mcp/client-demo.js            # asks you to approve at the terminal
node mcp/client-demo.js --reject   # shows that nothing is written on a no
node mcp/server.js                 # the server alone, for your own MCP client
```

**The checks.** 57 of them, covering every constraint in the brief plus the gate, run against the live server:

```bash
node eval/run_eval.js    # exit 1 on any failure
```

---

## 2. Where the MCP approval happens

Two tools are exposed by [`mcp/server.js`](mcp/server.js): `notes.append_entry` (appends to `docs/product-pulse-log.md`) and `email.create_draft` (writes an `.eml` draft, never sends).

Both are gated in the server itself, not in the client, so an agent that forgets to ask cannot write anything:

```
call  notes.append_entry { date, top_themes, weekly_pulse, … }        no token
  →   { "status": "approval_required",
        "what_will_happen": "Append a dated entry to docs/product-pulse-log.md",
        "preview": "## Week ending 2026-10-12 …",
        "approval_token": "3f9c…" }                                   nothing written

      [ a human reads the preview and decides ]

call  notes.append_entry { …same arguments…, approval_token: "3f9c…" }
  →   { "status": "appended", "file": "docs/product-pulse-log.md", "bytes_added": 3364 }
```

Three properties make the gate worth something, and each has a test:

- **The token is an HMAC of the arguments.** An approval obtained for one payload cannot be reused to write a different one. Changing a single field after approval is refused.
- **Approvals are single-use.** A replayed call is refused, so a retry loop cannot append the same entry five times.
- **The secret is minted per process.** Tokens do not survive a restart.

In the browser prototype, step 4 does the same exchange against an in-page client and prints the transcript, because GitHub Pages serves static files and cannot host a stdio process. The payloads, the refusals, the token and the replay check are identical to what `mcp/client-demo.js` produces against the real server — run that to see it write to disk.

---

## 3. What fee issue the reviews identified

**Brokerage, and the charges deducted beside it.** Named in **110** reviews, of which **13** also signal that the deduction was not expected — "hidden charges", "extra charge", "bina bataye", "pata nahi". It wins on a score that multiplies how often a charge is raised by how often it is misread, because raw volume would always pick the best-known charge and raw density would pick one two people mentioned.

| Charge | Named in | Confused | Rate | Score |
|---|--:|--:|--:|--:|
| **Brokerage, and the charges deducted beside it** | 110 | 13 | 11.8% | **1.53** |
| Auto square-off charge | 4 | 2 | 50.0% | 1.00 |
| MTF interest and pledge charges | 18 | 4 | 22.2% | 0.89 |
| Account maintenance and platform fees | 18 | 4 | 22.2% | 0.89 |
| What is deducted when you sell, beyond brokerage | 23 | 3 | 13.0% | 0.39 |
| GST and statutory levies | 4 | 1 | 25.0% | 0.25 |

The verbatims say what the number cannot. One review puts the whole problem in a sentence:

> ये लोग brokrege charge कितना काट ना है वो तो बताएगै लेकिन, DP charge, CDSL DP charge, exchange ट्रांजेक्शन चार्ज कितना कटना है, वो कभी नही बताया जायेगा।
> *(They will tell you how much brokerage will be cut, but how much DP charge, CDSL DP charge and exchange transaction charge will be cut is never told.)* — 1★, 16 Sep 2026

So the problem is not the price. Every figure is published on Groww's pricing page. The problem is **placement**: brokerage is visible before the order, and the DP charge of ₹16.50 plus CDSL's ₹3.50 plus 18% GST is met in the ledger the next day. On a small delivery sell those flat lines are most of the cost, which is why "hidden" is the word users reach for. That is what the explainer answers and what the three action ideas in the pulse address.

---

## 4. The pipeline

`src/engine.js` is one module with no dependencies, and both the web prototype and `cli/run.js` import it unchanged — the page cannot drift from the file the checks run against.

```
data/reviews.csv  3,220 reviews, 21 Jul – 12 Oct 2026, text only
      │
      ├─ 1  Window        12 weeks to 12 Oct 2026
      ├─ 2  Qualify       25+ characters of text
      ├─ 3  Cluster       5 themes, strongest match wins, no double counting
      ├─ 4  Rank          top 3 by volume
      ├─ 5  Detect        fee entity x confusion marker → the misread charge
      ├─ 6  Quote         3 verbatims: 2 on the fee, 1 on the leading negative theme
      ├─ 7  Pulse         ≤250 words
      └─ 8  Explainer     ≤6 bullets, 2 official links, "Last checked"
      │
      ▼
  buildDocEntry()      → notes.append_entry      ┐ both gated
  buildEmailDraft()    → email.create_draft      ┘ behind approval
```

No model is called anywhere. The same CSV always produces the same note, the same quotes and the same fee — there is a determinism test for exactly that. For a weekly artefact that goes to a team and to customers, reproducibility was worth more than fluency, and it means every sentence can be traced to a row.

**Themes found**

| # | Theme | Reviews | Share | Avg |
|---|---|--:|--:|--:|
| 1 | Easy to start, easy to use | 1,299 | 40.3% | 4.68★ |
| 2 | Orders and app reliability | 382 | 11.9% | 2.18★ |
| 3 | Support that does not close the loop | 361 | 11.2% | 2.06★ |
| 4 | Charges users did not expect | 237 | 7.4% | 2.33★ |
| 5 | Money in and money out | 90 | 2.8% | 2.29★ |

851 reviews (26%) match no theme and are left out rather than pushed into the nearest bucket, because a theme table that accounts for everything is a theme table that has stopped meaning anything.

---

## 5. Why the fee explainer is written the way it is

It is read by a user who already feels overcharged, so it earns nothing by reassuring them. Every bullet is a fact with a figure, in the order a confused user asks: what is it, when does it apply, how is it calculated, what is tax, what is not Groww's, where can I see it. It carries **Last checked: 13 Oct 2026** because these rates move — Groww revised DP and MTF charges in 2025, and a support snippet with no date goes stale silently.

The engine declares the rates it asserts (`explainer.figures`), and `eval/run_eval.js` checks each one appears both in the bullets and in `sources.csv`. A tone check fails the build on recommendation words — *should*, *best*, *avoid*, *better off*. Nothing here is investment advice, and the prototype says so.

---

## 6. Things that did not work

**TF-IDF + spherical k-means (k=5) over the same 3,220 reviews.** The honest first attempt at "cluster reviews into themes". It split the corpus by **language and sentiment, not subject**: one cluster was almost entirely Hinglish, two were variants of "nice app, easy to use", one came back empty, and the top terms of the largest cluster were *thi, service, work, customer, update* — nothing a team could act on. Clusters that cannot name a problem cannot drive an action idea, so the themes are a rule-based classifier instead, seeded from the distinctive terms that pass did surface. The log-odds term extraction survives in the shipped engine: it is what fills the "words that distinguish it" column, so the table still shows the data's own vocabulary rather than mine.

**Ranking fees by mention count.** Brokerage wins any volume contest because everyone knows the word. The question is not which charge is discussed most, it is which is *misunderstood* most, so the score multiplies volume by the share of mentions carrying a confusion marker.

**Letting the pulse run long.** The first draft was 466 words. Rather than hand-trimming once, the builder renders at decreasing quote lengths until it fits 250, so the limit holds even when the input changes.

---

## 7. What this is not

Not affiliated with, endorsed by, or connected to Groww. Reviews are public Google Play reviews retrieved for study; display names and avatars were dropped at ingest and `review_id` is a hash. Charge figures were read from official pages on 13 Oct 2026 and can change. Nothing here is investment advice.

MIT licensed. Jayesh Rangari, NextLeap PM Fellowship 2026.
