import { DEFAULTS, MODELS } from "./config.js";
import { Store } from "./store.js";
import { stepstoneJobsWatcher } from "./watchers/stepstoneJobs.js";
import { writeDailyReport } from "./report/daily.js";
import { writeSignalsReport } from "./report/signals.js";
import { classifyCompany } from "./pipeline/classify.js";
import { signalHash } from "./pipeline/normalize.js";
import type { Watcher, WatcherRunStats } from "./types.js";

const WATCHERS: Watcher[] = [stepstoneJobsWatcher];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function watch() {
  const demo = process.argv.includes("--demo");
  const maxItemsPerQuery = Number(arg("max-items") ?? DEFAULTS.maxItemsPerQuery);
  const postedWithinDays = Number(arg("days") ?? DEFAULTS.postedWithinDays);

  const store = new Store(demo ? "data/demo.sqlite" : "data/engine.sqlite");
  const sinceIso = new Date().toISOString();
  const allStats: WatcherRunStats[] = [];

  for (const watcher of WATCHERS) {
    const startedAt = new Date().toISOString();
    console.log(`Running watcher: ${watcher.name} (demo=${demo}, days=${postedWithinDays}, max/query=${maxItemsPerQuery})`);
    const obs = await watcher.run({ maxItemsPerQuery, postedWithinDays, demo });
    const { inserted, duplicates } = store.insertObservations(obs);
    const stats: WatcherRunStats = {
      watcher: watcher.name,
      queries: demo ? 0 : 6,
      fetched: obs.length,
      inserted,
      duplicates,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    store.logRun(stats);
    allStats.push(stats);
    console.log(`  fetched=${obs.length} new=${inserted} duplicates=${duplicates}`);
  }

  const reportPath = writeDailyReport(store, allStats, sinceIso, demo);
  console.log(`Report written: ${reportPath}`);
  store.close();
}

/** Regenerate today's report from stored observations (e.g. after pipeline changes). */
async function report() {
  const since = arg("since") ?? new Date().toISOString().slice(0, 10);
  const store = new Store("data/engine.sqlite");
  const stats = store.recentRuns(since).map((r) => ({
    watcher: r.watcher,
    queries: r.queries,
    fetched: r.fetched,
    inserted: r.inserted,
    duplicates: r.duplicates,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
  const path = writeDailyReport(store, stats, since);
  console.log(`Report written: ${path}`);
  store.close();
}

/** Classify unprocessed companies and derive signal events. */
async function classify() {
  const store = new Store("data/engine.sqlite");
  const maxCompanies = Number(arg("max") ?? 200);
  const groups = store.unclassifiedCompanies().slice(0, maxCompanies);
  console.log(`Classifying ${groups.length} companies with ${MODELS.classify} ...`);

  let signals = 0;
  let escalations = 0;
  const CHUNK = 5;

  for (let i = 0; i < groups.length; i += CHUNK) {
    const chunk = groups.slice(i, i + CHUNK);
    const outcomes = await Promise.all(
      chunk.map(async (g) => {
        try {
          return { g, out: await classifyCompany({ companyKey: g.company_key, companyRaw: g.company_raw, postings: g.postings }, MODELS.classify) };
        } catch (err) {
          console.log(`  ERROR ${g.company_raw}: ${(err as Error).message}`);
          return null;
        }
      })
    );

    for (const res of outcomes) {
      if (!res) continue;
      const { g, out } = res;
      const c = out.classification;
      for (const u of out.usages) store.logLlmUsage(u);
      store.saveClassification({
        companyKey: g.company_key,
        companyRaw: g.company_raw,
        companyType: c.company_type,
        isSignal: c.is_signal,
        confidence: c.confidence,
        industry: c.industry,
        quote: c.quote,
        reason: c.reason,
        escalated: out.escalated,
        model: MODELS.classify,
      });
      if (out.escalated) escalations++;

      if (c.is_signal && c.company_type === "end_user") {
        const strength = Math.min(1, c.confidence + 0.05 * (g.postings.length - 1));
        const created = store.upsertSignalEvent({
          hash: signalHash(g.company_key, "S1_erp_migration", new Date()),
          companyKey: g.company_key,
          companyRaw: g.company_raw,
          signalType: "S1_erp_migration",
          strength,
          evidenceJson: JSON.stringify({
            postings: g.postings.map((p) => ({ title: p.title, url: p.url, postedAt: p.postedAt })),
            lookup: out.lookupEvidence.map((l) => ({ url: l.url, title: l.title })),
            quote: c.quote,
          }),
        });
        if (created) signals++;
        console.log(`  SIGNAL  ${g.company_raw} (${c.industry}, conf ${c.confidence.toFixed(2)}${out.escalated ? ", escalated" : ""})`);
      } else {
        console.log(`  filtered ${g.company_raw} [${c.company_type}]`);
      }
    }
  }

  const path = writeSignalsReport(store);
  console.log(`\nDone: ${signals} new signal events, ${escalations} escalated lookups.`);
  console.log(`Signals report: ${path}`);
  store.close();
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "watch":
      await watch();
      break;
    case "classify":
      await classify();
      break;
    case "report":
      await report();
      break;
    default:
      console.log("Usage: tsx src/cli.ts <watch|classify|report> [--demo] [--days 7] [--max-items 25] [--max 200]");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
