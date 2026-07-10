/**
 * Person redaction for published artifacts. Companies come from public job
 * postings and stay visible; compiled person data (names, LinkedIn URLs) is
 * legitimate to use for outreach internally but does not belong in a public
 * repository. REDACT_PEOPLE=1 turns every committed artifact person-safe;
 * the local workflow and the HubSpot routing keep full data.
 */
export const REDACT_PEOPLE = process.env.REDACT_PEOPLE === "1";

export function redactName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((p) => `${p[0]}.`)
    .join(" ");
}

export interface PersonLike {
  name: string;
  linkedin_url: string;
  [k: string]: unknown;
}

export function redactPerson<T extends PersonLike>(p: T): T {
  if (!REDACT_PEOPLE) return p;
  return { ...p, name: redactName(p.name), linkedin_url: "" };
}
