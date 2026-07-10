import { readFileSync } from "node:fs";

export interface EmailSlots {
  company_short: string;
  company_category_de: string;
  opener_de: string;
}

export interface Recipient {
  name: string;
  anrede: string;
}

/**
 * "Hallo Herr Dörr" when the salutation form is known, "Hallo Anna Georgieva"
 * when it is not, "Hallo" only when there is no recipient at all.
 */
export function salutationFor(r?: Recipient | null): string {
  if (!r?.name) return "";
  const lastName = r.name.trim().split(/\s+/).at(-1) ?? r.name;
  return r.anrede === "Herr" || r.anrede === "Frau" ? ` ${r.anrede} ${lastName}` : ` ${r.name.trim()}`;
}

/**
 * Template-first email rendering (Atira pattern): the skeleton, value
 * proposition and CTA are fixed and reviewed once; the LLM only fills
 * evidence-anchored slots. Consistency and brand control beat free-form
 * generation for outreach at scale.
 */
export function renderEmail(
  slots: EmailSlots,
  opts: { recipient?: Recipient | null; sender?: string } = {}
): { subject: string; body: string } {
  const raw = readFileSync("templates/email.de.md", "utf8");
  const [subjectLine, ...bodyParts] = raw.split("\n---\n");
  const subjectTemplate = subjectLine.replace(/^subject:\s*/, "").trim();

  const fill = (t: string) =>
    t
      .replace(/\{\{company_short\}\}/g, slots.company_short)
      .replace(/\{\{company_category\}\}/g, slots.company_category_de)
      .replace(/\{\{opener\}\}/g, slots.opener_de)
      .replace(/\{\{salutation\}\}/g, salutationFor(opts.recipient))
      .replace(/\{\{sender\}\}/g, opts.sender ?? "[SDR Name]");

  return { subject: fill(subjectTemplate), body: fill(bodyParts.join("\n---\n")).trim() };
}
