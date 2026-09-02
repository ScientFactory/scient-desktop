import type { ManagedRuntimeProvider } from "@scientfactory/provider-runtime";
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ManagedRuntimeCatalog } from "./ManagedRuntimeCatalog.ts";

const allManagedProviders: ReadonlyArray<ManagedRuntimeProvider> = [
  "codex",
  "claudeAgent",
  "antigravity",
  "cursor",
  "droid",
  "grok",
];

export function catalogProviderForDriver(
  driver: ProviderDriverKind,
): ManagedRuntimeProvider | undefined {
  switch (driver) {
    case "codex":
      return "codex";
    case "claude":
      return "claudeAgent";
    case "antigravity":
      return "antigravity";
    case "cursor":
      return "cursor";
    case "droid":
      return "droid";
    case "grok":
      return "grok";
    default:
      return undefined;
  }
}

/**
 * Recompute only the volatile managed-runtime summary. Provider processes,
 * sessions, settings, authentication, and selected executable paths remain
 * untouched; a catalog update merely makes an already-qualified action
 * visible on the existing canonical provider snapshot.
 */
export const reconcileManagedRuntimeProviders = Effect.fn(
  "ManagedRuntimeCatalogReconciler.reconcile",
)(function* (changedProviders: ReadonlyArray<ManagedRuntimeProvider>) {
  const providerRegistry = yield* ProviderRegistry;
  const changed = new Set(changedProviders);
  const providers = yield* providerRegistry.getProviders;
  yield* Effect.forEach(
    providers.filter((provider) => {
      const catalogProvider = catalogProviderForDriver(provider.driver);
      return catalogProvider !== undefined && changed.has(catalogProvider);
    }),
    (provider) =>
      Effect.gen(function* () {
        const actions = yield* providerRegistry.getProviderManagedRuntimeActionsForInstance(
          provider.instanceId,
        );
        if (!actions) return;
        const runtime = yield* actions.getSummary;
        yield* providerRegistry.setProviderManagedRuntimeSummary({
          instanceId: provider.instanceId,
          runtime,
          // A catalog publication can race a user-started install/update.
          // Preserve the supervisor-owned operation atomically in the registry.
          preserveOperation: true,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logError("managed runtime catalog reconciliation failed", {
                instanceId: provider.instanceId,
                driver: provider.driver,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    { concurrency: 1, discard: true },
  );
});

/** Process-owned bridge from catalog changes to canonical provider snapshots. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* ManagedRuntimeCatalog;
    const changes = yield* catalog.subscribeChanges;
    yield* changes.pipe(
      Stream.runForEach((change) => reconcileManagedRuntimeProviders(change.changedProviders)),
      Effect.forkScoped,
    );

    // The catalog refresh fiber may have completed before this layer acquired
    // its subscription. Reconcile once in the background to close that startup
    // window without delaying HTTP or provider readiness.
    yield* reconcileManagedRuntimeProviders(allManagedProviders).pipe(Effect.forkScoped);
  }),
);
