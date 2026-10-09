import {
  ManagedProviderRuntimeError,
  compareManagedRuntimeReleases,
  type ManagedRuntimeArtifactReceipt,
  hydrateManagedRuntimeArtifact,
  type ManagedProviderRuntime,
  type ManagedProviderRuntimeProgress,
  ManagedRuntimeFileError,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeArtifactPolicy,
  type ManagedRuntimeCatalogProvider,
} from "@scientfactory/provider-runtime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  ProviderManagedRuntimeAction,
  ProviderRuntimeDiagnostics,
  ProviderRuntimePlan,
  ProviderRuntimeSummary,
} from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type {
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "../../provider/ProviderDriver.ts";
import { parseGenericCliVersion, spawnAndCollect } from "../../provider/providerSnapshot.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import {
  ManagedRuntimeCatalog,
  resolveManagedRuntimeCatalogCandidate,
  resolveManagedRuntimeRepairArtifact,
} from "./ManagedRuntimeCatalog.ts";
import { compareManagedRuntimeVersions } from "./managedRuntimeVersion.ts";

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

/** What `binary --version` prints when it exits 0 within five seconds. */
export const readConfiguredRuntimeVersion = Effect.fn(
  "ManagedProviderRuntimeActions.readConfiguredRuntimeVersion",
)(function* (input: {
  readonly binary: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Whether the child also inherits the server's own environment. */
  readonly extendEnv: boolean;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const resolved = yield* resolveSpawnCommand(input.binary, ["--version"], {
    env: input.environment,
    extendEnv: input.extendEnv,
  });
  const result = yield* spawnAndCollect(
    input.binary,
    ChildProcess.make(resolved.command, resolved.args, {
      env: input.environment,
      extendEnv: input.extendEnv,
      shell: resolved.shell,
    }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    Effect.timeoutOption("5 seconds"),
    Effect.result,
  );
  return result._tag === "Success" &&
    Option.isSome(result.success) &&
    result.success.value.code === 0
    ? Option.some(`${result.success.value.stdout}\n${result.success.value.stderr}`)
    : Option.none<string>();
});

/**
 * Decides whether the configured (custom or system) runtime is healthy: its
 * `--version` output when it is, none when it is not.
 */
export type ConfiguredRuntimeProbe = (
  binary: string,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) => Effect.Effect<Option.Option<string>>;

const readHealthyConfiguredRuntime: ConfiguredRuntimeProbe = (binary, environment, spawner) =>
  readConfiguredRuntimeVersion({ binary, environment, extendEnv: true, spawner });

const CURSOR_CLI_VERSION = /\b\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,40}\b/u;

/** The release a runtime's `--version` output names, in its provider's own version scheme. */
export function parseConfiguredRuntimeVersion(
  provider: ManagedRuntimeCatalogProvider,
  output: string,
): string | null {
  return provider === "cursor"
    ? (CURSOR_CLI_VERSION.exec(output)?.[0] ?? null)
    : parseGenericCliVersion(output);
}

/**
 * Whether using the managed release instead of the system runtime would move
 * to an older release. A system version Scient cannot read or compare is not
 * known to be newer.
 */
export function isManagedRuntimeDowngrade(input: {
  readonly artifact: ManagedRuntimeArtifact | undefined;
  readonly systemVersion: string | null;
}): boolean {
  return (
    input.artifact !== undefined &&
    input.systemVersion !== null &&
    compareManagedRuntimeVersions({
      provider: input.artifact.provider,
      current: input.systemVersion,
      candidate: input.artifact.version,
    }) === "older"
  );
}

/**
 * Why Codex's private copy that failed its check is not repaired or updated
 * while a newer PATH Codex stands in for it: both releases.
 */
export function managedRuntimeDowngradeMessage(input: {
  readonly providerName: string;
  readonly managedVersion: string;
  readonly systemVersion: string;
}): string {
  return `Scient-managed ${input.providerName} ${input.managedVersion} is older than the ${input.providerName} ${input.systemVersion} installed on this computer, so Scient keeps using the system installation.`;
}

/**
 * Diagnostics for choosing the qualified managed release instead of a system
 * runtime. Unknown versions stay explicit; comparison metadata is bound to the
 * catalog revision so a changed plan must be refreshed before execution.
 */
export function managedRuntimeSwitchPlan(input: {
  readonly providerName: string;
  readonly artifact: ManagedRuntimeArtifact | undefined;
  readonly systemVersion: string | null;
}): Pick<ProviderRuntimePlan, "catalogRevision" | "message" | "systemVersion" | "olderThanSystem"> {
  const { providerName, systemVersion } = input;
  const managedVersion = input.artifact?.version ?? "";
  const olderThanSystem = isManagedRuntimeDowngrade(input);
  const scope = `${providerName} accounts in this environment that use the default runtime will use`;
  const decision = olderThanSystem
    ? ":older-than-system"
    : systemVersion === null
      ? ":system-version-unknown"
      : "";
  return {
    systemVersion,
    olderThanSystem,
    catalogRevision: `${input.artifact?.catalogRevision ?? "unavailable"}${decision}`,
    message: olderThanSystem
      ? `Scient-managed ${providerName} ${managedVersion} is older than your installed ${providerName} ${systemVersion}. Scient will use its own verified copy; your installation stays as it is. ${scope} that copy; custom paths remain unchanged.`
      : systemVersion === null
        ? `Scient does not know which ${providerName} version, if any, is installed on this computer (system version unknown), so Scient-managed ${providerName} ${managedVersion} may be older than it. Scient will use its own verified copy; an existing installation stays as it is. ${scope} that copy; custom paths remain unchanged.`
        : `Scient will install private ${providerName} ${managedVersion} and use it instead of the system installation (${systemVersion}), which stays untouched. ${scope} the verified private copy; custom paths remain unchanged.`,
  };
}

export function resolveManagedRuntimeSource(input: {
  readonly hasCustomRuntime: boolean;
  readonly configuredRuntimeHealthy: boolean;
  readonly managedInstalled: boolean;
  readonly managedSelected: boolean;
}): ProviderRuntimeSummary["source"] {
  if (input.hasCustomRuntime) return input.configuredRuntimeHealthy ? "custom" : "unknown";
  if (input.managedSelected) return "scient_managed";
  if (input.configuredRuntimeHealthy) return "system";
  return input.managedInstalled ? "scient_managed" : "missing";
}

export function resolveManagedRuntimePolicy(input: {
  readonly source: ProviderRuntimeSummary["source"];
  readonly artifact: ManagedRuntimeArtifact | undefined;
  readonly installed: boolean;
  readonly installedVersion: string | null;
  readonly installedArtifact?: ManagedRuntimeArtifactReceipt | null | undefined;
  readonly managedInstallationAllowed: boolean;
  readonly systemToManagedSwitchAllowed: boolean;
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
      : input.source === "system"
        ? // Using the managed copy instead is the user's choice, whatever the
          // two releases are; the plan shows both before anything starts.
          input.systemToManagedSwitchAllowed
          ? ["install"]
          : []
        : input.source === "scient_managed"
          ? input.installed &&
            input.artifact &&
            input.installedVersion !== null &&
            compareManagedRuntimeReleases({
              provider: input.artifact.provider,
              current:
                input.installedArtifact?.version === input.installedVersion
                  ? input.installedArtifact
                  : { version: input.installedVersion },
              candidate: input.artifact,
            }) === "newer"
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
  readonly bundledArtifact: ManagedRuntimeArtifact | undefined;
  /** Compiled packaging rules may precede the first published release. */
  readonly artifactPolicy?: ManagedRuntimeArtifactPolicy | undefined;
  readonly contractRevision: number;
  readonly targetLabel: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly configuredRuntimeProbeAllowed?: boolean | undefined;
  /** A provider whose processes need more than a plain `--version` run supplies its own. */
  readonly probeConfiguredRuntime?: ConfiguredRuntimeProbe | undefined;
  readonly managedInstallationAllowed: boolean;
  readonly systemToManagedSwitchAllowed: boolean;
  readonly sourceLabel: string;
  readonly managedInstallationLimitation: string;
  readonly diagnosticsHomePath: string | null;
  readonly diagnosticsBackend: string;
}): Effect.fn.Return<ManagedProviderRuntimeResolution, never> {
  const {
    bundledArtifact,
    defaultBinary,
    environment,
    managedInstallationAllowed,
    providerName,
    providerSlug,
    runtime,
    spawner,
    targetLabel,
  } = input;
  const artifactPolicy = input.artifactPolicy ?? bundledArtifact;
  const catalogService = yield* ManagedRuntimeCatalog;
  const resolveCandidate = (refresh: boolean) =>
    (refresh ? catalogService.refresh : catalogService.current).pipe(
      Effect.map((catalog) =>
        resolveManagedRuntimeCatalogCandidate({
          catalog,
          bundledArtifact,
          artifactPolicy,
          contractRevision: input.contractRevision,
        }),
      ),
    );
  const artifact = yield* resolveCandidate(false);
  yield* Effect.tryPromise({
    try: () => runtime.reconcile(artifact),
    catch: (cause) =>
      runtimeError(`Scient could not reconcile managed ${providerName} staging.`, cause),
  }).pipe(Effect.ignore);

  // An installed receipt remains usable offline, even when this app shipped
  // before the family's first release. Reapply current packaging policy to it.
  const inspectManaged = (candidate: ManagedRuntimeArtifact | undefined) =>
    Effect.tryPromise({
      try: async () => {
        if (!artifactPolicy) return undefined;
        let inspectionArtifact = candidate ?? bundledArtifact;
        if (!inspectionArtifact) {
          const state = await runtime.readState();
          inspectionArtifact =
            state?.schemaVersion === 3
              ? hydrateManagedRuntimeArtifact(artifactPolicy, state.activeArtifact)
              : undefined;
        }
        if (!inspectionArtifact) return undefined;
        return { artifact: inspectionArtifact, status: await runtime.status(inspectionArtifact) };
      },
      catch: (cause) =>
        runtimeError(`Scient could not inspect managed ${providerName} state.`, cause),
    });

  const hasCustomRuntime = input.configuredBinaryPath !== defaultBinary;
  const probeConfiguredRuntime = (input.probeConfiguredRuntime ?? readHealthyConfiguredRuntime)(
    input.configuredBinaryPath,
    environment,
    spawner,
  ).pipe(Effect.catchCause(() => Effect.succeed(Option.none<string>())));
  const configuredRuntimeVersionOutput =
    input.configuredRuntimeProbeAllowed === false
      ? Option.none<string>()
      : yield* probeConfiguredRuntime;
  const configuredRuntimeHealthy = Option.isSome(configuredRuntimeVersionOutput);
  const systemVersionOf = (versionOutput: Option.Option<string>) =>
    artifactPolicy && Option.isSome(versionOutput)
      ? parseConfiguredRuntimeVersion(artifactPolicy.provider, versionOutput.value)
      : null;
  /**
   * The latest look at the configured runtime. The first one, above, decided
   * which runtime this instance launches; the tool can be upgraded, installed
   * or removed outside Scient afterwards, so an install looks again
   * (`prepareAction`) and summaries describe what was seen last.
   */
  const latestConfiguredRuntime = yield* Ref.make(configuredRuntimeVersionOutput);
  const configuredExecutable = configuredRuntimeHealthy
    ? yield* resolveCommandPath(input.configuredBinaryPath, {
        env: environment,
        extendEnv: true,
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.orElseSucceed(() => input.configuredBinaryPath),
      )
    : input.configuredBinaryPath;
  const inspection = yield* inspectManaged(artifact).pipe(Effect.orElseSucceed(() => undefined));
  const managedStatus = Option.fromUndefinedOr(inspection?.status);
  const managedInstalled = Option.isSome(managedStatus) && managedStatus.value.installed;
  const managedSelected = Option.isSome(managedStatus) && managedStatus.value.selected;
  const source = resolveManagedRuntimeSource({
    hasCustomRuntime,
    configuredRuntimeHealthy,
    managedInstalled,
    managedSelected,
  });
  const initialPolicy = resolveManagedRuntimePolicy({
    source,
    artifact: artifact ?? inspection?.artifact,
    installed: managedInstalled,
    installedVersion: Option.isSome(managedStatus) ? managedStatus.value.activeVersion : null,
    installedArtifact: Option.isSome(managedStatus) ? managedStatus.value.activeArtifact : null,
    managedInstallationAllowed,
    systemToManagedSwitchAllowed: input.systemToManagedSwitchAllowed,
  });
  const effectiveBinaryPath = initialPolicy.useManagedPath
    ? managedInstalled && Option.isSome(managedStatus)
      ? managedStatus.value.launchPath
      : runtime.launchPath((artifact ?? inspection?.artifact)!)
    : input.configuredBinaryPath;

  /** The runtime's state with `currentArtifact` as the release on offer. */
  const summarize = Effect.fnUntraced(function* (
    currentArtifact: ManagedRuntimeArtifact | undefined,
  ) {
    const latestInspection = yield* inspectManaged(currentArtifact);
    const latest = latestInspection?.status;
    const availableArtifact = currentArtifact ?? latestInspection?.artifact;
    const latestManagedInstalled = latest?.installed ?? false;
    const latestManagedSelected = latest?.selected ?? false;
    const latestVersionOutput = yield* Ref.get(latestConfiguredRuntime);
    const latestSource = resolveManagedRuntimeSource({
      hasCustomRuntime,
      configuredRuntimeHealthy: Option.isSome(latestVersionOutput),
      managedInstalled: latestManagedInstalled,
      managedSelected: latestManagedSelected,
    });
    const policy = resolveManagedRuntimePolicy({
      source: latestSource,
      artifact: availableArtifact,
      installed: latestManagedInstalled,
      installedVersion: latest?.activeVersion ?? null,
      installedArtifact: latest?.activeArtifact,
      managedInstallationAllowed,
      systemToManagedSwitchAllowed: input.systemToManagedSwitchAllowed,
    });
    const latestManagedVersion =
      latest?.activeVersion ?? (latestManagedInstalled ? (currentArtifact?.version ?? null) : null);
    const message =
      latestSource === "custom"
        ? `Scient is preserving the custom ${providerName} runtime configured for this account.`
        : latestSource === "system"
          ? `Scient is using the healthy ${providerName} runtime already installed on this computer.`
          : latestSource === "scient_managed"
            ? `Scient is using an app-private, verified ${providerName} runtime.`
            : hasCustomRuntime
              ? `Scient could not launch the custom ${providerName} runtime configured for this account. Update or clear the custom path in advanced provider settings.`
              : currentArtifact
                ? managedInstallationAllowed
                  ? currentArtifact.supportMessage
                  : input.managedInstallationLimitation
                : input.artifactPolicy
                  ? `No qualified ${providerName} release is available yet. You can use a configured executable.`
                  : `Scient does not have a qualified managed ${providerName} artifact for this computer.`;
    const executable = policy.useManagedPath
      ? latestManagedInstalled && latest
        ? latest.launchPath
        : availableArtifact
          ? runtime.launchPath(availableArtifact)
          : configuredExecutable
      : configuredExecutable;
    return {
      source: latestSource,
      supportTier: policy.supportTier,
      target: targetLabel,
      actions: [...policy.actions],
      managedVersion: latestManagedVersion,
      availableManagedVersion: policy.actions.includes("update")
        ? (availableArtifact?.version ?? null)
        : null,
      previousManagedVersion: latest?.previousVersion ?? null,
      operation: null,
      message,
      diagnostics: makeManagedProviderRuntimeDiagnostics({
        executable,
        source: latestSource,
        managedVersion: latestManagedVersion,
        homePath: input.diagnosticsHomePath,
        backend: input.diagnosticsBackend,
      }),
    } satisfies ProviderRuntimeSummary;
  });
  const getSummary = resolveCandidate(false).pipe(Effect.flatMap(summarize));

  const prepareAction = Effect.fn("ManagedProviderRuntimeActions.prepareAction")(function* (
    action: ProviderManagedRuntimeAction,
  ) {
    // Explicit download actions wait for a bounded, TTL-gated catalog refresh.
    // Routine checks and removal remain local and non-blocking.
    const candidateArtifact = yield* resolveCandidate(action !== "remove");
    const isDownload = action === "install" || action === "update" || action === "repair";
    const managedInspection = isDownload ? yield* inspectManaged(candidateArtifact) : undefined;
    const managed = managedInspection?.status;
    // The release this action installs, as planned here and as `run` installs it.
    const actionArtifact =
      action === "repair"
        ? resolveManagedRuntimeRepairArtifact({
            bundledArtifact,
            artifactPolicy,
            candidateArtifact,
            activeArtifact: managed?.activeArtifact,
          })
        : isDownload
          ? candidateArtifact
          : undefined;
    // A download puts the managed copy in use, unless the user already selected
    // it: then it is the runtime in use and maintaining it replaces nothing.
    // Otherwise (no copy, or a legacy copy that was never selected) look at
    // the system runtime now, whatever was seen when this instance was built.
    // A disabled instance's tool is never run: its system runtime stays unknown.
    const replacesUnselected = isDownload && !hasCustomRuntime && managed?.selected !== true;
    const probeAllowed = input.configuredRuntimeProbeAllowed !== false;
    if (replacesUnselected && probeAllowed)
      yield* Ref.set(latestConfiguredRuntime, yield* probeConfiguredRuntime);
    // The same release decides whether the action is offered at all.
    const summary = yield* summarize(candidateArtifact);
    // A copy that was never explicitly selected is offered Repair and Update
    // while its instance is not probed. They stay available once the fresh
    // look found a healthy system runtime beside it, as the switch they are
    // (below): the download records the selection the user decided on.
    const unselectedCopyActions =
      managed?.installed === true && managed.selected !== true && !hasCustomRuntime
        ? resolveManagedRuntimePolicy({
            source: "scient_managed",
            artifact: candidateArtifact ?? managedInspection?.artifact,
            installed: true,
            installedVersion: managed.activeVersion,
            installedArtifact: managed.activeArtifact,
            managedInstallationAllowed,
            systemToManagedSwitchAllowed: input.systemToManagedSwitchAllowed,
          }).actions
        : [];
    if (!summary.actions.includes(action) && !unselectedCopyActions.includes(action)) {
      return yield* runtimeError(
        `The ${action} action is not available for this ${providerName} runtime.`,
      );
    }
    if (isDownload && !actionArtifact) {
      return yield* runtimeError(
        `No qualified ${providerName} artifact is available for this computer.`,
      );
    }
    const plan = {
      action,
      target: targetLabel,
      version: isDownload ? (actionArtifact?.version ?? null) : summary.managedVersion,
      downloadBytes: isDownload ? (actionArtifact?.size ?? null) : null,
      sourceLabel: input.sourceLabel,
      catalogRevision: isDownload
        ? (actionArtifact?.catalogRevision ?? "unavailable")
        : `managed-${providerSlug}:${action}:${summary.managedVersion ?? "none"}`,
      message:
        action === "remove"
          ? `Scient will remove only its app-private ${providerName} copy. Custom and system installations are untouched.`
          : action === "update"
            ? `Scient will download, verify, test, and activate ${providerName} ${actionArtifact?.version ?? ""}. The current version remains active until then.`
            : action === "repair" && summary.source === "system"
              ? `Scient will repair the private ${providerName} ${actionArtifact?.version ?? ""} release and use it after verification. The working system installation is untouched.`
              : action === "repair"
                ? `Scient will download, verify, test, and repair ${providerName} ${actionArtifact?.version ?? ""}. The current version remains active until then.`
                : `Scient will download, verify, stage, test, and activate ${providerName} ${actionArtifact?.version ?? ""}.`,
      // Install beside a system runtime, and Repair or Update of a copy that was
      // never selected, put the managed copy in use in its place (or may: a
      // disabled instance's system runtime is unknown). One decision for all:
      // both releases, compared with the release that will be installed.
      ...(replacesUnselected && (summary.source === "system" || !probeAllowed)
        ? managedRuntimeSwitchPlan({
            providerName,
            artifact: actionArtifact,
            systemVersion: systemVersionOf(yield* Ref.get(latestConfiguredRuntime)),
          })
        : {}),
    };
    return { plan, artifact: actionArtifact };
  });

  const plan: ProviderManagedRuntimeActions["plan"] = (action) =>
    prepareAction(action).pipe(Effect.map((prepared) => prepared.plan));

  const progressMessage = (progress: ManagedProviderRuntimeProgress): string => {
    switch (progress.stage) {
      case "preparing":
        return `Preparing the private ${providerName} runtime.`;
      case "downloading":
        return `Downloading ${providerName} from the qualified official release.`;
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
          `The qualified ${providerName} setup plan changed. Review it again before continuing.`,
        );
      }
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const runPromise = Effect.runPromiseWith(context);
      if (action === "remove") {
        yield* awaitActivationWindow;
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
      const actionArtifact = prepared.artifact;
      if (!actionArtifact) {
        return yield* runtimeError(`No qualified ${providerName} artifact is available.`);
      }
      let lastStatus: ManagedProviderRuntimeProgress["stage"] | undefined;
      let lastReportedBytes = 0;
      yield* Effect.tryPromise({
        try: (signal) =>
          runtime.install({
            artifact: actionArtifact,
            signal,
            beforeActivate: (activationSignal) =>
              runPromise(awaitActivationWindow, { signal: activationSignal }),
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
          cause instanceof ProviderConnectionActionError
            ? cause
            : runtimeError(managedRuntimeInstallationFailureMessage(providerName, cause), cause),
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
