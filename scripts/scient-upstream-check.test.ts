import { assert, describe, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertGitHubRemote,
  assertReviewCurrent,
  assertUpstreamPushDisabled,
  githubRepositoryFromRemote,
  parseUpstreamState,
  resolveVerificationMode,
  shouldFetchUpstream,
  verifyAncestry,
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

  it("rejects the wrong owned repository and any writable upstream push URL", () => {
    assert.doesNotThrow(() =>
      assertGitHubRemote(
        "origin fetch URL",
        "git@github.com:ScientFactory/scient-desktop.git",
        "ScientFactory/scient-desktop",
      ),
    );
    assert.throws(
      () =>
        assertGitHubRemote(
          "origin fetch URL",
          "https://github.com/Emanuele-web04/synara.git",
          "ScientFactory/scient-desktop",
        ),
      /origin fetch URL mismatch/,
    );
    assert.doesNotThrow(() => assertUpstreamPushDisabled("DISABLED"));
    assert.throws(
      () => assertUpstreamPushDisabled("git@github.com:Emanuele-web04/synara.git"),
      /expected DISABLED/,
    );
  });

  it("fetches upstream by default and requires an explicit offline opt-out", () => {
    assert.equal(shouldFetchUpstream([]), true);
    assert.equal(shouldFetchUpstream(["--intake"]), true);
    assert.equal(shouldFetchUpstream(["--no-fetch"]), false);
  });

  it("uses explicit report, review, and intake modes", () => {
    assert.equal(resolveVerificationMode([]), "report");
    assert.equal(resolveVerificationMode(["--review-check"]), "review");
    assert.equal(resolveVerificationMode(["--require-reviewed-tip"]), "review");
    assert.equal(resolveVerificationMode(["--intake"]), "intake");
    assert.equal(resolveVerificationMode(["--checks"]), "intake");
    assert.throws(
      () => resolveVerificationMode(["--review-check", "--intake"]),
      /either strict review verification or --intake/,
    );
  });

  it("requires the reviewed checkpoint to equal the official tip only in strict review mode", () => {
    assert.doesNotThrow(() => assertReviewCurrent("report", 2, "a".repeat(40), "b".repeat(40)));
    assert.doesNotThrow(() => assertReviewCurrent("intake", 2, "a".repeat(40), "b".repeat(40)));
    assert.doesNotThrow(() => assertReviewCurrent("review", 0, "a".repeat(40), "a".repeat(40)));
    assert.throws(
      () => assertReviewCurrent("review", 2, "a".repeat(40), "b".repeat(40)),
      /leaves 2 unreviewed commit/,
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

  it("proves valid review and integration ancestry in a real Git repository", () => {
    const fixture = createAncestryFixture();
    try {
      assert.doesNotThrow(() =>
        verifyAncestry({
          reviewedThrough: fixture.reviewed,
          integrationBase: fixture.base,
          upstreamTip: fixture.upstreamTip,
          ownedHead: fixture.owned,
          cwd: fixture.cwd,
        }),
      );
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it("rejects review and integration checkpoints on the wrong histories", () => {
    const fixture = createAncestryFixture();
    try {
      assert.throws(
        () =>
          verifyAncestry({
            reviewedThrough: fixture.reviewed,
            integrationBase: fixture.owned,
            upstreamTip: fixture.upstreamTip,
            ownedHead: fixture.owned,
            cwd: fixture.cwd,
          }),
        /Integration base is not official upstream history/,
      );
      assert.throws(
        () =>
          verifyAncestry({
            reviewedThrough: fixture.owned,
            integrationBase: fixture.base,
            upstreamTip: fixture.upstreamTip,
            ownedHead: fixture.owned,
            cwd: fixture.cwd,
          }),
        /Invalid upstream review checkpoint/,
      );
      assert.throws(
        () =>
          verifyAncestry({
            reviewedThrough: fixture.reviewed,
            integrationBase: fixture.reviewed,
            upstreamTip: fixture.upstreamTip,
            ownedHead: fixture.owned,
            cwd: fixture.cwd,
          }),
        /Integration base is not present in owned history/,
      );
      assert.throws(
        () =>
          verifyAncestry({
            reviewedThrough: "f".repeat(40),
            integrationBase: fixture.base,
            upstreamTip: fixture.upstreamTip,
            ownedHead: fixture.owned,
            cwd: fixture.cwd,
          }),
        /cat-file/,
      );
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });
});

function createAncestryFixture(): {
  readonly cwd: string;
  readonly base: string;
  readonly owned: string;
  readonly reviewed: string;
  readonly upstreamTip: string;
} {
  const cwd = mkdtempSync(path.join(tmpdir(), "scient-desktop-upstream-"));
  git(cwd, "init", "--initial-branch=owned");
  git(cwd, "config", "user.email", "scient-test@users.noreply.github.com");
  git(cwd, "config", "user.name", "Scient Test");
  git(cwd, "config", "commit.gpgsign", "false");
  const base = commit(cwd, "base.txt", "base");
  git(cwd, "branch", "official");
  const owned = commit(cwd, "owned.txt", "owned");
  git(cwd, "checkout", "official");
  const reviewed = commit(cwd, "reviewed.txt", "reviewed");
  const upstreamTip = commit(cwd, "tip.txt", "tip");
  return { cwd, base, owned, reviewed, upstreamTip };
}

function commit(cwd: string, file: string, contents: string): string {
  writeFileSync(path.join(cwd, file), contents);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}
