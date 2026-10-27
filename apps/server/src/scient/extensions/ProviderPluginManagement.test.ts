import { assert, describe, it } from "@effect/vitest";
import {
  type ExtensionsError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import { nextInventoryReadSequence } from "../../provider/ProviderNativeInventory.ts";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import type {
  ProviderMcpSignInAttempt,
  ProviderNativeInventory,
  ProviderPluginActionFailure,
  ProviderPluginActions,
} from "../../provider/ScientProviderInstanceSeams.ts";
import {
  makeProviderPluginManagement,
  MAX_PENDING_PROVIDER_MCP_SIGN_INS,
} from "./ProviderPluginManagement.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex");

const linear: ServerProviderPlugin = {
  id: "linear@curated",
  name: "linear",
  source: "remote",
  enabled: true,
  canUninstall: true,
};
const bundled: ServerProviderPlugin = {
  id: "bundled@system",
  name: "bundled",
  source: "local",
  enabled: true,
};
const serverNames = Array.from(
  { length: MAX_PENDING_PROVIDER_MCP_SIGN_INS + 1 },
  (_, index) => `server-${index}`,
);

const baseProvider: ServerProvider = {
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  version: "0.150.0",
  models: [],
  slashCommands: [],
  skills: [],
  plugins: [linear, bundled],
  mcpServers: [
    { name: "notion", status: "needs-auth", canStartSignIn: true },
    { name: "token", status: "needs-auth" },
    ...serverNames.map((name) => ({ name, status: "needs-auth" as const, canStartSignIn: true })),
  ],
};

interface Recorded {
  readonly instanceId: ProviderInstanceId;
  readonly inventory: ProviderNativeInventory;
  readonly reportedBy: ProviderPluginActions;
}

/** A complete listing, ordered like the provider's own reads. */
const listing = (plugins: ReadonlyArray<ServerProviderPlugin>) =>
  nextInventoryReadSequence.pipe(Effect.map((sequence) => ({ plugins, sequence })));

/** A generation's plugin seam; `retire` plays the instance being rebuilt or removed. */
const makeGeneration = Effect.fn("makeGeneration")(function* (
  overrides: Partial<Omit<ProviderPluginActions, "isRetired" | "whenRetired">> = {},
) {
  const retired = yield* Deferred.make<void>();
  const actions: ProviderPluginActions = {
    listPlugins: () => listing([linear, bundled]),
    readMcpServer: ({ serverName }) =>
      Effect.succeed(baseProvider.mcpServers?.find((server) => server.name === serverName)),
    uninstall: () => Effect.die("unexpected uninstall"),
    startMcpSignIn: () => Effect.die("unexpected sign-in"),
    ...overrides,
    isRetired: Deferred.isDone(retired),
    whenRetired: Deferred.await(retired),
  };
  return { actions, retire: Deferred.succeed(retired, undefined) };
});

const makeHarness = Effect.fn("ProviderPluginManagement.makeHarness")(function* (options: {
  readonly provider?: ServerProvider;
  readonly actions?: ProviderPluginActions | undefined;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly actionsByInstance?: ReadonlyMap<ProviderInstanceId, ProviderPluginActions>;
}) {
  const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
    options.providers ?? [options.provider ?? baseProvider],
  );
  const refreshes = yield* Ref.make(0);
  const recorded = yield* Ref.make<ReadonlyArray<Recorded>>([]);
  const serviceScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
  const management = makeProviderPluginManagement(
    {
      ...makeProviderRegistryMock(),
      getProviders: Ref.get(providersRef),
      refreshInstance: () =>
        Ref.update(refreshes, (count) => count + 1).pipe(Effect.andThen(Ref.get(providersRef))),
      getProviderPluginActionsForInstance: (instanceId) =>
        Effect.succeed(options.actionsByInstance?.get(instanceId) ?? options.actions),
      recordProviderNativeInventory: (input) => {
        const plugins = input.inventory.plugins;
        return Ref.update(recorded, (calls) => [...calls, input]).pipe(
          Effect.andThen(
            input.inventory.cwd === undefined && plugins
              ? Ref.updateAndGet(providersRef, (providers) =>
                  providers.map((provider) =>
                    provider.instanceId === input.instanceId ? { ...provider, plugins } : provider,
                  ),
                )
              : Ref.get(providersRef),
          ),
        );
      },
    },
    serviceScope,
  );
  return { management, refreshes, recorded, serviceScope };
});

