import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type ProviderLifecycleOperationKind = "connection" | "runtime" | "maintenance";

export interface ProviderLifecycleReservation {
  readonly operationId: string;
  readonly kind: ProviderLifecycleOperationKind;
}

export interface ProviderLifecycleCoordinatorShape {
  readonly reserve: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly provider?: ProviderDriverKind;
    readonly reservation: ProviderLifecycleReservation;
  }) => Effect.Effect<boolean>;
  readonly release: (input: { readonly operationId: string }) => Effect.Effect<boolean>;
  readonly current: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderLifecycleReservation | undefined>;
}

export class ProviderLifecycleCoordinator extends Context.Service<
  ProviderLifecycleCoordinator,
  ProviderLifecycleCoordinatorShape
>()("t3/scient/providerLifecycle/ProviderLifecycleCoordinator") {}

export const make = Effect.gen(function* () {
  const reservations = yield* Ref.make<ReadonlyMap<string, ProviderLifecycleReservation>>(
    new Map(),
  );
  const reserve: ProviderLifecycleCoordinatorShape["reserve"] = (input) =>
    Ref.modify(reservations, (current) => {
      const instanceKey = `instance:${input.instanceId}`;
      const providerKey = input.provider ? `provider:${input.provider}` : undefined;
      const providerConnectionPrefix = input.provider
        ? `provider-connection:${input.provider}:`
        : undefined;
      const providerConnectionKey = providerConnectionPrefix
        ? `${providerConnectionPrefix}${input.instanceId}`
        : undefined;
      const changesSharedRuntime = input.reservation.kind !== "connection";

      if (current.has(instanceKey)) return [false, current] as const;
      if (providerKey && current.has(providerKey)) return [false, current] as const;
      if (
        changesSharedRuntime &&
        providerConnectionPrefix &&
        [...current.keys()].some((key) => key.startsWith(providerConnectionPrefix))
      ) {
        return [false, current] as const;
      }

      const keys = [instanceKey];
      if (providerKey && changesSharedRuntime) keys.push(providerKey);
      if (providerConnectionKey && !changesSharedRuntime) keys.push(providerConnectionKey);
      const next = new Map(current);
      for (const key of keys) next.set(key, input.reservation);
      return [true, next] as const;
    });
  const release: ProviderLifecycleCoordinatorShape["release"] = (input) =>
    Ref.modify(reservations, (current) => {
      const next = new Map(current);
      let released = false;
      for (const [key, reservation] of current) {
        if (reservation.operationId !== input.operationId) continue;
        next.delete(key);
        released = true;
      }
      return [released, released ? next : current] as const;
    });
  return ProviderLifecycleCoordinator.of({
    reserve,
    release,
    current: (instanceId) =>
      Ref.get(reservations).pipe(Effect.map((map) => map.get(`instance:${instanceId}`))),
  });
});

export const layer = Layer.effect(ProviderLifecycleCoordinator, make);
