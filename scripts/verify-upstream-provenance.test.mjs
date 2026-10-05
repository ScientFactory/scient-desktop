import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  validateIntroducedMergeParents,
  validateOwnedIntegrationMerges,
} from "./verify-upstream-provenance.mjs";

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
});

const mergeCommit = "a".repeat(40);
const firstParent = "b".repeat(40);
const secondParent = "c".repeat(40);
const ownedReceipt = {
  id: "reviewed-scient-lane",
  merge: mergeCommit,
  parents: [firstParent, secondParent],
  reviewRecord: "docs/internals/reviewed-lane.md",
};

const validateReceipt = (receipts, overrides = {}) =>
  validateOwnedIntegrationMerges({
    receipts,
    parentsOf: () => [firstParent, secondParent],
    isInOwnedHistory: () => true,
    hasCommittedReviewRecord: () => true,
    ...overrides,
  });

describe("reviewed owned branch receipts", () => {
  it.each([null, {}, "receipt"])("rejects a non-array receipt list: %s", (receipts) => {
    expect(validateReceipt(receipts)).toEqual({
      receipts: [],
      failures: ["ownedIntegrationMerges must be an array"],
    });
  });

  it("accepts only the exact ordered two-parent edge and retains nested donor checks", () => {
    const policy = {
      base: "owned-base",
      head: "feature-head",
      exceptions: [],
      ownedIntegrationMerges: validateReceipt([ownedReceipt]).receipts,
      isOfficialAncestor: () => false,
      isOwnedAncestor: () => false,
    };
    expect(
      validateIntroducedMergeParents({
        ...policy,
        merges: [
          { commit: mergeCommit, parents: [firstParent, secondParent] },
          { commit: secondParent, parents: ["lane-base", "unreviewed-pr-head"] },
        ],
      }),
    ).toEqual([`${secondParent}: non-official merge parent unreviewed-pr-head`]);
    for (const merge of [
      { commit: "different-merge", parents: [firstParent, secondParent] },
      { commit: mergeCommit, parents: [secondParent, firstParent] },
      { commit: mergeCommit, parents: [firstParent, "different-parent"] },
      { commit: mergeCommit, parents: [firstParent, secondParent, "third-parent"] },
    ]) {
      expect(validateIntroducedMergeParents({ ...policy, merges: [merge] }).length).toBeGreaterThan(
        0,
      );
    }
  });

  it.each([
    ["abbreviated merge", { ...ownedReceipt, merge: "abcdef" }],
    ["abbreviated parent", { ...ownedReceipt, parents: [firstParent, "abcdef"] }],
    ["extra parent", { ...ownedReceipt, parents: [firstParent, secondParent, mergeCommit] }],
    ["external record", { ...ownedReceipt, reviewRecord: "/tmp/review.md" }],
    ["escaping record", { ...ownedReceipt, reviewRecord: "docs/../review.md" }],
  ])("rejects malformed receipt: %s", (_, receipt) => {
    const result = validateReceipt([receipt]);
    expect(result.receipts).toEqual([]);
    expect(result.failures).toEqual(["Invalid owned integration merge receipt"]);
  });

  it("rejects duplicate identities, missing committed evidence and displaced merge parents", () => {
    expect(validateReceipt([ownedReceipt, ownedReceipt]).failures).toEqual([
      "reviewed-scient-lane: duplicate owned integration merge receipt",
    ]);
    expect(
      validateReceipt([ownedReceipt], { parentsOf: () => [secondParent, firstParent] }).failures,
    ).toEqual(["reviewed-scient-lane: owned integration merge parents do not match"]);
    expect(validateReceipt([ownedReceipt], { isInOwnedHistory: () => false }).failures).toEqual([
      "reviewed-scient-lane: owned integration merge is not in inspected history",
    ]);
    expect(
      validateReceipt([ownedReceipt], { hasCommittedReviewRecord: () => false }).failures,
    ).toEqual(["reviewed-scient-lane: committed owned integration review record is missing"]);
  });
});

