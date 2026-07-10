import { mkdirSync, writeFileSync } from "node:fs";
import { estimateCostUsd } from "../config.js";
import type { Store } from "../store.js";

/**
 * The SDR-facing artifact: qualified signals ranked by strength,
 * plus classification breakdown and run cost.
 */
export function writeSignalsReport(store: Store): string {
  const day = new Date().toISOString().slice(0, 10);
  const dir = `runs/${day}`;
  mkdirSync(dir, { recursive: true });

  const signals = store.qualifiedSignals();
  const noise = store.classificationBreakdown();
  const usage = store.usageSummary();

  const lines: string[] = [];
  lines.push(`# Qualified Signals ${day}`);
  lines.push("");
  lines.push(
    `${signals.length} end-user companies with an active S1 (ERP/S4 transformation) signal, ranked by strength.`
  );
  lines.push("");

  for (const s of signals) {
    const ev = JSON.parse(s.evidence_json) as {
      postings?: { title: string; url: string; postedAt: string | null }[];
      lookup?: { url: string; title: string }[];
    };
    lines.push(`## ${s.company_raw}`);
    lines.push("");
    lines.push(
      `Strength ${s.strength.toFixed(2)} · Confidence ${s.confidence.toFixed(2)} · Industry: ${s.industry ?? "n/a"} · Postings: ${s.postings}`
    );
    lines.push("");
    if (s.quote) lines.push(`> "${s.quote}"`);
    if (s.reason) lines.push(`\n${s.reason}`);
    lines.push("");
    for (const p of ev.postings ?? []) {
      lines.push(`- Evidence: [${p.title}](${p.url})${p.postedAt ? ` (${p.postedAt})` : ""}`);
    }
    lines.push("");
  }

  lines.push(`## Filtered out (no outreach)`);
  lines.push("");
  for (const n of noise) {
    lines.push(`- **${n.company_type}** (${n.n}): ${n.companies}`);
  }
  lines.push("");

  const cost = estimateCostUsd(usage);
  const calls = usage.reduce((a, u) => a + u.calls, 0);
  lines.push(`---`);
  lines.push(
    `Classification: ${calls} LLM calls, est. cost $${cost.toFixed(3)}. Every quote above is copied verbatim from captured evidence (evidence contract).`
  );
  lines.push("");

  const path = `${dir}/signals.md`;
  writeFileSync(path, lines.join("\n"));
  return path;
}
