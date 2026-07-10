import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RawObservation } from "./types.js";
import { companyKey, observationHash } from "./pipeline/normalize.js";

/**
 * SQLite for the reference implementation so reviewers can clone and run
 * without infrastructure. Production target is Postgres with the same schema
 * (see docs/decisions.md).
 */
export class Store {
  private db: Database.Database;

  constructor(path = "data/engine.sqlite") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        watcher TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        company_raw TEXT NOT NULL,
        company_key TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        posted_at TEXT,
        location TEXT,
        snippet TEXT,
        query TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
      );
      CREATE INDEX IF NOT EXISTS idx_obs_company ON observations(company_key);
      CREATE INDEX IF NOT EXISTS idx_obs_status ON observations(status);

      CREATE TABLE IF NOT EXISTS watcher_runs (
        id INTEGER PRIMARY KEY,
        watcher TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        queries INTEGER NOT NULL,
        fetched INTEGER NOT NULL,
        inserted INTEGER NOT NULL,
        duplicates INTEGER NOT NULL
      );
    `);
  }

  /** Insert observations, skipping already-seen URLs. Returns counts. */
  insertObservations(obs: RawObservation[]): { inserted: number; duplicates: number } {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO observations
        (hash, watcher, signal_type, company_raw, company_key, title, url,
         posted_at, location, snippet, query, fetched_at)
      VALUES
        (@hash, @watcher, @signalType, @companyRaw, @companyKey, @title, @url,
         @postedAt, @location, @snippet, @query, @fetchedAt)
    `);
    let inserted = 0;
    const tx = this.db.transaction((rows: RawObservation[]) => {
      for (const o of rows) {
        const res = stmt.run({
          ...o,
          hash: observationHash(o.url),
          companyKey: companyKey(o.companyRaw),
        });
        inserted += res.changes;
      }
    });
    tx(obs);
    return { inserted, duplicates: obs.length - inserted };
  }

  logRun(r: {
    watcher: string;
    startedAt: string;
    finishedAt: string;
    queries: number;
    fetched: number;
    inserted: number;
    duplicates: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO watcher_runs (watcher, started_at, finished_at, queries, fetched, inserted, duplicates)
         VALUES (@watcher, @startedAt, @finishedAt, @queries, @fetched, @inserted, @duplicates)`
      )
      .run(r);
  }

  /** Observations grouped by company for reporting. */
  companiesWithNewObservations(sinceIso: string): Array<{
    company_key: string;
    company_raw: string;
    postings: number;
    titles: string;
    urls: string;
    queries: string;
    first_seen: string;
  }> {
    return this.db
      .prepare(
        `SELECT company_key,
                MIN(company_raw) AS company_raw,
                COUNT(*) AS postings,
                GROUP_CONCAT(title, ' ||| ') AS titles,
                GROUP_CONCAT(url, ' ||| ') AS urls,
                GROUP_CONCAT(DISTINCT query) AS queries,
                MIN(fetched_at) AS first_seen
         FROM observations
         WHERE fetched_at >= ?
         GROUP BY company_key
         ORDER BY postings DESC, company_raw ASC`
      )
      .all(sinceIso) as any;
  }

  recentRuns(sinceIso: string): Array<{
    watcher: string;
    started_at: string;
    finished_at: string;
    queries: number;
    fetched: number;
    inserted: number;
    duplicates: number;
  }> {
    return this.db
      .prepare(`SELECT * FROM watcher_runs WHERE started_at >= ? ORDER BY started_at ASC`)
      .all(sinceIso) as any;
  }

  close() {
    this.db.close();
  }
}
