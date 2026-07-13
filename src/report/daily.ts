import { mkdirSync, writeFileSync } from "node:fs";
import type { Store } from "../store.js";
import type { WatcherRunStats } from "../types.js";

/** Markdown report per run day: what the watcher saw, grouped by company. */
export function writeDailyReport(store: Store, stats: WatcherRunStats[], sinceIso: string, demo = false): string {
  const day = new Date().toISOString().slice(0, 10);
  const dir = demo ? `runs/demo` : `runs/${day}`;
  mkdirSync(dir, { recursive: true });

  const companies = store.companiesWithNewObservations(sinceIso);

  const lines: string[] = [];
  lines.push(`# Signal Watch Report ${day}`);
  lines.push("");
  lines.push(`Candidate signal: S1 (ERP/S4 transformation) via German job postings.`);
  lines.push("");
  lines.push(`## Run stats`);
  lines.push("");
  lines.push(`| Watcher | Queries | Fetched | New | Duplicates | Cap hits |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const s of stats) {
    lines.push(
      `| ${s.watcher} | ${s.queries} | ${s.fetched} | ${s.inserted} | ${s.duplicates} | ${s.cappedQueries ? `${s.cappedQueries} (more postings likely existed)` : "0"} |`
    );
  }
  lines.push("");
  lines.push(`## Companies with signal-candidate postings (${companies.length})`);
  lines.push("");
  for (const c of companies) {
    const titles = String(c.titles).split(" ||| ");
    const urls = String(c.urls).split(" ||| ");
    lines.push(`### ${c.company_raw}`);
    lines.push("");
    lines.push(`Postings: ${c.postings} · Queries: ${c.queries}`);
    lines.push("");
    titles.forEach((t, i) => {
      lines.push(`- [${t}](${urls[i] ?? "#"})`);
    });
    lines.push("");
  }
  lines.push(`---`);
  lines.push(`Next pipeline stages (classification, scoring, briefs) consume observations with status 'new'.`);
  lines.push("");

  const path = `${dir}/report.md`;
  writeFileSync(path, lines.join("\n"));
  return path;
}
