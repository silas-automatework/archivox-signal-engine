import { DEFAULTS } from "./config.js";
import { Store } from "./store.js";
import { stepstoneJobsWatcher } from "./watchers/stepstoneJobs.js";
import { writeDailyReport } from "./report/daily.js";
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

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "watch":
      await watch();
      break;
    case "report":
      await report();
      break;
    default:
      console.log("Usage: tsx src/cli.ts watch [--demo] [--days 7] [--max-items 25]");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
