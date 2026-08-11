import { describe, expect, it } from "vite-plus/test";

import { validateIntroducedMergeParents } from "./verify-upstream-provenance.mjs";

describe("upstream provenance merge-parent guard", () => {
  it("accepts official T3 ancestry and rejects an unapproved donor parent", () => {
    const failures = validateIntroducedMergeParents({
      base: "owned-base",
      head: "feature-head",
      merges: [
        { commit: "official-merge", parents: ["owned-base", "official-parent"] },
        { commit: "donor-merge", parents: ["official-merge", "open-pr-parent"] },
      ],
      exceptions: [],
      isOfficialAncestor: (commit) => commit === "official-parent",
    });
    expect(failures).toEqual(["donor-merge: non-official merge parent open-pr-parent"]);
  });

  it("grandfathers only the exact historical exception merge", () => {
    const exception = { head: "open-pr-parent", importMerge: "historical-merge" };
    expect(
      validateIntroducedMergeParents({
        base: "owned-base",
        head: "feature-head",
        merges: [{ commit: "historical-merge", parents: ["owned-base", "open-pr-parent"] }],
        exceptions: [exception],
        isOfficialAncestor: () => false,
      }),
    ).toEqual([]);
    expect(
      validateIntroducedMergeParents({
        base: "owned-base",
        head: "feature-head",
        merges: [{ commit: "new-merge", parents: ["owned-base", "open-pr-parent"] }],
        exceptions: [exception],
        isOfficialAncestor: () => false,
      }),
    ).toEqual(["new-merge: non-official merge parent open-pr-parent"]);
  });

  it("ignores an owned platform merge only when the push workflow authorizes it", () => {
    expect(
      validateIntroducedMergeParents({
        base: "owned-base",
        head: "platform-merge",
        merges: [{ commit: "platform-merge", parents: ["owned-base", "feature-head"] }],
        exceptions: [],
        allowOwnedHeadMerge: true,
        isOfficialAncestor: () => false,
      }),
    ).toEqual([]);
    expect(
      validateIntroducedMergeParents({
        base: "owned-base",
        head: "upstream-pr-head",
        merges: [{ commit: "upstream-pr-head", parents: ["owned-base", "open-pr-parent"] }],
        exceptions: [],
        allowOwnedHeadMerge: false,
        isOfficialAncestor: () => false,
      }),
    ).toEqual(["upstream-pr-head: non-official merge parent open-pr-parent"]);
  });
});
