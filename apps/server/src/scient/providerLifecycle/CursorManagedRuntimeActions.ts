import {
  ManagedCursorRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedCursorArtifact,
} from "@scientfactory/provider-runtime";
import type { CursorSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_CURSOR_BINARY = "cursor-agent";

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
    readonly settings: CursorSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<CursorManagedRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedCursorArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;

    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_CURSOR_BINARY,
      providerName: "Cursor",
      providerSlug: "cursor",
      runtime: new ManagedCursorRuntime(input.baseDir),
      artifact,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      configuredRuntimeProbeAllowed: input.settings.enabled,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Cursor Agent release",
      managedInstallationLimitation:
        "Scient can use a healthy Cursor runtime here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath:
        input.environment.HOME?.trim() || input.environment.USERPROFILE?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);