const uninstallLinear = {
  instanceId: INSTANCE_ID,
  action: { type: "uninstall" as const, pluginId: linear.id },
};
const signIn = (serverName: string) => ({
  instanceId: INSTANCE_ID,
  action: { type: "mcp-sign-in" as const, serverName },
});

describe("ProviderPluginManagement uninstall", () => {
  it.effect("rejects an unknown instance or plugin before touching the provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { actions } = yield* makeGeneration({
          listPlugins: () => Effect.die("must not list"),
        });
        const { management, recorded } = yield* makeHarness({ actions });
        const unknownInstance = yield* management
          .act({ ...uninstallLinear, instanceId: ProviderInstanceId.make("gone") })
          .pipe(Effect.flip);
        assert.strictEqual(unknownInstance.reason, "not-found");
        const unknownPlugin = yield* management
          .act({ instanceId: INSTANCE_ID, action: { type: "uninstall", pluginId: "ghost@x" } })
          .pipe(Effect.flip);
        assert.strictEqual(unknownPlugin.reason, "not-found");
        // A workspace-scoped action is admitted against that workspace's inventory.
        const notInWorkspace = yield* management
          .act({ ...uninstallLinear, cwd: "/repo" })
          .pipe(Effect.flip);
        assert.strictEqual(notInWorkspace.reason, "not-found");
        assert.deepStrictEqual(yield* Ref.get(recorded), []);
      }),
    ),
  );

  it.effect("refuses read-only plugins, providers without the seam, and disabled providers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readOnlyNow = yield* makeGeneration({
          // The provider no longer offers uninstall for it, whatever the snapshot said.
          listPlugins: () => listing([{ ...linear, canUninstall: false }]),
        });
        const readOnly = yield* makeHarness({ actions: readOnlyNow.actions });
        const readOnlyError = yield* readOnly.management.act(uninstallLinear).pipe(Effect.flip);
        assert.strictEqual(readOnlyError.reason, "unsupported");
        assert.strictEqual(readOnlyError.message, "Codex does not let Scient uninstall 'linear'.");

        const noSeam = yield* makeHarness({ actions: undefined });
        assert.strictEqual(
          (yield* noSeam.management.act(uninstallLinear).pipe(Effect.flip)).reason,
          "unsupported",
        );

        const { actions } = yield* makeGeneration();
        const disabled = yield* makeHarness({
          provider: { ...baseProvider, enabled: false },
          actions,
        });
        assert.strictEqual(
          (yield* disabled.management.act(uninstallLinear).pipe(Effect.flip)).reason,
          "unsupported",
        );
      }),
    ),
  );

  it.effect(
    "validates, dispatches, and verifies through one generation, then records the listing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const installed = yield* Ref.make<ReadonlyArray<ServerProviderPlugin>>([linear, bundled]);
          const uninstalled: Array<{ pluginId: string; cwd?: string | undefined }> = [];
          const { actions } = yield* makeGeneration({
            listPlugins: () => Ref.get(installed).pipe(Effect.flatMap(listing)),
            uninstall: (input) =>
              Effect.sync(() => void uninstalled.push(input)).pipe(
                Effect.andThen(
                  Ref.update(installed, (plugins) =>
                    plugins.filter((p) => p.id !== input.pluginId),
                  ),
                ),
              ),
          });
          const { management, recorded } = yield* makeHarness({ actions });
          const result = yield* management.act(uninstallLinear);
          assert.deepStrictEqual(uninstalled, [{ pluginId: linear.id, cwd: undefined }]);
          const records = yield* Ref.get(recorded);
          assert.deepStrictEqual(
            records.map(({ instanceId, reportedBy, inventory }) => ({
              instanceId,
              reportedBy,
              plugins: inventory.plugins,
              cwd: inventory.cwd,
            })),
            [{ instanceId: INSTANCE_ID, reportedBy: actions, plugins: [bundled], cwd: undefined }],
          );
          // The verification listing's own read order goes with it.
          assert.isNumber(records[0]?.inventory.sequence);
          assert.deepStrictEqual(
            result.providers[0]?.plugins?.map((plugin) => plugin.id),
            [bundled.id],
          );
        }),
      ),
  );

  it.effect("records a workspace listing for a workspace-scoped plugin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const listedCwds: Array<string | undefined> = [];
        let removed = false;
        const { actions } = yield* makeGeneration({
          listPlugins: ({ cwd }) =>
            Effect.sync(() => {
              listedCwds.push(cwd);
              return removed ? [] : [linear];
            }).pipe(Effect.flatMap(listing)),
          uninstall: () => Effect.sync(() => void (removed = true)),
        });
        const { management, recorded } = yield* makeHarness({
          provider: {
            ...baseProvider,
            plugins: [],
            workspaceSnapshots: [
              {
                cwd: "/repo",
                checkedAt: "2026-10-21T00:00:00.000Z",
                slashCommands: [],
                skills: [],
                plugins: [linear],
              },
            ],
          },
          actions,
        });
        yield* management.act({ ...uninstallLinear, cwd: "/repo" });
        assert.deepStrictEqual(listedCwds, ["/repo", "/repo"]);
        assert.deepStrictEqual(
          (yield* Ref.get(recorded)).map(({ inventory: { cwd, plugins } }) => ({ cwd, plugins })),
          [{ cwd: "/repo", plugins: [] }],
        );
      }),
    ),
  );

  it.effect("reports the provider's refusal and a plugin a fresh listing still shows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rejecting = yield* makeGeneration({
          uninstall: () =>
            Effect.fail<ProviderPluginActionFailure>({ message: "plugin is managed by policy" }),
        });
        const rejected = yield* (yield* makeHarness({ actions: rejecting.actions })).management
          .act(uninstallLinear)
          .pipe(Effect.flip);
        assert.strictEqual(rejected.reason, "provider-rejected");
        assert.strictEqual(rejected.message, "plugin is managed by policy");

        const sticky = yield* makeGeneration({ uninstall: () => Effect.void });
        const stickyHarness = yield* makeHarness({ actions: sticky.actions });
        const survived = yield* stickyHarness.management.act(uninstallLinear).pipe(Effect.flip);
        assert.strictEqual(survived.reason, "provider-rejected");
        assert.deepStrictEqual(yield* Ref.get(stickyHarness.recorded), []);
      }),
    ),
  );

  it.effect("says the uninstall is unverified when the fresh listing is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let listings = 0;
        const { actions } = yield* makeGeneration({
          listPlugins: () =>
            listings++ === 0
              ? listing([linear, bundled])
              : Effect.fail<ProviderPluginActionFailure>({
                  message: "Codex could not load a plugin marketplace: /m (offline)",
                }),
          uninstall: () => Effect.void,
        });
        const { management, recorded } = yield* makeHarness({ actions });
        const error = yield* management.act(uninstallLinear).pipe(Effect.flip);
        assert.strictEqual(error.reason, "state-unavailable");
        assert.strictEqual(
          error.message,
          "The uninstall of 'linear' was sent to Codex, but Scient could not verify it.",
        );
        // The last good inventory is not replaced by a guess.
        assert.deepStrictEqual(yield* Ref.get(recorded), []);
      }),
    ),
  );

  it.effect("changes nothing when the provider could not list its plugins first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { actions } = yield* makeGeneration({
          listPlugins: () => Effect.fail<ProviderPluginActionFailure>({ message: "timed out" }),
        });
        const error = yield* (yield* makeHarness({ actions })).management
          .act(uninstallLinear)
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "state-unavailable");
      }),
    ),
  );

  it.effect("never dispatches through a generation retired during validation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let uninstalls = 0;
        const generation: { retire: Effect.Effect<boolean> } = { retire: Effect.succeed(false) };
        const { actions, retire } = yield* makeGeneration({
          // The instance is rebuilt while Scient reads its plugins.
          listPlugins: () => generation.retire.pipe(Effect.andThen(listing([linear]))),
          uninstall: () => Effect.sync(() => void uninstalls++),
        });
        generation.retire = retire;
        const { management, recorded } = yield* makeHarness({ actions });
        const error = yield* management.act(uninstallLinear).pipe(Effect.flip);
        assert.strictEqual(error.reason, "state-unavailable");
        assert.strictEqual(uninstalls, 0);
        assert.deepStrictEqual(yield* Ref.get(recorded), []);
      }),
    ),
  );

  it.effect("does not claim success when the generation retires during verification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const verificationStarted = yield* Deferred.make<void>();
        let listings = 0;
        const { actions, retire } = yield* makeGeneration({
          listPlugins: () =>
            listings++ === 0
              ? listing([linear])
              : Deferred.succeed(verificationStarted, undefined).pipe(Effect.andThen(Effect.never)),
          uninstall: () => Effect.void,
        });
        const { management, recorded } = yield* makeHarness({ actions });
        const attempt = yield* management.act(uninstallLinear).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(verificationStarted);
        yield* retire;
        const error: ExtensionsError = yield* Fiber.join(attempt);
        assert.strictEqual(error.reason, "state-unavailable");
        assert.deepStrictEqual(yield* Ref.get(recorded), []);
      }),
    ),
  );
});

