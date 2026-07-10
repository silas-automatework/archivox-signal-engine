import { mkdirSync, writeFileSync } from "node:fs";
import { estimateCostUsd } from "../config.js";
import { renderEmail } from "../pipeline/emailTemplate.js";
import type { Store } from "../store.js";
import type { Brief } from "../pipeline/brief.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The SDR cockpit: one compact row per signal, everything actionable one
 * click deep. No raw-data dumps; those live in report.md and signals.json.
 */
export function writeCockpit(store: Store, outPath?: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const rows = store.signalsForExport();
  const usage = store.usageSummary();
  const cost = estimateCostUsd(usage);

  let contactsTotal = 0;

  const items = rows
    .map((r) => {
      const evidence = JSON.parse(r.evidence_json) as {
        postings?: { title: string; url: string; postedAt: string | null }[];
      };
      const brief: Brief | null = r.brief_json ? JSON.parse(r.brief_json) : null;
      const contacts = store.contactsForCompany(r.company_key);
      contactsTotal += contacts.length;
      const pct = Math.round(r.strength * 100);

      const email = brief ? renderEmail(brief.email_slots) : null;

      const contactsHtml = contacts.length
        ? `<ul class="contacts">${contacts
            .map(
              (c) =>
                `<li><a href="${esc(c.linkedin_url)}" target="_blank" rel="noopener">${esc(c.name)}</a> · ${esc(c.role)} <span class="dim">(${Math.round(c.confidence * 100)}%)</span></li>`
            )
            .join("")}</ul>`
        : `<p class="dim">No confident contact hypotheses yet.</p>`;

      const detail = `
        ${brief?.signal_quote || r.quote ? `<blockquote>"${esc(brief?.signal_quote ?? r.quote)}"</blockquote>` : ""}
        <div class="cols">
          <div>
            <h4>Why now</h4>
            <p>${esc(brief?.why_now ?? r.reason ?? "")}</p>
            <h4>Angles</h4>
            <ul>${(brief?.angles ?? []).map((a) => `<li><strong>${esc(a.title)}</strong> ${esc(a.detail)}</li>`).join("")}</ul>
            ${brief?.flags.length ? `<h4>Flags</h4><ul>${brief.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
          </div>
          <div>
            <h4>People</h4>
            ${contactsHtml}
            <h4>Evidence</h4>
            <ul>${(evidence.postings ?? [])
              .map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></li>`)
              .join("")}</ul>
            ${
              r.magnet_path
                ? `<h4>Lead magnet</h4><p><a href="${esc(r.magnet_path.replace(/^runs\/[^/]+\//, ""))}" target="_blank" rel="noopener">S/4-Datenaltlast-Check (das Give hinter der Mail)</a></p>`
                : ""
            }
            ${
              email
                ? `<h4>Email draft <span class="dim">(template + evidence slots, approval required)</span></h4>
                   <div class="email"><div class="email-subject">${esc(email.subject)}</div>${esc(email.body).replace(/\n/g, "<br>")}</div>`
                : ""
            }
          </div>
        </div>`;

      return `
    <details class="row">
      <summary>
        <span class="meter" title="strength ${pct}%"><span style="width:${pct}%"></span></span>
        <span class="company">${esc(r.company_raw)}</span>
        <span class="badge">${esc(r.industry ?? "n/a")}</span>
        <span class="stats">${r.postings}p · ${contacts.length}c</span>
      </summary>
      <div class="detail">${detail}</div>
    </details>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ArchivoX Signal Cockpit · ${day}</title>
<style>
  :root { --bg:#f7f8f8; --card:#ffffff; --text:#15201e; --dim:#5e6d6a; --accent:#0f766e; --line:#e2e8e6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101514; --card:#18201e; --text:#e8eeec; --dim:#93a3a0; --accent:#2dd4bf; --line:#243230; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width: 960px; margin: 0 auto; padding: 36px 20px 80px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: var(--dim); margin-bottom: 24px; font-size: 14px; }
  .kpis { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:28px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 16px; }
  .kpi b { font-size:20px; display:block; }
  .kpi span { color:var(--dim); font-size:12px; }
  .row { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:8px; }
  .row summary { display:flex; align-items:center; gap:14px; padding:12px 16px; cursor:pointer; list-style:none; }
  .row summary::-webkit-details-marker { display:none; }
  .meter { width:54px; height:5px; background:var(--line); border-radius:3px; overflow:hidden; flex:none; }
  .meter span { display:block; height:100%; background:var(--accent); }
  .company { font-weight:600; flex:1; min-width:0; }
  .badge { font-size:11px; color:var(--accent); border:1px solid var(--accent); border-radius:99px; padding:1px 9px; white-space:nowrap; }
  .stats { color:var(--dim); font-size:12px; white-space:nowrap; }
  .detail { padding: 4px 18px 18px; border-top:1px solid var(--line); font-size:14px; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:0 28px; }
  @media (max-width:720px){ .cols { grid-template-columns:1fr; } }
  h4 { margin:14px 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); }
  ul { margin:4px 0; padding-left:18px; }
  li { margin:2px 0; }
  blockquote { margin:12px 0 4px; padding:6px 14px; border-left:3px solid var(--accent); font-style:italic; }
  a { color:var(--accent); }
  .dim { color:var(--dim); font-size:12px; font-weight:400; text-transform:none; letter-spacing:0; }
  .email { border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:var(--bg); font-size:13px; }
  .email-subject { font-weight:600; margin-bottom:8px; }
  .contacts { list-style:none; padding-left:0; }
  footer { color:var(--dim); font-size:13px; margin-top:28px; border-top:1px solid var(--line); padding-top:14px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ArchivoX Signal Cockpit</h1>
  <p class="sub">S1: ERP/S4 transformation · detected from public German job postings · updated ${day}</p>
  <div class="kpis">
    <div class="kpi"><b>${rows.length}</b><span>qualified signals</span></div>
    <div class="kpi"><b>${rows.filter((r) => r.brief_json).length}</b><span>with SDR brief</span></div>
    <div class="kpi"><b>${contactsTotal}</b><span>contact hypotheses</span></div>
    <div class="kpi"><b>$${cost.toFixed(2)}</b><span>total LLM cost</span></div>
  </div>
  ${items}
  <footer>
    Reference implementation for the SalesPlaybook GTM Engineer case study. Everything above traces to
    captured public sources (evidence contract). Emails are template-rendered with evidence-anchored slots.
    Nothing is sent without human approval.
  </footer>
</div>
</body>
</html>`;

  const path = outPath ?? `runs/${day}/cockpit.html`;
  mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, html);
  return path;
}
