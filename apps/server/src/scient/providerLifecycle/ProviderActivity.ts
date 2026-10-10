import type {
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";

/** A shared runtime cannot be replaced while any of its instances owns live work. */
export interface ProviderActivityShape {
  readonly isBusy: (provider: ProviderDriverKind) => Effect.Effect<boolean>;
}

export class ProviderActivity extends Context.Service<ProviderActivity, ProviderActivityShape>()(
  "t3/scient/providerLifecycle/ProviderActivity",
) {}

export function hasProviderActivity(input: {
  readonly provider: ProviderDriverKind;
  readonly driverByInstance: ReadonlyMap<ProviderInstanceId, ProviderDriverKind>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "providerInstanceId" | "status">>;
  readonly sessions: ReadonlyArray<Pick<OrchestrationV2ProviderSession, "driver" | "status">>;
  readonly threads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "driver" | "status" | "pendingBackgroundTasks">
  >;
}): boolean {
  if (
    input.sessions.some(
      (session) =>
        session.driver === input.provider &&
        (session.status === "starting" ||
          session.status === "running" ||
          session.status === "waiting"),
    ) ||
    input.threads.some(
      (thread) =>
        thread.driver === input.provider &&
        (thread.status === "active" || (thread.pendingBackgroundTasks?.length ?? 0) > 0),
    )
  )
    return true;

  return input.runs.some((run) => {
    if (
      run.status !== "preparing" &&
      run.status !== "starting" &&
      run.status !== "running" &&
      run.status !== "waiting"
    )
      return false;
    const driver = input.driverByInstance.get(run.providerInstanceId);
    // A removed or unavailable instance with unsettled work cannot be proved idle.
    return driver === undefined || driver === input.provider;
  });
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const instances = yield* ProviderInstanceRegistry;
  const isBusy: ProviderActivityShape["isBusy"] = Effect.fn("ProviderActivity.isBusy")(
    function* (provider) {
      const driverByInstance = new Map(
        (yield* instances.listInstances).map((instance) => [
          instance.instanceId,
          instance.driverKind,
        ]),
      );
      const snapshot = yield* projections.getShellSnapshot();
      for (const shell of [...snapshot.threads, ...snapshot.archivedThreads]) {
        const records = yield* projections.getThreadRecords(shell.id, [
          "runs",
          "providerSessions",
          "providerThreads",
        ]);
        if (
          hasProviderActivity({
            provider,
            driverByInstance,
            runs: records.runs,
            sessions: records.providerSessions,
            threads: records.providerThreads,
          })
        )
          return true;
      }
      return false;
    },
    (effect, provider) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider activity could not be read; treating it as busy", {
            provider,
            cause,
          }).pipe(Effect.as(true)),
        ),
      ),
  );
  return ProviderActivity.of({ isBusy });
});

export const layer = Layer.effect(ProviderActivity, make);
