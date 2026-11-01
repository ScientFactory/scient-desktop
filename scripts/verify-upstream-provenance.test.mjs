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
      isOwnedAncestor: () => false,
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
        isOwnedAncestor: () => false,
      }),
    ).toEqual([]);
    expect(
      validateIntroducedMergeParents({
        base: "owned-base",
        head: "feature-head",
        merges: [{ commit: "new-merge", parents: ["owned-base", "open-pr-parent"] }],
        exceptions: [exception],
        isOfficialAncestor: () => false,
        isOwnedAncestor: () => false,
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
        isOwnedAncestor: () => false,
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
        isOwnedAncestor: () => false,
      }),
    ).toEqual(["upstream-pr-head: non-official merge parent open-pr-parent"]);
  });

  it("accepts a realignment parent already contained in the exact owned base", () => {
    expect(
      validateIntroducedMergeParents({
        base: "current-owned-main",
        head: "aligned-feature-head",
        merges: [
          {
            commit: "alignment-merge",
            parents: ["feature-head", "current-owned-main"],
          },
        ],
        exceptions: [],
        allowOwnedHeadMerge: false,
        isOfficialAncestor: () => false,
        isOwnedAncestor: (commit) => commit === "current-owned-main",
      }),
    ).toEqual([]);

    expect(
      validateIntroducedMergeParents({
        base: "current-owned-main",
        head: "aligned-feature-head",
        merges: [
          {
            commit: "alignment-merge",
            parents: ["feature-head", "unapproved-donor-head"],
          },
        ],
        exceptions: [],
        allowOwnedHeadMerge: false,
        isOfficialAncestor: () => false,
        isOwnedAncestor: () => false,
      }),
    ).toEqual(["alignment-merge: non-official merge parent unapproved-donor-head"]);
  });

  const batch = {
    base: "owned-base",
    head: "second-platform-merge",
    merges: [
      { commit: "second-platform-merge", parents: ["first-platform-merge", "second-pr-head"] },
      { commit: "first-platform-merge", parents: ["owned-base", "first-pr-head"] },
    ],
    exceptions: [],
    isOfficialAncestor: (commit) => commit === "official-parent",
    isOwnedAncestor: (commit) => commit === "owned-base",
  };

  it("rejects platform merge batches without a trusted event allowance", () => {
    expect(validateIntroducedMergeParents(batch)).toEqual([
      "second-platform-merge: non-official merge parent second-pr-head",
      "first-platform-merge: non-official merge parent first-pr-head",
    ]);
  });

  // regression: fd3907ff8a fix(ci): accept batched merge-queue commits on main
  // Both allowances open the same queue-chain branch, so only acceptance runs for each.
  it.each([{ allowQueueMerges: true }, { allowOwnedHeadMerge: true }])(
    "accepts every integration merge in a batch with %j",
    (allowance) => {
      expect(validateIntroducedMergeParents({ ...batch, ...allowance })).toEqual([]);
    },
  );

  describe("trusted integration batch", () => {
    const allowance = { allowQueueMerges: true };

    it("still rejects a donor merge nested in a PR history", () => {
      expect(
        validateIntroducedMergeParents({
          ...batch,
          ...allowance,
          merges: [
            ...batch.merges,
            { commit: "first-pr-head", parents: ["owned-base", "unapproved-donor"] },
          ],
        }),
      ).toEqual(["first-pr-head: non-official merge parent unapproved-donor"]);
    });

    it("preserves official, owned and exact historical ancestry inside a PR", () => {
      expect(
        validateIntroducedMergeParents({
          ...batch,
          ...allowance,
          exceptions: [{ head: "historical-parent", importMerge: "historical-merge" }],
          merges: [
            ...batch.merges,
            { commit: "first-pr-head", parents: ["owned-merge", "official-parent"] },
            { commit: "owned-merge", parents: ["historical-merge", "owned-base"] },
            { commit: "historical-merge", parents: ["owned-base", "historical-parent"] },
          ],
        }),
      ).toEqual([]);
    });

    it.each([
      { label: "missing base", parents: ["different-base", "first-pr-head"] },
      { label: "cycle", parents: ["second-platform-merge", "first-pr-head"] },
      { label: "single-parent gap", parents: ["owned-base"] },
      { label: "octopus merge", parents: ["owned-base", "first-pr-head", "another-head"] },
    ])("rejects a $label in the integration chain", ({ parents }) => {
      const failures = validateIntroducedMergeParents({
        ...batch,
        ...allowance,
        merges: [batch.merges[0], { commit: "first-platform-merge", parents }],
      });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/^Unexpected merge queue topology at /);
    });
  });
});
