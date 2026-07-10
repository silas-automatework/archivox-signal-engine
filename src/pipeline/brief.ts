import { jsonCall, type LlmUsage } from "../llm/openai.js";

export interface SignalForBrief {
  signalId: number;
  companyRaw: string;
  industry: string | null;
  confidence: number;
  strength: number;
  quote: string | null;
  reason: string | null;
  evidence: {
    postings?: { title: string; url: string; postedAt: string | null }[];
    lookup?: { url: string; title: string }[];
    quote?: string;
  };
  snippets: { title: string; snippet: string | null; url: string }[];
}

export interface Brief {
  signal_summary: string;
  why_now: string;
  signal_quote: string;
  stakeholder_hypothesis: string[];
  angles: { title: string; detail: string }[];
  discovery_questions: string[];
  /** Slots for the fixed email template (templates/email.de.md), not a full email. */
  email_slots: { company_short: string; company_category_de: string; opener_de: string };
  flags: string[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "signal_summary",
    "why_now",
    "signal_quote",
    "stakeholder_hypothesis",
    "angles",
    "discovery_questions",
    "email_slots",
    "flags",
  ],
  properties: {
    signal_summary: { type: "string" },
    why_now: { type: "string" },
    signal_quote: { type: "string" },
    stakeholder_hypothesis: { type: "array", items: { type: "string" } },
    angles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: { title: { type: "string" }, detail: { type: "string" } },
      },
    },
    discovery_questions: { type: "array", items: { type: "string" } },
    email_slots: {
      type: "object",
      additionalProperties: false,
      required: ["company_short", "company_category_de", "opener_de"],
      properties: {
        company_short: { type: "string" },
        company_category_de: { type: "string" },
        opener_de: { type: "string" },
      },
    },
    flags: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You write SDR research briefs for "ArchivoX", a vendor of enterprise
data archiving and document management software for complex SAP/ERP landscapes.
ArchivoX value: data volume reduction before S/4HANA migrations (smaller HANA
footprint, lower migration cost), compliant archiving (GoBD), and legacy system
decommissioning after migration. ArchivoX cuts digital archiving costs by 40-50%
versus classical solutions.

You receive one qualified signal: a German company whose current job postings show
an active ERP/S4 transformation. Write the brief a senior SDR reads in 90 seconds.

EVIDENCE CONTRACT (hard rules):
- Every claim about the COMPANY must come from the provided evidence. Do not invent
  facts, numbers, incumbent systems, project names or dates about the company.
- signal_quote: copy the single strongest fragment VERBATIM from the provided
  postings (German original). It must appear character-for-character in the input.
