import {
  MANAGED_RUNTIME_POLICY,
  ManagedMuseRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveMuseArtifactPolicy,
} from "@scientfactory/provider-runtime";
import type { MuseSettings } from "@t3tools/provider-muse/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeManagedProviderRuntimeResolution } from "./ManagedProviderRuntimeActions.ts";
import { qualifyMuseManagedRuntime } from "./MuseManagedRuntimeQualification.ts";

/** Muse uses the shared private-runtime transaction and keeps native credentials outside it. */
export const makeMuseManagedRuntimeResolution = Effect.fn("MuseManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: MuseSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }) {
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const target = yield* Effect.try(() => detectManagedRuntimeTarget({ platform, arch })).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: "muse",
      providerName: "Muse Code",
      providerSlug: "muse",
      runtime: new ManagedMuseRuntime(input.baseDir),
      bundledArtifact: undefined,
      artifactPolicy: target ? resolveMuseArtifactPolicy(target) : undefined,
      contractRevision: MANAGED_RUNTIME_POLICY.muse.revision,
      targetLabel: target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`,
      environment: input.environment,
      spawner: input.spawner,
      qualify: ({ executablePath, signal }) =>
        qualifyMuseManagedRuntime({ executablePath, signal, environment: input.environment }),
      configuredRuntimeProbeAllowed: input.settings.enabled,
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Meta Muse Code stable release",
      managedInstallationLimitation: "Managed Muse installation requires a local desktop host.",
      diagnosticsHomePath: input.environment.HOME ?? input.environment.USERPROFILE ?? null,
      diagnosticsBackend: platform === "win32" ? "Native Windows" : "Native",
    });
  },
);
