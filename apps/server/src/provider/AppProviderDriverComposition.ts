import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { GrokSettings } from "@t3tools/provider-grok/settings";
import {
  makeAcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import {
  makeGrokDriver,
  type GrokDriverEnv,
  type GrokRuntimeResolution,
  type GrokRuntimeResolverInput,
} from "@t3tools/provider-grok/server";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  scientAcpApplicationBridge,
  scientAcpProviderBridge,
} from "../orchestration-v2/Adapters/ScientAcpApplicationBridge.ts";
import { setGrokSkillEnabled } from "./Drivers/ScientNativeSkills.ts";
import { makeNativeSessionShutdown } from "./NativeSessionShutdown.ts";
import { makeAcpRegistryManagedRuntimeActions } from "../scient/providerLifecycle/AcpRegistryManagedRuntimeActions.ts";
import {
  makeGrokConnectionActions,
  withGrokSessionShutdown,
} from "../scient/providerLifecycle/GrokConnectionActions.ts";
import { makeGrokManagedRuntimeResolution } from "../scient/providerLifecycle/GrokManagedRuntimeActions.ts";
import type {
  ProviderConnectionActions,
  ProviderManagedRuntimeActions,
  ProviderSkillActions,
} from "./ScientProviderInstanceSeams.ts";
import type { ScientProviderDriver } from "./ScientProviderInstance.ts";

export type GrokCompositionRequirements = GrokDriverEnv | ServerConfig | Scope.Scope;

type GrokCompositionExtension = {
  readonly connectionActions: ProviderConnectionActions;
  readonly managedRuntimeActions: ProviderManagedRuntimeActions;
  readonly skillActions: ProviderSkillActions;
};

const GROK_DRIVER = ProviderDriverKind.make("grok");

const resolveGrokRuntime = (
  input: GrokRuntimeResolverInput,
): Effect.Effect<
  GrokRuntimeResolution<GrokCompositionRequirements, GrokCompositionExtension>,
  ProviderDriverError,
  GrokCompositionRequirements
> =>
  Effect.gen(function* () {
    const host = yield* ProviderHost;
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      input.environment,
      input.hostEnvironment,
    );
    const managedRuntime = yield* makeGrokManagedRuntimeResolution({
      settings: input.config,
      baseDir: host.paths.baseDir,
      environment: processEnvironment,
      spawner,
      managedInstallationAllowed: serverConfig.mode === "desktop",
    });
    const effectiveConfig = {
      ...input.config,
      enabled: input.enabled,
      binaryPath: managedRuntime.effectiveBinaryPath,
    } satisfies GrokSettings;
    const managedOnlyMaintenance = managedRuntime.usesManagedPath
      ? {
          resolve: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: GROK_DRIVER,
                packageName: null,
              }),
            ),
        }
      : undefined;
    const skillActions: ProviderSkillActions = {
      setEnabled: (skill) =>
        setGrokSkillEnabled({
          environment: processEnvironment,
          cwd: host.paths.cwd,
          name: skill.name,
          enabled: skill.enabled,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => ({ message: cause.detail, cause })),
        ),
    };

    return {
      effectiveConfig,
      effectiveEnvironment: processEnvironment,
      ...(managedOnlyMaintenance === undefined
        ? {}
        : { maintenanceResolver: managedOnlyMaintenance }),
      decorateSnapshot: (snapshot: ServerProvider) => ({
        ...snapshot,
        connection: {
          methods: ["grok_account", "grok_device_code"],
          canDisconnect:
            snapshot.auth.status === "authenticated" && snapshot.auth.type === "grok_account",
          operation: snapshot.connection?.operation ?? null,
          runtime: managedRuntime.summary,
        },
      }),
      composeInstance: (instance) =>
        Effect.gen(function* () {
          const nativeSessions = yield* makeNativeSessionShutdown(instance.orchestrationAdapter);
          const actions = yield* makeGrokConnectionActions(
            effectiveConfig,
            processEnvironment,
            spawner,
          );
          return {
            ...instance,
            orchestrationAdapter: nativeSessions.adapter,
            connectionActions: withGrokSessionShutdown(actions, nativeSessions.closeSessions),
            managedRuntimeActions: managedRuntime.actions,
            skillActions,
          };
        }),
    };
  });

/** The Grok implementation registered in the server, with Scient lifecycle authority composed in. */
export const GrokDriver = makeGrokDriver<GrokCompositionRequirements, GrokCompositionExtension>({
  application: scientAcpApplicationBridge,
  resolveRuntime: resolveGrokRuntime,
});

export type AcpRegistryCompositionEnv = AcpRegistryDriverEnv | ServerSettingsService;

const acpRegistryPackageDriver = makeAcpRegistryDriver({
  application: scientAcpProviderBridge,
  productName: "Scient",
});

/** Keep installation ownership in Scient while the package owns ACP Registry protocol behavior. */
export const AcpRegistryDriver = {
  ...acpRegistryPackageDriver,
  create: (input) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost;
      const hostEnvironment = yield* HostProcess.Environment;
      const processEnvironment = yield* mergeProviderInstanceEnvironment(
        input.environment,
        hostEnvironment,
      );
      const settings = { ...input.config, enabled: input.enabled } satisfies AcpRegistrySettings;
      const managedRuntimeActions = yield* makeAcpRegistryManagedRuntimeActions({
        instanceId: input.instanceId,
        settings,
        environment: processEnvironment,
        instanceEnvironment: input.environment,
        cwd: host.paths.cwd,
      });
      const instance = yield* acpRegistryPackageDriver.create(input);
      return { ...instance, managedRuntimeActions };
    }),
} satisfies ScientProviderDriver<AcpRegistrySettings, AcpRegistryCompositionEnv>;
