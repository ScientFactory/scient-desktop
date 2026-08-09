import {
  ManagedClaudeRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedClaudeArtifact,
} from "@scientfactory/provider-runtime";
import type { ClaudeSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeResolution,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";

const DEFAULT_CLAUDE_BINARY = "claude";

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export interface ClaudeManagedRuntimeResolution extends ManagedProviderRuntimeResolution {}

export const makeClaudeManagedRuntimeResolution = Effect.fn("ClaudeManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: ClaudeSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<ClaudeManagedRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedClaudeArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;

    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_CLAUDE_BINARY,
      providerName: "Claude",
      providerSlug: "claude",
      runtime: new ManagedClaudeRuntime(input.baseDir),
      artifact,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      managedInstallationAllowed: input.managedInstallationAllowed,
      sourceLabel: "Official Anthropic Claude Code release",
      managedInstallationLimitation:
        "Scient can use a healthy Claude runtime here, but managed installation is only enabled in the local desktop app.",
    });
  },
);
