import { jsonCall } from "../llm/openai.js";
import { lookupCompany, type LookupEvidence } from "../enrich/companyLookup.js";
import type { LlmUsage } from "../llm/openai.js";

export interface CompanyPostings {
  companyKey: string;
  companyRaw: string;
  postings: { title: string; url: string; snippet: string | null; query: string; postedAt: string | null }[];
}

export interface Classification {
  company_type: "end_user" | "it_consultancy" | "software_vendor" | "staffing_recruiting" | "public_research" | "other";
  is_signal: boolean;
  confidence: number;
  industry: string;
  quote: string;
  reason: string;
  needs_lookup: boolean;
}

export interface ClassifyOutcome {
  classification: Classification;
  escalated: boolean;
  lookupEvidence: LookupEvidence[];
  usages: LlmUsage[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["company_type", "is_signal", "confidence", "industry", "quote", "reason", "needs_lookup"],
  properties: {
    company_type: {
      type: "string",
      enum: ["end_user", "it_consultancy", "software_vendor", "staffing_recruiting", "public_research", "other"],
    },
    is_signal: { type: "boolean" },
    confidence: { type: "number" },
    industry: { type: "string" },
    quote: { type: "string" },
    reason: { type: "string" },
    needs_lookup: { type: "boolean" },
  },
};

const SYSTEM = `You classify German job postings as buying signals for "ArchivoX",
a vendor of enterprise data archiving / document management software for complex
SAP and ERP landscapes (data volume reduction before S/4HANA migrations, legacy
system decommissioning, compliant archiving).

You receive: a company name plus up to 3 of its current job postings (title,
snippet, search query that found it). Optionally: web lookup evidence about the company.

Decide:
1. company_type: Is this company an END USER running its own SAP/ERP landscape
   (manufacturer, utility, logistics, retail...), or an IT consultancy / systems
   integrator hiring for client projects, a software vendor, a staffing agency
   posting on behalf of clients, or a public/research body?
2. is_signal: TRUE only if company_type is end_user AND the postings indicate the
   company itself is running or planning an ERP/S4 transformation, SAP archiving,
   ILM, or legacy decommissioning work. Consultancies, vendors and staffing
   agencies are NEVER a signal, regardless of content.
3. confidence: 0 to 1 for your overall verdict.
4. industry: short label in English (e.g. "automotive supplier", "utilities").
5. quote: verbatim fragment from the provided postings that best supports your
   verdict. NEVER invent or paraphrase; copy from the input. Empty string if none.
6. reason: one short sentence.
7. needs_lookup: TRUE if you cannot tell the company type from name + postings
   alone and web evidence about the company would change your verdict.

Rules: Judge only from provided material. Anonymous or unclear postings from
staffing agencies get company_type=staffing_recruiting. Job boards sometimes pad
results with loosely related postings; a generic SAP admin role at an end user
without any transformation/archiving context is is_signal=false with low confidence.`;

function userPrompt(c: CompanyPostings, evidence: LookupEvidence[]): string {
  const parts: string[] = [];
  parts.push(`Company: ${c.companyRaw}`);
  parts.push("");
  c.postings.slice(0, 3).forEach((p, i) => {
    parts.push(`Posting ${i + 1}: ${p.title}`);
    parts.push(`Found by query: ${p.query}${p.postedAt ? ` | posted: ${p.postedAt}` : ""}`);
    if (p.snippet) parts.push(`Snippet: ${p.snippet}`);
    parts.push("");
  });
  if (evidence.length) {
    parts.push("Web lookup evidence about the company:");
    for (const e of evidence) {
      parts.push(`- ${e.title} (${e.url}): ${e.excerpt}`);
    }
  }
  return parts.join("\n");
}

export async function classifyCompany(
  c: CompanyPostings,
  model: string
): Promise<ClassifyOutcome> {
  const usages: LlmUsage[] = [];

  const first = await jsonCall<Classification>({
    model,
    purpose: "classify",
    system: SYSTEM,
    user: userPrompt(c, []),
    schemaName: "signal_classification",
    schema: SCHEMA,
    reasoningEffort: "none",
  });
  usages.push(first.usage);

  const needsEscalation = first.data.needs_lookup || first.data.confidence < 0.55;
  if (!needsEscalation) {
    return { classification: first.data, escalated: false, lookupEvidence: [], usages };
  }

  let lookupEvidence: LookupEvidence[] = [];
  try {
    lookupEvidence = await lookupCompany(c.companyRaw);
  } catch {
    // Lookup failure falls back to the first verdict rather than blocking the run.
    return { classification: first.data, escalated: false, lookupEvidence: [], usages };
  }

  const second = await jsonCall<Classification>({
    model,
    purpose: "classify_escalated",
    system: SYSTEM,
    user: userPrompt(c, lookupEvidence),
    schemaName: "signal_classification",
    schema: SCHEMA,
    reasoningEffort: "none",
  });
  usages.push(second.usage);

  return { classification: second.data, escalated: true, lookupEvidence, usages };
}
