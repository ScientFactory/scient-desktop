import { afterEach, describe, expect, it, vi } from "vitest";

import { readPdfPageLabels, readQuotePageLabels } from "./pdfQuotePageLabels";

const documents = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("../pdf/pdfDocuments", () => ({ acquirePdfDocument: documents.acquire }));

/** A lease whose document gives `labels`, or never opens when `labels` is undefined. */
function lease(labels?: ReadonlyArray<string> | null) {
  const release = vi.fn();
  const value =
    labels === undefined
      ? new Promise(() => undefined)
      : Promise.resolve({ document: { getPageLabels: async () => labels } });
  documents.acquire.mockReturnValueOnce({ value, release });
  return release;
}

afterEach(() => {
  documents.acquire.mockReset();
  vi.useRealTimers();
});

describe("page labels for a quote from a PDF no reader has open", () => {
  it("reads the labels once, closes the PDF, and remembers them for the same bytes", async () => {
    const release = lease(["i", "ii", "1"]);
    const url = vi.fn(async () => "blob:paper");
    const input = { contentKey: "sha-labelled", url };
    expect(await readQuotePageLabels(input)).toEqual(["i", "ii", "1"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await readQuotePageLabels(input)).toEqual(["i", "ii", "1"]);
    expect(documents.acquire).toHaveBeenCalledTimes(1);
    expect(url).toHaveBeenCalledTimes(1);
  });

  it("gives up after the timeout and stops opening the PDF", async () => {
    vi.useFakeTimers();
    const release = lease();
    const reading = readQuotePageLabels({
      contentKey: "sha-slow",
      url: async () => "blob:slow",
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await reading).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("falls back when the PDF cannot be served, and tries again next time", async () => {
    const failing = vi.fn(async () => null);
    expect(await readQuotePageLabels({ contentKey: "sha-unserved", url: failing })).toBeNull();
    expect(documents.acquire).not.toHaveBeenCalled();
    lease(null);
    const served = async () => "blob:later";
    expect(await readQuotePageLabels({ contentKey: "sha-unserved", url: served })).toBeNull();
    expect(documents.acquire).toHaveBeenCalledTimes(1);
  });

  it("tells a PDF without labels from one that could not be read", async () => {
    expect(await readPdfPageLabels({ contentKey: "sha-unread", url: async () => null })).toEqual({
      _tag: "Unread",
    });
    lease(null);
    const input = { contentKey: "sha-unlabelled", url: async () => "blob:plain" };
    expect(await readPdfPageLabels(input)).toEqual({ _tag: "None" });
    expect(await readPdfPageLabels(input)).toEqual({ _tag: "None" });
    expect(documents.acquire).toHaveBeenCalledTimes(1);
  });
});
