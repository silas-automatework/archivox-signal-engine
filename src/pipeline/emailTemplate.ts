import { readFileSync } from "node:fs";

export interface EmailSlots {
  company_short: string;
  company_category_de: string;
  opener_de: string;
}

/**
 * Template-first email rendering (Atira pattern): the skeleton, value
 * proposition and CTA are fixed and reviewed once; the LLM only fills
 * evidence-anchored slots. Consistency and brand control beat free-form
 * generation for outreach at scale.
 */
export function renderEmail(
  slots: EmailSlots,
  opts: { salutationName?: string; sender?: string } = {}
): { subject: string; body: string } {
  const raw = readFileSync("templates/email.de.md", "utf8");
  const [subjectLine, ...bodyParts] = raw.split("\n---\n");
  const subjectTemplate = subjectLine.replace(/^subject:\s*/, "").trim();

  const fill = (t: string) =>
    t
      .replace(/\{\{company_short\}\}/g, slots.company_short)
      .replace(/\{\{company_category\}\}/g, slots.company_category_de)
      .replace(/\{\{opener\}\}/g, slots.opener_de)
      .replace(/\{\{salutation\}\}/g, opts.salutationName ? ` ${opts.salutationName}` : "")
      .replace(/\{\{sender\}\}/g, opts.sender ?? "[SDR Name]");

  return { subject: fill(subjectTemplate), body: fill(bodyParts.join("\n---\n")).trim() };
}
