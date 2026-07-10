import { mkdirSync, writeFileSync } from "node:fs";
import { estimateCostUsd } from "../config.js";
import type { Store } from "../store.js";
import type { Brief } from "../pipeline/brief.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Human-facing signal queue as a single self-contained HTML page,
 * rendered straight from the DB. Published via GitHub Pages.
 */
export function writeQueuePage(store: Store, outPath?: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const rows = store.signalsForExport();
  const usage = store.usageSummary();
  const cost = estimateCostUsd(usage);
  const withBrief = rows.filter((r) => r.brief_json).length;

  const cards = rows
    .map((r) => {
      const evidence = JSON.parse(r.evidence_json) as {
        postings?: { title: string; url: string; postedAt: string | null }[];
      };
      const brief: Brief | null = r.brief_json ? JSON.parse(r.brief_json) : null;
      const pct = Math.round(r.strength * 100);

      const evidenceLinks = (evidence.postings ?? [])
        .map(
          (p) =>
            `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${
              p.postedAt ? ` <span class="dim">(${esc(p.postedAt)})</span>` : ""
            }</li>`
        )
        .join("");

      const briefHtml = brief
        ? `
      <details>
        <summary>SDR brief &amp; email draft</summary>
        <div class="brief">
          <p><strong>Why now:</strong> ${esc(brief.why_now)}</p>
          <p><strong>Stakeholders to find:</strong> ${brief.stakeholder_hypothesis.map(esc).join(" · ")}</p>
          <p><strong>Angles:</strong></p>
          <ul>${brief.angles.map((a) => `<li><strong>${esc(a.title)}:</strong> ${esc(a.detail)}</li>`).join("")}</ul>
          <p><strong>Discovery questions:</strong></p>
          <ul>${brief.discovery_questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
          ${brief.flags.length ? `<p><strong>Flags:</strong> ${brief.flags.map(esc).join(" · ")}</p>` : ""}
          <div class="email">
            <div class="email-subject">${esc(brief.email_draft.subject)}</div>
            <div class="email-body">${esc(brief.email_draft.body).replace(/\n/g, "<br>")}</div>
            <div class="dim" style="margin-top:8px">Draft only. Human approval required before anything is sent.</div>
          </div>
        </div>
      </details>`
        : `<p class="dim">Brief pending.</p>`;

      return `
    <article class="card">
      <header>
        <h2>${esc(r.company_raw)}</h2>
        <span class="badge">${esc(r.industry ?? "n/a")}</span>
      </header>
      <div class="meter" title="Signal strength ${pct}%"><div style="width:${pct}%"></div></div>
      <p class="meta">Strength ${r.strength.toFixed(2)} · Confidence ${r.confidence.toFixed(2)} · ${r.postings} posting${
        r.postings === 1 ? "" : "s"
      } · detected ${esc(String(r.created_at).slice(0, 10))}</p>
      ${brief?.signal_quote || r.quote ? `<blockquote>"${esc(brief?.signal_quote ?? r.quote)}"</blockquote>` : ""}
      <ul class="evidence">${evidenceLinks}</ul>
      ${briefHtml}
    </article>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ArchivoX Signal Queue · ${day}</title>
<style>
  :root { --bg:#f7f8f8; --card:#ffffff; --text:#15201e; --dim:#5e6d6a; --accent:#0f766e; --line:#e2e8e6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#101514; --card:#18201e; --text:#e8eeec; --dim:#93a3a0; --accent:#2dd4bf; --line:#243230; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .sub { color: var(--dim); margin-bottom: 32px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin-bottom:18px; }
  .card header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .card h2 { font-size:18px; margin:0; }
  .badge { font-size:12px; color:var(--accent); border:1px solid var(--accent); border-radius:99px; padding:2px 10px; white-space:nowrap; }
  .meter { height:6px; background:var(--line); border-radius:3px; margin:12px 0 6px; overflow:hidden; }
  .meter div { height:100%; background:var(--accent); border-radius:3px; }
  .meta { color:var(--dim); font-size:13px; margin:4px 0 10px; }
  blockquote { margin:10px 0; padding:8px 14px; border-left:3px solid var(--accent); color:var(--text); font-style:italic; }
  ul.evidence { padding-left:18px; margin:8px 0; font-size:14px; }
  a { color:var(--accent); }
  .dim { color:var(--dim); font-size:13px; }
  details { margin-top:10px; }
  summary { cursor:pointer; color:var(--accent); font-weight:600; font-size:14px; }
  .brief { margin-top:10px; font-size:14px; }
  .email { border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-top:12px; background:var(--bg); }
  .email-subject { font-weight:600; margin-bottom:8px; }
  footer { color:var(--dim); font-size:13px; margin-top:32px; border-top:1px solid var(--line); padding-top:16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ArchivoX Signal Queue</h1>
  <p class="sub">${rows.length} qualified end-user signals (S1: ERP/S4 transformation) · ${withBrief} with SDR brief · generated ${day} · total LLM cost so far $${cost.toFixed(2)}</p>
  ${cards}
  <footer>
    Reference implementation for the SalesPlaybook GTM Engineer case study. Signals detected from public
    German job postings, classified and briefed under an evidence contract: every company claim traces to a
    captured source. Nothing on this page is sent anywhere without human approval.
  </footer>
</div>
</body>
</html>`;

  const path = outPath ?? `runs/${day}/queue.html`;
  mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, html);
  return path;
}
