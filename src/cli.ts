import { DEFAULTS, MODELS } from "./config.js";
import { Store } from "./store.js";
import { stepstoneJobsWatcher } from "./watchers/stepstoneJobs.js";
import { writeDailyReport } from "./report/daily.js";
import { writeSignalsReport } from "./report/signals.js";
import { classifyCompany } from "./pipeline/classify.js";
import { generateBrief } from "./pipeline/brief.js";
import { generateMagnet, renderMagnetHtml } from "./pipeline/magnet.js";
import { discoverPeople } from "./pipeline/people.js";
import { signalHash } from "./pipeline/normalize.js";
import { exportSignals } from "./export/signals.js";
import { writeCockpit } from "./report/cockpit.js";
import { setupHubspot, routeSignals } from "./route/hubspot.js";
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

/** Generate structured SDR briefs for signals that lack one. */
async function brief() {
  const store = new Store("data/engine.sqlite");
  const maxBriefs = Number(arg("max") ?? 30);
  const pending = store.signalsWithoutBrief().slice(0, maxBriefs);
  console.log(`Generating ${pending.length} briefs with ${MODELS.brief} ...`);

  let ok = 0;
  let contractViolations = 0;
  const CHUNK = 4;

  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (s) => {
        try {
          const evidence = JSON.parse(s.evidence_json);
          const out = await generateBrief(
            {
              signalId: s.signal_id,
              companyRaw: s.company_raw,
              industry: s.industry,
              confidence: s.confidence,
              strength: s.strength,
              quote: s.quote,
              reason: s.reason,
              evidence,
              snippets: store.snippetsForCompany(s.company_key),
            },
            MODELS.brief
          );
          return { s, out };
        } catch (err) {
          console.log(`  ERROR ${s.company_raw}: ${(err as Error).message}`);
          return null;
        }
      })
    );

    for (const res of results) {
      if (!res) continue;
      const { s, out } = res;
      for (const u of out.usages) store.logLlmUsage(u);
      const contractOk = out.problems.length === 0;
      store.saveBrief(s.signal_id, JSON.stringify(out.brief), MODELS.brief, contractOk);
      if (contractOk) {
        ok++;
        console.log(`  BRIEF   ${s.company_raw}`);
      } else {
        contractViolations++;
        console.log(`  CONTRACT VIOLATION (kept, flagged) ${s.company_raw}: ${out.problems.join("; ")}`);
      }
    }
  }

  console.log(`\nDone: ${ok} briefs clean, ${contractViolations} flagged after retry.`);
  store.close();
}

/** Generate the one-page lead magnet ("S/4-Datenaltlast-Check") per signal. */
async function magnet() {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const store = new Store("data/engine.sqlite");
  const maxMagnets = Number(arg("max") ?? 30);
  const pending = store.signalsWithoutMagnet().slice(0, maxMagnets);
  const day = new Date().toISOString().slice(0, 10);
  console.log(`Generating ${pending.length} magnets with ${MODELS.brief} ...`);

  let ok = 0;
  const CHUNK = 4;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (s) => {
        try {
          const out = await generateMagnet(
            {
              signalId: s.signal_id,
              companyRaw: s.company_raw,
              industry: s.industry,
              confidence: s.confidence,
              strength: s.strength,
              quote: s.quote,
              reason: s.reason,
              evidence: JSON.parse(s.evidence_json),
              snippets: store.snippetsForCompany(s.company_key),
            },
            MODELS.brief
          );
          return { s, out };
        } catch (err) {
          console.log(`  ERROR ${s.company_raw}: ${(err as Error).message}`);
          return null;
        }
      })
    );

    for (const res of results) {
      if (!res) continue;
      const { s, out } = res;
      for (const u of out.usages) store.logLlmUsage(u);
      if (out.problems.length) {
        console.log(`  SKIPPED (contract) ${s.company_raw}: ${out.problems.join("; ")}`);
        continue;
      }
      const dir = `runs/${day}/magnets`;
      mkdirSync(dir, { recursive: true });
      const path = `${dir}/${s.company_key.replace(/\s+/g, "-")}.html`;
      writeFileSync(path, renderMagnetHtml(s.company_raw, out.magnet, day));
      store.saveMagnet(s.signal_id, JSON.stringify(out.magnet), path, MODELS.brief);
      ok++;
      console.log(`  MAGNET  ${s.company_raw}`);
    }
  }
  console.log(`\nDone: ${ok} magnets rendered to runs/${day}/magnets/.`);
  store.close();
}

