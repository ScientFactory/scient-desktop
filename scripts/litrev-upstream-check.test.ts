import { assert, describe, it } from "@effect/vitest";

import { githubRepositoryFromRemote, shouldFetchUpstream } from "./litrev-upstream-check.ts";

describe("litrev upstream source check", () => {
  it("accepts equivalent GitHub SSH and HTTPS remote forms", () => {
    assert.equal(
      githubRepositoryFromRemote("git@github.com:yaacovcorcos/synara.git"),
      "yaacovcorcos/synara",
    );
    assert.equal(
      githubRepositoryFromRemote("https://github.com/yaacovcorcos/synara.git"),
      "yaacovcorcos/synara",
    );
    assert.equal(
      githubRepositoryFromRemote("ssh://git@github.com/yaacovcorcos/synara"),
      "yaacovcorcos/synara",
    );
  });

  it("rejects non-GitHub and malformed remotes", () => {
    assert.equal(githubRepositoryFromRemote("https://example.com/owner/repo.git"), null);
    assert.equal(githubRepositoryFromRemote("DISABLED"), null);
    assert.equal(githubRepositoryFromRemote(""), null);
  });

  it("fetches upstream by default and requires an explicit offline opt-out", () => {
    assert.equal(shouldFetchUpstream([]), true);
    assert.equal(shouldFetchUpstream(["--checks"]), true);
    assert.equal(shouldFetchUpstream(["--no-fetch"]), false);
  });
});
