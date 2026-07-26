import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { AuthorizedGitPullInput, AuthorizedGitRunStackedActionInput } from "./gitActionAuthority";

describe("authorized Git mutation inputs", () => {
  it("requires the branch observed by the pull caller", () => {
    const decode = Schema.decodeUnknownSync(AuthorizedGitPullInput);

    expect(decode({ cwd: "/repo", expectedBranch: "main" })).toEqual({
      cwd: "/repo",
      expectedBranch: "main",
    });
    expect(() => decode({ cwd: "/repo" })).toThrow();
  });

  it("requires the branch observed by a stacked-action caller", () => {
    const decode = Schema.decodeUnknownSync(AuthorizedGitRunStackedActionInput);

    expect(
      decode({
        actionId: "action-branch-authority",
        cwd: "/repo",
        action: "commit_push",
        expectedBranch: "main",
      }).expectedBranch,
    ).toBe("main");
    expect(() =>
      decode({
        actionId: "action-without-authority",
        cwd: "/repo",
        action: "commit",
      }),
    ).toThrow();
  });
});
