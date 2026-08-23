import {
  ManagedAntigravityRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedAntigravityArtifact,
} from "@scientfactory/provider-runtime";
import type { AntigravitySettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_ANTIGRAVITY_BINARY = "agy";

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export interface AntigravityManagedRuntimeResolution extends ManagedProviderRuntimeResolution {}

export const makeAntigravityManagedRuntimeResolution = Effect.fn(
  "AntigravityManagedRuntime.makeResolution",
)(function* (input: {
  readonly settings: AntigravitySettings;
  readonly baseDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly managedInstallationAllowed: boolean;
}): Effect.fn.Return<AntigravityManagedRuntimeResolution, never> {
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const target = detectTargetSafely({ platform, arch });
  const artifact = target ? resolveReviewedAntigravityArtifact(target) : undefined;
  const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;

  return yield* makeManagedProviderRuntimeResolution({
    configuredBinaryPath: input.settings.binaryPath,
    defaultBinary: DEFAULT_ANTIGRAVITY_BINARY,
    providerName: "Antigravity",
    providerSlug: "antigravity",
    runtime: new ManagedAntigravityRuntime(input.baseDir),
    artifact,
    targetLabel,
    environment: input.environment,
    spawner: input.spawner,
    managedInstallationAllowed: input.managedInstallationAllowed,
    sourceLabel: "Official Google Antigravity CLI release",
    managedInstallationLimitation:
      "Scient can use a healthy Antigravity runtime here, but managed installation is only enabled in the local desktop app.",
    diagnosticsHomePath: input.environment.HOME?.trim() || null,
    diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
  });
});
