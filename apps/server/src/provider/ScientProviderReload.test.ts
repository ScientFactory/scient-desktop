import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderInstanceRegistryShape } from "./ProviderInstanceRegistry.ts";
import { makeScientProviderReload } from "./ScientProviderReload.ts";

const live = ProviderInstanceId.make("live");
const parked = ProviderInstanceId.make("parked");
const unknown = ProviderInstanceId.make("unknown");

/** `rebuild` retires a live instance the way a failed replacement leaves it unavailable. */
const makeReload = Effect.fn("ScientProviderReload.test.makeReload")(function* () {
  const instances = new Map([[live, { instanceId: live } as ProviderInstance]]);
  const rebuilt: Array<ProviderInstanceId> = [];
  const refreshed: Array<ProviderInstanceId> = [];
  const instanceRegistry: ProviderInstanceRegistryShape = {
    getInstance: (instanceId) => Effect.sync(() => instances.get(instanceId)),
    listInstances: Effect.sync(() => [...instances.values()]),
    listUnavailable: Effect.succeed([{ instanceId: parked } as ServerProvider]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  };
  const reload = makeScientProviderReload({
    instanceRegistry,
    rebuild: (instanceIds) =>
      Effect.sync(() => {
        rebuilt.push(...instanceIds);
        for (const instanceId of instanceIds) instances.delete(instanceId);
      }),
    layerScope: yield* Effect.scope,
    syncLiveSources: Effect.void,
    getLiveInstances: Effect.sync(() => new Map(instances)),
    refreshInstance: () => Effect.succeed([]),
    refreshOneSource: (instance) =>
      Effect.sync(() => {
        refreshed.push(instance.instanceId);
        return [];
      }),
    readRefreshedSource: () => Effect.die("Reload does not verify accounts."),
    syncProvider: () => Effect.die("Reload does not publish verified providers."),
    authenticationFailuresRef: yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly message: string }>
    >(new Map()),
  });
  return { reload, rebuilt, refreshed };
});

it.effect("strict reload fails instead of refreshing the instance its rebuild retired", () =>
  Effect.gen(function* () {
    const { reload, rebuilt, refreshed } = yield* makeReload();
    const error = yield* reload.reloadInstanceStrict(live).pipe(Effect.flip);
    assert.equal(error.operation, "reload");
    assert.deepEqual(rebuilt, [live]);
    assert.deepEqual(refreshed, []);
  }),
);

it.effect("reload hands every id to the registry's own rebuild, unavailable and unknown too", () =>
  Effect.gen(function* () {
    const { reload, rebuilt } = yield* makeReload();
    // No check of its own outside the registry's lock, where a replacement could hide the id.
    yield* reload.reloadInstance(parked);
    yield* reload.reloadInstance(unknown);
    assert.deepEqual(rebuilt, [parked, unknown]);
  }),
);
