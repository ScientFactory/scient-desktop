import {
  MANAGED_RUNTIME_POLICY,
  ManagedCursorRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedCursorArtifact,
} from "@scientfactory/provider-runtime";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { cursorRuntimeEnvironment } from "../../provider/CursorCli.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderMaintenanceCapabilitiesResolver } from "@t3tools/provider-core/server/maintenanceResolver";
import { assistedCursorConnectionMethods } from "./CursorConnectionActions.ts";
import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_CURSOR_BINARY = "cursor-agent";
const DRIVER_KIND = ProviderDriverKind.make("cursor");

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export interface CursorManagedRuntimeResolution extends ManagedProviderRuntimeResolution {}

export const makeCursorManagedRuntimeResolution = Effect.fn("CursorManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: Pick<CursorSettings, "binaryPath">;
    readonly enabled: boolean;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<CursorManagedRuntimeResolution, never> {
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedCursorArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;

    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath?.trim() || DEFAULT_CURSOR_BINARY,
      defaultBinary: DEFAULT_CURSOR_BINARY,
      providerName: "Cursor CLI",
      providerSlug: "cursor",
      runtime: new ManagedCursorRuntime(input.baseDir),
      bundledArtifact: artifact,
      contractRevision: MANAGED_RUNTIME_POLICY.cursor.revision,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      configuredRuntimeProbeAllowed: input.enabled,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Cursor CLI release",
      managedInstallationLimitation:
        "Scient can use a healthy Cursor CLI here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath:
        input.environment.HOME?.trim() || input.environment.USERPROFILE?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);

// cursor-agent updates itself, so the resolved executable is its own updater.
// No executable means nothing to update, not "whatever is on PATH".
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "cursor-agent",
            platform: context.platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
    ),
};

/**
 * Scient's per-instance Cursor runtime: the managed or configured
 * `cursor-agent` executable and its environment, the assisted sign-in
 * methods, and the maintenance controls of an explicit CLI target.
 */
export const makeCursorInstanceRuntime = Effect.fnUntraced(function* (input: {
  readonly config: CursorSettings;
  readonly enabled: boolean;
  readonly baseDir: string;
  readonly managedInstallationAllowed: boolean;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const { config, enabled, processEnv, spawner } = input;
  const managedRuntime = yield* makeCursorManagedRuntimeResolution({
    settings: config,
    enabled,
    baseDir: input.baseDir,
    environment: processEnv,
    spawner,
    managedInstallationAllowed: input.managedInstallationAllowed,
  });
  const effectiveConfig = {
    ...config,
    enabled,
    binaryPath: managedRuntime.effectiveBinaryPath,
  } satisfies CursorSettings;
  const effectiveProcessEnv = cursorRuntimeEnvironment(processEnv, managedRuntime.usesManagedPath);
  const connectionMethods = assistedCursorConnectionMethods(processEnv);
  // The bundled SDK has no CLI update target. Explicit CLI targets retain
  // their maintenance controls; managed installs are replaced by Scient.
  const maintenanceResolver: ProviderMaintenanceCapabilitiesResolver =
    !config.binaryPath?.trim() || managedRuntime.usesManagedPath
      ? {
          resolve: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER_KIND,
                packageName: null,
              }),
            ),
        }
      : UPDATE;
  return {
    managedRuntime,
    effectiveConfig,
    effectiveProcessEnv,
    connectionMethods,
    maintenanceResolver,
  };
});
