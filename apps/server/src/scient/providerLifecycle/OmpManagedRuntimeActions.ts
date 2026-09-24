import {
  MANAGED_RUNTIME_POLICY,
  ManagedOmpRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedOmpArtifact,
} from "@scientfactory/provider-runtime";
import type { OmpSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_OMP_BINARY = "omp";

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export const makeOmpManagedRuntimeResolution = Effect.fn("OmpManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: OmpSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<ManagedProviderRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedOmpArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;
    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_OMP_BINARY,
      providerName: "Oh My Pi",
      providerSlug: "omp",
      runtime: new ManagedOmpRuntime(input.baseDir),
      bundledArtifact: artifact,
      contractRevision: MANAGED_RUNTIME_POLICY.omp.revision,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Oh My Pi release",
      managedInstallationLimitation:
        "Scient can use a healthy Oh My Pi runtime here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath: input.environment.HOME?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);
