import { assert, describe, it } from "@effect/vitest";

import {
  githubRepositoryFromRemote,
  parseUpstreamState,
  resolveVerificationMode,
  shouldFetchUpstream,
} from "./scient-upstream-check.ts";

const validState = {
  schemaVersion: 1,
  ownedRepository: "ScientFactory/scient-desktop",
  ownedDefaultBranch: "main",
  officialRepository: "Emanuele-web04/synara",
  officialDefaultBranch: "main",
  updateMode: "divergent-cherry-pick",
  reviewedThrough: "a".repeat(40),
  reviewedAt: "2026-07-18",
  integrationBase: "b".repeat(40),
  reviewRecord: "ScientFactory/Scient:lab/external/upstream-reviews/2026-07-18-scient-desktop.md",
};

describe("scient upstream source check", () => {
  it("accepts equivalent GitHub SSH and HTTPS remote forms", () => {
    assert.equal(
      githubRepositoryFromRemote("git@github.com:ScientFactory/scient-desktop.git"),
      "scientfactory/scient-desktop",
    );
    assert.equal(
      githubRepositoryFromRemote("https://github.com/ScientFactory/scient-desktop.git"),
      "scientfactory/scient-desktop",
    );
    assert.equal(
      githubRepositoryFromRemote("ssh://git@github.com/ScientFactory/scient-desktop"),
      "scientfactory/scient-desktop",
    );
  });

  it("rejects non-GitHub and malformed remotes", () => {
    assert.equal(githubRepositoryFromRemote("https://example.com/owner/repo.git"), null);
    assert.equal(githubRepositoryFromRemote("DISABLED"), null);
    assert.equal(githubRepositoryFromRemote(""), null);
  });

  it("fetches upstream by default and requires an explicit offline opt-out", () => {
    assert.equal(shouldFetchUpstream([]), true);
    assert.equal(shouldFetchUpstream(["--intake"]), true);
    assert.equal(shouldFetchUpstream(["--no-fetch"]), false);
  });

  it("uses explicit report, review, and intake modes", () => {
    assert.equal(resolveVerificationMode([]), "report");
    assert.equal(resolveVerificationMode(["--review-check"]), "review");
    assert.equal(resolveVerificationMode(["--intake"]), "intake");
    assert.equal(resolveVerificationMode(["--checks"]), "intake");
    assert.throws(
      () => resolveVerificationMode(["--review-check", "--intake"]),
      /either --review-check or --intake/,
    );
  });

  it("validates machine-readable upstream review state", () => {
    assert.deepEqual(parseUpstreamState(validState), validState);
    assert.throws(
      () => parseUpstreamState({ ...validState, reviewedThrough: "short" }),
      /full lowercase commit SHA/,
    );
    assert.throws(
      () => parseUpstreamState({ ...validState, updateMode: "always-merge" }),
      /unsupported updateMode/,
    );
  });
});