- General domain reasoning about S/4 migrations and archiving is allowed and
  encouraged in why_now, but keep it clearly generic ("companies migrating to S/4
  typically...") rather than asserted about this company.
- stakeholder_hypothesis: role titles worth finding (e.g. "CIO", "Head of SAP
  Competence Center"), clearly hypotheses, no invented names.
- angles: SPECIFIC to this company or they are worthless. Each angle must anchor
  to a concrete detail: the exact role being hired, a stated timeline or system,
  or industry-specific data/document types (e.g. batch records and GxP retention
  for life sciences, maintenance records for transit operators, delivery documents
  for retail logistics). Generic ArchivoX value statements ("reduce data volume
  before migration") are FORBIDDEN as angles; they are the baseline, not an angle.
  If the evidence is thin, return fewer angles rather than padding with generic ones.
- flags: risks or caveats an SDR should know (e.g. "posting might be for a
  subsidiary", "group-level IT could decide centrally").

Brief fields in English. The outreach email itself is a FIXED template; you only
fill three German slots (email_slots):
- company_short: how an SDR would naturally shorten the company name in German
  ("Papierfabrik Palm GmbH & Co. KG" -> "Palm").
- company_category_de: dative plural category for the sentence "Bei {category} in
  dieser Phase geht es oft darum, ..." (e.g. "Papierherstellern",
  "Automobilzulieferern", "kommunalen Verkehrsbetrieben"). Lowercase unless a noun.
- opener_de: 1-2 sentences, Sie-Form, max 40 words. THE HARD PART: start inside
  the reader's world, never inside our research. Treat their program, project or
  role as shared context and connect it to the data question with a sharp point
  of view. One example of the right MOVE (do not reuse its wording or sentence
  pattern; find your own for this company): "Wenn QIAbase in die Umsetzungsphase
  geht, fällt meist früher als geplant die Entscheidung, wie viel ECC-Altbestand
  mit nach S/4 wandert." FORBIDDEN: any discovery narration ("ich habe gesehen",
  "ich bin darauf gestoßen", "mir ist aufgefallen", "Sie suchen aktuell", "in
  Ihrer Stellenanzeige"). The specificity of naming their program IS the proof of
  research; never narrate the act of finding it. The opener continues after the
  salutation comma ("Hallo Herr X,"), so it MUST start lowercase. Write proper
  German umlauts (ä, ö, ü, ß); never transliterate as ae/oe/ue/ss. Sober tone, no
  flattery, no buzzwords, no exclamation marks. Never use em dashes. Do not use
  "nicht X, sondern Y" constructions. Flowing natural German, no choppy
  fragments. The opener is followed by a fixed benchmark paragraph about cold ECC
  data and HANA sizing cost, then a fixed offer of a prepared one-page assessment
  with a yes/no CTA. Do not preempt any of that content.`;

function userPrompt(s: SignalForBrief): string {
  const lines: string[] = [];
  lines.push(`Company: ${s.companyRaw}`);
  lines.push(`Industry (classified): ${s.industry ?? "unknown"}`);
  lines.push(`Signal confidence: ${s.confidence} | strength: ${s.strength}`);
  if (s.reason) lines.push(`Classifier reason: ${s.reason}`);
  lines.push("");
  lines.push("Job postings (evidence):");
  for (const p of s.snippets) {
    lines.push(`- Title: ${p.title}`);
    lines.push(`  URL: ${p.url}`);
    if (p.snippet) lines.push(`  Snippet: ${p.snippet}`);
  }
  if (s.evidence.lookup?.length) {
    lines.push("");
    lines.push("Company lookup evidence:");
    for (const l of s.evidence.lookup) lines.push(`- ${l.title} (${l.url})`);
  }
  return lines.join("\n");
}

/** Rejects briefs that violate the evidence contract. */
export function validateBrief(brief: Brief, s: SignalForBrief): string[] {
  const problems: string[] = [];

  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const evidenceText = norm(s.snippets.map((p) => `${p.title}\n${p.snippet ?? ""}`).join("\n"));
  if (!brief.signal_quote || !evidenceText.includes(norm(brief.signal_quote))) {
    problems.push("signal_quote is not a verbatim substring of the provided evidence");
  }

  const knownUrls = new Set([
    ...s.snippets.map((p) => p.url),
    ...(s.evidence.lookup ?? []).map((l) => l.url),
  ]);
  const urlPattern = /https?:\/\/[^\s)>"]+/g;
  const briefText = JSON.stringify(brief);
  for (const url of briefText.match(urlPattern) ?? []) {
    if (![...knownUrls].some((k) => url.startsWith(k) || k.startsWith(url))) {
      problems.push(`brief references URL outside captured evidence: ${url}`);
    }
  }

  if (brief.email_slots.opener_de.split(/\s+/).length > 50) {
    problems.push("email opener exceeds word limit");
  }
  if (
    /ich habe (gesehen|gelesen|bemerkt|entdeckt)|bin (darauf|auf .{0,40}) gestoßen|mir ist aufgefallen|Stellenanzeige|Sie suchen (aktuell|derzeit|gerade)/i.test(
      brief.email_slots.opener_de
    )
  ) {
    problems.push("email opener narrates signal discovery instead of starting in the reader's world");
  }
  if (/\b(fuer|ueber|frueh\w*|faell\w*|gehoer\w*|spaet\w*|waehrend|koenn\w*|moeglich\w*|loesung\w*|abloesung\w*)\b/i.test(brief.email_slots.opener_de)) {
    problems.push("email opener transliterates umlauts (ae/oe/ue); use real German umlauts");
  }
  if (/^[A-ZÄÖÜ]/.test(brief.email_slots.opener_de.trim())) {
    problems.push("email opener must start lowercase (it continues after the salutation comma)");
  }
  if (/nicht\s+\w[^.]{0,60},\s*sondern/i.test(brief.email_slots.opener_de)) {
    problems.push("email opener uses a 'nicht X, sondern Y' construction");
  }
  if (/—/.test(briefText)) {
    problems.push("brief contains em dashes");
  }
  return problems;
}

export async function generateBrief(
  s: SignalForBrief,
  model: string
): Promise<{ brief: Brief; usages: LlmUsage[]; problems: string[] }> {
  const usages: LlmUsage[] = [];

  const first = await jsonCall<Brief>({
    model,
    purpose: "brief",
    system: SYSTEM,
    user: userPrompt(s),
    schemaName: "sdr_brief",
    schema: SCHEMA,
    reasoningEffort: "low",
  });
  usages.push(first.usage);

  let brief = first.data;
  let problems = validateBrief(brief, s);

  if (problems.length) {
    const retry = await jsonCall<Brief>({
      model,
      purpose: "brief_retry",
      system: SYSTEM,
      user:
        userPrompt(s) +
        `\n\nYour previous draft violated the evidence contract:\n- ${problems.join("\n- ")}\nProduce a corrected brief.`,
      schemaName: "sdr_brief",
      schema: SCHEMA,
      reasoningEffort: "low",
    });
    usages.push(retry.usage);
    brief = retry.data;
    problems = validateBrief(brief, s);
  }

  return { brief, usages, problems };
}