/**
 * A sign-in seam that counts every provider process, both the one each
 * validation opens and the one each sign-in keeps, and lets tests hold each
 * phase.
 */
const makeSignInGeneration = Effect.fn("makeSignInGeneration")(function* (options?: {
  readonly holdValidation?: Effect.Effect<void>;
  readonly holdStart?: Effect.Effect<void>;
  readonly holdClose?: Effect.Effect<void>;
  readonly authorizationUrl?: string;
}) {
  const processes = yield* Ref.make({ opened: 0, closed: 0 });
  const validations = yield* Ref.make({ opened: 0, closed: 0 });
  const live = yield* Ref.make({ now: 0, peak: 0 });
  const completions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<void, ProviderPluginActionFailure>>
  >([]);
  const openProcess = (counter: typeof processes, holdClose: Effect.Effect<void>) =>
    Effect.acquireRelease(
      Ref.update(counter, (count) => ({ ...count, opened: count.opened + 1 })).pipe(
        Effect.andThen(
          Ref.update(live, ({ now, peak }) => ({ now: now + 1, peak: Math.max(peak, now + 1) })),
        ),
      ),
      () =>
        holdClose.pipe(
          Effect.andThen(Ref.update(counter, (count) => ({ ...count, closed: count.closed + 1 }))),
          Effect.andThen(Ref.update(live, ({ now, peak }) => ({ now: now - 1, peak }))),
        ),
    );
  const generation = yield* makeGeneration({
    readMcpServer: ({ serverName }) =>
      Effect.gen(function* () {
        yield* openProcess(validations, Effect.void);
        yield* options?.holdValidation ?? Effect.void;
        return baseProvider.mcpServers?.find((server) => server.name === serverName);
      }).pipe(Effect.scoped),
    startMcpSignIn: () =>
      Effect.gen(function* () {
        yield* openProcess(processes, options?.holdClose ?? Effect.void);
        yield* options?.holdStart ?? Effect.void;
        const completed = yield* Deferred.make<void, ProviderPluginActionFailure>();
        yield* Ref.update(completions, (all) => [...all, completed]);
        return {
          authorizationUrl: options?.authorizationUrl ?? "https://auth.example.com/authorize",
          waitForCompletion: Deferred.await(completed),
        } satisfies ProviderMcpSignInAttempt;
      }),
  });
  return { ...generation, processes, validations, live, completions };
});

