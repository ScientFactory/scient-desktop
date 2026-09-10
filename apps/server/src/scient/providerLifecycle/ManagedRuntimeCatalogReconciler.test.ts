import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { MANAGED_RUNTIME_CATALOG_PROVIDERS } from "@scientfactory/provider-runtime";
import { CodexDriver } from "../../provider/Drivers/CodexDriver.ts";
import { ClaudeDriver } from "../../provider/Drivers/ClaudeDriver.ts";
import { AntigravityDriver } from "../../provider/Drivers/AntigravityDriver.ts";
import { CursorDriver } from "../../provider/Drivers/CursorDriver.ts";
import { DroidDriver } from "../../provider/Drivers/DroidDriver.ts";
import { GrokDriver } from "../../provider/Drivers/GrokDriver.ts";
import { PiDriver } from "../../provider/Drivers/PiDriver.ts";

import type { ProviderManagedRuntimeActions } from "../../provider/ProviderDriver.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import {
  catalogProviderForDriver,
  layer,
  reconcileManagedRuntimeProviders,
} from "./ManagedRuntimeCatalogReconciler.ts";

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
  it("maps actual managed drivers to every non-ACP catalog key", () => {
    const drivers = [
      CodexDriver,
      ClaudeDriver,
      AntigravityDriver,
      CursorDriver,
      DroidDriver,
      GrokDriver,
      PiDriver,
    ];
    assert.deepStrictEqual(
      drivers.map((driver) => catalogProviderForDriver(driver.driverKind)),
      MANAGED_RUNTIME_CATALOG_PROVIDERS.filter((provider) => provider !== "antigravityAcp"),
    );
    assert.isUndefined(catalogProviderForDriver(ProviderDriverKind.make("opencode")));
    assert.isUndefined(catalogProviderForDriver(ProviderDriverKind.make("antigravityAcp")));
  });
  it.effect("reconciles Claude and Pi at startup even without a new catalog event", () =>
    Effect.gen(function* () {
      const instances = ["claudeAgent", "pi"].map((driver) => ({
        ...provider,
        instanceId: ProviderInstanceId.make(`${driver}-managed`),
        driver: ProviderDriverKind.make(driver),
      }));
      const finished = yield* Deferred.make<void>();
      const calls: ProviderInstanceId[] = [];
      const registry = ProviderRegistry.of({
        ...makeProviderRegistryMock(instances),
        getProviderManagedRuntimeActionsForInstance: (id) =>
          Effect.gen(function* () {
            calls.push(id);
            if (calls.length === instances.length) yield* Deferred.succeed(finished, undefined);
            return undefined;
          }),
      });
      yield* Layer.build(layer.pipe(Layer.provide(Layer.succeed(ProviderRegistry, registry))));
      yield* Deferred.await(finished);
      assert.deepStrictEqual(
        calls,
        instances.map((instance) => instance.instanceId),
      );
    }).pipe(Effect.scoped),
  );

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

  for (const driver of MANAGED_RUNTIME_CATALOG_PROVIDERS.filter(
    (provider) => provider !== "antigravityAcp",
  )) {
    it.effect(
      `publishes a newly available ${driver} managed update without reloading the provider`,
      () =>
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
          const selectedProvider = { ...provider, driver: ProviderDriverKind.make(driver) };
          const base = makeProviderRegistryMock([selectedProvider]);
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

          yield* reconcileManagedRuntimeProviders([driver]).pipe(
            Effect.provideService(ProviderRegistry, registry),
          );

          assert.deepStrictEqual(yield* Ref.get(publications), [
            { runtime: updateRuntime, preserveOperation: true },
          ]);
        }),
    );
  }

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
