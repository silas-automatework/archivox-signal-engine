# Design Decisions

Short records of the decisions a reviewer would ask about, with the honest
trade-offs.

## 1. Code-first instead of Clay/n8n

Continuous monitoring of a full TAM is an always-on daemon workload, and
credit-metered tools price per row exactly where a signal engine works
hardest. Code is versioned, tested and extended in minutes with coding
agents. The boundary to the tool ecosystem stays open by design: every stage
reads/writes plain data (SQLite/JSON/CSV), so a Clay table or an n8n workflow
can replace any single stage. `signals.csv` is deliberately shaped like a
Clay table (one row per signal, flat columns).

## 2. Evidence contract enforced in code, not in prompts

Prompts ask; validators enforce. The quote must be a verbatim substring of
captured evidence, URLs outside the evidence set reject, LLM-written text may
not contain numbers where numbers are computed, surveillance-sounding
framing rejects. The validator caught a real ingestion bug on day one
(StepStone search-highlighting HTML in snippets) that would otherwise have
shipped into customer-facing mails.

## 3. SQLite in the reference implementation, Postgres in production

Reviewers must be able to clone and run in two minutes without Docker. The
schema (append-only signal_events, evidence with source URLs, contacts keyed
by company) is Postgres-shaped; swapping the store is a driver change, not a
redesign. The scheduled CI run is stateless by choice (fresh DB, 2-day
lookback): within-run dedupe suffices for a daily snapshot, and state
persistence is exactly what the production Postgres is for.

## 4. Template emails with LLM slots, not free generation

The skeleton, value proposition and CTA are written once, by a human, and
reviewed once. The LLM fills three evidence-anchored slots (company short
name, industry category, opener). Consistency and brand control beat
free-form generation at scale, and review effort drops from "every mail"
to "every template change".

## 5. Numbers come from a deterministic benchmark model

The lead magnet's savings ranges (archivable TB, 3-year EUR range, scope
reduction) are computed in code from a size-class model. Every document
calculates identically, every range is defensible in a review, and the LLM
is structurally unable to invent a number. The LLM's job is prose: situation,
size-class estimate, industry-specific levers.

## 6. Deterministic A/B rotation instead of stylistic debate

Whether a question opener beats a statement opener (friction hypothesis:
question + yes/no CTA = two competing asks) is measurable, so the engine
assigns variants 50/50 by signal id, enforces them per variant in the
validator, and exports `opener_variant` for reply-rate comparison. The same
mechanism rotates question types so the queue never reads as one cloned
message. Prompt examples were removed entirely after the model cloned them
verbatim; diversity is guaranteed by construction, not hoped for.

## 7. Person redaction in public artifacts

Companies come from public job postings and stay visible. Compiled person
data (names, LinkedIn URLs) is legitimate for internal outreach routing but
does not belong in a public repository, so all committed artifacts are
person-redacted (initials + role, no profile URLs). Full data exists only
locally and in the CRM. Emails render as drafts and are never sent by the
system; the human approval step is a design feature, not a missing feature.

## 8. Language routing is a known limitation

Emails are German. Some target contacts (e.g. international group CIOs)
communicate in English; per-contact language routing based on profile
signals is the next refinement, noted rather than half-built.
