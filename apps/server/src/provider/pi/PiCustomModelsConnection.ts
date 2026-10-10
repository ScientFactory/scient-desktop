import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process";
import {
  makePiRpcConnection,
  PiRpcError as ConnectionError,
  PiRpcTimeoutError as ConnectionTimeoutError,
  piRecordString,
  type PiRpcConnection,
  type PiRpcRecord,
  type PiRpcSpawnOptions as ConnectionSpawnOptions,
} from "../../orchestration-v2/Adapters/PiRpc.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { makePiCustomModelsClientFactory } from "./PiCustomModels.ts";
import { PiRpcProtocolError, type PiRpcClient, type PiRpcError } from "./PiRpcClient.ts";
import {
  PiRpcAvailableModels,
  PiRpcCommands,
  PiRpcModel,
  PiRpcSessionStats,
  PiRpcState,
  PiRpcThinkingLevels,
} from "./PiRpcSchema.ts";

const decodeModels = Schema.decodeUnknownEffect(PiRpcAvailableModels);
const decodeCommands = Schema.decodeUnknownEffect(PiRpcCommands);
const decodeModel = Schema.decodeUnknownEffect(PiRpcModel);
const decodeStats = Schema.decodeUnknownEffect(PiRpcSessionStats);
const decodeState = Schema.decodeUnknownEffect(PiRpcState);
const decodeLevels = Schema.decodeUnknownEffect(PiRpcThinkingLevels);
const isConnectionError = Schema.is(Schema.Union([ConnectionError, ConnectionTimeoutError]));
const connectionError = (cause: unknown) =>
  isConnectionError(cause)
    ? cause
    : new ConnectionError({
        operation: "custom models",
        detail: cause instanceof Error ? cause.message : "Pi model integration failed.",
        cause,
      });
const isSendError = Schema.is(ConnectionError);
const sendError = (cause: unknown) =>
  isSendError(cause)
    ? cause
    : new ConnectionError({
        operation: "custom models",
        detail: cause instanceof Error ? cause.message : "Pi model integration failed.",
        cause,
      });
const nativeError = (cause: unknown) =>
  new PiRpcProtocolError({ detail: "Pi model integration failed.", cause });

/** A typed facade for the model authority wrapper; V2 retains the only event consumer. */
function modelClient(connection: PiRpcConnection): PiRpcClient {
  const request = (record: PiRpcRecord) =>
    connection.request(record).pipe(Effect.mapError(nativeError));
  return {
    events: Stream.empty,
    getState: () =>
      request({ type: "get_state" }).pipe(
        Effect.flatMap(decodeState),
        Effect.mapError(nativeError),
      ),
    getAvailableModels: () =>
      request({ type: "get_available_models" }).pipe(
        Effect.flatMap(decodeModels),
        Effect.mapError(nativeError),
      ),
    getCommands: () =>
      request({ type: "get_commands" }).pipe(
        Effect.flatMap(decodeCommands),
        Effect.mapError(nativeError),
      ),
    getThinkingLevels: () =>
      request({ type: "get_available_thinking_levels" }).pipe(
        Effect.flatMap(decodeLevels),
        Effect.mapError(nativeError),
      ),
    getSessionStats: () =>
      request({ type: "get_session_stats" }).pipe(
        Effect.flatMap(decodeStats),
        Effect.mapError(nativeError),
      ),
    setModel: (provider, modelId) =>
      request({ type: "set_model", provider, modelId }).pipe(
        Effect.flatMap(decodeModel),
        Effect.mapError(nativeError),
      ),
    setThinkingLevel: (level) => request({ type: "set_thinking_level", level }).pipe(Effect.asVoid),
    prompt: (message, images, streamingBehavior) =>
      request({
        type: "prompt",
        message,
        ...(images === undefined ? {} : { images }),
        ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
      }).pipe(Effect.asVoid),
    abort: () => request({ type: "abort" }).pipe(Effect.asVoid),
    clearQueue: () => request({ type: "clear_queue" }).pipe(Effect.asVoid),
    synchronizeEvents: () => Effect.die("The model authority facade must not consume V2 events."),
    respondToExtensionUi: (response) =>
      connection
        .send({ type: "extension_ui_response", ...response })
        .pipe(Effect.mapError(nativeError)),
    close: () => connection.terminate,
  };
}

/** Instance-scoped custom-model authority over the same raw connection V2 executes. */
export const makePiCustomModelsConnectionFactory = Effect.fn("PiCustomModelsConnection.make")(
  function* (
    settings: Pick<
      ServerSettingsService["Service"],
      "resolveCustomModels" | "getSettings" | "subscribeChanges"
    >,
    instanceId: ProviderInstanceId,
    stateDir: string,
    spawn: (
      options: ConnectionSpawnOptions,
    ) => Effect.Effect<
      PiRpcConnection,
      ConnectionError,
      ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
    > = makePiRpcConnection,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (options: ConnectionSpawnOptions) =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<PiRpcConnection, PiRpcError>();
        const factory = yield* makePiCustomModelsClientFactory(
          settings,
          instanceId,
          stateDir,
          (prepared) =>
            Effect.gen(function* () {
              const connection = yield* spawn({
                command: prepared.command,
                args: prepared.args ?? [],
                cwd: prepared.cwd,
                env: prepared.env ?? {},
              }).pipe(Effect.mapError(nativeError));
              yield* Deferred.succeed(opened, connection);
              return modelClient(connection);
            }),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(nativeError),
        );
        const ready = yield* Deferred.make<
          Effect.Success<ReturnType<typeof factory>>,
          PiRpcError
        >();
        // Return the connection as soon as it exists. The adapter starts its event
        // pump before initialization may ask an extension to resolve a dialog.
        yield* factory({
          command: options.command,
          args: options.args,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: options.env,
        }).pipe(
          Effect.tapError((cause) => Deferred.fail(opened, cause)),
          Deferred.into(ready),
          Effect.forkScoped,
        );
        const connection = yield* Deferred.await(opened);
        return {
          ...connection,
          request: (record: PiRpcRecord, timeoutMs?: number) =>
            Effect.gen(function* () {
              const client = yield* Deferred.await(ready);
              switch (record.type) {
                case "set_model": {
                  const provider = piRecordString(record, "provider");
                  const modelId = piRecordString(record, "modelId");
                  if (provider === undefined || modelId === undefined)
                    return yield* new PiRpcProtocolError({ detail: "Invalid Pi model selection." });
                  return yield* client.setModel(provider, modelId);
                }
                case "get_available_models":
                  return yield* client.getAvailableModels();
                case "get_available_thinking_levels":
                  return yield* client.getThinkingLevels();
                case "get_commands":
                  return yield* client.getCommands();
                case "get_state": {
                  // Settlement probes keep their short timeout and retain metadata.
                  const state = yield* connection
                    .request(record, timeoutMs)
                    .pipe(Effect.flatMap(decodeState));
                  return {
                    ...state,
                    ...(state.model === undefined
                      ? {}
                      : { model: client.annotateModel(state.model) }),
                  };
                }
                default:
                  return yield* connection.request(record, timeoutMs);
              }
            }).pipe(Effect.mapError(connectionError)),
          send: (record: PiRpcRecord) =>
            (record.type === "prompt" || record.type === "compact"
              ? Deferred.await(ready).pipe(
                  Effect.flatMap((client) => client.validateModelAuthority()),
                )
              : Effect.void
            ).pipe(Effect.andThen(connection.send(record)), Effect.mapError(sendError)),
        };
      }).pipe(Effect.mapError(sendError));
  },
);
