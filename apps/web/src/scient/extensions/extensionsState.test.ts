import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { ConnectorId, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { createExtensionsAtoms } from "./extensionsState";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const CONNECTOR = ConnectorId.make("con_linear0001");

const INVENTORY = {
  revision: 1,
  connectors: [],
  providerSupport: [],
  plugins: [],
  diagnostics: [],
};

/** An RPC client whose connector update waits until the test releases it. */
function makeHarness() {
  const events: string[] = [];
  const releaseUpdate = Promise.withResolvers<void>();
  const updateStarted = Promise.withResolvers<void>();
  const client = {
    [WS_METHODS.extensionsConnectorUpdate]: () =>
      Effect.sync(() => {
        events.push("update:start");
        updateStarted.resolve();
      }).pipe(
        Effect.andThen(Effect.promise(() => releaseUpdate.promise)),
        Effect.tap(() => Effect.sync(() => events.push("update:end"))),
        Effect.as(INVENTORY),
      ),
    [WS_METHODS.extensionsPluginInstall]: (input: { readonly path: string }) =>
      Effect.sync(() => events.push(`install:${input.path}`)).pipe(Effect.as(INVENTORY)),
    [WS_METHODS.extensionsConnectorStartSignIn]: () =>
      Effect.sync(() => events.push("sign-in")).pipe(
        Effect.as({
          authorizationUrl: "https://auth.example.com/authorize",
          expiresAt: "2026-10-21T00:10:00.000Z",
        }),
      ),
    [WS_METHODS.extensionsList]: () => Effect.succeed(INVENTORY),
  } as unknown as RpcSession["client"];
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const connected: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const registryLayer = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId: LOCAL,
          label: "Local",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
        state: yield* SubscriptionRef.make(connected),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      return EnvironmentRegistry.EnvironmentRegistry.of({
        run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    }),
  );
  const atoms = createExtensionsAtoms(Atom.runtime(registryLayer));
  return { atoms, events, releaseUpdate, updateStarted: updateStarted.promise };
}

describe("extensions mutation lane", () => {
  it("runs a different mutation of the same environment only after the pending one", async () => {
    const { atoms, events, releaseUpdate, updateStarted } = makeHarness();
    const registry = AtomRegistry.make();
    const update = atoms.updateConnector.run(registry, {
      environmentId: LOCAL,
      input: { connectorId: CONNECTOR, enabled: false },
    });
    await updateStarted;
    const install = atoms.installScientPlugin.run(registry, {
      environmentId: LOCAL,
      input: { path: "/bundles/local" },
    });
    // A command outside the lane, started after the install, completes while
    // the install still waits for the pending update.
    const signIn = await atoms.startConnectorSignIn.run(registry, {
      environmentId: LOCAL,
      input: { connectorId: CONNECTOR, callbackOrigin: "http://127.0.0.1:3773" },
    });
    expect(signIn).toMatchObject({ _tag: "Success" });
    expect(events).toEqual(["update:start", "sign-in"]);

    releaseUpdate.resolve();
    expect(await update).toMatchObject({ _tag: "Success" });
    expect(await install).toMatchObject({ _tag: "Success" });
    expect(events).toEqual(["update:start", "sign-in", "update:end", "install:/bundles/local"]);
    registry.dispose();
  });

  it("keeps other environments and non-mutating commands concurrent", async () => {
    const { atoms, events, releaseUpdate, updateStarted } = makeHarness();
    const registry = AtomRegistry.make();
    const update = atoms.updateConnector.run(registry, {
      environmentId: LOCAL,
      input: { connectorId: CONNECTOR, enabled: false },
    });
    await updateStarted;
    const remoteInstall = atoms.installScientPlugin.run(registry, {
      environmentId: REMOTE,
      input: { path: "/bundles/remote" },
    });
    const signIn = atoms.startConnectorSignIn.run(registry, {
      environmentId: LOCAL,
      input: { connectorId: CONNECTOR, callbackOrigin: "http://127.0.0.1:3773" },
    });
    expect(await remoteInstall).toMatchObject({ _tag: "Success" });
    expect(await signIn).toMatchObject({ _tag: "Success" });
    expect(events).toEqual(["update:start", "install:/bundles/remote", "sign-in"]);

    releaseUpdate.resolve();
    expect(await update).toMatchObject({ _tag: "Success" });
    registry.dispose();
  });
});
