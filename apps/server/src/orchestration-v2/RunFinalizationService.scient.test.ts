import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

// A rewind re-reads the root with every repository; a later turn re-reads only what it changed.
it.effect("a newer repository refresh never drops a pending folder it does not re-read", () => {
  const threadId = ThreadId.make("thread-overlapping-refreshes");
  const rewound = ["/repo", "/api", "/web", "/docs", "/lib", "/site"];
  const gate = Deferred.makeUnsafe<void>();
  const saturated = Deferred.makeUnsafe<void>();
  const settled = Deferred.makeUnsafe<void>();
  const completed = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: (cwd) =>
            Effect.gen(function* () {
              maxInFlight = Math.max(maxInFlight, ++inFlight);
              if (inFlight === 4) yield* Deferred.succeed(saturated, undefined);
              yield* Deferred.await(gate);
              completed.add(cwd);
              if (completed.size === rewound.length) yield* Deferred.succeed(settled, undefined);
              return {
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              };
            }).pipe(
              Effect.onInterrupt(() =>
                cwd === "/api" ? Effect.void : Deferred.succeed(settled, undefined),
              ),
              Effect.ensuring(Effect.sync(() => inFlight--)),
            ),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refreshRepositories({ threadId, cwds: rewound });
    yield* Deferred.await(saturated);
    yield* observer.refreshRepositories({ threadId, cwds: ["/api"] });
    yield* Deferred.succeed(gate, undefined);
    yield* Deferred.await(settled);
    assert.deepEqual([...completed].toSorted(), rewound.toSorted());
    assert.strictEqual(maxInFlight, 4);
  }).pipe(Effect.provide(layer));
});