const settle = Effect.fn("settle")(function* () {
  for (let attempt = 0; attempt < 200; attempt++) yield* Effect.yieldNow;
});

describe("ProviderPluginManagement MCP sign-in", () => {
  it.effect("returns the provider's page, keeps its process for the callback, then refreshes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const generation = yield* makeSignInGeneration();
        const { management, refreshes } = yield* makeHarness({ actions: generation.actions });
        const result = yield* management.act(signIn("notion"));
        assert.strictEqual(result.authorizationUrl, "https://auth.example.com/authorize");
        assert.deepStrictEqual(yield* Ref.get(generation.processes), { opened: 1, closed: 0 });
        assert.strictEqual(yield* Ref.get(refreshes), 0);

        const [completed] = yield* Ref.get(generation.completions);
        yield* Deferred.succeed(completed!, undefined);
        yield* settle();
        assert.deepStrictEqual(yield* Ref.get(generation.processes), { opened: 1, closed: 1 });
        assert.strictEqual(yield* Ref.get(refreshes), 1);
      }),
    ),
  );

  it.effect("admits at most the limit, counting attempts that are still starting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startGate = yield* Deferred.make<void>();
        const generation = yield* makeSignInGeneration({ holdStart: Deferred.await(startGate) });
        const { management } = yield* makeHarness({ actions: generation.actions });
        // Forked from this fiber, so every start runs concurrently and stays alive.
        const starts = yield* Effect.forEach(serverNames, (name) =>
          management.act(signIn(name)).pipe(Effect.exit, Effect.forkChild),
        );
        yield* settle();
        assert.strictEqual(
          (yield* Ref.get(generation.processes)).opened,
          MAX_PENDING_PROVIDER_MCP_SIGN_INS,
        );
        yield* Deferred.succeed(startGate, undefined);
        const exits = yield* Fiber.joinAll(starts);
        const refused = exits.filter(Exit.isFailure);
        assert.strictEqual(refused.length, 1);
        assert.strictEqual(
          (yield* Ref.get(generation.processes)).opened,
          MAX_PENDING_PROVIDER_MCP_SIGN_INS,
        );

        // Completing one frees its slot for the refused server.
        const [first] = yield* Ref.get(generation.completions);
        yield* Deferred.succeed(first!, undefined);
        yield* settle();
        const refusedName = serverNames[exits.findIndex(Exit.isFailure)]!;
        yield* management.act(signIn(refusedName));
        assert.strictEqual(
          (yield* Ref.get(generation.processes)).opened,
          MAX_PENDING_PROVIDER_MCP_SIGN_INS + 1,
        );
      }),
    ),
  );

  it.effect("frees the slot and the process when a start fails or is cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startGate = yield* Deferred.make<void>();
        const unusable = yield* makeSignInGeneration({ authorizationUrl: "javascript:alert(1)" });
        const failing = yield* makeHarness({ actions: unusable.actions });
        for (const name of serverNames) {
          const error = yield* failing.management.act(signIn(name)).pipe(Effect.flip);
          assert.strictEqual(error.reason, "provider-rejected");
        }
        // Every failed start closed its process and returned its slot.
        assert.deepStrictEqual(yield* Ref.get(unusable.processes), {
          opened: serverNames.length,
          closed: serverNames.length,
        });

        const slow = yield* makeSignInGeneration({ holdStart: Deferred.await(startGate) });
        const cancelling = yield* makeHarness({ actions: slow.actions });
        for (const name of serverNames) {
          const start = yield* cancelling.management.act(signIn(name)).pipe(Effect.forkChild);
          yield* settle();
          yield* Fiber.interrupt(start);
        }
        assert.deepStrictEqual(yield* Ref.get(slow.processes), {
          opened: serverNames.length,
          closed: serverNames.length,
        });
      }),
    ),
  );

  it.effect("stops the older process before a newer sign-in to the same server starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const generation = yield* makeSignInGeneration();
        const { management, refreshes } = yield* makeHarness({ actions: generation.actions });
        yield* management.act(signIn("notion"));
        yield* management.act(signIn("notion"));
        assert.deepStrictEqual(yield* Ref.get(generation.processes), { opened: 2, closed: 1 });
        yield* settle();
        // A replaced attempt is not a completed sign-in.
        assert.strictEqual(yield* Ref.get(refreshes), 0);
      }),
    ),
  );

  it.effect("cannot strand a process when the replacing request is interrupted mid-handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeGate = yield* Deferred.make<void>();
        let holdClose = true;
        const generation = yield* makeSignInGeneration({
          holdClose: Effect.suspend(() => (holdClose ? Deferred.await(closeGate) : Effect.void)),
        });
        const { management, serviceScope } = yield* makeHarness({ actions: generation.actions });
        yield* management.act(signIn("notion"));

        // The replacement waits while the older process shuts down slowly.
        const replacing = yield* management.act(signIn("notion")).pipe(Effect.forkChild);
        yield* settle();
        const interrupting = yield* Fiber.interrupt(replacing).pipe(Effect.forkChild);
        yield* settle();
        holdClose = false;
        yield* Deferred.succeed(closeGate, undefined);
        yield* Fiber.join(interrupting);
        yield* settle();
        const afterInterrupt = yield* Ref.get(generation.processes);
        assert.strictEqual(afterInterrupt.opened, afterInterrupt.closed);

        // The slot is reusable, and closing the service leaves no process behind.
        yield* management.act(signIn("notion"));
        yield* Scope.close(serviceScope, Exit.void);
        const afterShutdown = yield* Ref.get(generation.processes);
        assert.strictEqual(afterShutdown.opened, afterShutdown.closed);
      }),
    ),
  );

  it.effect("ends a pending sign-in when its instance generation is retired", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const generation = yield* makeSignInGeneration();
        const { management, refreshes } = yield* makeHarness({ actions: generation.actions });
        yield* management.act(signIn("notion"));
        yield* generation.retire;
        yield* settle();
        assert.deepStrictEqual(yield* Ref.get(generation.processes), { opened: 1, closed: 1 });
        assert.strictEqual(yield* Ref.get(refreshes), 0);
        // A retired generation starts nothing new.
        const error = yield* management.act(signIn("notion")).pipe(Effect.flip);
        assert.strictEqual(error.reason, "state-unavailable");
        assert.strictEqual((yield* Ref.get(generation.processes)).opened, 1);
      }),
    ),
  );

  it.effect("rejects servers the provider cannot sign in to, checked against a fresh read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const generation = yield* makeSignInGeneration();
        const { management } = yield* makeHarness({ actions: generation.actions });
        const bearer = yield* management.act(signIn("token")).pipe(Effect.flip);
        assert.strictEqual(bearer.reason, "unsupported");
        const unknown = yield* management.act(signIn("ghost")).pipe(Effect.flip);
        assert.strictEqual(unknown.reason, "not-found");

        const gone = yield* makeGeneration({ readMcpServer: () => Effect.succeed(undefined) });
        const goneError = yield* (yield* makeHarness({ actions: gone.actions })).management
          .act(signIn("notion"))
          .pipe(Effect.flip);
        assert.strictEqual(goneError.reason, "not-found");
        assert.strictEqual((yield* Ref.get(generation.processes)).opened, 0);
      }),
    ),
  );

  it.effect(
    "counts the validation process: more requests than the limit never run more processes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const validationGate = yield* Deferred.make<void>();
          const generation = yield* makeSignInGeneration({
            holdValidation: Deferred.await(validationGate),
          });
          const { management } = yield* makeHarness({ actions: generation.actions });
          const starts = yield* Effect.forEach(serverNames, (name) =>
            management.act(signIn(name)).pipe(Effect.exit, Effect.forkChild),
          );
          yield* settle();
          // Every admitted request holds its slot while its validation process runs.
          assert.strictEqual(
            (yield* Ref.get(generation.validations)).opened,
            MAX_PENDING_PROVIDER_MCP_SIGN_INS,
          );
          yield* Deferred.succeed(validationGate, undefined);
          const exits = yield* Fiber.joinAll(starts);
          assert.strictEqual(exits.filter(Exit.isFailure).length, 1);
          assert.isAtMost(
            (yield* Ref.get(generation.live)).peak,
            MAX_PENDING_PROVIDER_MCP_SIGN_INS,
          );
        }),
      ),
  );

  it.effect("starts a replacement only after its predecessor's process has exited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeGate = yield* Deferred.make<void>();
        let holdClose = false;
        const generation = yield* makeSignInGeneration({
          holdClose: Effect.suspend(() => (holdClose ? Deferred.await(closeGate) : Effect.void)),
        });
        const { management } = yield* makeHarness({ actions: generation.actions });
        // At capacity: seven other servers and the one being replaced.
        for (const name of serverNames.slice(0, MAX_PENDING_PROVIDER_MCP_SIGN_INS - 1)) {
          yield* management.act(signIn(name));
        }
        yield* management.act(signIn("notion"));
        holdClose = true;

        // Two replacements race while the first process shuts down slowly.
        const second = yield* management.act(signIn("notion")).pipe(Effect.forkChild);
        const third = yield* management.act(signIn("notion")).pipe(Effect.forkChild);
        yield* settle();
        assert.strictEqual(
          (yield* Ref.get(generation.processes)).opened,
          MAX_PENDING_PROVIDER_MCP_SIGN_INS,
        );
        holdClose = false;
        yield* Deferred.succeed(closeGate, undefined);
        yield* Fiber.join(second);
        yield* Fiber.join(third);
        yield* settle();
        const live = yield* Ref.get(generation.live);
        assert.isAtMost(live.peak, MAX_PENDING_PROVIDER_MCP_SIGN_INS);
        assert.strictEqual(live.now, MAX_PENDING_PROVIDER_MCP_SIGN_INS);
      }),
    ),
  );

  it.effect("keeps a finished attempt's slot until its process has exited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeGate = yield* Deferred.make<void>();
        let holdClose = false;
        const generation = yield* makeSignInGeneration({
          holdClose: Effect.suspend(() => (holdClose ? Deferred.await(closeGate) : Effect.void)),
        });
        const { management } = yield* makeHarness({ actions: generation.actions });
        const admitted = serverNames.slice(0, MAX_PENDING_PROVIDER_MCP_SIGN_INS);
        for (const name of admitted) yield* management.act(signIn(name));
        holdClose = true;
        const [first] = yield* Ref.get(generation.completions);
        yield* Deferred.succeed(first!, undefined);
        yield* settle();

        // Its process is still shutting down, so its slot is still taken.
        const nextServer = serverNames[MAX_PENDING_PROVIDER_MCP_SIGN_INS]!;
        const refused = yield* management.act(signIn(nextServer)).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "limit-reached");
        holdClose = false;
        yield* Deferred.succeed(closeGate, undefined);
        yield* settle();
        yield* management.act(signIn(nextServer));
        assert.isAtMost((yield* Ref.get(generation.live)).peak, MAX_PENDING_PROVIDER_MCP_SIGN_INS);
      }),
    ),
  );
});

