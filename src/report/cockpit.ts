import { mkdirSync, writeFileSync } from "node:fs";
import { estimateCostUsd } from "../config.js";
import { renderEmail } from "../pipeline/emailTemplate.js";
import { redactPerson } from "../redact.js";
import type { Store } from "../store.js";
import type { Brief } from "../pipeline/brief.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Per-day run log: what each daily run found and cost. */
function renderRunLog(store: Store): string {
  const days = store.dailyStats();
  if (!days.length) return "";
  const usage = store.dailyUsage();
  const costFor = (day: string) => estimateCostUsd(usage.filter((u) => u.day === day));
  const maxSignals = Math.max(...days.map((d) => d.new_signals), 1);

  const rows = days
    .map((d) => {
      const companies = d.new_companies
        ? esc(d.new_companies.length > 110 ? d.new_companies.slice(0, 110) + " …" : d.new_companies)
        : '<span class="dim-log">keine neuen Signale</span>';
      const pct = Math.round((d.new_signals / maxSignals) * 100);
      return `<tr>
        <td class="mono-cell">${esc(d.day)}</td>
        <td class="mono-cell num">${d.fetched}${d.capped_queries ? ` <span class="dim-log" title="Query-Limit erreicht, vermutlich weitere Postings vorhanden">(Limit)</span>` : ""}</td>
        <td class="mono-cell num"><span class="logbar" style="--w:${pct}%"></span>+${d.new_signals}</td>
        <td class="mono-cell num">+${d.new_contacts}</td>
        <td class="mono-cell num">$${costFor(d.day).toFixed(2)}</td>
        <td class="companies">${companies}</td>
      </tr>`;
    })
    .join("");

  return `
  <h2 class="runlog-title">Tagesläufe</h2>
  <p class="runlog-sub">Jeder Lauf setzt auf dem Vortag auf. Bekannte Signale werden dedupliziert (30-Tage-Fenster), gezählt wird nur Neues.</p>
  <div class="runlog-scroll"><table class="runlog">
    <tr><th>Tag</th><th>Postings</th><th>Neue Signale</th><th>Neue Personen</th><th>LLM-Kosten</th><th>Neue Firmen</th></tr>
    ${rows}
  </table></div>`;
}

