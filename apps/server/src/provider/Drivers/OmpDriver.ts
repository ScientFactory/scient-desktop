import {
  OmpSettings,
  ProviderDriverKind,
  type ProviderConnectionSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { checkOmpProviderStatus, makePendingOmpProvider } from "../Layers/OmpProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { OMP_AGENT_DIR_ENV, OMP_PROFILE_ENV } from "../omp/OmpRpcProcess.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  ompMaintenance,
  shapeOmpExternalAdvisory,
  withOmpReleaseVersion,
} from "../omp/OmpMaintenance.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);

const manualRuntime = {
  source: "system",
  supportTier: "manual_or_advanced_only",
  target: "current-platform",
  actions: [],
  managedVersion: null,
  previousManagedVersion: null,
  operation: null,
  message:
    "Scient uses the Oh My Pi executable you install. It does not download, update, or sign in to Oh My Pi.",
} as const satisfies NonNullable<ProviderConnectionSummary["runtime"]>;

export type OmpDriverEnv =
  | BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
      const processEnv: NodeJS.ProcessEnv = { ...mergeProviderInstanceEnvironment(environment) };
      const home = effectiveConfig.homePath.trim();
      const profile = effectiveConfig.profile.trim();
      if (home.length > 0 && profile.length > 0) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "Choose either an Oh My Pi home or a named profile, not both.",
        });
      }
      if (home.length > 0) processEnv[OMP_AGENT_DIR_ENV] = expandHomePath(home);
      if (profile.length > 0) processEnv[OMP_PROFILE_ENV] = profile;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...stampIdentity(snapshot),
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          runtime: manualRuntime,
        },
      });
      const adapter = yield* makeOmpAdapter({
        binaryPath: effectiveConfig.binaryPath,
        providerInstanceId: instanceId,
        stateDir: serverConfig.stateDir,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnv,
        homePath: home || undefined,
        profile: profile || undefined,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const textGeneration = yield* makeOmpTextGeneration(effectiveConfig, processEnv).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(ompMaintenance, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      );
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOmpProvider(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkOmpProviderStatus(effectiveConfig, processEnv).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.map(stamp),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((capabilities) =>
              withOmpReleaseVersion(
                capabilities,
                settings.enableProviderUpdateChecks !== false && currentSnapshot.enabled,
              ),
            ),
            Effect.flatMap((capabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, capabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.map((enriched) => {
              const advisory = enriched.versionAdvisory;
              if (!advisory) return enriched;
              return {
                ...enriched,
                versionAdvisory: shapeOmpExternalAdvisory({
                  currentVersion: advisory.currentVersion,
                  latestVersion: advisory.latestVersion,
                  checkedAt: advisory.checkedAt,
                }),
              };
            }),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the Oh My Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          checkOmpProviderStatus(effectiveConfig, processEnv, undefined, cwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.map(stamp),
          ),
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
