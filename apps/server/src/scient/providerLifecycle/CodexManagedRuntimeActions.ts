// @effect-diagnostics nodeBuiltinImport:off -- Managed Codex capability checks must verify the provider-owned companion executable beside the selected binary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MANAGED_RUNTIME_POLICY,
  ManagedCodexRuntime,
  detectManagedRuntimeTarget,
  managedRuntimeSmokeEnvironment,
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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { openCodexAppServerConnection } from "../../provider/CodexProvider.ts";
import type {
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "../../provider/ScientProviderInstanceSeams.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import {
  ManagedRuntimeCatalog,
  resolveManagedRuntimeCatalogCandidate,
  resolveManagedRuntimeRepairArtifact,
  type ManagedRuntimeCatalogData,
} from "./ManagedRuntimeCatalog.ts";
import {
  isManagedRuntimeDowngrade,
  managedRuntimeDowngradeMessage,
  managedRuntimeSwitchPlan,
} from "./ManagedProviderRuntimeActions.ts";
import { isManagedRuntimeUpdate } from "./managedRuntimeVersion.ts";

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
    downloading: "Downloading Codex from the qualified OpenAI release.",
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

/** Selects only a strictly newer qualified release, never a remote downgrade or repack. */
export function resolveCodexCatalogCandidate(input: {
  readonly bundledArtifact: ManagedRuntimeArtifact | undefined;
  readonly catalog: ManagedRuntimeCatalogData;
}): ManagedRuntimeArtifact | undefined {
  return resolveManagedRuntimeCatalogCandidate({
    catalog: input.catalog,
    bundledArtifact: input.bundledArtifact,
    contractRevision: MANAGED_RUNTIME_POLICY.codex.revision,
  });
}

