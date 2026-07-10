import { jsonCall, type LlmUsage } from "../llm/openai.js";
import type { SignalForBrief } from "./brief.js";

/**
 * The give behind the email CTA: a one-page "S/4-Datenaltlast-Check".
 * Division of labor: the LLM reads evidence and writes German prose
 * (situation, industry-specific levers, size-class estimate); ALL numbers
 * come from a deterministic benchmark model in code, so every document
 * calculates identically and every range is defensible.
 */
export interface Magnet {
  headline_insight: string;
  situation_de: string;
  size_class: "M" | "L" | "XL";
  size_rationale: string;
  hebel: { titel: string; beschreibung: string }[];
  pruefschritte: string[];
}

export interface MagnetModel {
  sizeLabel: string;
  dbTb: [number, number];
  coldSharePct: [number, number];
  coldTb: [number, number];
  savings3y: [number, number];
  scopeReductionPct: [number, number];
  tcoPerTbYear: [number, number];
}

/** Benchmark constants: ECC DB size by company size class, cold-data share, HANA TCO. */
const SIZE_MODEL: Record<Magnet["size_class"], { label: string; dbTb: [number, number] }> = {
  M: { label: "500 bis 2.000 Mitarbeitende", dbTb: [1, 3] },
  L: { label: "2.000 bis 10.000 Mitarbeitende", dbTb: [3, 8] },
  XL: { label: "über 10.000 Mitarbeitende", dbTb: [8, 20] },
};
const COLD_SHARE: [number, number] = [0.4, 0.6];
const TCO_PER_TB_YEAR: [number, number] = [20_000, 35_000];
const SCOPE_REDUCTION: [number, number] = [20, 40];

