import type { ProviderRuntimeOperation } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ProviderRuntimeManager } from "./ProviderRuntimeManager.ts";
import { nextTryAt, ProviderRuntimeRequests } from "./ProviderRuntimeRequests.ts";

const START_DELAY = "60 seconds";
const POLL_INTERVAL = "1 minute";
/** Stopped for the user's own change, or another change was running. */
const BUSY_DELAY_MS = 5 * 60_000;

const isRunning = (operation: ProviderRuntimeOperation | null | undefined) =>
  operation != null &&
  operation.finishedAt === null &&
  operation.status !== "failed" &&
  operation.status !== "cancelled" &&
  operation.status !== "succeeded";

/**
 * Tries again, one at a time, the runtime changes the user asked for that a restart or a temporary
 * failure stopped. Each try first checks that the instance is still enabled and offers the same
 * reviewed plan; otherwise the request is dropped.
 */
export const make = Effect.fn("ProviderRuntimeRecovery.make")(function* () {
  const requests = yield* ProviderRuntimeRequests;
  const manager = yield* ProviderRuntimeManager;
  const registry = yield* ProviderRegistry;

  const tryDue = Effect.fn("ProviderRuntimeRecovery.tryDue")(function* () {
    yield* requests.assertAvailable;
    const now = yield* Clock.currentTimeMillis;
    const request = (yield* requests.list)
      .filter((candidate) => candidate.dueAt <= now)
      .toSorted((left, right) => left.dueAt - right.dueAt)[0];
    if (!request) return;
    const providers = yield* registry.getProviders;
    if (providers.some((provider) => isRunning(provider.connection?.runtime?.operation))) return;
    const provider = providers.find((candidate) => candidate.instanceId === request.instanceId);
    const planned =
      provider?.enabled === true && provider.driver === request.driver
        ? yield* manager
            .plan({ instanceId: request.instanceId, action: request.action })
            .pipe(Effect.option)
        : Option.none();
    if (Option.isNone(planned) || planned.value.catalogRevision !== request.catalogRevision) {
      return yield* requests.update(request.requestId, () => undefined);
    }
    const attempt = request.retries + 1;
    const lease = yield* nextTryAt(attempt);
    yield* requests.update(request.requestId, (current) => ({
      ...current,
      retries: attempt,
      dueAt: lease,
    }));
    if (!(yield* requests.list).some((current) => current.requestId === request.requestId)) return;
    // The manager settles the request when the change ends; only a try that never ran is undone.
    const outcome = yield* manager
      .startInBackground({
        instanceId: request.instanceId,
        action: request.action,
        catalogRevision: request.catalogRevision,
        attempt,
        requestId: request.requestId,
      })
      .pipe(Effect.orElseSucceed(() => "busy" as const));
    if (outcome === "interrupted") return yield* Effect.interrupt;
    if (outcome === "yielded" || outcome === "busy") {
      const later = (yield* Clock.currentTimeMillis) + BUSY_DELAY_MS;
      yield* requests.update(request.requestId, (current) =>
        current.retries === attempt
          ? { ...current, retries: request.retries, dueAt: later }
          : current,
      );
    }
  });

  yield* tryDue().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logError("provider runtime recovery failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.andThen(Effect.sleep(POLL_INTERVAL)),
    Effect.forever,
    Effect.delay(START_DELAY),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make());
