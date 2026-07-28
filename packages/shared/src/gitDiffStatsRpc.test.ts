import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  GIT_WORKING_TREE_DIFF_STATS_METHOD,
  GitDiffStatsRpcGroup,
  GitWorkingTreeDiffStatsResult,
} from "./gitDiffStatsRpc";

describe("Git diff stats RPC overlay", () => {
  it("owns the additive method outside the released contract group", () => {
    expect(GIT_WORKING_TREE_DIFF_STATS_METHOD).toBe("scient.git.workingTreeDiffStats.v1");
    expect([...GitDiffStatsRpcGroup.requests.keys()]).toEqual([GIT_WORKING_TREE_DIFF_STATS_METHOD]);
  });

  it("accepts compact non-negative totals", () => {
    expect(
      Schema.decodeUnknownSync(GitWorkingTreeDiffStatsResult)({
        additions: 4,
        deletions: 2,
        fileCount: 3,
      }),
    ).toEqual({ additions: 4, deletions: 2, fileCount: 3 });
    expect(() =>
      Schema.decodeUnknownSync(GitWorkingTreeDiffStatsResult)({
        additions: -1,
        deletions: 0,
        fileCount: 1,
      }),
    ).toThrow();
  });
});
