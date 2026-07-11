# ArchivoX Signal Engine

A signal-based outbound engine, built as the working component ("cog") of my
SalesPlaybook GTM Engineer case study. It watches the German market for
companies entering an ERP/S4 transformation window, qualifies them with an
LLM under a strictly enforced evidence contract, finds the right people,
drafts the outreach, generates a personalized one-page lead magnet per
account, and routes everything into HubSpot as ready-to-work SDR tasks.

**Start here: the [case study presentation](https://silas-automatework.github.io/archivox-signal-engine/case/)** walks through the strategy, the workflow and the thinking behind every stage.

**This is a running system, not a slide.** The curated showcase snapshot lives in [`showcase/`](showcase/) (25 qualified signals, live cockpit: https://silas-automatework.github.io/archivox-signal-engine/). The `runs/` folder is written by a
scheduled GitHub Action every morning; its commit history is the proof.

```
watch ──▶ classify ──▶ brief ──▶ magnet ──▶ people ──▶ export ──▶ route
 job        end user     why-now    1-page     LinkedIn    json/csv   HubSpot
 boards     vs noise     + email    per-acct   contacts    + cockpit  company,
 (Apify)    (LLM +       slots      value      (Exa +      (HTML)     note, task,
            Exa esc.)    (LLM)      check      LLM)                   contacts
```

## Quickstart (no API keys needed)

```bash
npm install
npm run demo        # runs the watcher on bundled fixtures -> runs/demo/
npm test            # 33 tests: dedupe, evidence contract, email rules, model
```

With API keys (see `.env.example`) the full pipeline runs against live data:

```bash
npx tsx src/cli.ts watch          # pull German job postings (6 S1 queries)
npx tsx src/cli.ts classify       # end user vs consultancy/vendor/staffing
npx tsx src/cli.ts brief          # SDR briefs + email slots (evidence contract)
npx tsx src/cli.ts magnet         # one-page S/4-Datenaltlast-Check per signal
npx tsx src/cli.ts people         # account -> people (LinkedIn via Exa)
npx tsx src/cli.ts export         # signals.json + signals.csv (Clay-compatible)
npx tsx src/cli.ts cockpit        # the SDR cockpit (HTML)
npx tsx src/cli.ts hubspot:setup  # create custom properties (once)
npx tsx src/cli.ts route          # company + note + task + contacts into HubSpot
```

## What a signal looks like

From the first real run (7-day window, 2026-07-10): 150 postings, 139 unique,
75 companies, **25 qualified end-user signals** including a public transit
operator hiring its own S/4 sub-project leads, a truck manufacturer's finance
transformation program, and a paper manufacturer standardizing on S/4. Total
LLM cost for classification, briefs and magnets: about $2.

Each qualified signal carries:

- a **verbatim evidence quote** from the posting (validator-enforced: it must
  be a character-level substring of captured evidence)
- a **why-now hypothesis**, company-specific angles and honest flags
- **contact hypotheses** with roles and confidence (account -> people stage)
- a **drafted German email**: fixed template, LLM fills three evidence-anchored
  slots; opener A/B-tested (question vs statement) via deterministic rotation
- a generated **one-page lead magnet** ("S/4-Datenaltlast-Check") whose savings
  ranges come from a deterministic benchmark model in code, never from the LLM

## The evidence contract

Every claim about a company must trace to a captured source. Enforced in code,
not in prompts: the quote must be verbatim, URLs outside the evidence set are
rejected, numbers in LLM-written lever text are rejected (numbers are computed),
surveillance-sounding language is rejected, violations trigger one corrective
retry and are flagged if they persist. This is what keeps AI personalization
from burning enterprise trust.

## Design decisions

The reasoning behind code-first (vs Clay/n8n), SQLite vs Postgres, template
emails vs free generation, deterministic A/B rotation, and person redaction in
public artifacts: see [docs/decisions.md](docs/decisions.md).

## Costs

| Stage | Cost |
|---|---|
| Watcher (Apify, 6 queries, daily) | < $0.30/day |
| Classification (gpt-5.4-mini, per company) | ~$0.002 |
| Brief + magnet (gpt-5.4, per signal) | ~$0.04 |
| People discovery (Exa + mini, per company) | ~$0.02 |
| **Fully processed qualified signal** | **~$0.10** |

The case-study SDRs spend 6 to 8 hours per day on research. This engine
delivers the researched, drafted, routed signal for a dime.

## Personal data (GDPR by design)

The companies in this repository are real and stay visible: they come from
public job postings, and their buying signals are the point of the case study.
Person-level data is handled differently, on purpose:

- **Public artifacts are person-redacted.** Everything committed here
  (exports, cockpit, reports) shows initials + role only, no names, no
  LinkedIn URLs (`REDACT_PEOPLE=1`). Using public professional data to route
  outreach internally is a legitimate-interest case; republishing a compiled
  list of named people on the open internet is not. The repository history
  was rewritten before publishing to hold this line retroactively.
- **Full person data lives only where it belongs:** in private processing
  state (the workflow's cache) and in the CRM, the system built to hold it.
- **Nothing is ever sent.** Emails exist as drafts inside CRM tasks; sending
  requires a human decision. The engine has no send path at all.

This mirrors the engine's own trust thesis: in a finite market, how you treat
data is part of the product. See [docs/decisions.md](docs/decisions.md) #7.

---

Case study context: "ArchivoX" is a fictional enterprise archiving vendor
(SAP/ERP data archiving, DACH market). Reference implementation by Silas
Schüttel, built with Claude Code.
