import { createHash } from "node:crypto";

const LEGAL_SUFFIXES =
  /\b(gmbh\s*&\s*co\.?\s*kga?a?|gmbh\s*&\s*co\.?\s*kg|se\s*&\s*co\.?\s*kg|ag\s*&\s*co\.?\s*kg|gmbh|mbh|ag|se|kgaa|kg|ohg|e\.?\s?v\.?|ug|inc\.?|ltd\.?|holding|group|gruppe)\b/gi;

/**
 * Normalized company key for entity resolution and dedupe.
 * "Müller Maschinenbau GmbH & Co. KG" -> "mueller maschinenbau"
 */
export function companyKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip HTML tags and entities from scraped text (e.g. StepStone search highlighting). */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One observation per job posting URL. */
export function observationHash(url: string): string {
  return createHash("sha1").update(url.trim().toLowerCase()).digest("hex");
}

/**
 * Signal-level dedupe: the same company re-triggering the same signal type
 * within a 30-day bucket is one signal, not many.
 */
export function signalHash(key: string, signalType: string, date: Date): string {
  const bucket = Math.floor(date.getTime() / (30 * 24 * 3600 * 1000));
  return createHash("sha1").update(`${key}|${signalType}|${bucket}`).digest("hex");
}
