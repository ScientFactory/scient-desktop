import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type ProviderLifecycleOperationKind = "connection" | "runtime";

export interface ProviderLifecycleReservation {
  readonly operationId: string;
  readonly kind: ProviderLifecycleOperationKind;
}

export interface ProviderLifecycleCoordinatorShape {
  readonly reserve: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly reservation: ProviderLifecycleReservation;
  }) => Effect.Effect<boolean>;
  readonly release: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly operationId: string;
  }) => Effect.Effect<boolean>;
  readonly current: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderLifecycleReservation | undefined>;
}

export class ProviderLifecycleCoordinator extends Context.Service<
  ProviderLifecycleCoordinator,
  ProviderLifecycleCoordinatorShape
>()("t3/scient/providerLifecycle/ProviderLifecycleCoordinator") {}

export const make = Effect.gen(function* () {
  const reservations = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ProviderLifecycleReservation>
  >(new Map());
  const reserve: ProviderLifecycleCoordinatorShape["reserve"] = (input) =>
    Ref.modify(reservations, (current) => {
      if (current.has(input.instanceId)) return [false, current] as const;
      const next = new Map(current);
      next.set(input.instanceId, input.reservation);
      return [true, next] as const;
    });
  const release: ProviderLifecycleCoordinatorShape["release"] = (input) =>
    Ref.modify(reservations, (current) => {
      if (current.get(input.instanceId)?.operationId !== input.operationId) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.delete(input.instanceId);
      return [true, next] as const;
    });
  return ProviderLifecycleCoordinator.of({
    reserve,
    release,
    current: (instanceId) => Ref.get(reservations).pipe(Effect.map((map) => map.get(instanceId))),
  });
});

export const layer = Layer.effect(ProviderLifecycleCoordinator, make);
