/**
 * Scient first-party analytics adapter.
 *
 * The inherited T3 call sites remain unchanged, but this boundary accepts only
 * Scient-registered events and properties. Delivery is disabled by default and
 * goes only through Scient's first-party gateway when deliberately enabled.
 *
 * @module AnalyticsService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
    ) => Effect.Effect<void>;

    /** Attempt delivery of the currently due local outbox batch. */
    readonly flush: Effect.Effect<void>;
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
/** @public Service construction is part of the canonical Effect module API. */
export { make };
// SCIENT-FORK:END

export const layer = Layer.effect(AnalyticsService, make);
/** @public Service construction is part of the canonical Effect module API. */
export const layerDisabled = AnalyticsService.layerDisabled;
