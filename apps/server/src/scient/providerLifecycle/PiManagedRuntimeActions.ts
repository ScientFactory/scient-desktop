import {
  ManagedPiRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedPiArtifact,
} from "@scientfactory/provider-runtime";
import type { PiSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_PI_BINARY = "pi";
export const PI_MANAGED_RUNTIME_CONTRACT_REVISION = 1;

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export interface PiManagedRuntimeResolution extends ManagedProviderRuntimeResolution {}

export const makePiManagedRuntimeResolution = Effect.fn("PiManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: PiSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<PiManagedRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedPiArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;

    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_PI_BINARY,
      providerName: "Pi",
      providerSlug: "pi",
      runtime: new ManagedPiRuntime(input.baseDir),
      bundledArtifact: artifact,
      contractRevision: PI_MANAGED_RUNTIME_CONTRACT_REVISION,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Pi release",
      managedInstallationLimitation:
        "Scient can use a healthy Pi runtime here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath: input.environment.HOME?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);
