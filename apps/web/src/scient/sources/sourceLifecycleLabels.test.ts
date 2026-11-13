import { describe, expect, it } from "vite-plus/test";

import {
  changedFieldsLabel,
  editorialStatusLine,
  revisionLabel,
  sourceTrustLabel,
} from "./sourceLifecycleLabels";

describe("source lifecycle labels", () => {
  it("names changed fields once in plain words and skips the first revision", () => {
    expect(changedFieldsLabel(["issuedRaw", "issuedYear", "creators", "attachments"])).toBe(
      "Changed date, authors, PDFs",
    );
    expect(changedFieldsLabel([])).toBe("");
    expect(revisionLabel({ savedAt: "not a date", savedBy: "agent", changes: ["title"] })).toBe(
      "Edited by an agent",
    );
    expect(revisionLabel({ savedAt: "not a date", savedBy: "user", changes: [] })).toBe(
      "Saved by you",
    );
  });

  it("warns about the most serious registry notice and stays quiet otherwise", () => {
    const status = {
      state: "retracted" as const,
      checkedAt: "2026-11-10T00:00:00.000Z",
      notices: [
        { kind: "correction" as const, doi: "10.1/c", date: "2004-03-06" },
        { kind: "retraction" as const, doi: "10.1/r", date: "2010" },
      ],
    };
    expect(editorialStatusLine(status)).toMatchObject({
      text: "Retracted in 2010",
      serious: true,
      noticeDoi: "10.1/r",
    });
    expect(editorialStatusLine({ ...status, state: "none", notices: [] })).toBeNull();
    // A package's notice says it is another computer's check.
    expect(editorialStatusLine({ ...status, carriedAt: "2026-11-12T00:00:00.000Z" })?.text).toBe(
      "Retracted in 2010 (from another computer's check)",
    );
    expect(sourceTrustLabel({ editorialStatus: status })).toBe(" · Retracted");
    expect(sourceTrustLabel({ verification: { state: "unverified", problem: "not-found" } })).toBe(
      " · Not found in registry",
    );
    expect(sourceTrustLabel({ verification: { state: "verified" } })).toBe("");
  });
});
