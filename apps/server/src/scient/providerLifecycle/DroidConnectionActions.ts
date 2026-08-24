/**
 * Factory Droid account lifecycle over Droid's standard ACP transport.
 *
 * Droid owns browser launch, device pairing, credentials, and revocation.
 * Scient initializes the ACP peer, invokes only capabilities the exact
 * running binary advertises, and owns the child/fiber through the connection
 * attempt's scope. No terminal output or TUI wording is parsed here.
 */
import type { DroidSettings, ProviderConnectionMethod } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  ProviderConnectionActions,
  ProviderConnectionActionFailure,
} from "../../provider/ProviderDriver.ts";
import {
  buildDroidAcpSpawnInput,
  droidAccountCapabilitiesFromInitializeResult,
  DROID_AUTH_METHOD_DEVICE_PAIRING,
} from "../../provider/acp/DroidAcpSupport.ts";
import {
  ProviderConnectionActionError,
  withProviderSessionShutdown,
} from "./ProviderConnectionActions.ts";

const ACP_START_TIMEOUT = "30 seconds";

const connectionError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export function droidProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    // Managed binaries must not mutate themselves. The variable is harmless
    // for external binaries because it affects only this supervised process.
    FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
  };
}

const initializeRequest = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: "scient-droid-account", version: "0.0.0" },
} satisfies EffectAcpSchema.InitializeRequest;

interface OpenDroidAcp {
  readonly client: EffectAcpClient.AcpClient["Service"];
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
}

export interface DroidAccountAcpSession {
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly authenticate: Effect.Effect<void, ProviderConnectionActionFailure>;
  readonly logout: Effect.Effect<void, ProviderConnectionActionFailure>;
}

const openDroidAcp = Effect.fn("DroidConnectionActions.openAcp")(function* (input: {
  readonly settings: DroidSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): Effect.fn.Return<OpenDroidAcp, ProviderConnectionActionFailure, Scope.Scope> {
  const spawn = buildDroidAcpSpawnInput(input.settings, process.cwd(), input.environment);
  const resolved = yield* resolveSpawnCommand(spawn.command, spawn.args, {
    env: input.environment,
    extendEnv: true,
  }).pipe(
    Effect.mapError((cause) => connectionError("Scient could not prepare Droid sign in.", cause)),
  );
  const child = yield* input.spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
        env: input.environment,
        extendEnv: true,
        shell: resolved.shell,
      }),
    )
    .pipe(
      Effect.mapError((cause) => connectionError("Scient could not start Droid sign in.", cause)),
    );
  const context = yield* Layer.build(EffectAcpClient.layerChildProcess(child));
  const client = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(context));
  const initializeResult = yield* client.agent.initialize(initializeRequest).pipe(
    Effect.timeout(ACP_START_TIMEOUT),
    Effect.mapError((cause) =>
      connectionError("Droid did not initialize its secure account connection.", cause),
    ),
  );
  return { client, initializeResult };
});

export function supportsDroidAcpLogout(result: EffectAcpSchema.InitializeResponse): boolean {
  return droidAccountCapabilitiesFromInitializeResult(result).logout;
}

export function makeDroidConnectionActions(input: {
  readonly settings: DroidSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): ProviderConnectionActions {
  const open = openDroidAcp({
    settings: input.settings,
    environment: input.environment,
    spawner: input.spawner,
  }).pipe(
    Effect.map(({ client, initializeResult }) => ({
      initializeResult,
      authenticate: client.agent.authenticate({ methodId: DROID_AUTH_METHOD_DEVICE_PAIRING }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          connectionError("Droid could not complete Factory sign in.", cause),
        ),
      ),
      logout: client.agent
        .logout({})
        .pipe(Effect.mapError((cause) => connectionError("Droid could not sign out.", cause))),
    })),
  );

  return makeDroidConnectionActionsFromOpen({ open });
}

export function makeDroidConnectionActionsFromOpen(input: {
  readonly open: Effect.Effect<
    DroidAccountAcpSession,
    ProviderConnectionActionFailure,
    Scope.Scope
  >;
}): ProviderConnectionActions {
  return {
    methods: ["droid_device_pairing"],
    start: (method: ProviderConnectionMethod) =>
      Effect.gen(function* () {
        if (method !== "droid_device_pairing") {
          return yield* connectionError("Droid does not support this sign-in method.");
        }
        const scope = yield* Scope.Scope;
        const session = yield* input.open;
        const { initializeResult } = session;
        if (!droidAccountCapabilitiesFromInitializeResult(initializeResult).devicePairing) {
          return yield* connectionError(
            "This Droid version does not advertise Factory device pairing.",
          );
        }

        const fiber = yield* Effect.forkIn(session.authenticate, scope);
        return {
          // Droid owns opening its dynamic Factory URL. ACP does not expose
          // that URL to Scient, so the UI must not invent a fallback link.
          initialStatus: "waiting_for_browser",
          waitForCompletion: Fiber.join(fiber),
          cancel: Fiber.interrupt(fiber).pipe(Effect.asVoid),
        };
      }),
    disconnect: Effect.gen(function* () {
      const session = yield* input.open;
      const { initializeResult } = session;
      if (!supportsDroidAcpLogout(initializeResult)) {
        return yield* connectionError("This Droid version no longer advertises assisted sign out.");
      }
      yield* session.logout;
    }),
  };
}

export function withDroidSessionShutdown<E>(
  actions: ProviderConnectionActions,
  stopAll: Effect.Effect<void, E>,
): ProviderConnectionActions {
  return withProviderSessionShutdown(actions, stopAll, (cause) =>
    connectionError("Scient could not stop active Droid sessions before sign out.", cause),
  );
}
