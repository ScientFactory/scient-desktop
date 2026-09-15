// @effect-diagnostics nodeBuiltinImport:off -- admission is budgeted for the execution host.
import * as NodeOS from "node:os";
import { ComputeOperationError } from "@scientfactory/compute";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const DEFAULT_COMPUTE_HOST_CAPACITY = Math.max(
  1,
  Math.min(16, Math.floor(NodeOS.totalmem() / (4 * 1024 ** 3))),
);

/**
 * A small host admission counter shared by session and native batch execution.
 * It does not schedule work or own processes. The caller releases its lease only
 * after its process scope closes, never merely because a result is terminal.
 */
export class ComputeHostCapacity extends Context.Service<
  ComputeHostCapacity,
  {
    readonly acquire: (limit?: number) => Effect.Effect<Effect.Effect<void>, ComputeOperationError>;
  }
>()("t3/scient/compute/ComputeHostCapacity") {}

export const layer = Layer.effect(
  ComputeHostCapacity,
  Effect.sync(() => {
    const leases = new Set<symbol>();
    return ComputeHostCapacity.of({
      acquire: (limit = DEFAULT_COMPUTE_HOST_CAPACITY) =>
        Effect.suspend(() => {
          if (leases.size >= limit)
            return Effect.fail(
              new ComputeOperationError({
                operation: "start",
                reason: "capacity-reached",
                message: `This host has ${limit} active or starting compute sessions, tests, or batch runs. Stop unused work and try again.`,
              }),
            );
          const lease = Symbol();
          leases.add(lease);
          return Effect.succeed(
            Effect.sync(() => {
              leases.delete(lease);
            }),
          );
        }),
    });
  }),
);
