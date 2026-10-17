import { makeMuseDriver, type MuseDriverEnv } from "@t3tools/provider-muse/server";
import { ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServerConfig } from "../config.ts";
import {
  canAuthenticateMuse,
  guardMuseTextGeneration,
  makeMuseAuth,
  usesMuseApiKey,
} from "../scient/providerLifecycle/MuseAuth.ts";
import { makeMuseManagedRuntimeResolution } from "../scient/providerLifecycle/MuseManagedRuntimeActions.ts";
import { ProviderLifecycleCoordinator } from "../scient/providerLifecycle/ProviderLifecycleCoordinator.ts";
import { makeNativeSessionShutdown } from "./NativeSessionShutdown.ts";
import type { ScientProviderInstance } from "./ScientProviderInstance.ts";
import { buildScientRuntimeInstructions } from "./ScientRuntimeInstructions.ts";

export type MuseCompositionEnv =
  | MuseDriverEnv
  | ServerConfig
  | ProviderLifecycleCoordinator
  | Crypto.Crypto;

/** Scient owns lifecycle policy; the original package remains the sole MSP implementation. */
export const MuseDriver = makeMuseDriver<
  MuseCompositionEnv,
  Pick<ScientProviderInstance, "managedRuntimeActions">
>({
  runtimeInstructions: buildScientRuntimeInstructions,
  resolveRuntime: Effect.fnUntraced(function* (input) {
    const host = yield* ProviderHost;
    const config = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const managed = yield* makeMuseManagedRuntimeResolution({
      settings: {
        ...input.config,
        enabled: input.enabled,
        binaryPath: expandHomePath(input.config.binaryPath, yield* HostProcess.HomeDirectory),
      },
      baseDir: host.paths.baseDir,
      environment: input.processEnvironment,
      spawner,
      managedInstallationAllowed: config.mode === "desktop",
    });
    const binaryPath = managed.effectiveBinaryPath;
    const usesKey = usesMuseApiKey(input.processEnvironment, yield* HostProcess.Platform);
    return {
      binaryPath,
      decorateSnapshot: (snapshot) => ({
        ...snapshot,
        setup: {
          ...snapshot.setup,
          canAuthenticate: canAuthenticateMuse(snapshot, usesKey),
          canInstall: false,
        },
        auth: { ...snapshot.auth, canLogout: canAuthenticateMuse(snapshot, usesKey) },
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          runtime: managed.summary,
        },
      }),
      composeInstance: Effect.fnUntraced(function* (instance) {
        const nativeSessions = yield* makeNativeSessionShutdown(instance.orchestrationAdapter);
        const auth = yield* makeMuseAuth({
          instanceId: input.instanceId,
          binaryPath,
          environment: input.processEnvironment,
          snapshot: instance.snapshot,
          beforeChange: nativeSessions.closeSessions.pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "stopSessions",
                  detail: "Muse native sessions could not finish closing.",
                }),
            ),
          ),
          cwd: host.paths.providerStatusCacheDir,
          onChanged: instance.snapshot.refresh.pipe(Effect.asVoid),
        }).pipe(
          Effect.mapError(
            () =>
              new ProviderDriverError({
                driver: ProviderDriverKind.make("muse"),
                instanceId: input.instanceId,
                detail: "Could not prepare Muse account assistance.",
              }),
          ),
        );
        // Advertised methods follow runtime eligibility.
        yield* instance.snapshot.streamChanges.pipe(
          Stream.map((snapshot) => canAuthenticateMuse(snapshot, usesKey)),
          Stream.changes,
          Stream.runForEach(() => auth.controller.refreshMethods ?? Effect.void),
          Effect.forkScoped,
        );
        return {
          ...instance,
          auth: auth.controller,
          orchestrationAdapter: nativeSessions.adapter,
          textGeneration: guardMuseTextGeneration(auth.controller, instance.textGeneration),
          managedRuntimeActions: managed.actions,
        };
      }),
    };
  }),
});
