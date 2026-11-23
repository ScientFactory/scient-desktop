import {
  type AntigravityAuthMethod,
  type AntigravitySettings,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderConnectionFailureReason,
  type ProviderInstallState,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeSummary,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  isProviderConnectionActionError,
  ProviderConnectionActionError,
} from "./ProviderConnectionActions.ts";
import type {
  ProviderConnectionActions,
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "../../provider/ScientProviderInstanceSeams.ts";
import type { AntigravityInstallation } from "../../provider/AntigravityInstallation.ts";
import {
  ANTIGRAVITY_ACP_REGISTRY_VERSION,
  resolveAntigravityReleaseAsset,
} from "./antigravityAcpCatalog.ts";
import {
  antigravityReleaseDownloadBytes,
  antigravityReleaseIdentity,
  antigravityReleaseRevision,
  supersedesAntigravityRelease,
  type AntigravityManagedRelease,
  type AntigravityReleaseIdentity,
} from "./antigravityRuntimeRelease.ts";
import { ManagedRuntimeCatalog } from "./ManagedRuntimeCatalog.ts";
import { antigravityAuthUsesBrowser } from "../../provider/antigravityAuthSupport.ts";
import type { ProviderAuthController } from "../../provider/ProviderAuthService.ts";
import { ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE } from "./antigravityAuthDiagnostics.ts";

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

const failure = (message: string, cause?: unknown, reason?: ProviderConnectionFailureReason) =>
  new ProviderConnectionActionError({
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(reason === undefined ? {} : { failureReason: reason }),
  });

export const ANTIGRAVITY_STARTING_MESSAGE = "Antigravity can take up to a minute to start.";

const CLI_SWITCH_MESSAGE =
  "An update moves Antigravity to Google's agy CLI, which runs your Antigravity plugins in Scient chats.";

export function antigravityConnectionMethod(method: AntigravityAuthMethod) {
  return antigravityAuthUsesBrowser(method)
    ? ("antigravity_google" as const)
    : ("antigravity_credentials" as const);
}

function authFailure(state: {
  readonly phase: string;
  readonly message: string | null;
  readonly failureReason?: ProviderConnectionFailureReason | undefined;
}) {
  const message =
    state.message?.trim() ||
    (state.phase === "cancelled"
      ? "Antigravity sign-in was cancelled."
      : "Antigravity sign-in did not finish.");
  const afterSignIn = message === ANTIGRAVITY_SESSION_SETUP_FAILED_MESSAGE;
  const reason =
    (state.phase === "failed" ? state.failureReason : undefined) ??
    (afterSignIn ? "post_signin_setup" : state.phase === "cancelled" ? "flow_stopped" : undefined);
  return new ProviderConnectionActionError({
    message,
    ...(afterSignIn ? { afterSignIn: true } : {}),
    ...(reason === undefined ? {} : { failureReason: reason }),
  });
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
    startingMessage: ANTIGRAVITY_STARTING_MESSAGE,
    start: Effect.fn("AntigravityAcpLifecycleActions.start")(function* (method) {
      if (method !== antigravityConnectionMethod(input.authMethod)) {
        return yield* failure(
          "The selected connection method does not match this Antigravity account.",
          undefined,
          "start_failed",
        );
      }
      const owner = `scient-provider-lifecycle-${yield* input.randomOwnerId.pipe(
        Effect.mapError((cause) =>
          failure("Could not start Antigravity sign-in.", cause, "start_failed"),
        ),
      )}`;
      const started = yield* Effect.acquireRelease(
        input.controller
          .start(owner, input.stopSessions)
          .pipe(
            Effect.mapError((cause) =>
              failure(mapSetupError(cause).message, cause, "start_failed"),
            ),
          ),
        (state) =>
          state.flowId
            ? input.controller.cancel(owner, state.flowId).pipe(Effect.ignore)
            : Effect.void,
      );
      const initial =
        started.phase === "starting"
          ? yield* input.controller.subscribe(owner).pipe(
              Stream.filter((state) => state.phase !== "starting"),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      failure(
                        "Antigravity sign-in stopped unexpectedly.",
                        undefined,
                        "flow_stopped",
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            )
          : started;
      if (isTerminalAuthPhase(initial.phase) && initial.phase !== "succeeded") {
        return yield* authFailure(initial);
      }
      const flowId = initial.flowId ?? started.flowId;
      if (!flowId) {
        return yield* failure(
          "Antigravity did not provide a sign-in operation identifier.",
          undefined,
          "invalid_response",
        );
      }
      // The managed 1.4.5 harness finishes on a loopback callback URL; the agy CLI asks for the
      // code its Antigravity page shows, through a credentials interaction.
      const interaction =
        initial.phase !== "waiting"
          ? null
          : initial.interaction !== undefined
            ? initial.interaction
            : yield* input.controller.subscribe(owner).pipe(
                Stream.runHead,
                Effect.map((state) =>
                  Option.isSome(state) && state.value.flowId === flowId
                    ? (state.value.interaction ?? null)
                    : null,
                ),
              );
      const codeField =
        interaction?.type === "credentials" && interaction.fields.length === 1
          ? interaction.fields[0]?.name
          : undefined;
      const respond = input.controller.respond;
      const waitForCompletion = input.controller.subscribe(owner).pipe(
        Stream.filter((state) => state.flowId === flowId && isTerminalAuthPhase(state.phase)),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                failure("Antigravity sign-in stopped unexpectedly.", undefined, "flow_stopped"),
              ),
            onSome: (state) =>
              state.phase === "succeeded" ? Effect.void : Effect.fail(authFailure(state)),
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
        ...(initial.phase !== "waiting" || !antigravityAuthUsesBrowser(input.authMethod)
          ? {}
          : interaction?.type === "credentials" && codeField !== undefined && respond
            ? {
                authorizationResponseKind: "code" as const,
                submitAuthorizationCode: (code: string) =>
                  respond(owner, {
                    instanceId: input.instanceId,
                    flowId,
                    interactionId: interaction.id,
                    response: { type: "credentials", values: { [codeField]: code } },
                  }).pipe(Effect.asVoid, Effect.mapError(mapSetupError)),
              }
            : {
                authorizationResponseKind: "callback_url" as const,
                submitAuthorizationCode: (callbackUrl: string) =>
                  input.controller
                    .complete(owner, { flowId, callbackUrl })
                    .pipe(Effect.asVoid, Effect.mapError(mapSetupError)),
              }),
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
  // The CLI keeps its own sign-in; a paired runtime's Google sign-in does not carry over.
  const signInAgain = antigravityAuthUsesBrowser(input.settings.authMethod)
    ? " You'll sign in to Google again after it."
    : "";

  const readResolution = input.installation
    .resolve(configuredPath || undefined, input.environment)
    .pipe(Effect.option);

  const getSummary: ProviderManagedRuntimeActions["getSummary"] = Effect.gen(function* () {
    const catalog = yield* (yield* ManagedRuntimeCatalog).freshness;
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
    const installed: AntigravityReleaseIdentity | undefined = executable && {
      cli: executable.harnessPath === null,
      version: executable.version,
      registryVersion:
        executable.registryVersion ??
        (executable.harnessPath !== null && executable.version === bundledAsset?.version
          ? ANTIGRAVITY_ACP_REGISTRY_VERSION
          : undefined),
    };
    const candidate = asset ? antigravityReleaseIdentity(asset) : undefined;
    const updateAvailable =
      source === "scient_managed" &&
      installed !== undefined &&
      candidate !== undefined &&
      supersedesAntigravityRelease(installed, candidate);
    // Repair reinstalls the catalog's release, so it never replaces a newer install with an older one.
    const repairAvailable =
      asset !== null &&
      (installed === undefined ||
        candidate === undefined ||
        !supersedesAntigravityRelease(candidate, installed));
    const switchesToCli = updateAvailable && candidate?.cli === true && installed?.cli === false;
    const actions: ReadonlyArray<ProviderManagedRuntimeAction> =
      source === "scient_managed" && !configuredPath
        ? [
            ...(updateAvailable ? (["update"] as const) : []),
            ...(repairAvailable ? (["repair"] as const) : []),
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
              ? switchesToCli
                ? `${CLI_SWITCH_MESSAGE}${signInAgain}`
                : "Scient is using an app-private, verified Antigravity ACP runtime."
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
      availableManagedVersion: updateAvailable
        ? candidate?.cli
          ? (candidate.version ?? null)
          : (candidate?.registryVersion ?? null)
        : null,
      previousManagedVersion: null,
      // No `qualifiedVersion`: the installed executable and its registry
      // release are numbered differently, so "Up to date" is never claimed.
      catalog,
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

  const plan: ProviderManagedRuntimeActions["plan"] = Effect.fn(
    "AntigravityAcpLifecycleActions.plan",
  )(function* (action) {
    const asset = yield* action === "remove"
      ? input.installation.latestRelease
      : input.installation.refreshLatestRelease;
    const summary = yield* getSummary;
    if (action === "remove") {
      if (!summary.actions.includes(action)) {
        return yield* failure(
          `The ${action} action is not available for this Antigravity runtime.`,
        );
      }
      return {
        action,
        target,
        version: null,
        downloadBytes: null,
        sourceLabel: "Official Google Antigravity ACP release",
        catalogRevision: `antigravity-acp:remove:${summary.managedVersion ?? "none"}`,
        message:
          "Remove Scient's private Antigravity ACP runtime. System and custom installations are untouched.",
      };
    }
    if (!summary.actions.includes(action) || !asset) {
      return yield* failure(`The ${action} action is not available for this Antigravity runtime.`);
    }
    const cli = antigravityReleaseIdentity(asset).cli;
    const replacesPaired =
      cli && Option.exists(yield* readResolution, (current) => current.harnessPath !== null);
    const verb = action === "repair" ? "Repair" : action === "update" ? "Update" : "Install";
    return {
      action,
      target,
      version: asset.version,
      downloadBytes: antigravityReleaseDownloadBytes(asset),
      sourceLabel: cli
        ? "Official Google Antigravity CLI release"
        : "Official Google Antigravity ACP release",
      catalogRevision: antigravityReleaseRevision(asset),
      // Only the agy CLI loads Antigravity plugins.
      nativePlugins: cli,
      message: cli
        ? `${verb} Google's verified Antigravity CLI privately for Scient. It runs your Antigravity plugins in Scient chats.${replacesPaired ? signInAgain : ""}`
        : `${verb} Google's verified Antigravity ACP runtime privately for Scient.`,
    };
  });

  const runInstall = Effect.fn("AntigravityLifecycleBridge.runInstall")(function* (
    asset: AntigravityManagedRelease,
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

  // The Antigravity installer replaces its runtime in one step, so the
  // activation window is awaited before installing rather than mid-install.
  const runEffect = Effect.fn("AntigravityAcpLifecycleActions.run")(
    function* (
      action: Parameters<ProviderManagedRuntimeActions["run"]>[0],
      revision: Parameters<ProviderManagedRuntimeActions["run"]>[1],
      report: Parameters<ProviderManagedRuntimeActions["run"]>[2],
      awaitActivationWindow: NonNullable<Parameters<ProviderManagedRuntimeActions["run"]>[3]>,
    ) {
      const summary = yield* getSummary;
      if (!summary.actions.includes(action)) {
        return yield* failure(`The ${action} action is no longer available for Antigravity.`);
      }
      if (action === "remove") {
        if (revision !== `antigravity-acp:remove:${summary.managedVersion ?? "none"}`) {
          return yield* failure("The Antigravity removal plan changed. Review it again.");
        }
        yield* awaitActivationWindow;
        yield* report({
          status: "removing",
          message: "Removing Scient's private Antigravity runtime.",
        });
        yield* input.installation.remove(yield* input.protectedBinaryPaths);
        return;
      }
      const asset = yield* input.installation.latestRelease;
      if (!asset || revision !== antigravityReleaseRevision(asset)) {
        return yield* failure("The Antigravity installation plan changed. Review it again.");
      }
      yield* awaitActivationWindow;
      yield* runInstall(asset, report);
    },
    (effect, action) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProviderConnectionActionError(cause)
            ? cause
            : cause instanceof Error && cause.message.trim()
              ? failure(cause.message, cause)
              : failure(`Scient could not ${action} Antigravity.`, cause),
        ),
      ),
  );

  const run: ProviderManagedRuntimeActions["run"] = (
    action,
    revision,
    report,
    awaitActivationWindow = Effect.void,
  ) => runEffect(action, revision, report, awaitActivationWindow);

  return { getSummary, plan, run };
}
