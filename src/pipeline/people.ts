import { jsonCall, type LlmUsage } from "../llm/openai.js";
import { requireEnv } from "../config.js";

export interface ContactHypothesis {
  name: string;
  role: string;
  linkedin_url: string;
  confidence: number;
  reason: string;
  /** German salutation form, empty when not confidently inferable from the first name. */
  anrede: "Herr" | "Frau" | "";
}

interface ExaHit {
  url: string;
  title: string;
  snippet: string;
}

/** LinkedIn profile discovery via Exa (account -> people stage). */
async function searchLinkedIn(query: string): Promise<ExaHit[]> {
  const key = requireEnv("EXA_AI_API_KEY");
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      numResults: 5,
      type: "auto",
      includeDomains: ["linkedin.com"],
      contents: { text: { maxCharacters: 400 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa people search failed: ${res.status}`);
  const json = (await res.json()) as { results: { url: string; title: string | null; text: string | null }[] };
  return (json.results ?? [])
    .filter((r) => /linkedin\.com\/in\//.test(r.url))
    .map((r) => ({ url: r.url, title: r.title ?? "", snippet: (r.text ?? "").slice(0, 400) }));
}

const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role", "linkedin_url", "confidence", "reason", "anrede"],
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          linkedin_url: { type: "string" },
          confidence: { type: "number" },
          reason: { type: "string" },
          anrede: { type: "string", enum: ["Herr", "Frau", ""] },
        },
      },
    },
  },
};

const MATCH_SYSTEM = `You validate LinkedIn search results for B2B outbound targeting.
Given a target company and desired buyer roles, select ONLY results that are clearly
a person currently at that company (or its obvious group parent) in a relevant role
(IT/SAP/ERP leadership, enterprise architecture, IT procurement). Extract name and
role from the result title/snippet. linkedin_url must be copied exactly from the
provided results. Exclude: people at similarly named but different companies,
consultants placed at the company, past employees where detectable, and irrelevant
roles. confidence 0-1. Return an empty list rather than guessing.
anrede: "Herr" or "Frau" when the first name makes it unambiguous, else "".`;

export async function discoverPeople(
  companyRaw: string,
  wantedRoles: string[],
  model: string
): Promise<{ contacts: ContactHypothesis[]; usages: LlmUsage[]; searched: number }> {
  const usages: LlmUsage[] = [];
  const queries = [
    `${wantedRoles.slice(0, 2).join(" or ")} at ${companyRaw}`,
    `SAP or IT leadership at ${companyRaw} Germany`,
  ];

  const hits: ExaHit[] = [];
  for (const q of queries) {
    try {
      hits.push(...(await searchLinkedIn(q)));
    } catch {
      // one failed query must not kill the stage
    }
  }
  const unique = [...new Map(hits.map((h) => [h.url, h])).values()];
  if (!unique.length) return { contacts: [], usages, searched: queries.length };

  const user = [
    `Target company: ${companyRaw}`,
    `Desired roles: ${wantedRoles.join(", ")}`,
    "",
    "LinkedIn search results:",
    ...unique.map((h, i) => `${i + 1}. ${h.title}\n   URL: ${h.url}\n   ${h.snippet}`),
  ].join("\n");

  const res = await jsonCall<{ matches: ContactHypothesis[] }>({
    model,
    purpose: "people_match",
    system: MATCH_SYSTEM,
    user,
    schemaName: "people_matches",
    schema: MATCH_SCHEMA,
    reasoningEffort: "none",
  });
  usages.push(res.usage);

  // Evidence contract for people too: only URLs that were actually in the results.
  const known = new Set(unique.map((h) => h.url));
  const contacts = res.data.matches.filter((m) => known.has(m.linkedin_url) && m.confidence >= 0.5);
  return { contacts, usages, searched: queries.length };
}
