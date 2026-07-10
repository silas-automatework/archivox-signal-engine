import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { signalHash } from "./pipeline/normalize.js";
import type { RawObservation } from "./types.js";

let dir: string;
let store: Store;

function obs(url: string, company = "Müller Maschinenbau GmbH"): RawObservation {
  return {
    watcher: "stepstone_jobs",
    signalType: "S1_erp_migration",
    companyRaw: company,
    title: "SAP S/4HANA Lead",
    url,
    postedAt: "2026-07-01",
    location: "Stuttgart",
    snippet: "S/4HANA Migration",
    query: "S/4HANA Migration",
    fetchedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  store = new Store(join(dir, "test.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("observations", () => {
  it("dedupes on posting URL across runs", () => {
    expect(store.insertObservations([obs("https://x.de/1"), obs("https://x.de/2")])).toEqual({
      inserted: 2,
      duplicates: 0,
    });
    expect(store.insertObservations([obs("https://x.de/1")])).toEqual({ inserted: 0, duplicates: 1 });
  });

  it("groups unclassified observations by company key", () => {
    store.insertObservations([obs("https://x.de/1"), obs("https://x.de/2", "Müller Maschinenbau GmbH & Co. KG")]);
    const groups = store.unclassifiedCompanies();
    expect(groups).toHaveLength(1);
    expect(groups[0].postings).toHaveLength(2);
  });
});

describe("signal events", () => {
  it("dedupes signals in the same 30-day bucket", () => {
    const hash = signalHash("mueller maschinenbau", "S1", new Date());
    const e = {
      hash,
      companyKey: "mueller maschinenbau",
      companyRaw: "Müller Maschinenbau GmbH",
      signalType: "S1_erp_migration",
      strength: 0.9,
      evidenceJson: "{}",
    };
    expect(store.upsertSignalEvent(e)).toBe(true);
    expect(store.upsertSignalEvent(e)).toBe(false);
  });
});

describe("contacts", () => {
  it("upserts on linkedin url and keeps the freshest role", () => {
    const c = {
      companyKey: "qiagen",
      name: "Thorsten Harzer",
      role: "VP",
      linkedinUrl: "https://linkedin.com/in/x",
      confidence: 0.9,
      reason: "",
      anrede: "Herr",
    };
    store.upsertContact(c);
    store.upsertContact({ ...c, role: "SVP", confidence: 0.95 });
    const contacts = store.contactsForCompany("qiagen");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].role).toBe("SVP");
  });

  it("finds companies below the contact threshold (the reuse bridge)", () => {
    store.insertObservations([obs("https://x.de/1")]);
    store.saveClassification({
      companyKey: "mueller maschinenbau",
      companyRaw: "Müller Maschinenbau GmbH",
      companyType: "end_user",
      isSignal: true,
      confidence: 0.9,
      industry: "machinery",
      quote: "",
      reason: "",
      escalated: false,
      model: "test",
    });
    store.upsertSignalEvent({
      hash: "h1",
      companyKey: "mueller maschinenbau",
      companyRaw: "Müller Maschinenbau GmbH",
      signalType: "S1_erp_migration",
      strength: 0.9,
      evidenceJson: "{}",
    });
    expect(store.companiesNeedingPeople(2)).toHaveLength(1);
    store.upsertContact({
      companyKey: "mueller maschinenbau",
      name: "A B",
      role: "CIO",
      linkedinUrl: "https://linkedin.com/in/a",
      confidence: 0.9,
      reason: "",
      anrede: "",
    });
    store.upsertContact({
      companyKey: "mueller maschinenbau",
      name: "C D",
      role: "Head of SAP",
      linkedinUrl: "https://linkedin.com/in/c",
      confidence: 0.8,
      reason: "",
      anrede: "",
    });
    expect(store.companiesNeedingPeople(2)).toHaveLength(0);
  });
});
