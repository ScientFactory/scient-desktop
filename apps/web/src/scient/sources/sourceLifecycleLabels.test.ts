import { describe, expect, it } from "vite-plus/test";

import { changedFieldsLabel, revisionLabel } from "./sourceLifecycleLabels";

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
});
