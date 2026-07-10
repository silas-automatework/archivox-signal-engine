import { describe, expect, it } from "vitest";
import { renderEmail, salutationFor } from "./emailTemplate.js";

const SLOTS = {
  company_short: "Palm",
  company_category_de: "Papierherstellern",
  opener_de: "wie viel vom ECC-Bestand braucht Ihr Team im Alltag wirklich noch?",
};

describe("salutationFor", () => {
  it("uses Herr/Frau with the last name when the form is known", () => {
    expect(salutationFor({ name: "Holger Dörr", anrede: "Herr" })).toBe(" Herr Dörr");
    expect(salutationFor({ name: "Anna Georgieva", anrede: "Frau" })).toBe(" Frau Georgieva");
  });

  it("falls back to the full name when the form is unknown", () => {
    expect(salutationFor({ name: "Kim Nguyen", anrede: "" })).toBe(" Kim Nguyen");
  });

  it("is empty without a recipient", () => {
    expect(salutationFor(null)).toBe("");
  });
});

describe("renderEmail", () => {
  it("fills all template slots and personalizes the greeting", () => {
    const { subject, body } = renderEmail(SLOTS, { recipient: { name: "Markus Scheller", anrede: "Herr" } });
    expect(subject).toBe("Datenaltlast vor dem S/4-Cutover bei Palm");
    expect(body).toContain("Hallo Herr Scheller,");
    expect(body).toContain("Bei Papierherstellern liegen erfahrungsgemäß");
    expect(body).toContain(SLOTS.opener_de);
    expect(body).toContain("Soll ich sie Ihnen schicken? Ein kurzes Ja genügt.");
    expect(body).not.toContain("{{");
  });

  it("renders a neutral greeting without a recipient", () => {
    const { body } = renderEmail(SLOTS);
    expect(body).toContain("Hallo,");
  });
});