const qualifyManagedCodexRuntime = Effect.fn("CodexManagedRuntime.qualify")(function* (input: {
  readonly binaryPath: string;
  readonly expectedVersion: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const connection = yield* Effect.scoped(
    openCodexAppServerConnection({
      binaryPath: input.binaryPath,
      homePath: input.cwd,
      launchArgs: "",
      cwd: input.cwd,
      environment: managedRuntimeSmokeEnvironment(input.environment),
      extendEnvironment: false,
    }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    Effect.timeout("8 seconds"),
  );
  if (connection.version !== input.expectedVersion) {
    return yield* runtimeError(
      `The installed Codex package reported ${connection.version ?? "an unknown version"} instead of ${input.expectedVersion}.`,
    );
  }
});

export type CodexCapabilityCheck =
  | { readonly healthy: true; readonly version: string | null }
  | { readonly healthy: false; readonly reason: string };

const CODEX_CAPABILITY_TIMEOUT = "8 seconds";

/** A short, credential-free reason for a failed capability check. */
export function describeCodexCapabilityFailure(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause);
  if (Cause.isTimeoutError(failure)) {
    return `it did not answer within ${CODEX_CAPABILITY_TIMEOUT}`;
  }
  // The first line, without the spawned command (a long private path).
  const message =
    failure instanceof Error
      ? (failure.message.trim().split("\n", 1)[0] ?? "").replace(/ for command: .*$/u, "")
      : "";
  const short = message.length > 120 ? `${message.slice(0, 119).trimEnd()}…` : message;
  return short ? `it failed to start: ${short}` : "it failed to start";
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
      Effect.flatMap(({ client, version }) =>
        client.request("account/read", {}).pipe(Effect.as(version ?? null)),
      ),
    ),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout(CODEX_CAPABILITY_TIMEOUT),
    Effect.map((version): CodexCapabilityCheck => ({ healthy: true, version })),
    Effect.catchCause((cause) =>
      Effect.succeed<CodexCapabilityCheck>({
        healthy: false,
        reason: describeCodexCapabilityFailure(cause),
      }),
    ),
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

/**
 * PATH Codex is standing in for an installed private copy that failed its
 * capability check. The private copy remains the user's durable selection, so
 * its update or repair is the fix; PATH Codex is not offered its own update.
 */
export function isStandInForManagedCodex(
  summary: Pick<ProviderRuntimeSummary, "source" | "managedVersion" | "actions">,
): boolean {
  return (
    summary.source === "system" &&
    summary.managedVersion !== null &&
    (summary.actions.includes("repair") || summary.actions.includes("update"))
  );
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
  /** The healthy PATH Codex's own release, when its app-server named one. */
  readonly systemVersion: string | null;
  /**
   * The release Repair installs when it is not `artifact`: the installed
   * release, when that is newer than the catalog's.
   */
  readonly repairArtifact?: ManagedRuntimeArtifact | undefined;
}): {
  readonly supportTier: ProviderRuntimeSummary["supportTier"];
  readonly actions: ReadonlyArray<ProviderManagedRuntimeAction>;
  readonly useManagedPath: boolean;
} {
  const fullyAssisted =
    input.managedInstallationAllowed && input.artifact?.supportTier === "fully_assisted";
  // An installed private copy keeps its update while PATH Codex stands in for it:
  // activating a newer release re-runs the capability check that selects it again.
  const installedActions: ReadonlyArray<ProviderManagedRuntimeAction> =
    input.artifact &&
    isManagedRuntimeUpdate({
      provider: input.artifact.provider,
      current: input.installedVersion,
      candidate: input.artifact.version,
    })
      ? ["update", "repair", "remove"]
      : ["repair", "remove"];
  // While PATH Codex stands in for a private copy that failed its check,
  // repairing or updating that copy would put it back in use without the user
  // choosing it: never with an older release than PATH Codex. Each action is
  // judged by the release it installs. Installing a private copy beside PATH
  // Codex is the user's own choice, whatever the two releases are; its plan
  // shows both before anything starts.
  const wouldDowngrade = input.source === "system" && isManagedRuntimeDowngrade(input);
  const repairWouldDowngrade =
    input.source === "system" &&
    isManagedRuntimeDowngrade({
      artifact: input.repairArtifact ?? input.artifact,
      systemVersion: input.systemVersion,
    });
  const actions: ReadonlyArray<ProviderManagedRuntimeAction> = !fullyAssisted
    ? []
    : input.source === "missing"
      ? ["install"]
      : input.source === "system" && !input.installed
        ? ["install"]
        : (input.source === "system" || input.source === "scient_managed") && input.installed
          ? installedActions.filter((action) =>
              action === "repair"
                ? !repairWouldDowngrade
                : action === "update"
                  ? !wouldDowngrade
                  : true,
            )
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
    /** Test seams: the managed runtime engine and the app-server capability check. */
    readonly dependencies?: {
      readonly runtime?: ManagedCodexRuntime;
      readonly probeRuntime?: (binaryPath: string) => Effect.Effect<CodexCapabilityCheck>;
    };
  }): Effect.fn.Return<CodexManagedRuntimeResolution, never> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const bundledArtifact = target ? resolveReviewedCodexArtifact(target) : undefined;
    const catalogService = yield* ManagedRuntimeCatalog;
    const resolveCandidate = (refresh: boolean) =>
      (refresh ? catalogService.refresh : catalogService.current).pipe(
        Effect.map((catalog) => resolveCodexCatalogCandidate({ bundledArtifact, catalog })),
      );
    const artifact = yield* resolveCandidate(false);
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;
    const runtime = input.dependencies?.runtime ?? new ManagedCodexRuntime(input.baseDir);
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
    const probeRuntime =
      input.dependencies?.probeRuntime ??
      ((binaryPath: string) =>
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
        ));
    // A failed check hands the provider to PATH Codex until selection is
    // re-checked, so one slow start (a cold disk, a first-launch malware scan)
    // is retried before the private copy loses selection.
    const probeManagedRuntime = (binaryPath: string) =>
      hasManagedCodexCodeModeHost(binaryPath, platform).pipe(
        Effect.flatMap((complete) =>
          complete
            ? probeRuntime(binaryPath).pipe(
                Effect.flatMap((check) =>
                  check.healthy ? Effect.succeed(check) : probeRuntime(binaryPath),
                ),
              )
            : Effect.succeed<CodexCapabilityCheck>({
                healthy: false,
                reason: "its code-mode host is missing",
              }),
        ),
        Effect.tap((check) =>
          check.healthy
            ? Effect.void
            : Effect.logWarning("Private Codex failed its capability check", {
                launchPath: binaryPath,
                reason: check.reason,
              }),
        ),
      );
    const shouldProbeManagedRuntime = shouldProbeManagedCodexRuntime({
      hasCustomRuntime,
      managedInstalled,
    });
    const initialManagedCheck =
      shouldProbeManagedRuntime && Option.isSome(managedStatus)
        ? yield* probeManagedRuntime(managedStatus.value.launchPath)
        : null;
    const initialManagedRuntimeHealthy = initialManagedCheck?.healthy ?? false;
    const managedHealthCache = yield* Ref.make<{
      readonly launchPath: string;
      readonly check: CodexCapabilityCheck;
    } | null>(
      initialManagedCheck && Option.isSome(managedStatus)
        ? { launchPath: managedStatus.value.launchPath, check: initialManagedCheck }
        : null,
    );
    const managedRuntimeHealth = Effect.fn("CodexManagedRuntime.managedRuntimeHealth")(function* (
      status: { readonly installed: boolean; readonly launchPath: string } | undefined,
    ) {
      if (!status?.installed) return false;
      const cached = yield* Ref.get(managedHealthCache);
      if (cached?.launchPath === status.launchPath) return cached.check.healthy;
      const check = yield* probeManagedRuntime(status.launchPath);
      yield* Ref.set(managedHealthCache, { launchPath: status.launchPath, check });
      return check.healthy;
    });
    const probeConfiguredRuntime = probeRuntime(configuredBinaryPath);
    // Probe the configured PATH/custom binary whenever selection might still
    // choose it. Skip when the installed managed runtime has already passed
    // the capability probe and will win selection.
    const skipConfiguredProbe = shouldSkipConfiguredCodexProbe({
      hasCustomRuntime,
      managedRuntimeHealthy: initialManagedRuntimeHealthy,
    });
    const initialConfiguredCheck = skipConfiguredProbe ? null : yield* probeConfiguredRuntime;
    const configuredRuntimeHealthy = initialConfiguredCheck?.healthy ?? false;
    // Runtime actions change install state after this resolution is built, so
    // getSummary re-derives selection. The probe result is cached: a summary
    // that suddenly needs configured health after remove probes once instead
    // of starting another app-server on every read. A download drops the
    // cached check first (`prepareAction`), so it decides on PATH Codex as it
    // is now.
    const configuredCheckCache = yield* Ref.make<CodexCapabilityCheck | null>(
      initialConfiguredCheck,
    );
    const configuredCheck = Effect.gen(function* () {
      const cached = yield* Ref.get(configuredCheckCache);
      if (cached !== null) return cached;
      const probed = yield* probeConfiguredRuntime;
      yield* Ref.set(configuredCheckCache, probed);
      return probed;
    });
    /** The PATH Codex's own release, once a probe has read it. */
    const systemVersionOf = (check: CodexCapabilityCheck | null) =>
      check?.healthy ? check.version : null;
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
      systemVersion: systemVersionOf(initialConfiguredCheck),
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

    /** The runtime's state with `currentArtifact` as the release on offer. */
    const summarize = Effect.fnUntraced(function* (
      currentArtifact: ManagedRuntimeArtifact | undefined,
    ) {
      const latest = bundledArtifact
        ? yield* Effect.tryPromise({
            try: () => runtime.status(bundledArtifact),
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
      const latestConfiguredCheck = shouldSkipConfiguredCodexProbe({
        hasCustomRuntime,
        managedRuntimeHealthy: latestManagedRuntimeHealthy,
      })
        ? null
        : yield* configuredCheck;
      const latestConfiguredHealthy = latestConfiguredCheck?.healthy ?? false;
      const latestSource = resolveCodexRuntimeSource({
        hasCustomRuntime,
        configuredRuntimeHealthy: latestConfiguredHealthy,
        managedInstalled: latestManagedInstalled,
        managedRuntimeHealthy: latestManagedRuntimeHealthy,
      });
      const policy = resolveCodexManagedRuntimePolicy({
        source: latestSource,
        artifact: currentArtifact,
        installed: latestManagedInstalled,
        installedVersion: latest?.activeVersion ?? null,
        managedInstallationAllowed: input.managedInstallationAllowed,
        systemVersion: systemVersionOf(latestConfiguredCheck),
        repairArtifact: resolveManagedRuntimeRepairArtifact({
          bundledArtifact,
          candidateArtifact: currentArtifact,
          activeArtifact: latest?.activeArtifact,
        }),
      });
      const latestExecutable = policy.useManagedPath
        ? latestManagedInstalled && latest
          ? latest.launchPath
          : currentArtifact
            ? runtime.launchPath(currentArtifact)
            : configuredBinaryPath
        : configuredBinaryPath;
      const managedVersion = latestManagedInstalled
        ? (latest?.activeVersion ?? currentArtifact?.version ?? null)
        : null;
      const cachedCheck = (yield* Ref.get(managedHealthCache))?.check;
      const failedCheckReason = cachedCheck && !cachedCheck.healthy ? cachedCheck.reason : null;
      const message =
        latestSource === "custom"
          ? "Scient is preserving the custom Codex runtime configured for this account."
          : latestSource === "system"
            ? latestManagedInstalled
              ? `Scient is using healthy PATH Codex because the private copy failed its runtime capability check${failedCheckReason ? ` (${failedCheckReason})` : ""}. ${
                  policy.actions.includes("repair")
                    ? "Refresh providers to check it again, or repair or update it."
                    : "The qualified private release is older than PATH Codex, so it is not repaired over it; remove the private copy, or refresh providers to check it again."
                }`
              : "Scient is using the healthy Codex runtime already installed on this computer."
            : latestSource === "scient_managed"
              ? latestManagedRuntimeHealthy
                ? "Scient is using an app-private, verified Codex runtime."
                : "Scient selected its app-private Codex runtime, but its runtime capability check failed. Repair the private runtime before signing in."
              : hasCustomRuntime
                ? "Scient could not launch the custom Codex runtime configured for this account. Update or clear the custom path in advanced provider settings."
                : currentArtifact
                  ? input.managedInstallationAllowed
                    ? currentArtifact.supportMessage
                    : "Scient can use a healthy Codex runtime here, but managed installation is only proven in the local desktop app."
                  : "Scient does not have a qualified managed Codex artifact for this computer.";
      return {
        source: latestSource,
        supportTier: policy.supportTier,
        target: targetLabel,
        actions: [...policy.actions],
        managedVersion,
        availableManagedVersion: policy.actions.includes("update")
          ? (currentArtifact?.version ?? null)
          : null,
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
    const getSummary = resolveCandidate(false).pipe(Effect.flatMap(summarize));

    const prepareAction = Effect.fn("CodexManagedRuntime.prepareAction")(function* (
      action: ProviderManagedRuntimeAction,
    ) {
      // Explicit download actions refresh; routine checks and removal stay local.
      const candidateArtifact = yield* resolveCandidate(action !== "remove");
      // A download makes the private copy the runtime in use. Where PATH Codex
      // can be the one in use, check it now rather than trust the cached check,
      // so the releases compared and shown are the current ones.
      if (action !== "remove" && !hasCustomRuntime) yield* Ref.set(configuredCheckCache, null);
      // The release captured above decides what is offered, whatever the
      // catalog holds by now.
      const summary = yield* summarize(candidateArtifact);
      const isDownload = action === "install" || action === "update" || action === "repair";
      const activeArtifact =
        action === "repair" && bundledArtifact
          ? (yield* Effect.tryPromise({
              try: () => runtime.status(bundledArtifact),
              catch: (cause) =>
                runtimeError("Scient could not inspect its private runtime.", cause),
            })).activeArtifact
          : undefined;
      // The release this action installs, as planned here and as `run` installs it.
      const actionArtifact =
        action === "repair"
          ? resolveManagedRuntimeRepairArtifact({
              bundledArtifact,
              candidateArtifact,
              activeArtifact,
            })
          : isDownload
            ? candidateArtifact
            : undefined;
      // While PATH Codex is the runtime in use, the release that will be
      // installed is compared with it, as it was just checked. Install is the
      // user's choice of the private copy and is planned below with both
      // releases; repair and update of a copy PATH Codex stands in for are not.
      const pathVersion = systemVersionOf(yield* Ref.get(configuredCheckCache));
      if (
        isDownload &&
        action !== "install" &&
        summary.source === "system" &&
        actionArtifact &&
        pathVersion !== null &&
        isManagedRuntimeDowngrade({ artifact: actionArtifact, systemVersion: pathVersion })
      ) {
        return yield* runtimeError(
          managedRuntimeDowngradeMessage({
            providerName: "Codex",
            managedVersion: actionArtifact.version,
            systemVersion: pathVersion,
          }),
        );
      }
      if (!summary.actions.includes(action)) {
        return yield* runtimeError(`The ${action} action is not available for this Codex runtime.`);
      }
      if (isDownload && !actionArtifact) {
        return yield* runtimeError("No qualified Codex artifact is available for this computer.");
      }
      const plan = {
        action,
        target: targetLabel,
        version: isDownload ? (actionArtifact?.version ?? null) : summary.managedVersion,
        downloadBytes: isDownload ? (actionArtifact?.size ?? null) : null,
        sourceLabel: "Official OpenAI Codex release on GitHub",
        catalogRevision: isDownload
          ? (actionArtifact?.catalogRevision ?? "unavailable")
          : `managed-codex:${action}:${summary.managedVersion ?? "none"}`,
        message:
          action === "remove"
            ? "Scient will remove only its app-private Codex copy. Custom and system installations are untouched."
            : action === "update" && summary.source === "system"
              ? `Scient will download, verify, test, and activate private Codex ${actionArtifact?.version ?? ""}, then use it instead of the system installation, which stays untouched.`
              : action === "update"
                ? `Scient will download, verify, test, and activate Codex ${actionArtifact?.version ?? ""}. The current version remains active until then.`
                : action === "repair" && summary.source === "system"
                  ? `Scient will repair the private Codex ${actionArtifact?.version ?? ""} release and use it after verification. The working system installation is untouched.`
                  : action === "repair"
                    ? `Scient will download, verify, test, and repair Codex ${actionArtifact?.version ?? ""}. The current version remains active until then.`
                    : `Scient will download, verify, stage, test, and activate Codex ${actionArtifact?.version ?? ""}.`,
        ...(action === "install" && summary.source === "system"
          ? managedRuntimeSwitchPlan({
              providerName: "Codex",
              artifact: actionArtifact,
              systemVersion: pathVersion,
            })
          : {}),
      };
      return { plan, artifact: actionArtifact };
    });

    const plan: ProviderManagedRuntimeActions["plan"] = (action) =>
      prepareAction(action).pipe(Effect.map((prepared) => prepared.plan));

    const run: ProviderManagedRuntimeActions["run"] = (
      action,
      catalogRevision,
      report,
      awaitActivationWindow = Effect.void,
    ) =>
      Effect.gen(function* () {
        const prepared = yield* prepareAction(action);
        const planned = prepared.plan;
        if (planned.catalogRevision !== catalogRevision) {
          return yield* runtimeError(
            "The qualified Codex setup plan changed. Review it again before continuing.",
          );
        }
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        const runPromise = Effect.runPromiseWith(context);
        if (action === "remove") {
          yield* awaitActivationWindow;
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
        const actionArtifact = prepared.artifact;
        if (!actionArtifact) {
          return yield* runtimeError("No qualified Codex artifact is available.");
        }
        let lastStatus: ManagedCodexRuntimeProgress["stage"] | undefined;
        let lastReportedBytes = 0;
        yield* Effect.tryPromise({
          try: (signal) =>
            runtime.install({
              artifact: actionArtifact,
              signal,
              beforeActivate: (activationSignal) =>
                runPromise(awaitActivationWindow, { signal: activationSignal }),
              qualify: async ({ executablePath, signal: qualificationSignal }) => {
                qualificationSignal.throwIfAborted();
                const qualificationDirectory = await NodeFSP.mkdtemp(
                  NodePath.join(NodeOS.tmpdir(), "scient-codex-qualification-"),
                );
                try {
                  await runPromise(
                    qualifyManagedCodexRuntime({
                      binaryPath: executablePath,
                      expectedVersion: actionArtifact.version,
                      cwd: qualificationDirectory,
                      environment: input.environment,
                      spawner: input.spawner,
                    }),
                    { signal: qualificationSignal },
                  );
                } finally {
                  await NodeFSP.rm(qualificationDirectory, {
                    recursive: true,
                    force: true,
                  }).catch(() => undefined);
                }
              },
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
            cause instanceof ProviderConnectionActionError
              ? cause
              : runtimeError("Scient could not install the private Codex runtime.", cause),
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

    // PATH Codex stands in only while the private copy fails its check, and
    // this instance launches whichever binary selection chose when it was
    // built. Re-check the private copy so the owner can switch back to it.
    const selectionChanged = Effect.gen(function* () {
      if (source !== "system" || hasCustomRuntime || !bundledArtifact) return false;
      const latest = yield* Effect.tryPromise(() => runtime.status(bundledArtifact)).pipe(
        Effect.option,
      );
      if (Option.isNone(latest) || !latest.value.installed) return false;
      // Not cached: this instance keeps launching PATH Codex until the owner
      // reloads it, and its summary must keep saying so.
      const check = yield* probeManagedRuntime(latest.value.launchPath);
      return check.healthy;
    });

    return {
      effectiveBinaryPath,
      usesManagedPath: initialPolicy.useManagedPath,
      summary,
      actions: { getSummary, plan, run, selectionChanged },
    };
  },
);
