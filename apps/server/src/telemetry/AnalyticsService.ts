/** Scient analytics accepts only registered events and properties.
 * Delivery is disabled by default and uses Scient's first-party gateway when enabled.
 * @module AnalyticsService
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { TelemetryOwner } from "./Identify.ts";

// SCIENT-FORK:START — Scient first-party analytics replaces the PostHog client
import { disabledAnalyticsService, make, type ScientAnalyticsControls } from "./ScientAnalytics.ts";
export { localAnalyticsTestEndpoint, type AnalyticsStatus } from "./ScientAnalytics.ts";
// SCIENT-FORK:END

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record a registered, bounded event without interrupting user work. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
      /** In-memory observer fence; never persisted or exported. */
      expectedCollectionEpoch?: number,
    ) => Effect.Effect<void>;

    /** Attempt delivery of the currently due local outbox batch. */
    readonly flush: Effect.Effect<void>;

    /** Compatibility only: Scient never records provider or installation owner identities. */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
    // SCIENT-FORK:START — consent and deletion controls
  } & ScientAnalyticsControls
  // SCIENT-FORK:END
>()("t3/telemetry/AnalyticsService") {
  // SCIENT-FORK:START — Scient first-party analytics replaces the PostHog client
  /** No-op layer for tests and callers that intentionally disable analytics. */
  static readonly layerDisabled = Layer.succeed(AnalyticsService, disabledAnalyticsService);
  static readonly layerTest = AnalyticsService.layerDisabled;
  // SCIENT-FORK:END
}

// SCIENT-FORK:START — Scient first-party analytics replaces the PostHog client
/** @public */
export { make };
// SCIENT-FORK:END

export const layer = Layer.effect(AnalyticsService, make);
/** @public */
export const layerDisabled = AnalyticsService.layerDisabled;
