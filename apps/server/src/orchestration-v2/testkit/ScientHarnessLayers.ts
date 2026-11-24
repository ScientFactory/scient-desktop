/**
 * Services Scient's product adds to T3's orchestration test harnesses, so each T3 harness
 * provides one Scient layer instead of editing its own wiring.
 *
 * @module ScientHarnessLayers
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";

/** A snapshot registry for recorded providers: an unexpected auth invalidation fails visibly. */
export const layerRecordedProviderRegistry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
  ...makeProviderRegistryMock(),
  setProviderAuthenticationFailure: Effect.fn("ProviderRegistry.setProviderAuthenticationFailure")(
    function () {
      return Effect.die("Unexpected authentication invalidation in a recorded provider harness.");
    },
  ),
});

/** What the platform layers of T3's runtime and project-upgrade tests also need in Scient. */
export const layerRuntimeHarness = Layer.mergeAll(
  layerRecordedProviderRegistry,
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
    get: () => Effect.succeed(null),
    discard: () => Effect.void,
  }),
  ThreadCommandExecutor.layer,
);
