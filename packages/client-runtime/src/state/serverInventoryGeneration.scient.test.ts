import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  type ServerConfigStreamEvent,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import {
  hasCurrentProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "../providerSkills.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { createEnvironmentPresentationAtoms } from "./presentation.ts";
import {
  INVENTORY_CHECKED_AT,
  INVENTORY_PROVIDER,
  OTHER_INVENTORY_PROVIDER,
  inventoryConfig,
  inventoryProvider,
  inventorySnapshot,
} from "./providerWorkspaceSnapshots.scient.fixture.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

type RefreshInput = EnvironmentRpcInput<typeof WS_METHODS.serverRefreshProviders>;
const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("inventory-environment"),
  label: "Inventory environment",
  httpBaseUrl: "https://inventory.example.test",
  wsBaseUrl: "wss://inventory.example.test",
});

const makeInventoryHarness = Effect.fn("TestInventory.makeHarness")(function* (
  providers: ReadonlyArray<ServerProvider>,
) {
  const initial = inventoryConfig(providers);
  const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
  const requests = yield* Queue.unbounded<{
    readonly input: RefreshInput;
    readonly reply: Deferred.Deferred<ServerProviderUpdatedPayload>;
  }>();
  const client = {
    [WS_METHODS.serverRefreshProviders]: Effect.fn("TestInventory.refreshProviders")(function* (
      input: RefreshInput,
    ) {
      const reply = yield* Deferred.make<ServerProviderUpdatedPayload>();
      yield* Queue.offer(requests, { input, reply });
      return yield* Deferred.await(reply);
    }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(initial),
    subscribeServerConfig: () => Stream.fromQueue(events),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const environments = EnvironmentRegistry.of({
    run,
    followStream,
  } as EnvironmentRegistry["Service"]);
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(EnvironmentCacheStore, cache),
    ),
  );
  const initialConfig = Atom.make(initial);
  const server = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => initialConfig,
  });
  const presentation = createEnvironmentPresentationAtoms({
    catalogValueAtom: Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([
        [TARGET.environmentId, { target: TARGET, enabled: true, profile: Option.none() }],
      ]),
    }),
    stateAtom: () => Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE)),
    serverConfigValueAtom: server.configValueAtom,
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  // This is the subscription used by useEnvironmentProviders; commands outlive its unmount.
  const stopPage = registry.mount(presentation.providersByEnvironmentAtom);
  let mounted = true;
  const unmountPage = () => {
    if (!mounted) return;
    mounted = false;
    stopPage();
  };
  yield* Effect.addFinalizer(() => Effect.sync(unmountPage));
  const projection = server.configProjection({ environmentId: TARGET.environmentId, input: {} });
  const publish = Effect.fn("TestInventory.publish")(function* (event: ServerConfigStreamEvent) {
    const observed = yield* Deferred.make<void>();
    const unsubscribe = registry.subscribe(
      projection,
      (result) => {
        if (AsyncResult.isSuccess(result) && result.value.latestEvent === event) {
          Deferred.doneUnsafe(observed, Exit.void);
        }
      },
      { immediate: true },
    );
    yield* Queue.offer(events, event).pipe(
      Effect.andThen(Deferred.await(observed)),
      Effect.ensuring(Effect.sync(unsubscribe)),
    );
  });
  const start = (input: RefreshInput) =>
    server.refreshProviders.run(registry, {
      environmentId: TARGET.environmentId,
      input,
    });
  const complete = Effect.fn("TestInventory.complete")(function* (
    input: RefreshInput,
    reply: ServerProviderUpdatedPayload,
  ) {
    const pending = start(input);
    const request = yield* Queue.take(requests);
    yield* Deferred.succeed(request.reply, reply);
    const result = yield* Effect.promise(() => pending);
    expect(AsyncResult.isSuccess(result)).toBe(true);
    if (AsyncResult.isSuccess(result)) expect(result.value).toBe(reply);
    return result;
  });
  yield* publish({ version: 1, type: "snapshot", config: initial });
  return {
    requests,
    start,
    complete,
    publish,
    unmountPage,
    read: () => registry.get(presentation.providersByEnvironmentAtom).get(TARGET.environmentId)!,
  };
});

