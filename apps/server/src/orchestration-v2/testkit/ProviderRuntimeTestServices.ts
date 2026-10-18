import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as CommandOutputHub from "../CommandOutputHub.ts";
import type * as EventSink from "../EventSink.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";

/** Scripted sessions run outside a git checkout, so no worktree branch is ever renamed. */
export const layerGitVcsDriverWithoutBranches = Layer.mock(GitVcsDriver.GitVcsDriver)({
  resolveBranchName: () => Effect.succeed(null),
});

/**
 * The services a session manager and its event ingestor need beyond a test's
 * own stores: the live command-output hub over those stores, and a git driver
 * that never resolves a branch.
 */
export const layerProviderRuntimeTestServices = <E, R>(
  stores: Layer.Layer<EventSink.EventSinkV2 | ProjectionStore.ProjectionStoreV2, E, R>,
) =>
  Layer.merge(CommandOutputHub.layer.pipe(Layer.provide(stores)), layerGitVcsDriverWithoutBranches);