export function computeModel(sizeClass: Magnet["size_class"]): MagnetModel {
  const { label, dbTb } = SIZE_MODEL[sizeClass];
  const coldTb: [number, number] = [dbTb[0] * COLD_SHARE[0], dbTb[1] * COLD_SHARE[1]];
  const roundK = (v: number) => Math.round(v / 5_000) * 5_000;
  return {
    sizeLabel: label,
    dbTb,
    coldSharePct: [COLD_SHARE[0] * 100, COLD_SHARE[1] * 100],
    coldTb: [Math.round(coldTb[0] * 10) / 10, Math.round(coldTb[1] * 10) / 10],
    savings3y: [roundK(coldTb[0] * TCO_PER_TB_YEAR[0] * 3), roundK(coldTb[1] * TCO_PER_TB_YEAR[1] * 3)],
    scopeReductionPct: SCOPE_REDUCTION,
    tcoPerTbYear: TCO_PER_TB_YEAR,
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline_insight", "situation_de", "size_class", "size_rationale", "hebel", "pruefschritte"],
  properties: {
    headline_insight: { type: "string" },
    situation_de: { type: "string" },
    size_class: { type: "string", enum: ["M", "L", "XL"] },
    size_rationale: { type: "string" },
    hebel: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["titel", "beschreibung"],
        properties: { titel: { type: "string" }, beschreibung: { type: "string" } },
      },
    },
    pruefschritte: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You write the German prose for a one-page "S/4-Datenaltlast-Check",
a personalized assessment ArchivoX sends after a prospect replies yes to a cold
email. The reader is an IT/SAP decision maker. Reading time: 2 minutes. The
document must feel like a senior consultant prepared it specifically for them.
The savings numbers are computed separately in code; you never write numbers
about data volumes or euros.

Fields:
- headline_insight: one sharp German sentence connecting THIS company's situation
  to the data question of their S/4 program. Confident, specific, no hedging.
- situation_de: 2 sentences. What their current hiring/statements show about where
  they stand, written as a natural observation a well-prepared consultant would
  make ("Bei X läuft mit dem QIAbase-Programm..."). Warm, factual, never creepy,
  never words like "beobachtbar", "öffentlich", "Stellenanzeige zeigt". Reference
  programs/roles naturally as things they are doing, not things we found.
- size_class: M (500-2k employees), L (2k-10k), XL (>10k). Use your knowledge of
  the company and the evidence. When unsure, choose the smaller class.
- size_rationale: 5-10 German words for the footnote (e.g. "Einordnung auf Basis
  der Unternehmensgröße").
- hebel: exactly 3 levers, industry-specific for THIS company. titel: 3-6 words.
  beschreibung: 1-2 sentences naming concrete data/document classes of this
  industry (Chargen- und QK-Dokumentation for life sciences, Instandhaltungsakten
  for transit, Lieferschein-/POS-Daten for retail, Konstruktions- und
  Auftragsdokumente for machinery...). No euro figures, no percentages.
- pruefschritte: 3 steps their SAP Basis team can run within two weeks, tool-level
  (DB02/ST10 Tabellenanalyse, SE16H Belegvolumen je Modul, Altsystem-Inventar).
  Each max 15 words, imperative ("Größte Tabellen und Wachstum in DB02 auswerten").

Style rules: Sie-Form. Never use em dashes. No "nicht X, sondern Y" constructions.
No exclamation marks, no marketing adjectives (innovativ, ganzheitlich). Flowing
natural German.`;

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
  if (/beobachtbar|Stellenanzeige|öffentlich einsehbar/i.test(res.data.situation_de)) {
    problems.push("situation_de uses surveillance-sounding language");
  }
  if (/\d{3,}|€|EUR|Prozent|%/.test(JSON.stringify(res.data.hebel))) {
    problems.push("hebel contains numbers; numbers are computed in code");
  }

  return { magnet: res.data, usages: [res.usage], problems };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const fmtEur = (v: number): string => v.toLocaleString("de-DE") + " €";
const fmtTb = (v: number): string => v.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " TB";

/** One-page document: hero numbers first, levers, self-check, effortless next step. */
export function renderMagnetHtml(companyRaw: string, m: Magnet, day: string): string {
  const mod = computeModel(m.size_class);
  const coldMid = Math.round(((mod.coldSharePct[0] + mod.coldSharePct[1]) / 2 / 100) * 1000) / 10;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>S/4-Datenaltlast-Check · ${esc(companyRaw)}</title>
<style>
  :root { --text:#15201e; --dim:#5e6d6a; --accent:#0f766e; --accent-soft:#e5f2f0; --line:#e2e8e6; --bg:#ffffff; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; color:var(--text); background:var(--bg); }
  .page { max-width:780px; margin:0 auto; padding:44px 44px 36px; }
  .kicker { color:var(--accent); font-size:11px; text-transform:uppercase; letter-spacing:.1em; font-weight:700; }
  h1 { font-size:25px; margin:6px 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:20px; }
  .insight { font-size:17px; line-height:1.45; font-weight:500; margin:0 0 8px; }
  .situation { color:var(--dim); margin:0 0 24px; max-width:640px; }
  .tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:0 0 22px; }
  @media (max-width:640px){ .tiles { grid-template-columns:1fr; } }
  .tile { background:var(--accent-soft); border-radius:12px; padding:16px 18px; }
  .tile b { display:block; font-size:21px; color:var(--accent); letter-spacing:-.01em; white-space:nowrap; }
  .tile span { font-size:12.5px; color:var(--text); }
  .bar-wrap { margin:0 0 26px; }
  .bar-title { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin-bottom:8px; }
  .bar { display:flex; height:34px; border-radius:6px; overflow:hidden; gap:2px; }
  .bar .active { background:#cbd5d2; flex:${100 - coldMid}; display:flex; align-items:center; padding:0 12px; font-size:12.5px; color:#3d4a47; min-width:120px; }
  .bar .cold { background:var(--accent); flex:${coldMid}; display:flex; align-items:center; padding:0 12px; font-size:12.5px; color:#fff; min-width:150px; }
  .bar-note { font-size:12px; color:var(--dim); margin-top:6px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.07em; color:var(--dim); margin:24px 0 10px; }
  .hebel { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  @media (max-width:640px){ .hebel { grid-template-columns:1fr; } }
  .h-card { border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .h-card b { display:block; margin-bottom:4px; font-size:13.5px; }
  .h-card p { margin:0; font-size:13px; color:var(--dim); }
  ol { margin:6px 0 0; padding-left:22px; }
  ol li { margin:5px 0; }
  .next { margin-top:26px; background:var(--accent); color:#fff; border-radius:12px; padding:16px 20px; font-size:14.5px; }
  .next b { color:#fff; }
  .foot { margin-top:18px; color:var(--dim); font-size:11px; line-height:1.5; }
</style>
</head>
<body>
<div class="page">
  <div class="kicker">ArchivoX · Potenzial-Einschätzung · vorbereitet für ${esc(companyRaw)}</div>
  <h1>S/4-Datenaltlast-Check</h1>
  <div class="sub">Stand ${day} · Lesezeit 2 Minuten</div>

  <p class="insight">${esc(m.headline_insight)}</p>
  <p class="situation">${esc(m.situation_de)}</p>

  <div class="tiles">
    <div class="tile"><b>${fmtTb(mod.coldTb[0])} bis ${fmtTb(mod.coldTb[1])}</b><span>Datenbestand, der typischerweise vor der Migration archivierbar ist</span></div>
    <div class="tile"><b>${fmtEur(mod.savings3y[0])} bis ${fmtEur(mod.savings3y[1])}</b><span>Einsparpotenzial über 3 Jahre (HANA-Sizing, Infrastruktur, Betrieb)</span></div>
    <div class="tile"><b>${mod.scopeReductionPct[0]} bis ${mod.scopeReductionPct[1]} %</b><span>weniger Belegvolumen im Migrationsscope, je nach Systemhistorie</span></div>
  </div>

  <div class="bar-wrap">
    <div class="bar-title">Typischer ECC-Datenbestand einer Landschaft Ihrer Größenordnung</div>
    <div class="bar">
      <div class="active">aktiv genutzt</div>
      <div class="cold">${mod.coldSharePct[0]} bis ${mod.coldSharePct[1]} % archivierbar</div>
    </div>
    <div class="bar-note">Basis: ${esc(mod.sizeLabel)}, ECC-Datenbank ${fmtTb(mod.dbTb[0])} bis ${fmtTb(mod.dbTb[1])}. Ihre realen Werte liefert eine DB02-Auswertung in unter einer Stunde.</div>
  </div>

  <h2>Wo das Potenzial konkret liegt</h2>
  <div class="hebel">
    ${m.hebel.map((h) => `<div class="h-card"><b>${esc(h.titel)}</b><p>${esc(h.beschreibung)}</p></div>`).join("")}
  </div>

  <h2>In zwei Wochen intern prüfbar</h2>
  <ol>${m.pruefschritte.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>

  <div class="next"><b>Nächster Schritt:</b> Antworten Sie kurz auf unsere Mail. Wir übertragen diese Modellrechnung in 30 Minuten auf Ihre reale Systemlandschaft, auf Basis Ihrer eigenen DB02-Zahlen, ohne Verpflichtung.</div>

  <div class="foot">
    Modellrechnung auf Basis branchentypischer Erfahrungswerte: ${esc(m.size_rationale)} (${esc(mod.sizeLabel)});
    HANA-Gesamtkosten ${fmtEur(mod.tcoPerTbYear[0])} bis ${fmtEur(mod.tcoPerTbYear[1])} pro TB und Jahr inkl. Betrieb und Ausfallsicherheit;
    archivierbarer Anteil ${mod.coldSharePct[0]} bis ${mod.coldSharePct[1]} % des Altbestands. Ersetzt keine Analyse Ihrer konkreten Systemlandschaft.
    ArchivoX Referenzimplementierung, Case Study.
  </div>
</div>
</body>
</html>`;
}