it.effect.each(["full", "fresh cwd"] as const)(
  "rejects a held A %s command after B publication and page unmount, then admits B",
  (path) =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = inventoryProvider("A", [inventorySnapshot("/project", "old")]);
        const other = inventoryProvider(
          "other",
          [inventorySnapshot("/project", "other")],
          OTHER_INVENTORY_PROVIDER,
        );
        const h = yield* makeInventoryHarness([
          inventoryProvider("A"),
          inventoryProvider("other", [], OTHER_INVENTORY_PROVIDER),
        ]);
        yield* h.complete({ workspaceSnapshotsOnDemand: false }, { providers: [a, other] });
        expect(
          resolveProviderSkillsForCwd(h.read()[0]!, "/project").map((skill) => skill.name),
        ).toEqual(["old"]);
        expect(
          hasCurrentProviderWorkspaceSnapshot(
            h.read()[0],
            "/project",
            Date.parse(INVENTORY_CHECKED_AT),
          ),
        ).toBe(true);
        const input: RefreshInput = {
          instanceId: INVENTORY_PROVIDER,
          cwd: "/project",
          ...(path === "full" ? { workspaceSnapshotsOnDemand: false } : { fresh: true }),
        };
        const pending = h.start(input);
        const held = yield* Queue.take(h.requests);
        expect(held.input.workspaceSnapshotsOnDemand).toBe(path !== "full");
        yield* h.publish({
          version: 1,
          type: "providerStatuses",
          payload: {
            providers: [
              inventoryProvider("B"),
              inventoryProvider("other", [], OTHER_INVENTORY_PROVIDER),
            ],
          },
        });
        expect(h.read()[0]?.nativeInventoryGeneration).toBe("B");
        expect(resolveProviderSkillsForCwd(h.read()[0]!, "/project")).toEqual([]);
        expect(resolveProviderSlashCommandsForCwd(h.read()[0]!, "/project")).toEqual([]);
        expect(
          hasCurrentProviderWorkspaceSnapshot(
            h.read()[0],
            "/project",
            Date.parse(INVENTORY_CHECKED_AT),
          ),
        ).toBe(false);

        const b = inventoryProvider("B", [
          inventorySnapshot("/project", "replacement"),
          inventorySnapshot("/untouched", "untouched"),
        ]);
        yield* h.complete({ workspaceSnapshotsOnDemand: false }, { providers: [b, other] });
        h.unmountPage();
        const late = {
          providers: [
            inventoryProvider("A", [inventorySnapshot("/project", "late")]),
            inventoryProvider("other", [], OTHER_INVENTORY_PROVIDER),
          ],
        };
        yield* Deferred.succeed(held.reply, late);
        const result = yield* Effect.promise(() => pending);
        expect(AsyncResult.isSuccess(result)).toBe(true);
        if (AsyncResult.isSuccess(result)) expect(result.value).toBe(late);
        expect(h.read().map((provider) => provider.workspaceSnapshots)).toEqual([
          b.workspaceSnapshots,
          other.workspaceSnapshots,
        ]);
        expect(
          resolveProviderSkillsForCwd(h.read()[0]!, "/project").map((skill) => skill.name),
        ).toEqual(["replacement"]);
        expect(resolveProviderSlashCommandsForCwd(h.read()[0]!, "/project")).toEqual([
          { name: "replacement" },
        ]);

        const positive = inventoryProvider("B", [inventorySnapshot("/project", "accepted")]);
        yield* h.complete(input, { providers: [positive, other] });
        expect(resolveProviderSlashCommandsForCwd(h.read()[0]!, "/project")).toEqual([
          { name: "accepted" },
        ]);
        expect(h.read()[1]?.workspaceSnapshots).toEqual(
          path === "full" ? other.workspaceSnapshots : [],
        );
        expect(
          h.read()[0]?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === "/untouched"),
        ).toBe(path !== "full");
      }),
    ),
);

it.effect(
  "preserves legacy omitted-generation command replies and bounds only the shared cache",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeInventoryHarness([inventoryProvider(undefined)]);
        const legacy = inventoryProvider(
          undefined,
          Array.from({ length: 40 }, (_, index) =>
            inventorySnapshot(`/project-${index}`, `command-${index}`),
          ),
        );
        yield* h.complete({ workspaceSnapshotsOnDemand: false }, { providers: [legacy] });
        expect(legacy.workspaceSnapshots).toHaveLength(40);
        expect(h.read()[0]?.workspaceSnapshots).toHaveLength(32);
        expect(h.read()[0]?.workspaceSnapshots?.[0]?.cwd).toBe("/project-8");
        const cwd = inventoryProvider(undefined, [inventorySnapshot("/project-0", "legacy-cwd")]);
        yield* h.complete(
          { instanceId: INVENTORY_PROVIDER, cwd: "/project-0" },
          { providers: [cwd] },
        );
        expect(h.read()[0]?.workspaceSnapshots).toHaveLength(32);
        expect(resolveProviderSlashCommandsForCwd(h.read()[0]!, "/project-0")).toEqual([
          { name: "legacy-cwd" },
        ]);
        yield* h.complete(
          { workspaceSnapshotsOnDemand: false },
          { providers: [inventoryProvider(undefined)] },
        );
        expect(h.read()[0]?.workspaceSnapshots).toEqual([]);
      }),
    ),
);
