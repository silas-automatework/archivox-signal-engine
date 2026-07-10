import { describe, expect, it } from "vitest";
import { normalizeBrief, openerVariant, validateBrief, type Brief, type SignalForBrief } from "./brief.js";

const QUESTION_ID = 0; // openerVariant(0) = question/status
const STATEMENT_ID = 1; // openerVariant(1) = statement

function signal(overrides: Partial<SignalForBrief> = {}): SignalForBrief {
  return {
    signalId: QUESTION_ID,
    companyRaw: "QIAGEN GmbH",
    industry: "life sciences",
    confidence: 0.9,
    strength: 0.95,
    quote: null,
    reason: null,
    evidence: { postings: [{ title: "SAP S/4HANA Lead", url: "https://stepstone.de/x", postedAt: null }] },
    snippets: [{ title: "SAP S/4HANA Lead", snippet: "Wir führen S/4HANA im QIAbase Programm ein.", url: "https://stepstone.de/x" }],
    ...overrides,
  };
}

function brief(overrides: Partial<Brief> = {}, slots: Partial<Brief["email_slots"]> = {}): Brief {
  return {
    signal_summary: "s",
    why_now: "w",
    signal_quote: "Wir führen S/4HANA im QIAbase Programm ein.",
    stakeholder_hypothesis: ["CIO"],
    angles: [{ title: "a", detail: "d" }],
    discovery_questions: ["q"],
    email_slots: {
      company_short: "QIAGEN",
      company_category_de: "Biotechnologieunternehmen",
      opener_de: "wie viel vom ECC-Bestand braucht Ihr QIAbase-Team im Alltag wirklich noch?",
      ...slots,
    },
    flags: [],
    ...overrides,
  };
}

describe("validateBrief: evidence contract", () => {
  it("passes a clean brief", () => {
    expect(validateBrief(brief(), signal())).toEqual([]);
  });

  it("rejects a signal_quote that is not verbatim in the evidence", () => {
    const problems = validateBrief(brief({ signal_quote: "Erfundenes Zitat über Archivierung" }), signal());
    expect(problems.join()).toContain("verbatim");
  });

  it("accepts whitespace differences in an otherwise verbatim quote", () => {
    const problems = validateBrief(brief({ signal_quote: "Wir führen  S/4HANA im QIAbase   Programm ein." }), signal());
    expect(problems).toEqual([]);
  });

  it("rejects URLs outside the captured evidence", () => {
    const problems = validateBrief(brief({ why_now: "Siehe https://example.com/erfunden" }), signal());
    expect(problems.join()).toContain("outside captured evidence");
  });

  it("rejects em dashes anywhere in the brief", () => {
    const problems = validateBrief(brief({ why_now: "Alt — neu" }), signal());
    expect(problems.join()).toContain("em dashes");
  });
});

describe("validateBrief: opener rules", () => {
  it("rejects discovery narration", () => {
    const problems = validateBrief(
      brief({}, { opener_de: "ich habe gesehen, dass Sie im QIAbase-Programm suchen?" }),
      signal()
    );
    expect(problems.join()).toContain("narrates signal discovery");
  });

  it("rejects umlaut transliteration", () => {
    const problems = validateBrief(brief({}, { opener_de: "wie viel wandert fuer QIAbase wirklich mit?" }), signal());
    expect(problems.join()).toContain("transliterates umlauts");
  });

  it("rejects uppercase start after the salutation comma", () => {
    const problems = validateBrief(brief({}, { opener_de: "Wie viel braucht Ihr QIAbase-Team noch?" }), signal());
    expect(problems.join()).toContain("start lowercase");
  });

  it("enforces the question variant ending with ?", () => {
    const problems = validateBrief(brief({}, { opener_de: "das QIAbase-Programm legt den Schnitt fest." }), signal());
    expect(problems.join()).toContain("does not end with ?");
  });

  it("enforces the statement variant containing no question", () => {
    const problems = validateBrief(brief(), signal({ signalId: STATEMENT_ID }));
    expect(problems.join()).toContain("contains a question");
  });
});

describe("openerVariant", () => {
  it("alternates 50/50 and rotates question types deterministically", () => {
    expect(openerVariant(0)).toBe("question/status");
    expect(openerVariant(1)).toBe("statement");
    expect(openerVariant(2)).toBe("question/quantity");
    expect(openerVariant(3)).toBe("statement");
    expect(openerVariant(4)).toBe("question/ownership");
    expect(openerVariant(6)).toBe("question/timing");
    expect(openerVariant(8)).toBe("question/status");
  });
});

describe("normalizeBrief", () => {
  it("appends missing sentence punctuation on statement openers only", () => {
    const b = brief({}, { opener_de: "das Programm legt den Schnitt fest" });
    expect(normalizeBrief(b, STATEMENT_ID).email_slots.opener_de.endsWith(".")).toBe(true);
    expect(normalizeBrief(b, QUESTION_ID).email_slots.opener_de.endsWith(".")).toBe(false);
  });
});
