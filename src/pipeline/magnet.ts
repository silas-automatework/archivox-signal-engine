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

/**
 * One-page document in the ArchivoX design system: Registerkarten (file-folder
 * tabs) as the signature element, Archivo for display, IBM Plex Mono for
 * everything registratur-like. A document, therefore light-only and printable.
 */
export function renderMagnetHtml(companyRaw: string, m: Magnet, day: string): string {
  const mod = computeModel(m.size_class);
  const coldMid = (mod.coldSharePct[0] + mod.coldSharePct[1]) / 2;
  const akte = `AKTE S1-${day.replace(/-/g, "")} · ${companyRaw.toUpperCase().slice(0, 34)}`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>S/4-Datenaltlast-Check · ${esc(companyRaw)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..900&family=IBM+Plex+Mono:wght@400;500&display=swap');
  :root {
    --ink:#10201C; --ink-60:#4C605A; --ink-35:#8CA09A;
    --paper:#FCFDFC; --panel:#F3F7F5;
    --petrol:#0A5C50; --petrol-deep:#07473E; --petrol-tint:#E3EFEC;
    --line:#DCE5E1;
    --sans:"Archivo", ui-sans-serif, system-ui, sans-serif;
    --mono:"IBM Plex Mono", ui-monospace, "Cascadia Mono", monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.6 var(--sans); font-weight:400; }
  .sheet { max-width:820px; margin:0 auto; padding:56px 52px 40px; }
  @media (max-width:680px){ .sheet { padding:32px 20px; } }

  .tab { display:inline-block; background:var(--ink); color:var(--paper); font:500 11px/1 var(--mono);
         letter-spacing:.12em; padding:9px 26px 9px 14px; margin-left:2px;
         clip-path:polygon(0 100%, 0 6px, 6px 0, calc(100% - 16px) 0, 100% 100%); }
  .head { border:1.5px solid var(--ink); padding:30px 32px 26px; margin-bottom:34px; }
  h1 { font-family:var(--sans); font-weight:800; font-stretch:112%; font-size:clamp(30px,5vw,44px);
       line-height:1.02; letter-spacing:-.025em; margin:0 0 14px; }
  .meta { font:400 11.5px/1.6 var(--mono); color:var(--ink-60); letter-spacing:.04em; }
  .meta b { color:var(--petrol); font-weight:500; }

  .insight { font-size:19px; line-height:1.45; font-weight:600; letter-spacing:-.01em; margin:0 0 10px; max-width:660px; }
  .situation { color:var(--ink-60); margin:0 0 34px; max-width:640px; }

  .money { display:grid; grid-template-columns:1.6fr 1fr; border:1.5px solid var(--ink); margin-bottom:2px; }
  @media (max-width:680px){ .money { grid-template-columns:1fr; } }
  .money-main { padding:26px 30px 24px; border-right:1.5px solid var(--ink); }
  @media (max-width:680px){ .money-main { border-right:none; border-bottom:1.5px solid var(--ink); } }
  .money-label { font:500 11px/1 var(--mono); letter-spacing:.12em; color:var(--petrol); text-transform:uppercase; }
  .money-value { font-weight:900; font-stretch:105%; font-size:clamp(30px,4.6vw,42px); letter-spacing:-.03em; line-height:1.05; margin:10px 0 6px; }
  .money-sub { color:var(--ink-60); font-size:13.5px; }
  .money-side { display:flex; flex-direction:column; }
  .mini { flex:1; padding:16px 22px 14px; }
  .mini + .mini { border-top:1px solid var(--line); }
  .mini b { display:block; font-weight:800; font-size:21px; letter-spacing:-.02em; }
  .mini span { font-size:12.5px; color:var(--ink-60); }

  .gauge { border:1.5px solid var(--ink); border-top:none; padding:20px 30px 18px; margin-bottom:36px; background:var(--panel); }
  .gauge-title { font:500 11px/1 var(--mono); letter-spacing:.12em; color:var(--ink-60); text-transform:uppercase; margin-bottom:12px; }
  .bar { display:flex; height:30px; gap:2px; }
  .bar > div { display:flex; align-items:center; padding:0 12px; font-size:12px; }
  .bar .active { background:#CBD8D3; color:var(--ink); flex:${100 - coldMid}; min-width:110px; }
  .bar .cold { background:var(--petrol); color:#fff; flex:${coldMid}; min-width:170px; font-weight:600; }
  .gauge-note { font-size:12.5px; color:var(--ink-60); margin-top:10px; }
  .gauge-note b { color:var(--ink); font-weight:600; }

  h2 { font:500 11px/1 var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--ink-60); margin:34px 0 14px; }
  .hebel { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
  @media (max-width:680px){ .hebel { grid-template-columns:1fr; } }
  .h-card { position:relative; border:1px solid var(--line); background:var(--paper); padding:38px 16px 16px; }
  .h-tab { position:absolute; top:0; left:0; background:var(--petrol-tint); color:var(--petrol-deep);
           font:500 10px/1 var(--mono); letter-spacing:.1em; padding:7px 20px 7px 12px;
           clip-path:polygon(0 100%, 0 4px, 4px 0, calc(100% - 12px) 0, 100% 100%); }
  .h-card b { display:block; font-weight:700; font-size:14.5px; letter-spacing:-.01em; margin-bottom:5px; }
  .h-card p { margin:0; font-size:13px; line-height:1.55; color:var(--ink-60); }

  .steps { border-left:1.5px solid var(--ink); padding-left:0; margin:0; list-style:none; counter-reset:s; }
  .steps li { counter-increment:s; padding:8px 0 8px 54px; position:relative; max-width:620px; }
  .steps li::before { content:counter(s,decimal-leading-zero); position:absolute; left:16px; top:10px;
                      font:500 12px/1.4 var(--mono); color:var(--petrol); }

  .next { margin-top:36px; background:var(--ink); color:#EAF2EF; padding:22px 28px; font-size:15px; line-height:1.55; }
  .next b { color:#fff; font-weight:700; }
  .next .mono { font:400 11px/1 var(--mono); letter-spacing:.12em; color:#9DB8B0; display:block; margin-bottom:8px; text-transform:uppercase; }

  .foot { margin-top:18px; color:var(--ink-35); font:400 10.5px/1.6 var(--mono); text-transform:uppercase; }
  @media print { .sheet { padding:0; } body { background:#fff; } }
</style>
</head>
<body>
<div class="sheet">
  <div class="tab">${esc(akte)}</div>
  <div class="head">
    <h1>S/4-Datenaltlast-Check</h1>
    <div class="meta">VORBEREITET FÜR <b>${esc(companyRaw.toUpperCase())}</b> · STAND ${day} · LESEZEIT 2 MIN · MODELLRECHNUNG, ANNAHMEN IM FUSSTEIL</div>
  </div>

  <p class="insight">${esc(m.headline_insight)}</p>
  <p class="situation">${esc(m.situation_de)}</p>

  <div class="money">
    <div class="money-main">
      <div class="money-label">Einsparpotenzial über 3 Jahre</div>
      <div class="money-value">${fmtEur(mod.savings3y[0])} bis ${fmtEur(mod.savings3y[1])}</div>
      <div class="money-sub">HANA-Sizing, Infrastruktur und Betrieb, wenn Altbestand vor der Migration archiviert wird</div>
    </div>
    <div class="money-side">
      <div class="mini"><b>${fmtTb(mod.coldTb[0])} bis ${fmtTb(mod.coldTb[1])}</b><span>typischerweise archivierbarer Datenbestand</span></div>
      <div class="mini"><b>${mod.scopeReductionPct[0]} bis ${mod.scopeReductionPct[1]} %</b><span>weniger Belegvolumen im Migrationsscope</span></div>
    </div>
  </div>

  <div class="gauge">
    <div class="gauge-title">Typischer ECC-Datenbestand · ${esc(mod.sizeLabel)}</div>
    <div class="bar">
      <div class="active">aktiv genutzt</div>
      <div class="cold">${mod.coldSharePct[0]} bis ${mod.coldSharePct[1]} % archivierbar</div>
    </div>
    <div class="gauge-note">ECC-Datenbank ${fmtTb(mod.dbTb[0])} bis ${fmtTb(mod.dbTb[1])} angenommen. <b>Ihre realen Werte liefert eine DB02-Auswertung in unter einer Stunde.</b></div>
  </div>

  <h2>Wo das Potenzial konkret liegt</h2>
  <div class="hebel">
    ${m.hebel.map((h, i) => `<div class="h-card"><div class="h-tab">HEBEL ${String(i + 1).padStart(2, "0")}</div><b>${esc(h.titel)}</b><p>${esc(h.beschreibung)}</p></div>`).join("")}
  </div>

  <h2>In zwei Wochen intern prüfbar</h2>
  <ol class="steps">${m.pruefschritte.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>

  <div class="next">
    <span class="mono">Nächster Schritt</span>
    <b>Antworten Sie kurz auf unsere Mail.</b> Wir übertragen diese Modellrechnung in 30 Minuten auf Ihre reale Systemlandschaft, auf Basis Ihrer eigenen DB02-Zahlen, ohne Verpflichtung.
  </div>

  <div class="foot">
    MODELLRECHNUNG · ${esc(m.size_rationale)} (${esc(mod.sizeLabel)}) · HANA-GESAMTKOSTEN ${fmtEur(mod.tcoPerTbYear[0])} BIS ${fmtEur(mod.tcoPerTbYear[1])} PRO TB/JAHR INKL. BETRIEB UND AUSFALLSICHERHEIT · ARCHIVIERBARER ANTEIL ${mod.coldSharePct[0]} BIS ${mod.coldSharePct[1]} % DES ALTBESTANDS · ERSETZT KEINE ANALYSE IHRER KONKRETEN SYSTEMLANDSCHAFT · ARCHIVOX REFERENZIMPLEMENTIERUNG, CASE STUDY
  </div>
</div>
</body>
</html>`;
}