/**
 * The SDR cockpit in the ArchivoX design system: every signal is an Akte
 * (file) with a Registerkarte, mono record lines carry the registratur data.
 * A tool, therefore light and dark.
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
      const contacts = store.contactsForCompany(r.company_key).map(redactPerson);
      contactsTotal += contacts.length;
      const pct = Math.round(r.strength * 100);
      const email = brief ? renderEmail(brief.email_slots, { recipient: contacts[0] ?? null }) : null;
      const akte = `S1-${String(r.created_at).slice(0, 10).replace(/-/g, "")} · STÄRKE ${r.strength.toFixed(2)} · KONF ${r.confidence.toFixed(2)} · ${r.postings} BELEGE · ${contacts.length} PERSONEN`;

      const contactsHtml = contacts.length
        ? `<ul class="contacts">${contacts
            .map((c) => {
              const label = c.linkedin_url
                ? `<a href="${esc(c.linkedin_url)}" target="_blank" rel="noopener">${esc(c.name)}</a>`
                : `<strong>${esc(c.name)}</strong>`;
              return `<li>${label}<span class="c-role">${esc(c.role)}</span><span class="c-conf">${Math.round(c.confidence * 100)}%</span></li>`;
            })
            .join("")}</ul>`
        : `<p class="none">Noch keine belastbaren Personen-Hypothesen.</p>`;

      const detail = `
        ${brief?.signal_quote || r.quote ? `<blockquote>"${esc(brief?.signal_quote ?? r.quote)}"</blockquote>` : ""}
        <div class="cols">
          <div>
            <h4>Why now</h4>
            <p>${esc(brief?.why_now ?? r.reason ?? "")}</p>
            <h4>Angles</h4>
            <ul class="plain">${(brief?.angles ?? []).map((a) => `<li><b>${esc(a.title)}</b> ${esc(a.detail)}</li>`).join("")}</ul>
            ${brief?.flags.length ? `<h4>Flags</h4><ul class="plain">${brief.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
          </div>
          <div>
            <h4>Personen</h4>
            ${contactsHtml}
            <h4>Belege</h4>
            <ul class="plain evidence">${(evidence.postings ?? [])
              .map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></li>`)
              .join("")}</ul>
            ${
              r.magnet_path
                ? `<a class="akte-link" href="${esc(outPath ? r.magnet_path : r.magnet_path.replace(/^runs\/[^/]+\//, ""))}" target="_blank" rel="noopener">Datenaltlast-Check öffnen (das Give hinter der Mail) →</a>`
                : ""
            }
            ${
              email
                ? `<h4>Mail-Entwurf <span class="soft">Template + Evidence-Slots · Freigabe erforderlich</span></h4>
                   <div class="email"><div class="email-subject">${esc(email.subject)}</div>${esc(email.body).replace(/\n/g, "<br>")}</div>`
                : ""
            }
          </div>
        </div>`;

      return `
    <details class="akte">
      <summary>
        <span class="gauge" title="Signalstärke ${pct}%"><span style="width:${pct}%"></span></span>
        <span class="company">${esc(r.company_raw)}</span>
        <span class="record">${esc(akte)}</span>
        <span class="industry">${esc(r.industry ?? "n/a")}</span>
      </summary>
      <div class="detail">${detail}</div>
    </details>`;
    })
    .join("\n");

  const kpi = (v: string, l: string) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;

  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ArchivoX Signal-Cockpit · ${day}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..900&family=IBM+Plex+Mono:wght@400;500&display=swap');
  :root {
    --ink:#10201C; --ink-60:#4C605A; --ink-35:#8CA09A;
    --bg:#F2F5F3; --card:#FCFDFC; --panel:#F3F7F5;
    --petrol:#0A5C50; --petrol-deep:#07473E; --petrol-tint:#E3EFEC;
    --line:#DCE5E1; --gauge-track:#DDE6E2;
    --sans:"Archivo", ui-sans-serif, system-ui, sans-serif;
    --mono:"IBM Plex Mono", ui-monospace, "Cascadia Mono", monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink:#E6EEEA; --ink-60:#9FB3AC; --ink-35:#668078;
      --bg:#0C1512; --card:#121E1A; --panel:#16241F;
      --petrol:#39B098; --petrol-deep:#7FD1C0; --petrol-tint:#123B33;
      --line:#233731; --gauge-track:#233731;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14.5px/1.55 var(--sans); }
  .wrap { max-width:1020px; margin:0 auto; padding:44px 24px 90px; }

  .masthead { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:8px; }
  h1 { font-weight:900; font-stretch:110%; font-size:clamp(26px,4vw,38px); letter-spacing:-.025em; margin:0; }
  h1 em { font-style:normal; color:var(--petrol); }
  .stand { font:500 11px/1 var(--mono); letter-spacing:.12em; color:var(--ink-60); }
  .claim { color:var(--ink-60); margin:0 0 26px; max-width:560px; }

  .kpis { display:grid; grid-template-columns:repeat(4,1fr); border:1.5px solid var(--ink); margin-bottom:30px; background:var(--card); }
  @media (max-width:680px){ .kpis { grid-template-columns:repeat(2,1fr); } }
  .kpi { padding:16px 20px 14px; border-right:1px solid var(--line); }
  .kpi:last-child { border-right:none; }
  @media (max-width:680px){ .kpi:nth-child(2) { border-right:none; } .kpi:nth-child(-n+2){ border-bottom:1px solid var(--line); } }
  .kpi b { display:block; font-weight:800; font-size:26px; letter-spacing:-.02em; }
  .kpi span { font:500 10.5px/1.4 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--ink-60); }

  .akte { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--petrol); margin-bottom:10px; }
  .akte summary { display:flex; align-items:center; gap:16px; padding:14px 18px; cursor:pointer; list-style:none; }
  .akte summary::-webkit-details-marker { display:none; }
  .akte summary:focus-visible { outline:2px solid var(--petrol); outline-offset:2px; }
  .gauge { width:46px; height:5px; background:var(--gauge-track); flex:none; }
  .gauge span { display:block; height:100%; background:var(--petrol); }
  .company { font-weight:700; font-size:15.5px; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .record { font:400 10.5px/1 var(--mono); letter-spacing:.08em; color:var(--ink-60); flex:1; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .industry { font:500 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--petrol-deep); background:var(--petrol-tint); padding:5px 10px; white-space:nowrap; }
  @media (max-width:760px){ .record { display:none; } }

  .detail { padding:6px 20px 22px; border-top:1px solid var(--line); }
  blockquote { margin:16px 0 6px; padding:10px 16px; border-left:3px solid var(--petrol); font-size:15px; font-style:italic; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:0 34px; }
  @media (max-width:760px){ .cols { grid-template-columns:1fr; } }
  h4 { font:500 10.5px/1 var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--ink-60); margin:18px 0 8px; }
  h4 .soft { color:var(--ink-35); letter-spacing:.04em; text-transform:none; }
  .plain { list-style:none; padding:0; margin:4px 0; font-size:13.5px; }
  .plain li { margin:6px 0; color:var(--ink-60); }
  .plain li b { color:var(--ink); }
  .evidence a, .contacts a { color:var(--petrol); text-decoration-thickness:1px; text-underline-offset:3px; }
  .contacts { list-style:none; padding:0; margin:4px 0; font-size:13.5px; }
  .contacts li { display:flex; gap:10px; align-items:baseline; margin:6px 0; }
  .contacts a { font-weight:600; }
  .c-role { color:var(--ink-60); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .c-conf { font:400 10.5px/1 var(--mono); color:var(--ink-35); }
  .none { color:var(--ink-35); font-size:13px; }
  .akte-link { display:inline-block; margin-top:6px; font-weight:600; font-size:13.5px; color:var(--petrol); }
  .email { border:1px solid var(--line); background:var(--panel); padding:14px 16px; font-size:13px; line-height:1.6; }
  .email-subject { font-weight:700; margin-bottom:8px; }
  footer { color:var(--ink-35); font:400 10.5px/1.7 var(--mono); letter-spacing:.04em; text-transform:uppercase; margin-top:34px; border-top:1px solid var(--line); padding-top:14px; }
  .runlog-title { font-weight:800; font-stretch:108%; font-size:20px; letter-spacing:-.01em; margin:40px 0 4px; }
  .runlog-sub { color:var(--ink-60); font-size:13px; margin:0 0 14px; }
  .runlog-scroll { overflow-x:auto; }
  table.runlog { width:100%; border-collapse:collapse; border:1.5px solid var(--ink); background:var(--card); min-width:720px; }
  table.runlog th { font:500 10px/1.4 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--ink-60); text-align:left; padding:9px 14px; border-bottom:1.5px solid var(--ink); }
  table.runlog td { padding:9px 14px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  table.runlog tr:last-child td { border-bottom:none; }
  .mono-cell { font-family:var(--mono); font-size:12px; white-space:nowrap; }
  .companies { color:var(--ink-60); font-size:12.5px; }
  .dim-log { color:var(--ink-35); }
  .logbar { display:inline-block; width:40px; height:5px; background:var(--gauge-track); margin-right:8px; vertical-align:middle; position:relative; }
  .logbar::after { content:""; position:absolute; left:0; top:0; bottom:0; width:var(--w); background:var(--petrol); }
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <h1>Signal-Cockpit<em>.</em></h1>
    <span class="stand">ARCHIVOX · S1 ERP/S4-TRANSFORMATION · STAND ${day}</span>
  </div>
  <p class="claim">Endanwender im Kauffenster, erkannt aus öffentlichen deutschen Quellen. Jede Akte: Beleg, Ansprechpartner, Mail-Entwurf, Give.</p>

  <div class="kpis">
    ${kpi(String(rows.length), "Qualifizierte Signale")}
    ${kpi(String(rows.filter((r) => r.brief_json).length), "Mit SDR-Brief")}
    ${kpi(String(contactsTotal), "Personen-Hypothesen")}
    ${kpi(`$${cost.toFixed(2)}`, "LLM-Kosten gesamt")}
  </div>

  ${items}

  ${renderRunLog(store)}

  <footer>
    Referenzimplementierung · SalesPlaybook GTM Engineer Case Study · Evidence Contract: jede Unternehmensaussage
    führt auf eine gespeicherte Quelle zurück · Mails sind Template-gerendert mit Evidence-Slots · Versand nur nach
    menschlicher Freigabe
  </footer>
</div>
</body>
</html>`;

  const path = outPath ?? `runs/${day}/cockpit.html`;
  mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, html);
  return path;
}
