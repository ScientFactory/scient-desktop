// FILE: gitMutationRpc.ts
// Purpose: Overlays live Git mutation authority on immutable released transport contracts.
// Layer: Shared runtime RPC

import {
  GitActionProgressEvent,
  GitPullInput,
  GitPullResult,
  GitRunStackedActionInput,
  WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

const ExpectedBranch = Schema.Trim.check(Schema.isNonEmpty());

export const AuthorizedGitPullInput = Schema.Struct({
  ...GitPullInput.fields,
  expectedBranch: ExpectedBranch,
});
export type AuthorizedGitPullInput = typeof AuthorizedGitPullInput.Type;

export const AuthorizedGitRunStackedActionInput = Schema.Struct({
  ...GitRunStackedActionInput.fields,
  expectedBranch: ExpectedBranch,
});
export type AuthorizedGitRunStackedActionInput = typeof AuthorizedGitRunStackedActionInput.Type;

export const AuthorizedGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: AuthorizedGitPullInput,
  success: GitPullResult,
  error: WsRpcError,
});

export const AuthorizedGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: AuthorizedGitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: WsRpcError,
  stream: true,
});

// Merge this group after the released base group. Identical tags intentionally
// replace only these two live request schemas while historical contract files
// stay byte-for-byte frozen for shipped migration dependency lineage.
export const GitMutationRpcGroup = RpcGroup.make(
  AuthorizedGitPullRpc,
  AuthorizedGitRunStackedActionRpc,
);
