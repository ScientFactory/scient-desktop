import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  AuthorizedGitPullInput,
  AuthorizedGitPullRpc,
  AuthorizedGitRunStackedActionInput,
  AuthorizedGitRunStackedActionRpc,
  GitMutationRpcGroup,
} from "./gitMutationRpc";
import {
  LIVE_HTML_PREVIEW_PREPARE_V1_METHOD,
  LiveHtmlPreviewPrepareRpc,
  LiveHtmlPreviewRpcGroup,
} from "./liveHtmlPreviewTransport";

describe("Git mutation RPC authority overlay", () => {
  it("requires the caller-observed branch for pull and stacked actions", () => {
    expect(
      Schema.decodeUnknownSync(AuthorizedGitPullInput)({
        cwd: "/repo",
        expectedBranch: "main",
      }).expectedBranch,
    ).toBe("main");
    expect(() => Schema.decodeUnknownSync(AuthorizedGitPullInput)({ cwd: "/repo" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AuthorizedGitPullInput)({
        cwd: "/repo",
        expectedBranch: "   ",
      }),
    ).toThrow();

    expect(
      Schema.decodeUnknownSync(AuthorizedGitRunStackedActionInput)({
        actionId: "action-1",
        cwd: "/repo",
        action: "commit_push",
        expectedBranch: "main",
      }).expectedBranch,
    ).toBe("main");
    expect(() =>
      Schema.decodeUnknownSync(AuthorizedGitRunStackedActionInput)({
        actionId: "action-1",
        cwd: "/repo",
        action: "commit_push",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AuthorizedGitRunStackedActionInput)({
        actionId: "action-1",
        cwd: "/repo",
        action: "commit_push",
        expectedBranch: "   ",
      }),
    ).toThrow();
  });

  it("preserves live HTML preview while authorized Git mutations win their method tags", () => {
    expect([...GitMutationRpcGroup.requests.keys()]).toEqual(["git.pull", "git.runStackedAction"]);
    const merged = LiveHtmlPreviewRpcGroup.merge(GitMutationRpcGroup);
    expect(merged.requests.get(LIVE_HTML_PREVIEW_PREPARE_V1_METHOD)).toBe(
      LiveHtmlPreviewPrepareRpc,
    );
    expect(merged.requests.get("git.pull")).toBe(AuthorizedGitPullRpc);
    expect(merged.requests.get("git.runStackedAction")).toBe(AuthorizedGitRunStackedActionRpc);
  });
});