describe("ProviderPluginManagement enablement", () => {
  it.effect("publishes only verified enablement and rejects an unchanged owner state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const plugin = { ...linear, canSetEnabled: true };
        let enabled = true;
        let accept = false;
        const { actions } = yield* makeGeneration({
          listPlugins: () => listing([{ ...plugin, enabled }]),
          setEnabled: (input) =>
            Effect.sync(() => {
              if (accept) enabled = input.enabled;
            }),
        });
        const harness = yield* makeHarness({ actions });
        const input = {
          instanceId: INSTANCE_ID,
          action: { type: "set-enabled" as const, pluginId: plugin.id, enabled: false },
        };
        const rejected = yield* harness.management.act(input).pipe(Effect.flip);
        assert.strictEqual(rejected.reason, "provider-rejected");
        assert.strictEqual((yield* Ref.get(harness.recorded)).length, 0);
        accept = true;
        const result = yield* harness.management.act(input);
        assert.strictEqual(result.providers[0]?.plugins?.[0]?.enabled, false);
      }),
    ),
  );
});

describe("ProviderPluginManagement install", () => {
  it.effect("publishes only an installation that a fresh owner read verifies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const installed = yield* Ref.make(false);
        const accept = yield* Ref.make(false);
        const reject = yield* Ref.make(false);
        let mutations = 0;
        const { actions } = yield* makeGeneration({
          store: {
            search: () => Effect.succeed({ entries: [], total: 0 }),
            entry: () =>
              Ref.get(installed).pipe(
                Effect.map((installed) => ({
                  id: "review@official",
                  name: "review",
                  marketplace: "official",
                  displayName: "Review",
                  description: "",
                  kind: "shared" as const,
                  installed,
                  includes: [],
                  apps: [],
                })),
              ),
            install: () =>
              Effect.gen(function* () {
                if (yield* Ref.get(reject))
                  return yield* Effect.fail({
                    message: "The plugin archive could not be downloaded.",
                  });
                mutations++;
                yield* Ref.set(installed, yield* Ref.get(accept));
              }),
          },
          listPlugins: () =>
            Ref.get(installed).pipe(Effect.flatMap((value) => listing(value ? [linear] : []))),
        });
        const { management, recorded } = yield* makeHarness({ actions });
        const input = {
          instanceId: INSTANCE_ID,
          action: { type: "install" as const, entryId: "review@official" },
        };
        const rejected = yield* management.act(input).pipe(Effect.flip);
        assert.strictEqual(rejected.reason, "provider-rejected");
        assert.deepStrictEqual(yield* Ref.get(recorded), []);
        yield* Ref.set(accept, true);
        yield* management.act(input);
        assert.strictEqual(mutations, 2);
        assert.strictEqual((yield* Ref.get(recorded)).length, 1);
        yield* Ref.set(reject, true);
        assert.strictEqual(
          (yield* management.act(input).pipe(Effect.flip)).message,
          "The plugin archive could not be downloaded.",
        );
      }),
    ),
  );
  it.effect("refuses policy-disabled plugins before sending an installation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { actions } = yield* makeGeneration({
          store: {
            search: () => Effect.succeed({ entries: [], total: 0 }),
            entry: () =>
              Effect.succeed({
                id: "blocked",
                name: "blocked",
                marketplace: "store",
                displayName: "Blocked",
                description: "",
                kind: "shared",
                installed: false,
                includes: [],
                apps: [],
                disabledReason: "Disabled by your administrator",
              }),
            install: () => Effect.die("must not install"),
          },
        });
        const { management } = yield* makeHarness({ actions });
        assert.strictEqual(
          (yield* management
            .act({ instanceId: INSTANCE_ID, action: { type: "install", entryId: "blocked" } })
            .pipe(Effect.flip)).reason,
          "unsupported",
        );
      }),
    ),
  );
});

