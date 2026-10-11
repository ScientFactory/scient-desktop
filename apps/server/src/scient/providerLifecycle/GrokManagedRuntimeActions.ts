import {
  MANAGED_RUNTIME_POLICY,
  ManagedGrokRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedGrokArtifact,
} from "@scientfactory/provider-runtime";
import type { GrokSettings } from "@t3tools/provider-grok/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_GROK_BINARY = "grok";

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export interface GrokManagedRuntimeResolution extends ManagedProviderRuntimeResolution {}

export const makeGrokManagedRuntimeResolution = Effect.fn("GrokManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: GrokSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<GrokManagedRuntimeResolution, never> {
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedGrokArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;

    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_GROK_BINARY,
      providerName: "Grok",
      providerSlug: "grok",
      runtime: new ManagedGrokRuntime(input.baseDir),
      bundledArtifact: artifact,
      contractRevision: MANAGED_RUNTIME_POLICY.grok.revision,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official xAI Grok Build release",
      managedInstallationLimitation:
        "Scient can use a healthy Grok runtime here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath: input.environment.HOME?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);
