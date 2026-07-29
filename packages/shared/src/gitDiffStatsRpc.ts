// FILE: gitDiffStatsRpc.ts
// Purpose: Overlays compact Git diff statistics outside immutable released contracts.
// Layer: Shared desktop/web runtime RPC

import {
  GitReadWorkingTreeDiffInput,
  NonNegativeInt,
  WsRpcError,
  type NativeApi,
} from "@synara/contracts";
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const GIT_WORKING_TREE_DIFF_STATS_METHOD = "scient.git.workingTreeDiffStats.v1";

/** Compact totals for one working-tree diff scope, without the patch text. */
export const GitWorkingTreeDiffStatsResult = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  fileCount: NonNegativeInt,
});
export type GitWorkingTreeDiffStatsResult = typeof GitWorkingTreeDiffStatsResult.Type;

export const GitWorkingTreeDiffStatsRpc = Rpc.make(GIT_WORKING_TREE_DIFF_STATS_METHOD, {
  payload: GitReadWorkingTreeDiffInput,
  success: GitWorkingTreeDiffStatsResult,
  error: WsRpcError,
});

// Merge this additive group after the released base group. Keeping the method,
// schema, and API extension here preserves shipped migration dependency files.
export const GitDiffStatsRpcGroup = RpcGroup.make(GitWorkingTreeDiffStatsRpc);

export type GitDiffStatsNativeApi<TApi extends NativeApi = NativeApi> = Omit<TApi, "git"> & {
  git: TApi["git"] & {
    workingTreeDiffStats: (
      input: GitReadWorkingTreeDiffInput,
    ) => Promise<GitWorkingTreeDiffStatsResult>;
  };
};

export function asGitDiffStatsNativeApi<TApi extends NativeApi>(
  api: TApi,
): GitDiffStatsNativeApi<TApi> {
  return api as unknown as GitDiffStatsNativeApi<TApi>;
}
