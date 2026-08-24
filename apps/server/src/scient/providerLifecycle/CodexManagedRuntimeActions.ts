// @effect-diagnostics nodeBuiltinImport:off -- Managed Codex capability checks must verify the provider-owned companion executable beside the selected binary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

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
  ProviderRuntimeDiagnostics,
  ProviderRuntimeSummary,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveCodexLaunchArgs } from "../../provider/Layers/codexLaunchArgs.ts";
import { openCodexAppServerConnection } from "../../provider/Layers/CodexProvider.ts";
import type {
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "../../provider/ProviderDriver.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const DEFAULT_CODEX_BINARY = "codex";

export function resolveCodexCodeModeHostPath(
  binaryPath: string,
  platform: NodeJS.Platform,
): string {
  const path = platform === "win32" ? NodePath.win32 : NodePath;
  return path.join(
    path.dirname(binaryPath),
    platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host",
  );
}

export const hasManagedCodexCodeModeHost = Effect.fn("CodexManagedRuntime.hasCodeModeHost")(
  function* (binaryPath: string, platform: NodeJS.Platform) {
    const hostPath = resolveCodexCodeModeHostPath(binaryPath, platform);
    return yield* Effect.tryPromise(async () => {
      const stat = await NodeFSP.lstat(hostPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (platform !== "win32") await NodeFSP.access(hostPath, NodeFSP.constants.X_OK);
      return true;
    }).pipe(Effect.orElseSucceed(() => false));
  },
);

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

function runtimeBackendLabel(platform: string): string {
  if (platform === "win32") return "Windows native";
  if (platform === "darwin") return "macOS native";
  return "Linux native";
}

/**
 * Prefer a Codex binary only when it can speak the app-server protocol used
 * for assisted login. `--version` alone is not enough: PATH shims and older
 * builds can report a version while failing OAuth / account RPCs.
 */
const hasCapableCodex = Effect.fn("CodexManagedRuntime.hasCapableCodex")(function* (
  input: {
    readonly binaryPath: string;
    readonly homePath: string;
    readonly launchArgs: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  },
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const homePath = input.homePath.trim();
  return yield* Effect.scoped(
    openCodexAppServerConnection({
      binaryPath: input.binaryPath,
      ...(homePath.length > 0 ? { homePath } : {}),
      launchArgs: resolveCodexLaunchArgs(input.launchArgs, input.environment),
      cwd: input.cwd,
      environment: input.environment,
    }).pipe(
      Effect.flatMap(({ client }) => client.request("account/read", {})),
      Effect.as(true),
    ),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout("8 seconds"),
    Effect.orElseSucceed(() => false),
  );
});

export function resolveCodexRuntimeSource(input: {
  readonly hasCustomRuntime: boolean;
  readonly configuredRuntimeHealthy: boolean;
  readonly managedInstalled: boolean;
  readonly managedRuntimeHealthy: boolean;
}): ProviderRuntimeSummary["source"] {
  if (input.hasCustomRuntime) {
    return input.configuredRuntimeHealthy ? "custom" : "unknown";
  }
  // Installing the private runtime is the user's durable selection. Prefer it
  // while it is capability-healthy, without maintaining a second preference
  // file that can drift from the atomic managed-runtime state. If it is
  // unhealthy, use a healthy PATH runtime while preserving the repair action;
  // if neither runtime is healthy, retain the private copy as the repair target.
  if (input.managedInstalled && (input.managedRuntimeHealthy || !input.configuredRuntimeHealthy)) {
    return "scient_managed";
  }
  if (input.configuredRuntimeHealthy) return "system";
  return "missing";
}

export function resolveCodexRuntimeHomePath(input: {
  readonly effectiveHomePath: string | undefined;
  readonly configuredHomePath: string;
}): string {
  const effective = input.effectiveHomePath?.trim() ?? "";
  return effective.length > 0 ? effective : input.configuredHomePath.trim();
}

/**
 * Probing the configured PATH/custom binary spawns a Codex app-server, so it
 * is skipped whenever an already-installed managed runtime has passed the
 * same capability probe and will therefore win selection.
 */
export function shouldSkipConfiguredCodexProbe(input: {
  readonly hasCustomRuntime: boolean;
  readonly managedRuntimeHealthy: boolean;
}): boolean {
  return !input.hasCustomRuntime && input.managedRuntimeHealthy;
}

export function shouldProbeManagedCodexRuntime(input: {
  readonly hasCustomRuntime: boolean;
  readonly managedInstalled: boolean;
}): boolean {
  return input.managedInstalled && !input.hasCustomRuntime;
}

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
      : input.source === "system" && !input.installed
        ? ["install"]
        : input.source === "system" && input.installed
          ? ["repair", "remove"]
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
      input.source === "scient_managed" ||
      (input.source === "missing" && input.artifact !== undefined && fullyAssisted),
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
    readonly cwd: string;
    readonly effectiveHomePath?: string | undefined;
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
      catch: (cause) => runtimeError("Scient could not reconcile managed Codex state.", cause),
    }).pipe(Effect.ignore);
    const hasCustomRuntime = input.settings.binaryPath !== DEFAULT_CODEX_BINARY;
    const configuredBinaryPath = input.settings.binaryPath;
    const managedStatus = artifact
      ? yield* Effect.tryPromise({
          try: () => runtime.status(artifact),
          catch: (cause) => runtimeError("Scient could not inspect managed Codex state.", cause),
        }).pipe(Effect.option)
      : Option.none();
    const managedInstalled = Option.isSome(managedStatus) && managedStatus.value.installed;
    const runtimeHomePath = resolveCodexRuntimeHomePath({
      effectiveHomePath: input.effectiveHomePath,
      configuredHomePath: input.settings.homePath,
    });
    const probeRuntime = (binaryPath: string) =>
      hasCapableCodex(
        {
          binaryPath,
          // Probe exactly the home binding the provider will launch with. In
          // account-overlay configurations this is the materialized shadow home,
          // not the shared configured home.
          homePath: runtimeHomePath,
          launchArgs: input.settings.launchArgs,
          cwd: input.cwd,
          environment: input.environment,
        },
        input.spawner,
      ).pipe(Effect.catchCause(() => Effect.succeed(false)));
    const probeManagedRuntime = (binaryPath: string) =>
      hasManagedCodexCodeModeHost(binaryPath, platform).pipe(
        Effect.flatMap((complete) => (complete ? probeRuntime(binaryPath) : Effect.succeed(false))),
      );
    const shouldProbeManagedRuntime = shouldProbeManagedCodexRuntime({
      hasCustomRuntime,
      managedInstalled,
    });
    const initialManagedRuntimeHealthy =
      shouldProbeManagedRuntime && Option.isSome(managedStatus)
        ? yield* probeManagedRuntime(managedStatus.value.launchPath)
        : false;
    const managedHealthCache = yield* Ref.make<{
      readonly launchPath: string;
      readonly healthy: boolean;
    } | null>(
      shouldProbeManagedRuntime && Option.isSome(managedStatus)
        ? {
            launchPath: managedStatus.value.launchPath,
            healthy: initialManagedRuntimeHealthy,
          }
        : null,
    );
    const managedRuntimeHealth = Effect.fn("CodexManagedRuntime.managedRuntimeHealth")(function* (
      status: { readonly installed: boolean; readonly launchPath: string } | undefined,
    ) {
      if (!status?.installed) return false;
      const cached = yield* Ref.get(managedHealthCache);
      if (cached?.launchPath === status.launchPath) return cached.healthy;
      const healthy = yield* probeManagedRuntime(status.launchPath);
      yield* Ref.set(managedHealthCache, { launchPath: status.launchPath, healthy });
      return healthy;
    });
    const probeConfiguredRuntime = probeRuntime(configuredBinaryPath);
    // Probe the configured PATH/custom binary whenever selection might still
    // choose it. Skip when the installed managed runtime has already passed
    // the capability probe and will win selection.
    const skipConfiguredProbe = shouldSkipConfiguredCodexProbe({
      hasCustomRuntime,
      managedRuntimeHealthy: initialManagedRuntimeHealthy,
    });
    const configuredRuntimeHealthy = skipConfiguredProbe ? false : yield* probeConfiguredRuntime;
    // Runtime actions change install state after this resolution is built, so
    // getSummary re-derives selection. The probe result is cached: a summary
    // that suddenly needs configured health after remove probes once instead
    // of starting another app-server on every read.
    const configuredHealthCache = yield* Ref.make<boolean | null>(
      skipConfiguredProbe ? null : configuredRuntimeHealthy,
    );
    const configuredHealth = Effect.gen(function* () {
      const cached = yield* Ref.get(configuredHealthCache);
      if (cached !== null) return cached;
      const probed = yield* probeConfiguredRuntime;
      yield* Ref.set(configuredHealthCache, probed);
      return probed;
    });
    const source = resolveCodexRuntimeSource({
      hasCustomRuntime,
      configuredRuntimeHealthy,
      managedInstalled,
      managedRuntimeHealthy: initialManagedRuntimeHealthy,
    });
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
      : configuredBinaryPath;

    const diagnosticsHomePath = runtimeHomePath.length > 0 ? runtimeHomePath : null;

    const buildDiagnostics = (input_: {
      readonly source: ProviderRuntimeSummary["source"];
      readonly executable: string;
      readonly managedVersion: string | null;
    }): ProviderRuntimeDiagnostics => ({
      executable: input_.executable,
      version: input_.source === "scient_managed" ? input_.managedVersion : null,
      homePath: diagnosticsHomePath,
      backend: runtimeBackendLabel(platform),
    });

    const getSummary = Effect.gen(function* () {
      const latest = artifact
        ? yield* Effect.tryPromise({
            try: () => runtime.status(artifact),
            catch: (cause) =>
              runtimeError("Scient could not inspect its private Codex runtime.", cause),
          })
        : undefined;
      const latestManagedInstalled = latest?.installed ?? false;
      const latestManagedRuntimeHealthy = shouldProbeManagedCodexRuntime({
        hasCustomRuntime,
        managedInstalled: latestManagedInstalled,
      })
        ? yield* managedRuntimeHealth(latest)
        : false;
      const latestConfiguredHealthy = shouldSkipConfiguredCodexProbe({
        hasCustomRuntime,
        managedRuntimeHealthy: latestManagedRuntimeHealthy,
      })
        ? false
        : yield* configuredHealth;
      const latestSource = resolveCodexRuntimeSource({
        hasCustomRuntime,
        configuredRuntimeHealthy: latestConfiguredHealthy,
        managedInstalled: latestManagedInstalled,
        managedRuntimeHealthy: latestManagedRuntimeHealthy,
      });
      const policy = resolveCodexManagedRuntimePolicy({
        source: latestSource,
        artifact,
        installed: latestManagedInstalled,
        installedVersion: latest?.activeVersion ?? null,
        managedInstallationAllowed: input.managedInstallationAllowed,
      });
      const latestExecutable = policy.useManagedPath
        ? latestManagedInstalled && latest
          ? latest.launchPath
          : artifact
            ? runtime.launchPath(artifact)
            : configuredBinaryPath
        : configuredBinaryPath;
      const managedVersion = latestManagedInstalled
        ? (latest?.activeVersion ?? artifact?.version ?? null)
        : null;
      const message =
        latestSource === "custom"
          ? "Scient is preserving the custom Codex runtime configured for this account."
          : latestSource === "system"
            ? latestManagedInstalled
              ? "Scient is using healthy PATH Codex because the private copy failed its runtime capability check. Repair or remove the private copy when convenient."
              : "Scient is using the healthy Codex runtime already installed on this computer."
            : latestSource === "scient_managed"
              ? latestManagedRuntimeHealthy
                ? "Scient is using an app-private, verified Codex runtime."
                : "Scient selected its app-private Codex runtime, but its runtime capability check failed. Repair the private runtime before signing in."
              : hasCustomRuntime
                ? "Scient could not launch the custom Codex runtime configured for this account. Update or clear the custom path in advanced provider settings."
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
        managedVersion,
        previousManagedVersion: latest?.previousVersion ?? null,
        operation: null,
        message,
        diagnostics: buildDiagnostics({
          source: latestSource,
          executable: latestExecutable,
          managedVersion,
        }),
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
                  : action === "repair" && summary.source === "system"
                    ? `Scient will replace the unhealthy private Codex copy with verified Codex ${artifact?.version ?? ""} and use it after verification. The working system installation is untouched.`
                    : action === "install" && summary.source === "system"
                      ? `Scient will install private Codex ${artifact?.version ?? ""} beside the system installation. Codex accounts in this environment that use the default runtime will use the verified private copy; custom paths remain unchanged.`
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
          yield* Ref.set(managedHealthCache, null);
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
        yield* Ref.set(managedHealthCache, null);
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
        diagnostics: buildDiagnostics({
          source: "unknown",
          executable: configuredBinaryPath,
          managedVersion: null,
        }),
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
