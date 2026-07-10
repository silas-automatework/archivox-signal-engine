/**
 * Watcher queries for signal S1 (ERP/S4 transformation) via job postings.
 * German market sources, German search terms. Each query is a hypothesis:
 * "a company hiring for this is inside or entering an ERP migration window".
 */
export const S1_JOB_QUERIES: string[] = [
  "S/4HANA Migration",
  "S/4HANA Transformation",
  "SAP ECC",
  "SAP Archivierung",
  "SAP ILM",
  "ERP Transformation",
];

export const STEPSTONE_ACTOR = "memo23~stepstone-search-cheerio-ppr";

export const DEFAULTS = {
  /** Cost guard: hard cap on items per query per run. */
  maxItemsPerQuery: 25,
  /** Daily watcher looks back 7 days by default; overlap is handled by dedupe. */
  postedWithinDays: 7,
};

/**
 * Model tiers are env-swappable. Defaults target the cheapest tier that is
 * reliable for the job; switch to gpt-5.6-luna / gpt-5.6-terra once available
 * on the account.
 */
export const MODELS = {
  classify: process.env.CLASSIFY_MODEL ?? "gpt-5-mini",
  brief: process.env.BRIEF_MODEL ?? "gpt-5",
};

/** USD per 1M tokens, for the cost line in reports. Extend when adding models. */
export const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "gpt-5": { in: 1.25, out: 10 },
  "gpt-5-mini": { in: 0.25, out: 2 },
  "gpt-5-nano": { in: 0.05, out: 0.4 },
};

export function estimateCostUsd(rows: { model: string; input_tokens: number; output_tokens: number }[]): number {
  let usd = 0;
  for (const r of rows) {
    const p = Object.entries(PRICE_PER_M).find(([k]) => r.model.startsWith(k))?.[1];
    if (p) usd += (r.input_tokens / 1e6) * p.in + (r.output_tokens / 1e6) * p.out;
  }
  return usd;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}
