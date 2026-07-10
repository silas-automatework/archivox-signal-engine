import { jsonCall, type LlmUsage } from "../llm/openai.js";
import type { SignalForBrief } from "./brief.js";

/**
 * The give behind the email CTA: a one-page, company-specific
 * "S/4-Datenaltlast-Check". Company facts come from evidence; savings
 * figures are explicitly labeled benchmark assumptions, never claimed
 * as knowledge about the company.
 */
export interface Magnet {
  headline_insight: string;
  ausgangslage: string[];
  annahmen: string[];
  potenzial: { hebel: string; effekt: string }[];
  pruefschritte: string[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline_insight", "ausgangslage", "annahmen", "potenzial", "pruefschritte"],
  properties: {
    headline_insight: { type: "string" },
    ausgangslage: { type: "array", items: { type: "string" } },
    annahmen: { type: "array", items: { type: "string" } },
    potenzial: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hebel", "effekt"],
        properties: { hebel: { type: "string" }, effekt: { type: "string" } },
      },
    },
    pruefschritte: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You produce the content of a one-page German lead-magnet document:
an "S/4-Datenaltlast-Check" for a specific company, offered in a cold email and
sent after a yes-reply. Sender is ArchivoX (enterprise archiving for SAP/ERP
landscapes: pre-migration data volume reduction, compliant archiving, legacy
decommissioning; typically 40-50% cheaper than classical archiving solutions).

Sections (all German, Sie-Form, sober consulting tone, no marketing fluff):
- headline_insight: one sharp sentence tying THIS company's situation (from
  evidence) to the data question of an S/4 program.
- ausgangslage: 2-3 bullets describing what is publicly observable about the
  company's situation. ONLY from provided evidence. Cite nothing invented.
- annahmen: 3-4 bullets of explicitly generic benchmark assumptions used below
  (share of cold ECC data, typical retention needs of the industry, sizing cost
  logic). Each bullet must read as an assumption ("Branchentypisch...", "Wir
  unterstellen..."), never as a fact about the company.
- potenzial: 3 rows {hebel, effekt}. Hebel = concrete lever for THIS industry
  (name industry-specific data/document classes: e.g. Chargen- und QK-Dokumentation
  for life sciences, Instandhaltungs- und Fahrzeugakten for transit, Lieferschein-
  und POS-Daten for retail). Effekt = typical, clearly hedged effect (ranges, "je
  nach Datenlage").
- pruefschritte: 3 concrete first checks the company's SAP/Basis team can run
  itself (e.g. Tabellengrößen-Analyse DB02/SE38, Belegvolumen je Modul, Liste
  stillzulegender Altsysteme). Practical, tool-level, no sales language.

Rules: never use em dashes. No "nicht X, sondern Y" constructions. No promises of
concrete savings for this company; ranges and typical values only. No URLs.`;

export async function generateMagnet(
  s: SignalForBrief,
  model: string
): Promise<{ magnet: Magnet; usages: LlmUsage[]; problems: string[] }> {
  const user = [
    `Company: ${s.companyRaw}`,
    `Industry: ${s.industry ?? "unknown"}`,
    "",
    "Evidence (public job postings):",
    ...s.snippets.map((p) => `- ${p.title}${p.snippet ? `: ${p.snippet}` : ""}`),
  ].join("\n");

  const res = await jsonCall<Magnet>({
    model,
    purpose: "magnet",
    system: SYSTEM,
    user,
    schemaName: "datenaltlast_check",
    schema: SCHEMA,
    reasoningEffort: "low",
  });

  const problems: string[] = [];
  const text = JSON.stringify(res.data);
  if (/—/.test(text)) problems.push("magnet contains em dashes");
  if (/https?:\/\//.test(text)) problems.push("magnet contains URLs");

  return { magnet: res.data, usages: [res.usage], problems };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render the magnet as a self-contained one-page HTML document. */
export function renderMagnetHtml(companyRaw: string, m: Magnet, day: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>S/4-Datenaltlast-Check · ${esc(companyRaw)}</title>
<style>
  :root { --text:#15201e; --dim:#5e6d6a; --accent:#0f766e; --line:#e2e8e6; --bg:#ffffff; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; color:var(--text); background:var(--bg); }
  .page { max-width:760px; margin:0 auto; padding:44px 40px; }
  .kicker { color:var(--accent); font-size:12px; text-transform:uppercase; letter-spacing:.08em; font-weight:600; }
  h1 { font-size:24px; margin:6px 0 2px; }
  .date { color:var(--dim); font-size:13px; margin-bottom:18px; }
  .insight { border-left:3px solid var(--accent); padding:8px 16px; font-size:16px; margin:18px 0 22px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:22px 0 8px; }
  ul { margin:6px 0; padding-left:20px; }
  li { margin:4px 0; }
  table { width:100%; border-collapse:collapse; margin:8px 0; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); }
  .foot { margin-top:26px; padding-top:14px; border-top:1px solid var(--line); color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<div class="page">
  <div class="kicker">ArchivoX · Potenzial-Einschätzung</div>
  <h1>S/4-Datenaltlast-Check: ${esc(companyRaw)}</h1>
  <div class="date">Stand ${day} · eine Seite · Annahmen klar gekennzeichnet</div>
  <div class="insight">${esc(m.headline_insight)}</div>
  <h2>Ausgangslage (öffentlich beobachtbar)</h2>
  <ul>${m.ausgangslage.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
  <h2>Annahmen dieser Einschätzung</h2>
  <ul>${m.annahmen.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
  <h2>Potenzial-Hebel</h2>
  <table>
    <tr><th>Hebel</th><th>Typischer Effekt</th></tr>
    ${m.potenzial.map((p) => `<tr><td>${esc(p.hebel)}</td><td>${esc(p.effekt)}</td></tr>`).join("")}
  </table>
  <h2>Erste Prüfschritte (intern, ohne uns)</h2>
  <ul>${m.pruefschritte.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
  <div class="foot">
    Diese Einschätzung basiert auf öffentlich verfügbaren Informationen und branchentypischen Erfahrungswerten.
    Sie ersetzt keine Analyse Ihrer konkreten Systemlandschaft. ArchivoX · Referenzimplementierung Case Study.
  </div>
</div>
</body>
</html>`;
}
