import {
  ManagedCodexRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  resolveReviewedCodexArtifact,
  type ManagedCodexRuntimeProgress,
  type ManagedRuntimeArtifact,
} from "@scientfactory/provider-runtime";
import type {
  CodexSettings,
  ProviderManagedRuntimeAction,
  ProviderRuntimeSummary,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
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

const DEFAULT_CODEX_BINARY = "codex";

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

const runtimeError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

function mapProgress(progress: ManagedCodexRuntimeProgress): ProviderManagedRuntimeProgress {
  const messages = {
    preparing: "Preparing the private Codex runtime.",
    downloading: "Downloading Codex from the reviewed OpenAI release.",
    verifying: "Verifying the Codex download.",
    installing: "Installing the private Codex runtime.",
    testing: "Testing the installed Codex runtime.",
    activating: "Activating the verified Codex runtime.",
  } as const;
  return {
    status: progress.stage,
    message: messages[progress.stage],
    ...(progress.downloadedBytes === undefined
      ? {}
      : { downloadedBytes: progress.downloadedBytes }),
    ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
  };
}

const hasHealthySystemCodex = Effect.fn("CodexManagedRuntime.hasHealthySystemCodex")(function* (
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const resolved = yield* resolveSpawnCommand(DEFAULT_CODEX_BINARY, ["--version"], {
    env: environment,
    extendEnv: true,
  });
  const result = yield* spawnAndCollect(
    DEFAULT_CODEX_BINARY,
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

export function resolveCodexManagedRuntimePolicy(input: {
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

export interface CodexManagedRuntimeResolution {
  readonly effectiveBinaryPath: string;
  readonly usesManagedPath: boolean;
  readonly summary: ProviderRuntimeSummary;
  readonly actions: ProviderManagedRuntimeActions;
}

export const makeCodexManagedRuntimeResolution = Effect.fn("CodexManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: CodexSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<CodexManagedRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedCodexArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;
    const runtime = new ManagedCodexRuntime(input.baseDir);
    yield* Effect.tryPromise({
      try: () => runtime.reconcile(artifact),
      catch: (cause) => runtimeError("Scient could not reconcile managed Codex staging.", cause),
    }).pipe(Effect.ignore);
    const hasCustomRuntime = input.settings.binaryPath !== DEFAULT_CODEX_BINARY;
    const systemAvailable = hasCustomRuntime
      ? false
      : yield* hasHealthySystemCodex(input.environment, input.spawner).pipe(
          Effect.catchCause(() => Effect.succeed(false)),
        );
    const managedStatus = artifact
      ? yield* Effect.tryPromise({
          try: () => runtime.status(artifact),
          catch: (cause) => runtimeError("Scient could not inspect managed Codex state.", cause),
        }).pipe(Effect.option)
      : Option.none();
    const managedInstalled = Option.isSome(managedStatus) && managedStatus.value.installed;
    const source: ProviderRuntimeSummary["source"] = hasCustomRuntime
      ? "custom"
      : systemAvailable
        ? "system"
        : managedInstalled
          ? "scient_managed"
          : "missing";
    const initialPolicy = resolveCodexManagedRuntimePolicy({
      source,
      artifact,
      installed: managedInstalled,
      installedVersion: Option.isSome(managedStatus) ? managedStatus.value.activeVersion : null,
      managedInstallationAllowed: input.managedInstallationAllowed,
    });
    const effectiveBinaryPath = initialPolicy.useManagedPath
      ? managedInstalled && Option.isSome(managedStatus)
        ? managedStatus.value.launchPath
        : runtime.launchPath(artifact!)
      : input.settings.binaryPath;

    const getSummary = Effect.gen(function* () {
      const latest = artifact
        ? yield* Effect.tryPromise({
            try: () => runtime.status(artifact),
            catch: (cause) =>
              runtimeError("Scient could not inspect its private Codex runtime.", cause),
          })
        : undefined;
      const latestManagedInstalled = latest?.installed ?? false;
      const latestSource: ProviderRuntimeSummary["source"] = hasCustomRuntime
        ? "custom"
        : systemAvailable
          ? "system"
          : latestManagedInstalled
            ? "scient_managed"
            : "missing";
      const policy = resolveCodexManagedRuntimePolicy({
        source: latestSource,
        artifact,
        installed: latestManagedInstalled,
        installedVersion: latest?.activeVersion ?? null,
        managedInstallationAllowed: input.managedInstallationAllowed,
      });
      const message =
        latestSource === "custom"
          ? "Scient is preserving the custom Codex runtime configured for this account."
          : latestSource === "system"
            ? "Scient is using the healthy Codex runtime already installed on this computer."
            : latestSource === "scient_managed"
              ? "Scient is using an app-private, verified Codex runtime."
              : artifact
                ? input.managedInstallationAllowed
                  ? artifact.supportMessage
                  : "Scient can use a healthy Codex runtime here, but managed installation is only proven in the local desktop app."
                : "Scient does not have a reviewed managed Codex artifact for this computer.";
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
      } satisfies ProviderRuntimeSummary;
    });

    const plan: ProviderManagedRuntimeActions["plan"] = (action) =>
      getSummary.pipe(
        Effect.flatMap((summary) => {
          if (!summary.actions.includes(action)) {
            return Effect.fail(
              runtimeError(`The ${action} action is not available for this Codex runtime.`),
            );
          }
          const isDownload = action === "install" || action === "update" || action === "repair";
          if (isDownload && !artifact) {
            return Effect.fail(
              runtimeError("No reviewed Codex artifact is available for this computer."),
            );
          }
          return Effect.succeed({
            action,
            target: targetLabel,
            version: isDownload ? (artifact?.version ?? null) : summary.managedVersion,
            downloadBytes: isDownload ? (artifact?.size ?? null) : null,
            sourceLabel: "Official OpenAI Codex release on GitHub",
            catalogRevision: isDownload
              ? (artifact?.catalogRevision ?? "unavailable")
              : `managed-codex:${action}:${summary.managedVersion ?? "none"}`,
            message:
              action === "remove"
                ? "Scient will remove only its app-private Codex copy. Custom and system installations are untouched."
                : action === "update"
                  ? `Scient will download, verify, test, and activate Codex ${artifact?.version ?? ""}. The current version remains active until then.`
                  : `Scient will download, verify, stage, test, and activate Codex ${artifact?.version ?? ""}.`,
          });
        }),
      );

    const run: ProviderManagedRuntimeActions["run"] = (action, catalogRevision, report) =>
      Effect.gen(function* () {
        const planned = yield* plan(action);
        if (planned.catalogRevision !== catalogRevision) {
          return yield* runtimeError(
            "The reviewed Codex setup plan changed. Review it again before continuing.",
          );
        }
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        if (action === "remove") {
          yield* report({
            status: "removing",
            message: "Removing Scient's private Codex runtime.",
          });
          yield* Effect.tryPromise({
            try: () => runtime.remove(),
            catch: (cause) =>
              runtimeError("Scient could not remove its private Codex runtime.", cause),
          });
          return;
        }
        if (!artifact) return yield* runtimeError("No reviewed Codex artifact is available.");
        let lastStatus: ManagedCodexRuntimeProgress["stage"] | undefined;
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
                runFork(report(mapProgress(progress)));
              },
            }),
          catch: (cause) =>
            runtimeError("Scient could not install the private Codex runtime.", cause),
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
        message: "Scient could not inspect managed Codex runtime state.",
      })),
    );

    return {
      effectiveBinaryPath,
      usesManagedPath: initialPolicy.useManagedPath,
      summary,
      actions: { getSummary, plan, run },
    };
  },
);
