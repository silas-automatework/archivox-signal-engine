/** A single observation fetched by a watcher, before classification. */
export interface RawObservation {
  watcher: string;
  /** Candidate signal type, e.g. S1_erp_migration. Confirmed or discarded by classification. */
  signalType: string;
  companyRaw: string;
  title: string;
  url: string;
  postedAt: string | null;
  location: string | null;
  /** Text excerpt used as evidence input for classification. */
  snippet: string | null;
  /** The watcher query that produced this observation. */
  query: string;
  fetchedAt: string;
}

export interface WatcherRunStats {
  watcher: string;
  queries: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  /** Queries that returned exactly the per-query cap: more postings likely existed. */
  cappedQueries: number;
  startedAt: string;
  finishedAt: string;
}

export interface WatcherResult {
  observations: RawObservation[];
  /** Queries that hit the per-query item cap. */
  cappedQueries: number;
}

export interface Watcher {
  name: string;
  run(opts: { maxItemsPerQuery: number; postedWithinDays: number; demo: boolean }): Promise<WatcherResult>;
}
