import {
  ManagedProviderRuntimeError,
  type ManagedProviderRuntime,
  type ManagedProviderRuntimeProgress,
  ManagedRuntimeFileError,
  type ManagedRuntimeArtifact,
} from "@scientfactory/provider-runtime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  ProviderManagedRuntimeAction,
  ProviderRuntimeDiagnostics,
  ProviderRuntimeSummary,
} from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type {
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "../../provider/ProviderDriver.ts";
import { spawnAndCollect } from "../../provider/providerSnapshot.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const runtimeError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export function managedRuntimeInstallationFailureMessage(
  providerName: string,
  cause: unknown,
): string {
  const summary = `Scient could not install the private ${providerName} runtime.`;
  return cause instanceof ManagedRuntimeFileError || cause instanceof ManagedProviderRuntimeError
    ? `${summary} ${cause.message}`
    : summary;
}

const hasHealthyConfiguredRuntime = Effect.fn(
  "ManagedProviderRuntimeActions.hasHealthyConfiguredRuntime",
)(function* (
  binary: string,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const resolved = yield* resolveSpawnCommand(binary, ["--version"], {
    env: environment,
    extendEnv: true,
  });
  const result = yield* spawnAndCollect(
    binary,
    ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      extendEnv: true,
      shell: resolved.shell,
    }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeoutOption("5 seconds"),
    Effect.result,
  );
  return (
    result._tag === "Success" && Option.isSome(result.success) && result.success.value.code === 0
  );
});

export function resolveManagedRuntimeSource(input: {
  readonly hasCustomRuntime: boolean;
  readonly configuredRuntimeHealthy: boolean;
  readonly managedInstalled: boolean;
}): ProviderRuntimeSummary["source"] {
  if (input.hasCustomRuntime) return input.configuredRuntimeHealthy ? "custom" : "unknown";
  if (input.configuredRuntimeHealthy) return "system";
  return input.managedInstalled ? "scient_managed" : "missing";
}

export function resolveManagedRuntimePolicy(input: {
  readonly source: ProviderRuntimeSummary["source"];
  readonly artifact: ManagedRuntimeArtifact | undefined;
  readonly installed: boolean;
  readonly installedVersion: string | null;
  readonly managedInstallationAllowed: boolean;
}): {
  readonly supportTier: ProviderRuntimeSummary["supportTier"];
  readonly actions: ReadonlyArray<ProviderManagedRuntimeAction>;
  readonly useManagedPath: boolean;
} {
  const fullyAssisted =
    input.managedInstallationAllowed && input.artifact?.supportTier === "fully_assisted";
  const actions: ReadonlyArray<ProviderManagedRuntimeAction> = !fullyAssisted
    ? []
    : input.source === "missing"
      ? ["install"]
      : input.source === "scient_managed" && input.installed
        ? input.artifact && input.installedVersion !== input.artifact.version
          ? ["update", "repair", "remove"]
          : ["repair", "remove"]
        : [];
  return {
    supportTier:
      input.artifact?.supportTier === "fully_assisted" && !input.managedInstallationAllowed
        ? "external_runtime_supported"
        : (input.artifact?.supportTier ?? "unsupported"),
    actions,
    useManagedPath:
      input.source === "scient_managed" || (input.source === "missing" && fullyAssisted),
  };
}

export function nativeProviderRuntimeBackendLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows native";
  if (platform === "darwin") return "macOS native";
  return "Linux native";
}

export function makeManagedProviderRuntimeDiagnostics(input: {
  readonly executable: string;
  readonly source: ProviderRuntimeSummary["source"];
  readonly managedVersion: string | null;
  readonly homePath: string | null;
  readonly backend: string;
}): ProviderRuntimeDiagnostics {
  return {
    executable: input.executable,
    version: input.source === "scient_managed" ? input.managedVersion : null,
    homePath: input.homePath,
    backend: input.backend,
  };
}

export interface ManagedProviderRuntimeResolution {
  readonly effectiveBinaryPath: string;
  readonly usesManagedPath: boolean;
  readonly summary: ProviderRuntimeSummary;
  readonly actions: ProviderManagedRuntimeActions;
}

