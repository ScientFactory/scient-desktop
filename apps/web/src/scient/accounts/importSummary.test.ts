import { describe, expect, it } from "vite-plus/test";

import { browserImportEvent, importShortfall } from "./importSummary";

const reasons = (
  appBoundEncryption: number,
  decryptFailed: number,
  { partitionUnsupported = 0, writeFailed = 0 } = {},
) => ({ appBoundEncryption, decryptFailed, partitionUnsupported, writeFailed });

describe("importShortfall", () => {
  it.each([
    ["every cookie protected", 0, reasons(3, 0), "appBoundEncryption"],
    ["protected and unreadable cookies", 0, reasons(3, 2), "appBoundEncryption"],
    ["only unreadable cookies", 0, reasons(0, 2), "readFailed"],
    ["every write failed", 0, reasons(0, 0, { writeFailed: 5 }), "writeFailed"],
    [
      "only partitioned cookies it can't key",
      0,
      reasons(0, 0, { partitionUnsupported: 2 }),
      "writeFailed",
    ],
    ["some cookies written beside protected ones", 4, reasons(3, 0), undefined],
    ["nothing to read", 0, reasons(0, 0), undefined],
  ] as const)("%s", (_case, imported, skippedByReason, expected) => {
    const skipped = Object.values(skippedByReason).reduce((sum, count) => sum + count, 0);
    expect(importShortfall({ imported, skipped, skippedByReason })).toBe(expected);
  });
});

describe("browserImportEvent", () => {
  it("records what the import did in fixed codes", () => {
    expect(
      browserImportEvent("chrome", {
        kind: "imported",
        imported: 24,
        skipped: 6,
        protectedSkipped: 6,
      }),
    ).toEqual({
      variant: "partial",
      sourceBrowser: "chrome",
      importedUnit: "cookies",
      importedBucket: "11_100",
      protectedSkipped: "1_10",
    });
    expect(browserImportEvent("firefox", { kind: "imported", imported: 3, skipped: 0 })).toEqual(
      expect.objectContaining({ variant: "complete", protectedSkipped: "0" }),
    );
    // Into Main: sign-ins counted, and one left behind makes it partial with no cookie skipped.
    expect(
      browserImportEvent("chrome", {
        kind: "imported",
        imported: 1,
        skipped: 0,
        importedUnit: "signIns",
        partial: true,
      }),
    ).toEqual(expect.objectContaining({ variant: "partial", importedUnit: "sign_ins" }));
    expect(
      browserImportEvent("edge", {
        kind: "blocked",
        reason: "appBoundEncryption",
        protectedSkipped: 120,
      }),
    ).toEqual(expect.objectContaining({ variant: "blocked", protectedSkipped: "gt_100" }));
    expect(
      browserImportEvent("helium", { kind: "blocked", reason: "readFailed", message: "Policy" }),
    ).toEqual(expect.objectContaining({ variant: "blocked" }));
    expect(browserImportEvent("helium", { kind: "blocked", reason: "readFailed" })).toEqual(
      expect.objectContaining({ variant: "failed" }),
    );
  });
});
