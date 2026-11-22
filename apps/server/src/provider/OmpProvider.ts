import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  OmpRpcCommandError,
  OmpRpcFrameTooLargeError,
  OmpRpcProcessExitedError,
  OmpRpcProtocolError,
  OmpRpcProtocolViolationError,
  type OmpRpcError,
} from "effect-omp-rpc/errors";
import { ChildProcessSpawner } from "effect/process";

import type {
  ProviderConnectionAccount,
  ProviderStatusCheckFailure,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { compileOmpCommandCatalog } from "./omp/OmpCommandPolicy.ts";
import { OmpExecutableBusyError } from "./omp/OmpExecutableGate.ts";
import { OMP_GOAL_SLASH_COMMAND } from "./omp/OmpGoal.ts";
import { OMP_PLAN_SLASH_COMMAND } from "./omp/OmpPlan.ts";
import { ompModelToServerModel } from "./omp/OmpModel.ts";
import {
  OMP_ISOLATED_ARGS,
  ompNotInstalledDetail,
  ompStartFailedDetail,
  ompUserDetail,
  ompVersionCheckFailedDetail,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "./omp/OmpRpcProcess.ts";
import type { OmpTarget } from "./omp/OmpTarget.ts";
import {
  isCommandMissingCause,
  buildServerProvider,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

const presentation = (target: OmpTarget) =>
  ({
    displayName: target.displayName,
    badgeLabel: "Early Access",
    // SCIENT-FORK: native RPC usage now feeds the shared context meter.
    reportsContextWindow: true,
    showInteractionModeToggle: false,
    supportedRuntimeModes: ["full-access"],
    // SCIENT-FORK: rewind runs through the agent's session tree.
    supportsConversationRollback: true,
    requiresNewThreadForModelChange: false,
  }) as const;

/** The settings every target's provider shares: whether it is on and what to run. */
export interface OmpLaunchSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
}

export type OmpProcessFactory = (
  options: OmpRpcProcessOptions,
) => Effect.Effect<
  OmpRpcProcess,
  OmpRpcError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
>;

const isProtocolError = Schema.is(OmpRpcProtocolError);
const isProtocolViolation = Schema.is(OmpRpcProtocolViolationError);
const isCommandError = Schema.is(OmpRpcCommandError);
const isFrameTooLarge = Schema.is(OmpRpcFrameTooLargeError);
const isProcessExited = Schema.is(OmpRpcProcessExitedError);
const isExecutableBusy = Schema.is(OmpExecutableBusyError);

const checkedAt = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * What the agent prints before it exits when no provider offers it a model.
 * It answers nothing first, so the exit is the only sign.
 */
const NO_MODELS_OUTPUT = "No models available";

const discoveryMessage = (target: OmpTarget, error: unknown): string => {
  if (isProtocolError(error) && Schema.isSchemaError(error.cause)) {
    return `Couldn't load ${target.name}'s model information. Refresh the provider in Settings to try again.`;
  }
  if (isCommandError(error) && error.code === "timeout") {
    return `${target.name} did not answer ${error.command} in time.`;
  }
  if (isProtocolViolation(error)) {
    return `${target.name} sent output Scient could not read: ${error.detail}`;
  }
  if (isProcessExited(error)) return `${target.name} exited during the check: ${error.detail}`;
  if (isFrameTooLarge(error)) return ompUserDetail(target, error.message);
  if (isProtocolError(error) || isCommandError(error)) return ompUserDetail(target, error.detail);
  return `${target.name} could not be checked. Confirm the executable path and that version ${target.minimumVersion} or newer is installed.`;
};

/** Which step of the check failed, from error types and the details this module's process sets. */
const ompStatusCheckFailure = (target: OmpTarget, error: unknown): ProviderStatusCheckFailure => {
  if (isCommandError(error)) return error.code === "timeout" ? "command_timeout" : "command_failed";
  if (isProcessExited(error)) return "exit";
  if (isProtocolViolation(error) || isFrameTooLarge(error)) return "parse";
  if (!isProtocolError(error)) return isCommandMissingCause(error) ? "start_failed" : "other";
  if (Cause.isTimeoutError(error.cause)) return "version_timeout";
  if (Schema.isSchemaError(error.cause)) return "parse";
  if (isExecutableBusy(error.cause)) return "busy";
  switch (error.detail) {
    case ompVersionCheckFailedDetail(target):
    case target.unsupportedDetail:
      return "version_failed";
    case ompNotInstalledDetail(target):
    case ompStartFailedDetail(target):
      return "start_failed";
    default:
      return "other";
  }
};

export const makePendingOmpProvider = (
  target: OmpTarget,
  settings: OmpLaunchSettings,
): Effect.Effect<ServerProviderDraft> =>
  checkedAt.pipe(
    Effect.map((at) =>
      buildServerProvider({
        presentation: presentation(target),
        enabled: settings.enabled,
        checkedAt: at,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: settings.enabled
            ? `${target.name} has not been checked in this session yet.`
            : `${target.name} is disabled in Scient settings.`,
        },
      }),
    ),
  );

/** What a status check found, beyond the provider snapshot itself. */
export type OmpProviderStatus = ServerProviderDraft & {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /** The product's own sign-in list, when the check was asked to read it. */
  readonly accounts?: ReadonlyArray<ProviderConnectionAccount>;
  readonly checkFailure?: ProviderStatusCheckFailure;
};

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  target: OmpTarget,
  settings: OmpLaunchSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeProcess: OmpProcessFactory,
  cwd?: string,
  /**
   * Reads the product's sign-in list from the process the check already
   * started. Only a product that signs in through Scient passes it.
   */
  readAccounts?: (
    client: OmpRpcProcess,
  ) => Effect.Effect<ReadonlyArray<ProviderConnectionAccount> | undefined>,
): Effect.fn.Return<
  OmpProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const at = yield* checkedAt;
  if (!settings.enabled) return yield* makePendingOmpProvider(target, settings);
  const discovery = yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeProcess({
        target,
        command: settings.binaryPath,
        env: environment,
        extraArgs: OMP_ISOLATED_ARGS,
        ...(cwd === undefined ? {} : { cwd }),
      });
      const modelList = client.getModels().pipe(
        Effect.tapError((error) =>
          Effect.logWarning(`${target.name} provider model discovery failed.`, {
            errorType: error._tag,
            version: client.version,
            detail: client.redaction.text(error.message).slice(0, 1024),
          }),
        ),
      );
      const accountList = readAccounts ? readAccounts(client) : Effect.undefined;
      return yield* Effect.all([modelList, client.getCommands(), accountList], {
        concurrency: "unbounded",
      }).pipe(
        Effect.map(([models, commands, accounts]) => ({
          version: client.version,
          models: models.models,
          commands: commands.commands,
          accounts,
          modelConnections: client.assessModelConnections?.(models.models),
          providerLabel: client.modelProviderLabel,
          exitedWithoutModels: false,
        })),
        // A working executable with nothing to run is a setup state, not a fault.
        Effect.catchIf(isProcessExited, (error) =>
          client.shutdown.pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap((exit) =>
              exit?.stderrTail.includes(NO_MODELS_OUTPUT)
                ? Effect.succeed({
                    version: client.version,
                    models: [],
                    commands: [],
                    accounts: undefined,
                    modelConnections: undefined,
                    providerLabel: undefined,
                    exitedWithoutModels: true,
                  })
                : Effect.fail(error),
            ),
          ),
        ),
      );
    }),
  ).pipe(Effect.exit);
  if (discovery._tag === "Failure") {
    const error = Cause.squash(discovery.cause);
    // The probe tells an absent executable from one that cannot find what it runs.
    const commandMissing =
      isCommandMissingCause(error) ||
      (isProtocolError(error) && error.detail === ompNotInstalledDetail(target));
    return {
      ...buildServerProvider({
        presentation: presentation(target),
        enabled: true,
        checkedAt: at,
        models: [],
        probe: {
          installed: !commandMissing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: discoveryMessage(target, error),
        },
      }),
      checkFailure: ompStatusCheckFailure(target, error),
    };
  }
  const models = discovery.value.models.flatMap((model) => {
    const mapped = ompModelToServerModel(
      model,
      undefined,
      discovery.value.providerLabel?.(model.provider),
    );
    return mapped ? [mapped] : [];
  });
  const provider = buildServerProvider({
    presentation: presentation(target),
    enabled: true,
    checkedAt: at,
    models,
    ...(discovery.value.modelConnections && discovery.value.modelConnections.length > 0
      ? { modelConnections: discovery.value.modelConnections }
      : {}),
    slashCommands: [
      ...compileOmpCommandCatalog(discovery.value.commands).advertised,
      ...(target.driverKind === "scient" ? [OMP_GOAL_SLASH_COMMAND, OMP_PLAN_SLASH_COMMAND] : []),
    ],
    probe: {
      installed: true,
      version: discovery.value.version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: "unknown", required: false },
      // Whether the product exited or answered with an empty list, the next
      // step is the same.
      ...(models.length > 0
        ? {}
        : { message: `${target.name} has no models yet. ${target.noModelsHint}` }),
    },
  });
  return discovery.value.accounts ? { ...provider, accounts: discovery.value.accounts } : provider;
});