export const makeManagedProviderRuntimeResolution = Effect.fn(
  "ManagedProviderRuntimeActions.makeResolution",
)(function* (input: {
  readonly configuredBinaryPath: string;
  readonly defaultBinary: string;
  readonly providerName: string;
  readonly providerSlug: string;
  readonly runtime: ManagedProviderRuntime;
  readonly artifact: ManagedRuntimeArtifact | undefined;
  readonly targetLabel: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly managedInstallationAllowed: boolean;
  readonly sourceLabel: string;
  readonly managedInstallationLimitation: string;
  readonly diagnosticsHomePath: string | null;
  readonly diagnosticsBackend: string;
}): Effect.fn.Return<ManagedProviderRuntimeResolution, never> {
  const {
    artifact,
    defaultBinary,
    environment,
    managedInstallationAllowed,
    providerName,
    providerSlug,
    runtime,
    spawner,
    targetLabel,
  } = input;
  yield* Effect.tryPromise({
    try: () => runtime.reconcile(artifact),
    catch: (cause) =>
      runtimeError(`Scient could not reconcile managed ${providerName} staging.`, cause),
  }).pipe(Effect.ignore);

  const hasCustomRuntime = input.configuredBinaryPath !== defaultBinary;
  const configuredRuntimeHealthy = yield* hasHealthyConfiguredRuntime(
    input.configuredBinaryPath,
    environment,
    spawner,
  ).pipe(Effect.catchCause(() => Effect.succeed(false)));
  const configuredExecutable = configuredRuntimeHealthy
    ? yield* resolveCommandPath(input.configuredBinaryPath, {
        env: environment,
        extendEnv: true,
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.orElseSucceed(() => input.configuredBinaryPath),
      )
    : input.configuredBinaryPath;
  const managedStatus = artifact
    ? yield* Effect.tryPromise({
        try: () => runtime.status(artifact),
        catch: (cause) =>
          runtimeError(`Scient could not inspect managed ${providerName} state.`, cause),
      }).pipe(Effect.option)
    : Option.none();
  const managedInstalled = Option.isSome(managedStatus) && managedStatus.value.installed;
  const source = resolveManagedRuntimeSource({
    hasCustomRuntime,
    configuredRuntimeHealthy,
    managedInstalled,
  });
  const initialPolicy = resolveManagedRuntimePolicy({
    source,
    artifact,
    installed: managedInstalled,
    installedVersion: Option.isSome(managedStatus) ? managedStatus.value.activeVersion : null,
    managedInstallationAllowed,
  });
  const effectiveBinaryPath = initialPolicy.useManagedPath
    ? managedInstalled && Option.isSome(managedStatus)
      ? managedStatus.value.launchPath
      : runtime.launchPath(artifact!)
    : input.configuredBinaryPath;

  const getSummary = Effect.gen(function* () {
    const latest = artifact
      ? yield* Effect.tryPromise({
          try: () => runtime.status(artifact),
          catch: (cause) =>
            runtimeError(`Scient could not inspect its private ${providerName} runtime.`, cause),
        })
      : undefined;
    const latestManagedInstalled = latest?.installed ?? false;
    const latestSource = resolveManagedRuntimeSource({
      hasCustomRuntime,
      configuredRuntimeHealthy,
      managedInstalled: latestManagedInstalled,
    });
    const policy = resolveManagedRuntimePolicy({
      source: latestSource,
      artifact,
      installed: latestManagedInstalled,
      installedVersion: latest?.activeVersion ?? null,
      managedInstallationAllowed,
    });
    const message =
      latestSource === "custom"
        ? `Scient is preserving the custom ${providerName} runtime configured for this account.`
        : latestSource === "system"
          ? `Scient is using the healthy ${providerName} runtime already installed on this computer.`
          : latestSource === "scient_managed"
            ? `Scient is using an app-private, verified ${providerName} runtime.`
            : hasCustomRuntime
              ? `Scient could not launch the custom ${providerName} runtime configured for this account. Update or clear the custom path in advanced provider settings.`
              : artifact
                ? managedInstallationAllowed
                  ? artifact.supportMessage
                  : input.managedInstallationLimitation
                : `Scient does not have a reviewed managed ${providerName} artifact for this computer.`;
    const executable = policy.useManagedPath
      ? latestManagedInstalled && latest
        ? latest.launchPath
        : artifact
          ? runtime.launchPath(artifact)
          : configuredExecutable
      : configuredExecutable;
    return {
      source: latestSource,
      supportTier: policy.supportTier,
      target: targetLabel,
      actions: [...policy.actions],
      managedVersion: latestManagedInstalled
        ? (latest?.activeVersion ?? artifact?.version ?? null)
        : null,
      previousManagedVersion: latest?.previousVersion ?? null,
      operation: null,
      message,
      diagnostics: makeManagedProviderRuntimeDiagnostics({
        executable,
        source: latestSource,
        managedVersion: latestManagedInstalled
          ? (latest?.activeVersion ?? artifact?.version ?? null)
          : null,
        homePath: input.diagnosticsHomePath,
        backend: input.diagnosticsBackend,
      }),
    } satisfies ProviderRuntimeSummary;
  });

  const plan: ProviderManagedRuntimeActions["plan"] = (action) =>
    getSummary.pipe(
      Effect.flatMap((summary) => {
        if (!summary.actions.includes(action)) {
          return Effect.fail(
            runtimeError(`The ${action} action is not available for this ${providerName} runtime.`),
          );
        }
        const isDownload = action === "install" || action === "update" || action === "repair";
        if (isDownload && !artifact) {
          return Effect.fail(
            runtimeError(`No reviewed ${providerName} artifact is available for this computer.`),
          );
        }
        return Effect.succeed({
          action,
          target: targetLabel,
          version: isDownload ? (artifact?.version ?? null) : summary.managedVersion,
          downloadBytes: isDownload ? (artifact?.size ?? null) : null,
          sourceLabel: input.sourceLabel,
          catalogRevision: isDownload
            ? (artifact?.catalogRevision ?? "unavailable")
            : `managed-${providerSlug}:${action}:${summary.managedVersion ?? "none"}`,
          message:
            action === "remove"
              ? `Scient will remove only its app-private ${providerName} copy. Custom and system installations are untouched.`
              : action === "update"
                ? `Scient will download, verify, test, and activate ${providerName} ${artifact?.version ?? ""}. The current version remains active until then.`
                : `Scient will download, verify, stage, test, and activate ${providerName} ${artifact?.version ?? ""}.`,
        });
      }),
    );

  const progressMessage = (progress: ManagedProviderRuntimeProgress): string => {
    switch (progress.stage) {
      case "preparing":
        return `Preparing the private ${providerName} runtime.`;
      case "downloading":
        return `Downloading ${providerName} from the reviewed official release.`;
      case "verifying":
        return `Verifying the ${providerName} download.`;
      case "installing":
        return `Installing the private ${providerName} runtime.`;
      case "testing":
        return `Testing the installed ${providerName} runtime.`;
      case "activating":
        return `Activating the verified ${providerName} runtime.`;
    }
  };

  const run: ProviderManagedRuntimeActions["run"] = (action, catalogRevision, report) =>
    Effect.gen(function* () {
      const planned = yield* plan(action);
      if (planned.catalogRevision !== catalogRevision) {
        return yield* runtimeError(
          `The reviewed ${providerName} setup plan changed. Review it again before continuing.`,
        );
      }
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      if (action === "remove") {
        yield* report({
          status: "removing",
          message: `Removing Scient's private ${providerName} runtime.`,
        });
        yield* Effect.tryPromise({
          try: () => runtime.remove(),
          catch: (cause) =>
            runtimeError(`Scient could not remove its private ${providerName} runtime.`, cause),
        });
        return;
      }
      if (!artifact) {
        return yield* runtimeError(`No reviewed ${providerName} artifact is available.`);
      }
      let lastStatus: ManagedProviderRuntimeProgress["stage"] | undefined;
      let lastReportedBytes = 0;
      yield* Effect.tryPromise({
        try: (signal) =>
          runtime.install({
            artifact,
            signal,
            onProgress: (progress) => {
              const stageChanged = progress.stage !== lastStatus;
              const downloadedBytes = progress.downloadedBytes ?? 0;
              const downloadAdvanced = downloadedBytes - lastReportedBytes >= 1024 * 1024;
              const downloadFinished =
                progress.totalBytes !== undefined && downloadedBytes === progress.totalBytes;
              if (!stageChanged && !downloadAdvanced && !downloadFinished) return;
              lastStatus = progress.stage;
              lastReportedBytes = downloadedBytes;
              runFork(
                report({
                  status: progress.stage,
                  message: progressMessage(progress),
                  ...(progress.downloadedBytes === undefined
                    ? {}
                    : { downloadedBytes: progress.downloadedBytes }),
                  ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
                } satisfies ProviderManagedRuntimeProgress),
              );
            },
          }),
        catch: (cause) =>
          runtimeError(managedRuntimeInstallationFailureMessage(providerName, cause), cause),
      });
    });

  const summary = yield* getSummary.pipe(
    Effect.orElseSucceed(() => ({
      source: "unknown" as const,
      supportTier: artifact?.supportTier ?? ("unsupported" as const),
      target: targetLabel,
      actions: [],
      managedVersion: null,
      previousManagedVersion: null,
      operation: null,
      message: `Scient could not inspect managed ${providerName} runtime state.`,
    })),
  );

  return {
    effectiveBinaryPath,
    usesManagedPath: initialPolicy.useManagedPath,
    summary,
    actions: { getSummary, plan, run },
  };
});