const repositories = [];
afterEach(() => {
  for (const directory of repositories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function realHistory({ nestedDonor = false, recordKind = "regular" } = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-provenance-test-"));
  repositories.push(root);
  const run = (...args) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Scient fixture");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "commit.gpgsign", "false");
  run("config", "core.hooksPath", "/dev/null");
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "Official fixture\n");
  run("add", ".");
  run("commit", "-qm", "official root");
  const official = run("rev-parse", "HEAD");
  NodeFS.mkdirSync(NodePath.join(root, "docs/internals"), { recursive: true });
  const reviewRecord = "docs/internals/reviewed-lane.md";
  if (recordKind === "regular")
    NodeFS.writeFileSync(NodePath.join(root, reviewRecord), "Reviewed exact owned lane\n");
  if (recordKind === "symlink")
    NodeFS.symlinkSync("../../README.md", NodePath.join(root, reviewRecord));
  NodeFS.writeFileSync(NodePath.join(root, "owned.txt"), "Scient baseline\n");
  run("add", ".");
  run("commit", "-qm", "owned baseline");
  const base = run("rev-parse", "HEAD");
  run("switch", "-qc", "lane");
  let donorMerge;
  let donor;
  if (nestedDonor) {
    run("switch", "-qc", "foreign", official);
    NodeFS.writeFileSync(NodePath.join(root, "donor.txt"), "Unreviewed donor\n");
    run("add", ".");
    run("commit", "-qm", "foreign change");
    donor = run("rev-parse", "HEAD");
    run("switch", "-q", "lane");
    run("merge", "--no-ff", "-qm", "nested donor merge", donor);
    donorMerge = run("rev-parse", "HEAD");
  }
  NodeFS.writeFileSync(NodePath.join(root, "lane.txt"), "Reviewed owned change\n");
  run("add", ".");
  run("commit", "-qm", "owned lane change");
  const lane = run("rev-parse", "HEAD");
  run("switch", "-q", "main");
  run("merge", "--no-ff", "-qm", "reviewed integration", lane);
  const merge = run("rev-parse", "HEAD");
  const receipt = { id: "real-owned-lane", merge, parents: [base, lane], reviewRecord };
  const state = {
    schemaVersion: 2,
    updateMode: "thin-fork-merge",
    integrationBase: official,
    historicalExceptions: [],
    ownedIntegrationMerges: [receipt],
  };
  const saveState = () => {
    NodeFS.writeFileSync(NodePath.join(root, "upstream-state.json"), JSON.stringify(state));
    run("add", "upstream-state.json");
    run("commit", "-qm", "record exact review");
    return run("rev-parse", "HEAD");
  };
  const verify = () =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "verify-upstream-provenance.mjs"),
        "--base",
        base,
        "--head",
        run("rev-parse", "HEAD"),
        "--official-ref",
        official,
      ],
      { cwd: root, encoding: "utf8" },
    );
  saveState();
  return { root, run, state, receipt, donorMerge, donor, saveState, verify };
}

describe("production provenance CLI on actual Git histories", () => {
  it("accepts the frozen reviewed branch without advancing the official boundary", () => {
    const fixture = realHistory();
    const before = fixture.run("status", "--porcelain");
    const boundary = fixture.state.integrationBase;
    expect(fixture.verify().status).toBe(0);
    expect(fixture.state.integrationBase).toBe(boundary);
    expect(fixture.run("status", "--porcelain")).toBe(before);
    fixture.state.ownedIntegrationMerges[0].parents.reverse();
    fixture.saveState();
    const displaced = fixture.verify();
    expect(displaced.status).toBe(1);
    expect(displaced.stderr).toContain("owned integration merge parents do not match");
  });

  it("rejects an unapproved donor nested inside the approved lane", () => {
    const fixture = realHistory({ nestedDonor: true });
    const result = fixture.verify();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${fixture.donorMerge}: non-official merge parent ${fixture.donor}`,
    );
    expect(result.stderr).not.toContain(`${fixture.receipt.merge}: non-official merge parent`);
  });

  it.each(["untracked", "symlink"])("rejects a %s review record", (recordKind) => {
    const fixture = realHistory({ recordKind });
    if (recordKind === "untracked")
      NodeFS.writeFileSync(
        NodePath.join(fixture.root, fixture.receipt.reviewRecord),
        "Local only\n",
      );
    const result = fixture.verify();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("committed owned integration review record is missing");
  });
});