/** Account -> people stage: LinkedIn contact discovery for signal companies. */
async function people() {
  const store = new Store("data/engine.sqlite");
  const minContacts = Number(arg("min") ?? 2);
  const maxCompanies = Number(arg("max") ?? 30);
  const pending = store.companiesNeedingPeople(minContacts).slice(0, maxCompanies);
  console.log(`People discovery for ${pending.length} companies (target: ${minContacts}+ contacts each) ...`);

  const DEFAULT_ROLES = ["CIO", "Head of SAP", "Leiter IT", "Enterprise Architect"];
  let found = 0;
  const CHUNK = 4;

  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (c) => {
        const roles: string[] = c.brief_json
          ? (JSON.parse(c.brief_json).stakeholder_hypothesis ?? DEFAULT_ROLES)
          : DEFAULT_ROLES;
        try {
          return { c, out: await discoverPeople(c.company_raw, roles.slice(0, 4), MODELS.classify) };
        } catch (err) {
          console.log(`  ERROR ${c.company_raw}: ${(err as Error).message}`);
          return null;
        }
      })
    );

    for (const res of results) {
      if (!res) continue;
      const { c, out } = res;
      for (const u of out.usages) store.logLlmUsage(u);
      for (const contact of out.contacts) {
        store.upsertContact({
          companyKey: c.company_key,
          name: contact.name,
          role: contact.role,
          linkedinUrl: contact.linkedin_url,
          confidence: contact.confidence,
          reason: contact.reason,
          anrede: contact.anrede ?? "",
        });
        found++;
      }
      console.log(`  ${out.contacts.length ? "PEOPLE " : "none   "} ${c.company_raw}: ${out.contacts.map((p) => `${p.name} (${p.role})`).join(", ") || "no confident match"}`);
    }
  }

  console.log(`\nDone: ${found} contact hypotheses stored. Email enrichment stays stubbed (production: waterfall).`);
  store.close();
}

/** Create the engine-owned custom properties in the HubSpot portal. */
async function hubspotSetup() {
  console.log("Setting up HubSpot portal (custom company properties) ...");
  await setupHubspot();
  console.log("Done.");
}

/** Route signal events into HubSpot: company, note (brief), task (email draft). */
async function route() {
  const store = new Store("data/engine.sqlite");
  const maxSignals = Number(arg("max") ?? 30);
  console.log(`Routing up to ${maxSignals} signals into HubSpot ...`);
  const { routed } = await routeSignals(store, maxSignals);
  console.log(`\nDone: ${routed} signals routed.`);
  store.close();
}

/** Write machine-readable exports (signals.json + signals.csv). */
async function exportCmd() {
  const store = new Store("data/engine.sqlite");
  const { jsonPath, csvPath, count } = exportSignals(store);
  console.log(`Exported ${count} signals:\n  ${jsonPath}\n  ${csvPath}`);
  store.close();
}

/** Render the human-facing HTML cockpit. */
async function cockpit() {
  const store = new Store("data/engine.sqlite");
  const path = writeCockpit(store, arg("out"));
  console.log(`Cockpit written: ${path}`);
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
    case "brief":
      await brief();
      break;
    case "magnet":
      await magnet();
      break;
    case "people":
      await people();
      break;
    case "export":
      await exportCmd();
      break;
    case "hubspot:setup":
      await hubspotSetup();
      break;
    case "route":
      await route();
      break;
    case "cockpit":
      await cockpit();
      break;
    case "report":
      await report();
      break;
    default:
      console.log(
        "Usage: tsx src/cli.ts <watch|classify|brief|people|export|cockpit|report> [--demo] [--days 7] [--max-items 25] [--max N] [--min N] [--out path]"
      );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
