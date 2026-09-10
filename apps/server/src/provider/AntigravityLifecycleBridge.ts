import {
  type AntigravityAuthMethod,
  type AntigravitySettings,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeSummary,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isManagedRuntimeUpdate } from "@scientfactory/provider-runtime";

import { ProviderConnectionActionError } from "../scient/providerLifecycle/ProviderConnectionActions.ts";
import type {
  ProviderConnectionActions,
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "./ProviderDriver.ts";
import type { AntigravityInstallation } from "./AntigravityInstallation.ts";
import { resolveAntigravityReleaseAsset } from "./antigravityRelease.ts";
import type { AntigravityReleaseAsset } from "./antigravityRelease.ts";
import { ANTIGRAVITY_ACP_REGISTRY_VERSION } from "../scient/providerLifecycle/antigravityAcpCatalog.ts";
import { antigravityAuthUsesBrowser } from "./antigravityAuthSupport.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

function isTerminalAuthPhase(
  phase: ProviderAuthState["phase"],
): phase is "succeeded" | "failed" | "cancelled" {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled";
}

function isTerminalInstallPhase(
  phase: ProviderInstallState["phase"],
): phase is "succeeded" | "failed" | "cancelled" {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled";
}

const failure = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export function antigravityConnectionMethod(method: AntigravityAuthMethod) {
  return antigravityAuthUsesBrowser(method)
    ? ("antigravity_google" as const)
    : ("antigravity_credentials" as const);
}

function authFailureMessage(state: {
  readonly phase: string;
  readonly message: string | null;
}): string {
  return (
    state.message?.trim() ||
    (state.phase === "cancelled"
      ? "Antigravity sign-in was cancelled."
      : "Antigravity sign-in did not finish.")
  );
}

/** Expose the official ACP auth controller through Scient's compact lifecycle UI. */
export function makeAntigravityConnectionActionsFromController(input: {
  readonly instanceId: ProviderInstanceId;
  readonly authMethod: AntigravityAuthMethod;
  readonly controller: ProviderAuthController;
  readonly stopSessions: Effect.Effect<void, ProviderSetupError>;
  readonly randomOwnerId: Effect.Effect<string, ProviderSetupError>;
}): ProviderConnectionActions {
  const mapSetupError = (cause: unknown) =>
    failure(
      cause instanceof Error && cause.message.trim()
        ? cause.message
        : "Antigravity could not complete the account operation.",
      cause,
    );
  return {
    methods: [antigravityConnectionMethod(input.authMethod)],
    start: (method) =>
      Effect.gen(function* () {
        if (method !== antigravityConnectionMethod(input.authMethod)) {
          return yield* failure(
            "The selected connection method does not match this Antigravity account.",
          );
        }
        const owner = `scient-provider-lifecycle-${yield* input.randomOwnerId.pipe(
          Effect.mapError((cause) => failure("Could not start Antigravity sign-in.", cause)),
        )}`;
        const started = yield* Effect.acquireRelease(
          input.controller.start(owner, input.stopSessions).pipe(Effect.mapError(mapSetupError)),
          (state) =>
            state.flowId
              ? input.controller.cancel(owner, state.flowId).pipe(Effect.ignore)
              : Effect.void,
        );
        const initial =
          started.phase === "starting"
            ? Option.getOrElse(
                yield* input.controller.subscribe(owner).pipe(
                  Stream.filter((state) => state.phase !== "starting"),
                  Stream.runHead,
                  Effect.timeoutOrElse({
                    duration: "30 seconds",
                    orElse: () =>
                      Effect.fail(failure("Antigravity did not start sign-in in time.")),
                  }),
                ),
                () => started,
              )
            : started;
        if (isTerminalAuthPhase(initial.phase) && initial.phase !== "succeeded") {
          return yield* failure(authFailureMessage(initial));
        }
        const flowId = initial.flowId ?? started.flowId;
        if (!flowId) {
          return yield* failure("Antigravity did not provide a sign-in operation identifier.");
        }
        const waitForCompletion = input.controller.subscribe(owner).pipe(
          Stream.filter((state) => state.flowId === flowId && isTerminalAuthPhase(state.phase)),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(failure("Antigravity sign-in stopped unexpectedly.")),
              onSome: (state) =>
                state.phase === "succeeded"
                  ? Effect.void
                  : Effect.fail(failure(authFailureMessage(state))),
            }),
          ),
        );
        return {
          ...(initial.authorizationUrl
            ? {
                authorizationUrl: initial.authorizationUrl,
                authorizationUrlKind: "primary" as const,
              }
            : {}),
          initialStatus:
            initial.phase === "waiting" ? ("waiting_for_browser" as const) : ("verifying" as const),
          ...(initial.phase === "waiting" && antigravityAuthUsesBrowser(input.authMethod)
            ? {
                authorizationResponseKind: "callback_url" as const,
                submitAuthorizationCode: (callbackUrl: string) =>
                  input.controller
                    .complete(owner, { flowId, callbackUrl })
                    .pipe(Effect.asVoid, Effect.mapError(mapSetupError)),
              }
            : {}),
          waitForCompletion,
          cancel: input.controller
            .cancel(owner, flowId)
            .pipe(Effect.asVoid, Effect.mapError(mapSetupError)),
        };
      }),
    disconnect: input.controller
      .logout(input.stopSessions)
      .pipe(Effect.asVoid, Effect.mapError(mapSetupError)),
  };
}

