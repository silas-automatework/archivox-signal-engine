import { describe, expect, it } from "vitest";
import { computeModel, validateMagnet, type Magnet } from "./magnet.js";

function magnet(overrides: Partial<Magnet> = {}): Magnet {
  return {
    headline_insight: "h",
    situation_de: "Bei QIAGEN läuft mit QIAbase eine Transformation.",
    size_class: "L",
    size_rationale: "Einordnung nach Unternehmensgröße",
    hebel: [{ titel: "Chargen-Dokumentation", beschreibung: "GMP-relevante Datensätze abgrenzen." }],
    pruefschritte: ["Größte Tabellen in DB02 auswerten."],
    ...overrides,
  };
}

describe("computeModel", () => {
  it("derives all ranges deterministically from the size class", () => {
    const m = computeModel("L");
    expect(m.dbTb).toEqual([3, 8]);
    expect(m.coldTb).toEqual([1.2, 4.8]);
    expect(m.savings3y[0]).toBe(70_000); // 1.2 TB * 20k * 3y, rounded to 5k
    expect(m.savings3y[1]).toBe(505_000); // 4.8 TB * 35k * 3y, rounded to 5k
  });

  it("scales with size classes", () => {
    expect(computeModel("M").savings3y[1]).toBeLessThan(computeModel("XL").savings3y[0] * 10);
    expect(computeModel("XL").dbTb).toEqual([8, 20]);
  });
});

describe("validateMagnet", () => {
  it("passes a clean magnet", () => {
    expect(validateMagnet(magnet())).toEqual([]);
  });

  it("rejects surveillance-sounding situation language", () => {
    const problems = validateMagnet(magnet({ situation_de: "Öffentlich beobachtbar ist, dass Sie suchen." }));
    expect(problems.join()).toContain("surveillance");
  });

  it("rejects numbers inside levers (numbers are computed in code)", () => {
    const problems = validateMagnet(
      magnet({ hebel: [{ titel: "Hebel", beschreibung: "Spart 40 % der Kosten, etwa 100000 €." }] })
    );
    expect(problems.join()).toContain("numbers are computed in code");
  });

  it("rejects em dashes and URLs", () => {
    expect(validateMagnet(magnet({ headline_insight: "Alt — neu" })).join()).toContain("em dashes");
    expect(validateMagnet(magnet({ situation_de: "Siehe https://x.de" })).join()).toContain("URLs");
  });
});
