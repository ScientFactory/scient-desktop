import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProviderManagedRuntimeActions } from "../../provider/ProviderDriver.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import { reconcileManagedRuntimeProviders } from "./ManagedRuntimeCatalogReconciler.ts";

const INSTANCE = ProviderInstanceId.make("codex");
const currentRuntime: ProviderRuntimeSummary = {
  source: "scient_managed",
  supportTier: "fully_assisted",
  target: "darwin-arm64",
  actions: ["repair", "remove"],
  managedVersion: "0.151.0",
  previousManagedVersion: null,
  operation: null,
  message: "Scient manages this Codex runtime.",
};
const updateRuntime: ProviderRuntimeSummary = {
  ...currentRuntime,
  actions: ["update", "repair", "remove"],
};
const provider: ServerProvider = {
  instanceId: INSTANCE,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.151.0",
  status: "ready",
  auth: { status: "authenticated", required: true },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser"],
    canDisconnect: true,
    operation: null,
    runtime: currentRuntime,
  },
};

describe("ManagedRuntimeCatalogReconciler", () => {
  it.effect(
    "refreshes Antigravity when its separate ACP catalog changes without probing other providers",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity");
        const antigravity = {
          ...provider,
          instanceId,
          driver: ProviderDriverKind.make("antigravity"),
        };
        const calls = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
        const registry = ProviderRegistry.of({
          ...makeProviderRegistryMock([provider, antigravity]),
          getProviderManagedRuntimeActionsForInstance: (id) =>
            Ref.update(calls, (current) => [...current, id]).pipe(Effect.as(undefined)),
        });
        yield* reconcileManagedRuntimeProviders(["antigravityAcp"]).pipe(
          Effect.provideService(ProviderRegistry, registry),
        );
        assert.deepStrictEqual(yield* Ref.get(calls), [instanceId]);
      }),
  );

  it.effect("publishes a newly available managed update without reloading the provider", () =>
    Effect.gen(function* () {
      const publications = yield* Ref.make<
        ReadonlyArray<{
          readonly runtime: ProviderRuntimeSummary | null;
          readonly preserveOperation?: boolean;
        }>
      >([]);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(updateRuntime),
        plan: () => Effect.die("plan must not run during catalog reconciliation"),
        run: () => Effect.die("runtime mutation must not run during catalog reconciliation"),
      };
      const base = makeProviderRegistryMock([provider]);
      const registry = ProviderRegistry.of({
        ...base,
        getProviderManagedRuntimeActionsForInstance: () => Effect.succeed(actions),
        setProviderManagedRuntimeSummary: (input) =>
          Ref.update(publications, (current) => [
            ...current,
            {
              runtime: input.runtime,
              ...(input.preserveOperation === undefined
                ? {}
                : { preserveOperation: input.preserveOperation }),
            },
          ]).pipe(Effect.as([provider])),
      });

      yield* reconcileManagedRuntimeProviders(["codex"]).pipe(
        Effect.provideService(ProviderRegistry, registry),
      );

      assert.deepStrictEqual(yield* Ref.get(publications), [
        { runtime: updateRuntime, preserveOperation: true },
      ]);
    }),
  );

  it.effect("does not probe providers whose catalog entry did not change", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const base = makeProviderRegistryMock([provider]);
      const registry = ProviderRegistry.of({
        ...base,
        getProviderManagedRuntimeActionsForInstance: () =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.as(undefined)),
      });
      yield* reconcileManagedRuntimeProviders(["grok"]).pipe(
        Effect.provideService(ProviderRegistry, registry),
      );
      assert.strictEqual(yield* Ref.get(calls), 0);
    }),
  );
});
