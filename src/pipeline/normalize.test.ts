import { describe, expect, it } from "vitest";
import { companyKey, observationHash, signalHash, stripHtml } from "./normalize.js";

describe("companyKey", () => {
  it("strips legal suffixes and normalizes umlauts", () => {
    expect(companyKey("Müller Maschinenbau GmbH & Co. KG")).toBe("mueller maschinenbau");
    expect(companyKey("Alfred Kärcher SE & Co. KG")).toBe("alfred kaercher");
    expect(companyKey("QIAGEN GmbH")).toBe("qiagen");
  });

  it("matches the same company across naming variants", () => {
    expect(companyKey("Papierfabrik Palm GmbH & Co. KG")).toBe(companyKey("Papierfabrik Palm"));
  });
});

describe("observationHash", () => {
  it("is stable across case and whitespace", () => {
    expect(observationHash(" https://x.de/Job-1 ")).toBe(observationHash("https://x.de/job-1"));
  });
});

describe("signalHash", () => {
  it("dedupes within a 30-day bucket and separates across buckets", () => {
    const BUCKET_MS = 30 * 24 * 3600 * 1000;
    const bucketStart = new Date(BUCKET_MS * 700);
    const sameBucket = new Date(BUCKET_MS * 700 + 29 * 24 * 3600 * 1000);
    const nextBucket = new Date(BUCKET_MS * 701);
    expect(signalHash("qiagen", "S1", bucketStart)).toBe(signalHash("qiagen", "S1", sameBucket));
    expect(signalHash("qiagen", "S1", bucketStart)).not.toBe(signalHash("qiagen", "S1", nextBucket));
    expect(signalHash("qiagen", "S1", bucketStart)).not.toBe(signalHash("zeiss", "S1", bucketStart));
  });
});

describe("stripHtml", () => {
  it("removes search-highlighting markup and entities", () => {
    expect(stripHtml("Stable <strong>S</strong>/<strong>4HANA</strong> &amp; ECC")).toBe("Stable S/4HANA & ECC");
  });
});
