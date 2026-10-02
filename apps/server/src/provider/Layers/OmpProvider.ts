import { OmpSettings } from "@t3tools/contracts";
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
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { compileOmpCommandCatalog } from "../omp/OmpCommandPolicy.ts";
import { ompModelToServerModel } from "../omp/OmpModel.ts";
import {
  OMP_ISOLATED_ARGS,
  ompUserDetail,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "../omp/OmpRpcProcess.ts";
import type { OmpTarget } from "../omp/OmpTarget.ts";
import {
  isCommandMissingCause,
  buildServerProvider,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const presentation = (target: OmpTarget) =>
  ({
    displayName: target.name,
    badgeLabel: "Early Access",
    reportsContextWindow: false,
    showInteractionModeToggle: false,
    supportedRuntimeModes: ["full-access"],
    supportsConversationRollback: false,
    requiresNewThreadForModelChange: false,
  }) as const;

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

const checkedAt = Effect.map(DateTime.now, DateTime.formatIso);

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

export const makePendingOmpProvider = (
  target: OmpTarget,
  settings: OmpSettings,
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

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  target: OmpTarget,
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeProcess: OmpProcessFactory,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft & { readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand> },
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
      const [models, commands] = yield* Effect.all([modelList, client.getCommands()], {
        concurrency: "unbounded",
      });
      return {
        version: client.version,
        models: models.models,
        commands: commands.commands,
        modelConnections: client.assessModelConnections?.(models.models),
        providerLabel: client.modelProviderLabel,
      };
    }),
  ).pipe(Effect.exit);
  if (discovery._tag === "Failure") {
    const error = Cause.squash(discovery.cause);
    const commandMissing =
      isCommandMissingCause(error) ||
      (isProtocolError(error) && isCommandMissingCause(error.cause));
    return buildServerProvider({
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
    });
  }
  const models = discovery.value.models.flatMap((model) => {
    const mapped = ompModelToServerModel(
      model,
      undefined,
      discovery.value.providerLabel?.(model.provider),
    );
    return mapped ? [mapped] : [];
  });
  return buildServerProvider({
    presentation: presentation(target),
    enabled: true,
    checkedAt: at,
    models,
    ...(discovery.value.modelConnections && discovery.value.modelConnections.length > 0
      ? { modelConnections: discovery.value.modelConnections }
      : {}),
    slashCommands: compileOmpCommandCatalog(discovery.value.commands).advertised,
    probe: {
      installed: true,
      version: discovery.value.version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: "unknown", required: false },
      ...(models.length > 0
        ? {}
        : { message: `${target.name} started, but it did not report any models.` }),
    },
  });
});
