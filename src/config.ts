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

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}
