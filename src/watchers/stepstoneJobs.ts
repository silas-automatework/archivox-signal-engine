import { readFileSync } from "node:fs";
import { S1_JOB_QUERIES, STEPSTONE_ACTOR, requireEnv } from "../config.js";
import { stripHtml } from "../pipeline/normalize.js";
import type { RawObservation, Watcher } from "../types.js";

const APIFY_BASE = "https://api.apify.com/v2";

interface StepstoneItem {
  title?: string;
  companyName?: string;
  url?: string;
  location?: string;
  datePosted?: string;
  publishFromDate?: string;
  textSnippet?: string;
  isAnonymous?: boolean;
  [k: string]: unknown;
}

async function startActorRun(token: string, input: object): Promise<string> {
  const res = await fetch(`${APIFY_BASE}/acts/${STEPSTONE_ACTOR}/runs?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify run start failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: { id: string } };
  return data.data.id;
}

async function waitForRun(token: string, runId: string, timeoutMs = 10 * 60 * 1000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`);
    const data = (await res.json()) as { data: { status: string; defaultDatasetId: string } };
    const { status, defaultDatasetId } = data.data;
    if (status === "SUCCEEDED") return defaultDatasetId;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      throw new Error(`Apify run ${runId} ended with status ${status}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`Apify run ${runId} timed out after ${timeoutMs / 1000}s`);
}

async function fetchDatasetItems(token: string, datasetId: string): Promise<StepstoneItem[]> {
  const res = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&clean=true`);
  if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`);
  return (await res.json()) as StepstoneItem[];
}

function toObservation(item: StepstoneItem, query: string): RawObservation | null {
  const company = item.companyName;
  if (!company || !item.url || !item.title || item.isAnonymous) return null;
  const url = item.url.startsWith("http") ? item.url : `https://www.stepstone.de${item.url}`;
  return {
    watcher: "stepstone_jobs",
    signalType: "S1_erp_migration",
    companyRaw: String(company).trim(),
    title: String(item.title).trim(),
    url,
    postedAt: item.publishFromDate ?? item.datePosted ?? null,
    location: item.location ?? null,
    snippet: item.textSnippet ? stripHtml(String(item.textSnippet)).slice(0, 1500) : null,
    query,
    fetchedAt: new Date().toISOString(),
  };
}

export const stepstoneJobsWatcher: Watcher = {
  name: "stepstone_jobs",

  async run({ maxItemsPerQuery, postedWithinDays, demo }) {
    if (demo) {
      const fixture = JSON.parse(readFileSync("fixtures/stepstone-sample.json", "utf8")) as {
        query: string;
        items: StepstoneItem[];
      }[];
      return fixture.flatMap((f) =>
        f.items.map((i) => toObservation(i, f.query)).filter((o): o is RawObservation => o !== null)
      );
    }

    const token = requireEnv("APIFY_API_KEY");
    const all: RawObservation[] = [];

    for (const query of S1_JOB_QUERIES) {
      const input = {
        keyword: query,
        location: "deutschland",
        postedWithin: String(postedWithinDays),
        maxItems: maxItemsPerQuery,
        includeRelatedJobs: false,
        enrichEmails: false,
      };
      process.stdout.write(`  [stepstone_jobs] query "${query}" ... `);
      try {
        const runId = await startActorRun(token, input);
        const datasetId = await waitForRun(token, runId);
        const items = await fetchDatasetItems(token, datasetId);
        const obs = items.map((i) => toObservation(i, query)).filter((o): o is RawObservation => o !== null);
        console.log(`${items.length} items, ${obs.length} usable`);
        all.push(...obs);
      } catch (err) {
        console.log(`ERROR: ${(err as Error).message}`);
      }
    }
    return all;
  },
};
