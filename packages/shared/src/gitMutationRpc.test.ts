import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { WsRpcGroup } from "@synara/contracts";

import {
  AuthorizedGitPullInput,
  AuthorizedGitPullRpc,
  AuthorizedGitRunStackedActionInput,
  AuthorizedGitRunStackedActionRpc,
  GitMutationRpcGroup,
} from "./gitMutationRpc";

describe("Git mutation RPC authority overlay", () => {
  it("requires the caller-observed branch for pull and stacked actions", () => {
    expect(
      Schema.decodeUnknownSync(AuthorizedGitPullInput)({
        cwd: "/repo",
        expectedBranch: "main",
      }).expectedBranch,
    ).toBe("main");
    expect(() => Schema.decodeUnknownSync(AuthorizedGitPullInput)({ cwd: "/repo" })).toThrow();

    expect(
      Schema.decodeUnknownSync(AuthorizedGitRunStackedActionInput)({
        actionId: "action-1",
        cwd: "/repo",
        action: "commit_push",
        expectedBranch: "main",
      }).expectedBranch,
    ).toBe("main");
  });

  it("overlays the released Git mutation method tags", () => {
    expect([...GitMutationRpcGroup.requests.keys()]).toEqual(["git.pull", "git.runStackedAction"]);
    const merged = WsRpcGroup.merge(GitMutationRpcGroup);
    expect(merged.requests.get("git.pull")).toBe(AuthorizedGitPullRpc);
    expect(merged.requests.get("git.runStackedAction")).toBe(AuthorizedGitRunStackedActionRpc);
  });
});
