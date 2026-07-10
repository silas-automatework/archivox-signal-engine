import { requireEnv } from "../config.js";

export interface LookupEvidence {
  url: string;
  title: string;
  excerpt: string;
}

/**
 * Escalation lookup for companies the classifier is uncertain about.
 * Fetches 2 short sources via Exa so the classifier decides on captured
 * evidence instead of browsing (evidence contract).
 */
export async function lookupCompany(companyName: string): Promise<LookupEvidence[]> {
  const key = requireEnv("EXA_AI_API_KEY");
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `${companyName} Unternehmen was macht die Firma Branche Produkte`,
      numResults: 2,
      type: "auto",
      contents: { text: { maxCharacters: 800 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa lookup failed: ${res.status}`);
  const json = (await res.json()) as {
    results: { url: string; title: string | null; text: string | null }[];
  };
  return (json.results ?? []).map((r) => ({
    url: r.url,
    title: r.title ?? "",
    excerpt: (r.text ?? "").slice(0, 800),
  }));
}
