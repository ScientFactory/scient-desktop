import type { ScientAnalyticsStatus, ScientAnalyticsUiEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import type { AnalyticsService } from "./AnalyticsService.ts";

/** Fence delayed UI outcomes across consent changes and server restarts.
 * The random context never reaches the event contract, queue or gateway.
 */
export function makeAnalyticsUiAdapter(analytics: AnalyticsService["Service"]) {
  let epoch: number | undefined;
  let context: string | undefined;
  const status: Effect.Effect<ScientAnalyticsStatus, never, Crypto.Crypto> = Effect.gen(
    function* () {
      const current = yield* analytics.status;
      const currentEpoch = yield* analytics.collectionEpoch;
      if (!current.available || current.consent === "off") {
        epoch = undefined;
        context = undefined;
        return current;
      }
      if (epoch !== currentEpoch || context === undefined) {
        epoch = currentEpoch;
        const crypto = yield* Crypto.Crypto;
        context = yield* crypto.randomUUIDv4.pipe(Effect.orElseSucceed(() => undefined));
      }
      return context === undefined ? current : { ...current, collectionContext: context };
    },
  );

  const record = Effect.fn("AnalyticsUiAdapter.record")(function* (event: ScientAnalyticsUiEvent) {
    if (event.name.startsWith("scient.operation.")) {
      const current = yield* status;
      if (
        event.collectionContext === undefined ||
        event.collectionContext !== current.collectionContext ||
        (event.properties.operationKind !== "pdf-export" &&
          event.properties.operationKind !== "document-export")
      )
        return { accepted: false } as const;
    }
    yield* analytics.record(event.name, event.properties);
    return { accepted: true } as const;
  });

  return { status, record };
}
