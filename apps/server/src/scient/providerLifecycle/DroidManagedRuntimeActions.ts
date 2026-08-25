import {
  ManagedDroidRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedDroidArtifact,
} from "@scientfactory/provider-runtime";
import type { DroidSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_DROID_BINARY = "droid";

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export interface DroidManagedRuntimeResolution extends ManagedProviderRuntimeResolution {}

export const makeDroidManagedRuntimeResolution = Effect.fn("DroidManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: DroidSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<DroidManagedRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedDroidArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;

    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_DROID_BINARY,
      providerName: "Droid",
      providerSlug: "droid",
      runtime: new ManagedDroidRuntime(input.baseDir),
      artifact,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Factory Droid release",
      managedInstallationLimitation:
        "Scient can use a healthy Droid runtime here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath: input.environment.HOME?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);