function installProgress(state: ProviderInstallState): ProviderManagedRuntimeProgress {
  const status: ProviderManagedRuntimeProgress["status"] =
    state.phase === "downloading"
      ? "downloading"
      : state.phase === "extracting"
        ? "installing"
        : state.phase === "verifying"
          ? "testing"
          : state.phase === "succeeded"
            ? "activating"
            : "preparing";
  return {
    status,
    message:
      state.message?.trim() ||
      (state.phase === "succeeded"
        ? "Activating the verified Antigravity runtime."
        : "Preparing Antigravity."),
    ...(state.downloadedBytes > 0 ? { downloadedBytes: state.downloadedBytes } : {}),
    ...(state.totalBytes && state.totalBytes > 0 ? { totalBytes: state.totalBytes } : {}),
  };
}

function runtimeRevision(version: string, sha256: string): string {
  return `antigravity-acp:${version}:${sha256}`;
}

/** Expose T3's verified ACP installer through Scient's reviewed runtime actions. */
export function makeAntigravityManagedRuntimeActions(input: {
  readonly installation: AntigravityInstallation["Service"];
  readonly settings: AntigravitySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly protectedBinaryPaths: Effect.Effect<ReadonlyArray<string>, ProviderSetupError>;
}): ProviderManagedRuntimeActions {
  const bundledAsset = resolveAntigravityReleaseAsset(input.platform, input.arch);
  const target = `${input.platform}-${input.arch}`;
  const configuredPath = input.settings.binaryPath.trim();

  const readResolution = input.installation
    .resolve(configuredPath || undefined, input.environment)
    .pipe(Effect.option);

  const getSummary: ProviderManagedRuntimeActions["getSummary"] = Effect.gen(function* () {
    const asset = yield* input.installation.latestRelease;
    const state = yield* input.installation.state;
    const resolution = yield* readResolution;
    const executable = Option.getOrUndefined(resolution);
    const source: ProviderRuntimeSummary["source"] = executable
      ? configuredPath
        ? "custom"
        : executable.source === "managed"
          ? "scient_managed"
          : "system"
      : configuredPath
        ? "unknown"
        : state.canRemove && state.phase === "failed"
          ? "scient_managed"
          : "missing";
    const fullyAssisted = asset !== null && !configuredPath;
    const installedRegistryVersion =
      executable?.registryVersion ??
      (executable?.version === bundledAsset?.version ? ANTIGRAVITY_ACP_REGISTRY_VERSION : null);
    const updateAvailable =
      source === "scient_managed" &&
      asset !== null &&
      asset.registryVersion !== undefined &&
      isManagedRuntimeUpdate({
        provider: "antigravityAcp",
        current: installedRegistryVersion,
        candidate: asset.registryVersion,
      });
    const actions: ReadonlyArray<ProviderManagedRuntimeAction> =
      source === "scient_managed" && !configuredPath
        ? [
            ...(updateAvailable ? (["update"] as const) : []),
            ...(asset ? (["repair"] as const) : []),
            "remove",
          ]
        : !fullyAssisted
          ? []
          : source === "missing" || source === "system"
            ? ["install"]
            : [];
    const message =
      source === "custom"
        ? "Scient is preserving the custom Antigravity ACP runtime configured for this account."
        : source === "system"
          ? "Scient is using the official Antigravity ACP runtime already installed on this computer."
          : source === "scient_managed"
            ? executable
              ? "Scient is using an app-private, verified Antigravity ACP runtime."
              : "The private Antigravity ACP runtime needs repair."
            : configuredPath
              ? "Scient could not launch the custom Antigravity ACP runtime. Update or clear its path."
              : asset
                ? "Scient can install Google's verified Antigravity ACP runtime privately."
                : `Google does not publish an Antigravity ACP runtime for ${target}.`;
    return {
      source,
      supportTier: fullyAssisted
        ? "fully_assisted"
        : executable
          ? "external_runtime_supported"
          : "unsupported",
      target,
      actions: [...actions],
      managedVersion: state.installedVersion,
      previousManagedVersion: null,
      operation: null,
      message,
      diagnostics: {
        executable: executable?.executablePath ?? (configuredPath || "agy_acp_server.par"),
        version: executable?.version ?? null,
        homePath: null,
        backend:
          input.platform === "darwin"
            ? "macOS native ACP"
            : input.platform === "win32"
              ? "Windows native ACP"
              : "Linux native ACP",
      },
    } satisfies ProviderRuntimeSummary;
  }).pipe(
    Effect.mapError((cause) => failure("Scient could not inspect Antigravity's runtime.", cause)),
  );

  const plan: ProviderManagedRuntimeActions["plan"] = (action) =>
    Effect.gen(function* () {
      const asset = yield* action === "remove"
        ? input.installation.latestRelease
        : input.installation.refreshLatestRelease;
      const summary = yield* getSummary;
      if (!summary.actions.includes(action) || (action !== "remove" && !asset)) {
        return yield* failure(
          `The ${action} action is not available for this Antigravity runtime.`,
        );
      }
      return {
        action,
        target,
        version: action === "remove" ? null : (asset?.version ?? null),
        downloadBytes: action === "remove" ? null : (asset?.archiveBytes ?? null),
        sourceLabel: "Official Google Antigravity ACP release",
        catalogRevision:
          action === "remove"
            ? `antigravity-acp:remove:${summary.managedVersion ?? "none"}`
            : runtimeRevision(asset!.version, asset!.sha256),
        message:
          action === "remove"
            ? "Remove Scient's private Antigravity ACP runtime. System and custom installations are untouched."
            : `${action === "repair" ? "Repair" : action === "update" ? "Update" : "Install"} Google's verified Antigravity ACP runtime privately for Scient.`,
      };
    });

  const runInstall = Effect.fn("AntigravityLifecycleBridge.runInstall")(function* (
    asset: AntigravityReleaseAsset,
    report: (progress: ProviderManagedRuntimeProgress) => Effect.Effect<void>,
  ) {
    const started = yield* input.installation.startRelease(asset);
    yield* report(installProgress(started));
    const terminal = yield* input.installation.changes.pipe(
      Stream.filter((state) => state.operationId === started.operationId),
      Stream.tap((state) => report(installProgress(state))),
      Stream.filter((state) => isTerminalInstallPhase(state.phase)),
      Stream.runHead,
      Effect.onInterrupt(() =>
        started.operationId
          ? input.installation.cancel(started.operationId).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    const state = Option.getOrUndefined(terminal);
    if (!state || state.phase !== "succeeded") {
      return yield* failure(
        state?.message?.trim() || "Antigravity installation did not finish successfully.",
      );
    }
  });

  const run: ProviderManagedRuntimeActions["run"] = (action, revision, report) =>
    Effect.gen(function* () {
      const summary = yield* getSummary;
      if (!summary.actions.includes(action)) {
        return yield* failure(`The ${action} action is no longer available for Antigravity.`);
      }
      if (action === "remove") {
        if (revision !== `antigravity-acp:remove:${summary.managedVersion ?? "none"}`) {
          return yield* failure("The Antigravity removal plan changed. Review it again.");
        }
        yield* report({
          status: "removing",
          message: "Removing Scient's private Antigravity runtime.",
        });
        yield* input.installation.remove(yield* input.protectedBinaryPaths);
        return;
      }
      const asset = yield* input.installation.latestRelease;
      if (!asset || revision !== runtimeRevision(asset.version, asset.sha256)) {
        return yield* failure("The Antigravity installation plan changed. Review it again.");
      }
      yield* runInstall(asset, report);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderConnectionActionError
          ? cause
          : cause instanceof Error && cause.message.trim()
            ? failure(cause.message, cause)
            : failure(`Scient could not ${action} Antigravity.`, cause),
      ),
    );

  return { getSummary, plan, run };
}
