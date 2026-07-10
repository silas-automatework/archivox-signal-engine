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
  email_draft: { subject: string; body: string };
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
    "email_draft",
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
    email_draft: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body"],
      properties: { subject: { type: "string" }, body: { type: "string" } },
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
- flags: risks or caveats an SDR should know (e.g. "posting might be for a
  subsidiary", "group-level IT could decide centrally").

Brief fields in English. email_draft in German (Du-Form is wrong here: use Sie).
Email rules: max 120 words, reference the concrete evidence naturally (the company
is hiring for its S/4 transformation), one specific value hypothesis, one low-friction
CTA (kurzer Austausch), no buzzwords, no flattery, no exclamation marks. Never use
em dashes anywhere. Do not use "nicht X, sondern Y" constructions. Write flowing,
natural German sentences, not choppy fragments.`;

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

  if (brief.email_draft.body.split(/\s+/).length > 150) {
    problems.push("email body exceeds word limit");
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
