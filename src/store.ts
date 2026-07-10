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

      CREATE TABLE IF NOT EXISTS company_classifications (
        company_key TEXT PRIMARY KEY,
        company_raw TEXT NOT NULL,
        company_type TEXT NOT NULL,
        is_signal INTEGER NOT NULL,
        confidence REAL NOT NULL,
        industry TEXT,
        quote TEXT,
        reason TEXT,
        escalated INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        classified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signal_events (
        id INTEGER PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        company_key TEXT NOT NULL,
        company_raw TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        strength REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate',
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY,
        company_key TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        linkedin_url TEXT UNIQUE NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'exa_linkedin',
        status TEXT NOT NULL DEFAULT 'hypothesis',
        email TEXT,
        email_status TEXT NOT NULL DEFAULT 'not_enriched',
        first_seen TEXT NOT NULL,
        last_verified TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_key);

      CREATE TABLE IF NOT EXISTS briefs (
        id INTEGER PRIMARY KEY,
        signal_id INTEGER UNIQUE NOT NULL REFERENCES signal_events(id),
        brief_json TEXT NOT NULL,
        model TEXT NOT NULL,
        contract_ok INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS llm_usage (
        id INTEGER PRIMARY KEY,
        used_at TEXT NOT NULL,
        model TEXT NOT NULL,
        purpose TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL
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

  /** Companies with observations not yet classified, with up to 3 postings each. */
  unclassifiedCompanies(): Array<{
    company_key: string;
    company_raw: string;
    postings: { title: string; url: string; snippet: string | null; query: string; postedAt: string | null }[];
  }> {
    const rows = this.db
      .prepare(
        `SELECT o.company_key, o.company_raw, o.title, o.url, o.snippet, o.query, o.posted_at
         FROM observations o
         LEFT JOIN company_classifications c ON c.company_key = o.company_key
         WHERE c.company_key IS NULL
         ORDER BY o.company_key, o.fetched_at DESC`
      )
      .all() as any[];
    const byKey = new Map<string, any>();
    for (const r of rows) {
      if (!byKey.has(r.company_key)) {
        byKey.set(r.company_key, { company_key: r.company_key, company_raw: r.company_raw, postings: [] });
      }
      const g = byKey.get(r.company_key);
      if (g.postings.length < 3) {
        g.postings.push({ title: r.title, url: r.url, snippet: r.snippet, query: r.query, postedAt: r.posted_at });
      }
    }
    return [...byKey.values()];
  }

  saveClassification(c: {
    companyKey: string;
    companyRaw: string;
    companyType: string;
    isSignal: boolean;
    confidence: number;
    industry: string;
    quote: string;
    reason: string;
    escalated: boolean;
    model: string;
  }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO company_classifications
           (company_key, company_raw, company_type, is_signal, confidence, industry,
            quote, reason, escalated, model, classified_at)
         VALUES (@companyKey, @companyRaw, @companyType, @isSignal, @confidence, @industry,
                 @quote, @reason, @escalated, @model, @classifiedAt)`
      )
      .run({
        ...c,
        isSignal: c.isSignal ? 1 : 0,
        escalated: c.escalated ? 1 : 0,
        classifiedAt: new Date().toISOString(),
      });
  }

  upsertSignalEvent(e: {
    hash: string;
    companyKey: string;
    companyRaw: string;
    signalType: string;
    strength: number;
    evidenceJson: string;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO signal_events
           (hash, company_key, company_raw, signal_type, strength, evidence_json, created_at)
         VALUES (@hash, @companyKey, @companyRaw, @signalType, @strength, @evidenceJson, @createdAt)`
      )
      .run({ ...e, createdAt: new Date().toISOString() });
    return res.changes > 0;
  }

  logLlmUsage(u: { model: string; purpose: string; inputTokens: number; outputTokens: number }) {
    this.db
      .prepare(
        `INSERT INTO llm_usage (used_at, model, purpose, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(new Date().toISOString(), u.model, u.purpose, u.inputTokens, u.outputTokens);
  }

  qualifiedSignals(): Array<{
    company_raw: string;
    company_key: string;
    signal_type: string;
    strength: number;
    evidence_json: string;
    created_at: string;
    industry: string | null;
    confidence: number;
    quote: string | null;
    reason: string | null;
    postings: number;
  }> {
    return this.db
      .prepare(
        `SELECT s.company_raw, s.company_key, s.signal_type, s.strength, s.evidence_json, s.created_at,
                c.industry, c.confidence, c.quote, c.reason,
                (SELECT COUNT(*) FROM observations o WHERE o.company_key = s.company_key) AS postings
         FROM signal_events s
         JOIN company_classifications c ON c.company_key = s.company_key
         ORDER BY s.strength DESC, s.company_raw ASC`
      )
      .all() as any;
  }

  /** Signals lacking a brief, with the snippets needed as brief evidence. */
  signalsWithoutBrief(): Array<{
    signal_id: number;
    company_key: string;
    company_raw: string;
    industry: string | null;
    confidence: number;
    strength: number;
    quote: string | null;
    reason: string | null;
    evidence_json: string;
  }> {
    return this.db
      .prepare(
        `SELECT s.id AS signal_id, s.company_key, s.company_raw, s.strength, s.evidence_json,
                c.industry, c.confidence, c.quote, c.reason
         FROM signal_events s
         JOIN company_classifications c ON c.company_key = s.company_key
         LEFT JOIN briefs b ON b.signal_id = s.id
         WHERE b.id IS NULL
         ORDER BY s.strength DESC`
      )
      .all() as any;
  }

  snippetsForCompany(companyKey: string): { title: string; snippet: string | null; url: string }[] {
    return this.db
      .prepare(
        `SELECT title, snippet, url FROM observations WHERE company_key = ? ORDER BY fetched_at DESC LIMIT 3`
      )
      .all(companyKey) as any;
  }

  saveBrief(signalId: number, briefJson: string, model: string, contractOk: boolean) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO briefs (signal_id, brief_json, model, contract_ok, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(signalId, briefJson, model, contractOk ? 1 : 0, new Date().toISOString());
  }

  upsertContact(c: {
    companyKey: string;
    name: string;
    role: string;
    linkedinUrl: string;
    confidence: number;
    reason: string;
  }): boolean {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO contacts (company_key, name, role, linkedin_url, confidence, reason, first_seen, last_verified)
         VALUES (@companyKey, @name, @role, @linkedinUrl, @confidence, @reason, @now, @now)
         ON CONFLICT(linkedin_url) DO UPDATE SET
           role = excluded.role, confidence = excluded.confidence, last_verified = excluded.last_verified`
      )
      .run({ ...c, now });
    return res.changes > 0;
  }

  contactsForCompany(companyKey: string): Array<{
    name: string;
    role: string;
    linkedin_url: string;
    confidence: number;
    email_status: string;
    last_verified: string;
  }> {
    return this.db
      .prepare(
        `SELECT name, role, linkedin_url, confidence, email_status, last_verified
         FROM contacts WHERE company_key = ? ORDER BY confidence DESC`
      )
      .all(companyKey) as any;
  }

  /** Signal companies with fewer than min fresh contacts (the reuse bridge). */
  companiesNeedingPeople(minContacts = 2): Array<{ company_key: string; company_raw: string; brief_json: string | null }> {
    return this.db
      .prepare(
        `SELECT s.company_key, s.company_raw, b.brief_json
         FROM signal_events s
         LEFT JOIN briefs b ON b.signal_id = s.id
         WHERE (SELECT COUNT(*) FROM contacts c WHERE c.company_key = s.company_key) < ?
         GROUP BY s.company_key
         ORDER BY s.strength DESC`
      )
      .all(minContacts) as any;
  }

  /** Full signal rows incl. brief for export, queue rendering and routing. */
  signalsForExport(): Array<{
    signal_id: number;
    company_raw: string;
    company_key: string;
    signal_type: string;
    strength: number;
    status: string;
    created_at: string;
    industry: string | null;
    confidence: number;
    quote: string | null;
    reason: string | null;
    evidence_json: string;
    brief_json: string | null;
    contract_ok: number | null;
    postings: number;
  }> {
    return this.db
      .prepare(
        `SELECT s.id AS signal_id, s.company_raw, s.company_key, s.signal_type, s.strength,
                s.status, s.created_at, s.evidence_json,
                c.industry, c.confidence, c.quote, c.reason,
                b.brief_json, b.contract_ok,
                (SELECT COUNT(*) FROM observations o WHERE o.company_key = s.company_key) AS postings
         FROM signal_events s
         JOIN company_classifications c ON c.company_key = s.company_key
         LEFT JOIN briefs b ON b.signal_id = s.id
         ORDER BY s.strength DESC, s.company_raw ASC`
      )
      .all() as any;
  }

  classificationBreakdown(): Array<{ company_type: string; n: number; companies: string }> {
    return this.db
      .prepare(
        `SELECT company_type, COUNT(*) AS n, GROUP_CONCAT(company_raw, ', ') AS companies
         FROM company_classifications
         WHERE is_signal = 0
         GROUP BY company_type
         ORDER BY n DESC`
      )
      .all() as any;
  }

  usageSummary(): Array<{ model: string; purpose: string; calls: number; input_tokens: number; output_tokens: number }> {
    return this.db
      .prepare(
        `SELECT model, purpose, COUNT(*) AS calls,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
         FROM llm_usage GROUP BY model, purpose`
      )
      .all() as any;
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
