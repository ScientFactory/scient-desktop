import type { ScientAnalyticsStatus, ScientAnalyticsUiEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { AnalyticsService } from "./AnalyticsService.ts";

// The server records these operations itself; a UI copy would count them twice.
const SERVER_OBSERVED_OPERATIONS: ReadonlySet<string> = new Set([
  "compute-run",
  "compute-artifact",
  "latex-build",
  "source-import",
]);

// Accounts' browser observations (apps/web/src/scient/analytics/accountBrowserAnalytics.ts) often
// end long after they began, such as a sign-in window or a copied Google sign-in's lifetime.
const FENCED_FEATURES: ReadonlySet<string> = new Set([
  "accounts.google_signin.blocked",
  "accounts.browser_window",
  "accounts.browser_import",
  "accounts.google_copy.checked",
  "accounts.google_copy.ended",
]);

/** Fence delayed UI outcomes across consent changes and server restarts.
 * The random context never reaches the event contract, queue or gateway.
 */
export function makeAnalyticsUiAdapter(analytics: AnalyticsService["Service"]) {
  let epoch: number | undefined;
  let context: string | undefined;
  const status: Effect.Effect<ScientAnalyticsStatus, never, SecureRandom.SecureRandom> = Effect.gen(
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
        const random = yield* SecureRandom.SecureRandom;
        context = yield* random.uuidV4().pipe(Effect.orElseSucceed(() => undefined));
      }
      return context === undefined
        ? current
        : { ...current, collectionContext: context, voiceLifecycleVersion: 2 as const };
    },
  );

  const record = Effect.fn("AnalyticsUiAdapter.record")(function* (event: ScientAnalyticsUiEvent) {
    if (
      event.name.startsWith("voice.") ||
      event.name === "panel.viewed" ||
      event.name === "settings.viewed" ||
      event.name === "usage.viewed" ||
      event.name === "feature.viewed" ||
      event.name === "usage.availability" ||
      (event.name === "feature.used" && FENCED_FEATURES.has(String(event.properties.feature)))
    ) {
      const current = yield* status;
      if (
        event.collectionContext === undefined ||
        event.collectionContext !== current.collectionContext
      )
        return { accepted: false } as const;
    }
    if (event.name.startsWith("scient.operation.")) {
      const current = yield* status;
      if (
        event.collectionContext === undefined ||
        event.collectionContext !== current.collectionContext ||
        SERVER_OBSERVED_OPERATIONS.has(String(event.properties.operationKind))
      )
        return { accepted: false } as const;
    }
    yield* analytics.record(event.name, event.properties);
    return { accepted: true } as const;
  });

  return { status, record };
}