it.effect("installs an agent-configured shared plugin through the preferred Claude instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const claudeId = ProviderInstanceId.make("claude");
      const scientId = ProviderInstanceId.make("scient");
      const installed = yield* Ref.make(false);
      const operations: string[] = [];
      const entry = {
        id: "review@lab",
        name: "review",
        marketplace: "lab",
        displayName: "Review",
        description: "",
        kind: "shared" as const,
        installed: false,
        includes: [],
        apps: [],
      };
      const claude = yield* makeGeneration({
        store: {
          search: () => Effect.succeed({ entries: [], total: 0 }),
          entry: () =>
            Ref.get(installed).pipe(Effect.map((installed) => ({ ...entry, installed }))),
          ensureMarketplace: ({ name, source }) =>
            Effect.sync(() => {
              operations.push(`ensure:${name}:${source}`);
            }),
          install: (id) =>
            Effect.sync(() => {
              operations.push(`install:${id}`);
            }).pipe(Effect.andThen(Ref.set(installed, true))),
        },
        listPlugins: () => listing([{ ...linear, id: "claude:review", name: "review@lab" }]),
      });
      const scient = yield* makeGeneration({
        store: {
          search: () => Effect.succeed({ entries: [entry], total: 1 }),
          entry: () => Effect.succeed(entry),
          marketplaceSource: () => Effect.succeed("org/lab"),
          install: () => Effect.die("must install through Claude"),
        },
      });
      const { management, recorded } = yield* makeHarness({
        providers: [
          { ...baseProvider, instanceId: claudeId, driver: ProviderDriverKind.make("claudeAgent") },
          { ...baseProvider, instanceId: scientId, driver: ProviderDriverKind.make("scient") },
        ],
        actionsByInstance: new Map([
          [claudeId, claude.actions],
          [scientId, scient.actions],
        ]),
      });
      yield* management.act({
        instanceId: claudeId,
        action: { type: "install", sourceInstanceId: scientId, entryId: entry.id },
      });
      assert.deepStrictEqual(operations, ["ensure:lab:org/lab", "install:review@lab"]);
      assert.strictEqual((yield* Ref.get(recorded))[0]?.instanceId, claudeId);
    }),
  ),
);
