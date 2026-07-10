import { mkdirSync, writeFileSync } from "node:fs";
import { renderEmail } from "../pipeline/emailTemplate.js";
import type { Store } from "../store.js";
import type { Brief } from "../pipeline/brief.js";

/**
 * The machine-readable integration contract:
 * - signals.json: full nested export (evidence, brief) for any downstream system
 * - signals.csv: flat one-row-per-signal export, Clay-table compatible
 * DB stays the source of truth; these are derived artifacts.
 */
export function exportSignals(store: Store): { jsonPath: string; csvPath: string; count: number } {
  const day = new Date().toISOString().slice(0, 10);
  const dir = `runs/${day}`;
  mkdirSync(dir, { recursive: true });

  const rows = store.signalsForExport();

  const full = rows.map((r) => {
    const evidence = JSON.parse(r.evidence_json);
    const brief: Brief | null = r.brief_json ? JSON.parse(r.brief_json) : null;
    const contacts = store.contactsForCompany(r.company_key);
    const email = brief ? renderEmail(brief.email_slots, { recipient: contacts[0] ?? null }) : null;
    return {
      signal_id: r.signal_id,
      company: r.company_raw,
      company_key: r.company_key,
      signal_type: r.signal_type,
      strength: r.strength,
      confidence: r.confidence,
      industry: r.industry,
      status: r.status,
      detected_at: r.created_at,
      postings_count: r.postings,
      classifier_quote: r.quote,
      classifier_reason: r.reason,
      evidence,
      brief,
      brief_contract_ok: r.contract_ok === null ? null : r.contract_ok === 1,
      contacts,
      rendered_email: email,
    };
  });

  const jsonPath = `${dir}/signals.json`;
  writeFileSync(jsonPath, JSON.stringify(full, null, 2));

  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = [
    "company",
    "industry",
    "signal_type",
    "strength",
    "confidence",
    "postings_count",
    "detected_at",
    "signal_quote",
    "evidence_url_1",
    "evidence_url_2",
    "why_now",
    "angle_1",
    "angle_2",
    "angle_3",
    "contact_1_name",
    "contact_1_role",
    "contact_1_linkedin",
    "contact_2_name",
    "contact_2_role",
    "contact_2_linkedin",
    "email_subject",
    "email_body",
  ];
  const lines = [header.join(",")];
  for (const f of full) {
    const urls = (f.evidence.postings ?? []).map((p: { url: string }) => p.url);
    lines.push(
      [
        f.company,
        f.industry,
        f.signal_type,
        f.strength.toFixed(2),
        f.confidence.toFixed(2),
        f.postings_count,
        f.detected_at,
        f.brief?.signal_quote ?? f.classifier_quote ?? "",
        urls[0] ?? "",
        urls[1] ?? "",
        f.brief?.why_now ?? "",
        f.brief?.angles?.[0]?.title ?? "",
        f.brief?.angles?.[1]?.title ?? "",
        f.brief?.angles?.[2]?.title ?? "",
        f.contacts[0]?.name ?? "",
        f.contacts[0]?.role ?? "",
        f.contacts[0]?.linkedin_url ?? "",
        f.contacts[1]?.name ?? "",
        f.contacts[1]?.role ?? "",
        f.contacts[1]?.linkedin_url ?? "",
        f.rendered_email?.subject ?? "",
        f.rendered_email?.body ?? "",
      ]
        .map(esc)
        .join(",")
    );
  }
  const csvPath = `${dir}/signals.csv`;
  writeFileSync(csvPath, lines.join("\n"));

  return { jsonPath, csvPath, count: full.length };
}
