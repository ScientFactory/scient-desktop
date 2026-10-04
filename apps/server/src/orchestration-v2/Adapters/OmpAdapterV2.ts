import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type OmpSettings,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  OMP_KNOWN_EVENT_TYPES,
  OMP_RPC_PROTOCOL_V2,
  isRecord,
  type OmpRpcImage,
} from "effect-omp-rpc/schema";
import type { OmpRpcFrameTrace, OmpRpcNotification } from "effect-omp-rpc/client";
import { expandHomePath } from "../../pathExpansion.ts";
import { ompTarget, type OmpTarget } from "../../provider/omp/OmpTarget.ts";
import {
  assertReadableOmpSessionFile,
  ompSessionFilesEqual,
} from "../../provider/omp/OmpSessionFile.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import type { ServerConfig } from "../../config.ts";
import {
  readMcpProviderSession,
  withAgentDeviceEnvironment,
} from "../../mcp/McpProviderSession.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { ompCommandDecision } from "../../provider/omp/OmpCommandPolicy.ts";
import { writeOmpExtensionFiles } from "../../provider/omp/OmpExtensionBootstrap.ts";
import { ompScientExtensionSource } from "../../provider/omp/OmpScientExtension.ts";
import {
  makeOmpRedaction,
  type OmpRpcProcess,
  type OmpProcessExit,
} from "../../provider/omp/OmpRpcProcess.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import {
  decodeOmpModelSlug,
  encodeOmpModelSlug,
  ompThinkingLevel,
  ompModelThinkingLevels,
} from "../../provider/omp/OmpModel.ts";
import {
  ompSessionDirectoryKey,
  sessionFileInsideRoot,
  makeOmpSessionCursor,
  parseOmpSessionCursor,
  type OmpSessionCursor,
} from "../../provider/omp/OmpSessionCursor.ts";
import {
  acquireOmpSessionLock,
  releaseOmpSessionLock,
  makeOmpSessionLockRegistry,
} from "../../provider/omp/OmpSessionLock.ts";
import {
  makeOmpSessionRuntime,
  type OmpSessionUpdate,
} from "../../provider/omp/OmpSessionRuntime.ts";
import type { OmpProcessFactory } from "../../provider/Layers/OmpProvider.ts";
import { formatOmpBytes, planOmpImages } from "../../provider/omp/OmpImagePrompt.ts";
import {
  browserActionUrl,
  browserActionText,
  browserActionDiagnostic,
} from "../../provider/omp/OmpBrowserAction.ts";
import type * as ProviderAdapter from "../ProviderAdapter.ts";
import { AcpProviderCapabilitiesV2 } from "./AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  nativeSessionFailure,
  NativeSessionOperationError,
  type NativeSession,
  type NativeSessionUpdate,
  type NativeSessionAdapterV2Options,
} from "./NativeSessionAdapterV2.ts";

export interface OmpAdapterV2Options extends Pick<
  NativeSessionAdapterV2Options,
  "instanceId" | "idAllocator" | "continuations"
> {
  readonly target?: OmpTarget;
  readonly settings: Pick<OmpSettings, "binaryPath"> & {
    readonly homePath?: string | undefined;
    readonly profile?: string | undefined;
  };
  readonly homePath?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly serverConfig: ServerConfig["Service"];
  readonly makeProcess: OmpProcessFactory;
  readonly nativeEventLogger?: EventNdjsonLogger;
}
const JsonString = Schema.fromJsonString(Schema.String);
const encodeJsonString = Schema.encodeSync(JsonString);
const encodeJsonStringEffect = Schema.encodeEffect(JsonString);

const encodeToolJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const nativeToolText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["text", "message", "output", "content"] as const)
    if (typeof value[key] === "string") return value[key];
  if (!Array.isArray(value.content)) return undefined;
  const parts = value.content.flatMap((part) =>
    isRecord(part) && typeof part.text === "string" ? [part.text] : [],
  );
  return parts.length ? parts.join("") : undefined;
};
const boundedToolText = (value: string) =>
  Buffer.byteLength(value) <= 4096 ? value : `${Array.from(value).slice(0, 1024).join("")}…`;
const boundedToolInput = (value: unknown) => {
  const serialized = encodeToolJson(value);
  return Buffer.byteLength(serialized) <= 4096
    ? value
    : {
        truncated: true,
        originalBytes: Buffer.byteLength(serialized),
        preview: Array.from(serialized).slice(0, 1024).join(""),
      };
};

export function makeOmpAdapterV2(options: OmpAdapterV2Options) {
  const target = options.target ?? ompTarget;
  const locks = makeOmpSessionLockRegistry();
  return makeNativeSessionAdapterV2({
    ...options,
    mcpSessionInjection: true,
    defaultCwd: options.serverConfig.cwd,
    driver: target.driverKind,
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
      threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
      turns: {
        ...AcpProviderCapabilitiesV2.turns,
        supportsActiveSteering: true,
        supportsQueuedMessages: true,
      },
      streaming: {
        ...AcpProviderCapabilitiesV2.streaming,
        streamsReasoning: true,
        streamsToolOutput: true,
      },
      tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
      planning: {
        ...AcpProviderCapabilitiesV2.planning,
        emitsPlanUpdated: false,
        emitsTodoList: false,
      },
      subagents: {
        ...AcpProviderCapabilitiesV2.subagents,
        supportsSubagents: true,
        emitsSubagentLifecycle: true,
      },
      checkpointing: {
        ...AcpProviderCapabilitiesV2.checkpointing,
        providerCanRollbackConversation: false,
        providerRollbackReturnsSnapshot: false,
      },
    },
    open: (input, onUpdate) =>
      Effect.gen(function* () {
        let redaction = makeOmpRedaction(options.environment, [
          readMcpProviderSession(input.threadId)?.authorizationHeader,
        ]);
        const safeFailure = (cause: unknown) => {
          const failure = nativeSessionFailure(cause);
          return new NativeSessionOperationError({
            detail: redaction.text(failure.detail),
            ...(failure.breaksSession === undefined
              ? {}
              : { breaksSession: failure.breaksSession }),
            ...(failure.cause === undefined ? {} : { cause: redaction.log(failure.cause) }),
          });
        };
        const sessionScope = yield* Scope.make();
        const closed = yield* Deferred.make<void>();
        let closing = false;
        // Parent release must join cleanup already started by process loss.
        const closeSession = (exit: Exit.Exit<unknown, unknown>) =>
          Effect.uninterruptible(
            Effect.suspend(() => {
              if (closing) return Deferred.await(closed);
              closing = true;
              return Scope.close(sessionScope, exit).pipe(
                Effect.ensuring(Deferred.succeed(closed, undefined)),
              );
            }),
          );
        yield* Effect.addFinalizer(closeSession);
        return yield* Effect.gen(function* () {
          if (
            input.runtimePolicy.runtimeMode !== "full-access" ||
            input.runtimePolicy.approvalPolicy !== undefined ||
            input.runtimePolicy.sandboxPolicy !== undefined
          )
            return yield* Effect.fail(
              new NativeSessionOperationError({
                detail: `${target.name} supports only full access and has no native sandbox.`,
              }),
            );
          const { fileSystem: fs, path } = options;
          const scope = yield* Effect.scope;
          const cwd = yield* fs.realPath(input.runtimePolicy.cwd ?? options.serverConfig.cwd);
          const sessionRoot = path.join(
            options.serverConfig.stateDir,
            `${target.stateNamespace}-sessions`,
            ompSessionDirectoryKey(options.instanceId, input.threadId),
          );
          yield* fs.makeDirectory(sessionRoot, { recursive: true, mode: 0o700 });
          const root = yield* fs.realPath(sessionRoot);
          const stateRoot = yield* fs.realPath(options.serverConfig.stateDir);
          if (!sessionFileInsideRoot(stateRoot, root))
            return yield* Effect.fail(
              new NativeSessionOperationError({
                detail: `${target.name} session directory escaped Scient's state directory.`,
              }),
            );
          let ownedShutdown: OmpRpcProcess["shutdown"] | undefined;
          const sessionLock = yield* Effect.acquireRelease(
            acquireOmpSessionLock(target, path.join(root, ".session.lock"), locks),
            (lock) =>
              Effect.gen(function* () {
                if (ownedShutdown !== undefined) {
                  const exit = yield* ownedShutdown.pipe(Effect.option);
                  if (
                    Option.isNone(exit) ||
                    (exit.value.code === null && exit.value.exited !== true)
                  )
                    return;
                }
                yield* releaseOmpSessionLock(lock, locks);
              }),
          );
          // The owned lock excludes another writer while crash-left prompt files are removed.
          for (const name of yield* fs.readDirectory(root)) {
            if (
              /^scient-(?:prompt|context)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.txt$/iu.test(
                name,
              )
            )
              yield* fs.remove(path.join(root, name), { force: true });
          }
          const mcp =
            input.configureMcp === false ? undefined : readMcpProviderSession(input.threadId);
          if (mcp && mcp.providerInstanceId !== options.instanceId)
            return yield* Effect.fail(
              new NativeSessionOperationError({
                detail: "The tool session belongs to another provider instance.",
              }),
            );
          const extension = yield* writeOmpExtensionFiles({
            target,
            directory: root,
            name: `scient-extension-${yield* options.crypto.randomUUIDv4}`,
            source: (bootstrapPath) => ompScientExtensionSource(target, bootstrapPath),
            bootstrap: {
              endpoint: mcp?.endpoint ?? null,
              authorization: mcp?.authorizationHeader ?? null,
              awareness: buildScientAwareness(mcp?.capabilities),
            },
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          const writeNative = (record: {
            readonly kind: "notification" | "command" | "response";
            readonly method: string;
            readonly payload: unknown;
          }) =>
            options.nativeEventLogger
              ? Effect.gen(function* () {
                  const observedAt = DateTime.formatIso(yield* DateTime.now);
                  yield* options.nativeEventLogger!.write(
                    {
                      observedAt,
                      event: {
                        id: yield* options.crypto.randomUUIDv4,
                        kind: record.kind,
                        provider: target.driverKind,
                        providerInstanceId: options.instanceId,
                        providerSessionId: input.providerSessionId,
                        threadId: input.threadId,
                        createdAt: observedAt,
                        method: record.method,
                        payload: record.payload,
                      },
                    },
                    input.threadId,
                  );
                }).pipe(Effect.ignoreCause)
              : Effect.void;
          const client = yield* options
            .makeProcess({
              target,
              command: options.settings.binaryPath,
              cwd,
              env: withAgentDeviceEnvironment(options.environment, mcp),
              sessionDir: root,
              extraArgs: ["--extension", extension.extensionPath],
              secrets: [mcp?.authorizationHeader],
              ...(options.nativeEventLogger
                ? {
                    onFrame: ({ direction, frame }: OmpRpcFrameTrace) =>
                      writeNative({
                        kind: direction === "outbound" ? "command" : "response",
                        method:
                          frame.type === "response" && typeof frame.command === "string"
                            ? frame.command
                            : String(frame.type),
                        payload: browserActionDiagnostic(frame),
                      }),
                  }
                : {}),
            })
            .pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
          redaction = client.redaction;
          let confirmedExit: OmpProcessExit | undefined;
          const shutdownObserved = Effect.suspend(() =>
            confirmedExit !== undefined
              ? Effect.succeed(confirmedExit)
              : client.shutdown.pipe(
                  Effect.tap((exit) =>
                    Effect.sync(() => {
                      if (exit.code !== null || exit.exited === true) confirmedExit = exit;
                    }),
                  ),
                ),
          );
          ownedShutdown = shutdownObserved;
          yield* Effect.addFinalizer(() => shutdownObserved.pipe(Effect.ignore));
          const stopOwnedProcess = Effect.gen(function* () {
            const exit = yield* shutdownObserved;
            if (exit.code === null && exit.exited !== true)
              return yield* new NativeSessionOperationError({
                detail: `${target.name} shutdown could not confirm process exit; its conversation remains locked.`,
              });
            yield* releaseOmpSessionLock(sessionLock, locks);
          });
          let catalog: Effect.Success<ReturnType<typeof client.getModels>>["models"] = [];
          let catalogCurrent = false;
          let closed = false;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          );
          const refreshCatalog = Effect.fnUntraced(function* () {
            const available = yield* client.getModels().pipe(
              Effect.tapError((cause) => {
                const fields =
                  cause._tag === "OmpRpcProtocolError" && Schema.isSchemaError(cause.cause)
                    ? SchemaIssue.makeFormatterStandardSchemaV1({
                        leafHook: (issue) => issue._tag,
                        checkHook: () => "InvalidValue",
                      })(cause.cause.issue)
                        .issues.slice(0, 10)
                        .map((issue) => (issue.path ?? []).map(String).join("."))
                    : [];
                return Effect.logWarning(`${target.name} model discovery failed.`, {
                  command: "get_available_models",
                  errorType: cause._tag,
                  version: client.version,
                  detail: client.redaction.text(cause.message).slice(0, 1024),
                  fields,
                });
              }),
            );
            catalog = available.models;
            catalogCurrent = true;
            return available;
          });

          const home = expandHomePath(
            options.homePath?.trim() ||
              options.settings.homePath?.trim() ||
              options.environment[target.environment.agentDir]?.trim() ||
              options.environment.HOME?.trim() ||
              options.environment.USERPROFILE?.trim() ||
              "",
          );
          const identity = {
            providerInstanceId: String(options.instanceId),
            sessionRoot: root,
            workspace: cwd,
            homeIdentity: home ? path.resolve(home) : "",
            profileIdentity:
              options.settings.profile?.trim() ||
              options.environment[target.environment.profile]?.trim() ||
              options.environment[target.environment.profileFallback]?.trim() ||
              "",
          };
          let nativeId = "";
          let cursor: OmpSessionCursor | undefined;
          let fresh = false;
          const refreshCursor = (sessionFile: string, sessionId?: string) =>
            Effect.gen(function* () {
              const relative = sessionFileInsideRoot(root, sessionFile);
              if (!relative)
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} created a conversation outside its owned directory.`,
                });
              nativeId = path.resolve(root, relative);
              const readable = yield* assertReadableOmpSessionFile({
                target,
                sessionRoot: root,
                relativeSessionFile: relative,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.option,
              );
              cursor = Option.isSome(readable)
                ? makeOmpSessionCursor({
                    target,
                    identity,
                    sessionFile: nativeId,
                    ...(sessionId === undefined ? {} : { sessionId }),
                    ompVersion: client.runtimeVersion,
                    rpcProtocolVersion: OMP_RPC_PROTOCOL_V2,
                  })
                : undefined;
            });
          let processLossPublished: Effect.Effect<void> | undefined;
          const publishProcessLoss = (publish: Effect.Effect<void>) =>
            Effect.gen(function* () {
              const published = yield* Deferred.make<void>();
              const previous = processLossPublished;
              processLossPublished =
                previous === undefined
                  ? Deferred.await(published)
                  : previous.pipe(Effect.andThen(Deferred.await(published)));
              yield* stopOwnedProcess.pipe(
                Effect.ignore,
                Effect.andThen(publish),
                Effect.ensuring(Deferred.succeed(published, undefined)),
              );
            });
          let nextWarningOrdinal = 0;
          const ordinaryTools = new Map<string, Extract<NativeSessionUpdate, { type: "tool" }>>();
          const applyUpdate = (update: OmpSessionUpdate): Effect.Effect<void> => {
            switch (update.type) {
              case "assistant-delta":
                return onUpdate({
                  type: "text",
                  id: update.messageId,
                  delta: client.redaction.exact(update.delta),
                });
              case "reasoning-delta":
                return onUpdate({
                  type: "text",
                  id: `${update.messageId}:reasoning`,
                  delta: client.redaction.exact(update.delta),
                  reasoning: true,
                });
              case "assistant-completed":
                return onUpdate({
                  type: "text-completed",
                  id: update.messageId,
                  ...(update.status === undefined ? {} : { status: update.status }),
                });
              case "tool": {
                const previous = ordinaryTools.get(update.toolCallId);
                if (previous && previous.status !== "running") return Effect.void;
                const rawOutput = nativeToolText(update.data) ?? update.detail;
                const item: Extract<NativeSessionUpdate, { type: "tool" }> = {
                  type: "tool",
                  id: update.toolCallId,
                  name: update.name === "tool" && previous ? previous.name : update.name,
                  status: update.status === "inProgress" ? "running" : update.status,
                  ...(update.input === undefined
                    ? previous?.input === undefined
                      ? {}
                      : { input: previous.input }
                    : { input: boundedToolInput(client.redaction.log(update.input)) }),
                  ...(rawOutput === undefined
                    ? previous?.output === undefined
                      ? {}
                      : { output: previous.output }
                    : { output: boundedToolText(client.redaction.text(rawOutput)) }),
                };
                ordinaryTools.set(item.id, item);
                return onUpdate(item);
              }
              case "question":
                return onUpdate({
                  ...update,
                  message: client.redaction.text(update.message),
                  title: client.redaction.text(update.title),
                });
              case "question-resolved":
                return onUpdate(update);
              case "questions-cleared":
                return Effect.forEach(
                  update.ids,
                  (id) => onUpdate({ type: "question-resolved", id }),
                  { discard: true },
                );
              case "background-work":
                return onUpdate({ type: "background", pending: update.pending });
              case "session-info":
                return update.sessionFile
                  ? Effect.gen(function* () {
                      // Buffered session-info frames can precede a fresh/switch command.
                      // Only the current native state may update persisted resume authority.
                      const current = yield* client.getState();
                      if (!current.sessionFile) return;
                      yield* refreshCursor(current.sessionFile, current.sessionId);
                      yield* onUpdate({
                        type: "native-thread",
                        id: nativeId,
                        resumeCursor: cursor,
                      });
                    }).pipe(
                      Effect.mapError(safeFailure),
                      Effect.catch((error) =>
                        onUpdate({
                          type: "terminal",
                          status: "failed",
                          detail: error.detail,
                          broken: true,
                        }),
                      ),
                    )
                  : Effect.void;
              case "turn-outcome": {
                const broken = update.source === "process" || update.source === "unconfirmed";
                const publish = Effect.forEach(
                  [...ordinaryTools.values()].filter((tool) => tool.status === "running"),
                  (tool) => {
                    if (update.outcome !== "completed" && update.outcome !== "local")
                      return Effect.void;
                    const failed = { ...tool, status: "failed" as const };
                    ordinaryTools.set(tool.id, failed);
                    return onUpdate(failed);
                  },
                  { discard: true },
                ).pipe(
                  Effect.andThen(
                    onUpdate({
                      type: "terminal",
                      status:
                        update.stopReason === "abort"
                          ? "cancelled"
                          : update.outcome === "completed" || update.outcome === "local"
                            ? "completed"
                            : "failed",
                      ...(update.detail === undefined
                        ? update.outcome === "unknown"
                          ? {
                              detail: `${target.name} stopped before confirming this turn; its outcome is unknown.`,
                            }
                          : {}
                        : { detail: client.redaction.text(update.detail) }),
                      ...(update.outcome === "unknown" ? { failureClass: "unknown" as const } : {}),
                      ...(update.stopReason === undefined ? {} : { stopReason: update.stopReason }),
                      broken,
                    }),
                  ),
                  Effect.andThen(
                    update.source === "process" || update.source === "unconfirmed"
                      ? closeSession(Exit.void).pipe(Effect.forkDetach, Effect.asVoid)
                      : Effect.void,
                  ),
                );
                return broken ? publishProcessLoss(publish) : publish;
              }
              case "process-exited":
                return publishProcessLoss(
                  onUpdate({
                    type: "terminal",
                    status: "failed",
                    detail: `${target.name} exited before confirming this turn; its outcome is unknown.`,
                    failureClass: "unknown",
                    broken: true,
                  }),
                ).pipe(
                  Effect.andThen(closeSession(Exit.void).pipe(Effect.forkDetach, Effect.asVoid)),
                );
              case "error":
                return onUpdate({
                  type: "tool",
                  id: "native-error",
                  name: `${target.name} error`,
                  status: "failed",
                  output: client.redaction.text(update.message),
                });
              case "warning":
                return onUpdate({
                  type: "tool",
                  id: `native-warning-${++nextWarningOrdinal}`,
                  name: `${target.name} warning`,
                  status: "completed",
                  output: client.redaction.text(update.message),
                });
              case "subagent":
                return onUpdate({
                  type: "subagent",
                  id: update.id,
                  title: update.title,
                  status:
                    update.status === "inProgress"
                      ? "running"
                      : update.status === "stopped"
                        ? "cancelled"
                        : update.status,
                  ...(update.detail === undefined
                    ? {}
                    : { detail: client.redaction.text(update.detail) }),
                });
              case "session-settled":
                return onUpdate({ type: "background", pending: false });
              case "command-output":
                return onUpdate({
                  type: "text",
                  id: "command-output",
                  delta: client.redaction.text(update.delta),
                });
              case "background-result":
                return update.detail
                  ? onUpdate({
                      type: "text",
                      id: "background-result",
                      delta: client.redaction.text(update.detail),
                    })
                  : Effect.void;
              case "compacted":
                return onUpdate({
                  type: "tool",
                  id: "compaction",
                  name: "Conversation compacted",
                  status: "completed",
                });
              case "open-url": {
                const url = browserActionUrl(update.url);
                const launchUrl = browserActionUrl(update.launchUrl);
                return onUpdate({
                  type: "tool",
                  id: `open-url-${++nextWarningOrdinal}`,
                  name: url ? `${target.name} requests a URL` : `${target.name} warning`,
                  status: "completed",
                  ...(url
                    ? { input: { kind: "open-url", url, ...(launchUrl ? { launchUrl } : {}) } }
                    : {}),
                  output: url
                    ? client.redaction.text(
                        browserActionText(
                          update.instructions ?? `${target.name} requested a browser action.`,
                        ),
                      )
                    : `${target.name} requested an invalid browser URL.`,
                });
              }
              case "assistant-started":
                return Effect.void;
              case "turn-started":
                ordinaryTools.clear();
                return Effect.void;
              case "model-changed":
                return update.model
                  ? onUpdate({ type: "model", model: update.model })
                  : Effect.void;
            }
          };
          const runtime = yield* makeOmpSessionRuntime({
            target,
            client,
            scope,
            continuationIdPrefix: yield* options.crypto.randomUUIDv4,
            onUpdate: applyUpdate,
            ...(options.nativeEventLogger
              ? {
                  onNativeNotification: (notification: OmpRpcNotification) =>
                    writeNative({
                      kind: "notification",
                      method:
                        notification._tag === "Event" ? notification.event.type : notification._tag,
                      payload: client.redaction.log(browserActionDiagnostic(notification)),
                    }),
                }
              : {}),
          });
          const ready = yield* client.ready.pipe(Effect.timeout("8 seconds"));
          if (!ready.supportedProtocolVersions?.includes(OMP_RPC_PROTOCOL_V2))
            return yield* Effect.fail(
              new NativeSessionOperationError({
                detail: `${target.name} did not offer RPC protocol v2.`,
              }),
            );
          yield* refreshCatalog().pipe(Effect.ignore);
          yield* extension.discardUnconsumed;
          yield* client.setSubagentSubscription("progress");
          if (compareSemverVersions(client.runtimeVersion, "18.3.1") >= 0)
            yield* client
              .setEventFilter(OMP_KNOWN_EVENT_TYPES)
              .pipe(Effect.catchTag("OmpRpcCommandError", () => Effect.void));
          const ensureFresh = () =>
            Effect.gen(function* () {
              if (fresh) return;
              const previous = yield* client.getState();
              const result = yield* client.command({ type: "new_session" });
              if (!result.success || (isRecord(result.data) && result.data.cancelled === true))
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} did not create a fresh conversation.`,
                });
              const next = yield* client.getState();
              if (
                !next.sessionFile ||
                (previous.sessionFile !== undefined &&
                  path.resolve(next.sessionFile) === path.resolve(previous.sessionFile))
              )
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} acknowledged a new conversation without creating a fresh transcript.`,
                });
              yield* refreshCursor(next.sessionFile, next.sessionId);
              fresh = true;
            }).pipe(Effect.mapError(safeFailure));
          const resume = (requestedId: string, resumeCursor?: unknown) =>
            Effect.gen(function* () {
              const validated = yield* parseOmpSessionCursor(resumeCursor, {
                target,
                identity,
                ompVersion: client.runtimeVersion,
                rpcProtocolVersion: OMP_RPC_PROTOCOL_V2,
              }).pipe(Effect.mapError((detail) => new NativeSessionOperationError({ detail })));
              yield* assertReadableOmpSessionFile({
                target,
                sessionRoot: root,
                relativeSessionFile: validated.relativeSessionFile,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.mapError((detail) => new NativeSessionOperationError({ detail })),
              );
              const real = yield* fs.realPath(requestedId);
              const expected = yield* fs.realPath(
                path.resolve(root, validated.relativeSessionFile),
              );
              if (real !== expected || !sessionFileInsideRoot(root, real))
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} resume cursor does not name the requested conversation.`,
                });
              // A failed or cancelled switch must leave ensureThread able to reset
              // whatever transcript the native process may have partially loaded.
              fresh = false;
              const result = yield* client.switchSession(real);
              if (result.cancelled)
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} cancelled the session switch.`,
                });
              const resumed = yield* client.getState();
              const sameFile =
                resumed.sessionFile !== undefined &&
                (yield* ompSessionFilesEqual({
                  target,
                  sessionRoot: root,
                  expectedRelativeFile: validated.relativeSessionFile,
                  reportedFile: resumed.sessionFile,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.mapError((detail) => new NativeSessionOperationError({ detail })),
                ));
              if (
                !sameFile ||
                (validated.sessionId !== undefined && resumed.sessionId !== validated.sessionId)
              )
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} resumed a different conversation than the cursor requested.`,
                });
              yield* refreshCursor(real, resumed.sessionId);
            }).pipe(Effect.timeout("2 minutes"), Effect.mapError(safeFailure));
          // Eager native ids are unvalidated history. Activate only via
          // resumeThread, where a refused cursor follows portable fallback.
          yield* ensureFresh();
          const state = yield* client.getState();
          let lastSelection:
            | {
                readonly model: string;
                readonly level: string | undefined;
                readonly appliedLevel: string | undefined;
              }
            | undefined;
          const commands = yield* client.getCommands();
          runtime.replaceCatalog(commands.commands);
          const payload = (
            message: ProviderAdapter.ProviderAdapterV2TurnMessage,
            selected?: { provider: string; id: string },
          ) =>
            Effect.gen(function* () {
              const decision = ompCommandDecision(message.text, runtime.catalog());
              if (decision === "mutator")
                return yield* Effect.fail(
                  new NativeSessionOperationError({
                    detail: `This ${target.name} command changes provider configuration; use the provider settings instead.`,
                  }),
                );
              if (decision === "unavailable")
                return yield* Effect.fail(
                  new NativeSessionOperationError({
                    detail: `That command is unavailable in this ${target.name} conversation.`,
                  }),
                );
              const imageFiles: Array<{ path: string; size: number; mimeType: string }> = [];
              const files: string[] = [];
              for (const attachment of message.attachments) {
                const stored = resolveAttachmentPath({
                  attachmentsDir: options.serverConfig.attachmentsDir,
                  attachment,
                });
                if (!stored)
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: `Invalid ${target.name} attachment path.`,
                    }),
                  );
                const real = yield* fs.realPath(stored);
                const root = yield* fs.realPath(options.serverConfig.attachmentsDir);
                const info = yield* fs.stat(real);
                const limit =
                  attachment.type === "image"
                    ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                    : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
                if (!sessionFileInsideRoot(root, real) || info.type !== "File")
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: `${target.name} attachment escaped its directory or is not a file.`,
                    }),
                  );
                if (Number(info.size) > limit)
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: `${target.name} ${attachment.type} attachment exceeds the ${formatOmpBytes(limit)} limit.`,
                    }),
                  );
                if (attachment.type === "image")
                  imageFiles.push({
                    path: real,
                    size: Number(info.size),
                    mimeType: attachment.mimeType,
                  });
                else files.push(`[Attachment saved at ${real}]`);
              }
              if (imageFiles.length > 0) {
                const modelRef = selected ?? (yield* client.getState()).model;
                if (
                  !catalogCurrent ||
                  !catalog.some(
                    (model) =>
                      model.provider === modelRef?.provider &&
                      model.id === modelRef?.id &&
                      model.input !== undefined,
                  )
                )
                  yield* refreshCatalog().pipe(
                    Effect.mapError(
                      () =>
                        new NativeSessionOperationError({
                          detail: `Couldn't verify image support for the selected ${target.name} model. Text messages still work.`,
                          breaksSession: false,
                        }),
                    ),
                  );
                const model = catalog.find(
                  (candidate) =>
                    candidate.provider === modelRef?.provider && candidate.id === modelRef?.id,
                );
                if (!model?.input?.includes("image"))
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail:
                        model?.input === undefined
                          ? `Couldn't verify image support for the selected ${target.name} model. Text messages still work.`
                          : `The selected ${target.name} model does not support images.`,
                      breaksSession: false,
                    }),
                  );
              }
              const { maxFrameBytes } = yield* client.limits;
              let text = message.text;
              const plan = () =>
                planOmpImages({
                  images: imageFiles,
                  maxFrameBytes,
                  buildMessage: (externalImages) =>
                    [
                      text,
                      ...files,
                      ...(externalImages.length === 0
                        ? []
                        : [
                            "Attached images (open each with the read tool):",
                            ...externalImages.map((file) => encodeJsonString(file)),
                          ]),
                    ].join("\n\n"),
                });
              let delivery = plan();
              if ("messageBytes" in delivery) {
                const promptPath = path.join(
                  root,
                  `scient-prompt-${yield* options.crypto.randomUUIDv4}.txt`,
                );
                yield* fs.writeFileString(promptPath, text, { mode: 0o600 });
                yield* Effect.addFinalizer(() => fs.remove(promptPath).pipe(Effect.ignore));
                const encodedPromptPath = yield* encodeJsonStringEffect(promptPath);
                text = `Read the entire conversation and current request from this UTF-8 file before answering: ${encodedPromptPath}. Read successive ranges if needed; a preview is not the complete history. Answer the current request, treating historical messages as context.`;
                delivery = plan();
              }
              if ("messageBytes" in delivery)
                return yield* Effect.fail(
                  new NativeSessionOperationError({
                    detail: `The prompt exceeds ${target.name}'s ${maxFrameBytes}-byte frame limit.`,
                  }),
                );
              const images: OmpRpcImage[] = [];
              for (const image of delivery.inline)
                images.push({
                  type: "image",
                  data: Buffer.from(yield* fs.readFile(image.path)).toString("base64"),
                  mimeType: image.mimeType,
                });
              return { message: delivery.message, images };
            });
          const native: NativeSession = {
            getModelContextWindow: (selection) => {
              if (closed || selection.instanceId !== options.instanceId) return undefined;
              const selected = decodeOmpModelSlug(selection.model);
              const window = catalog.find(
                (model) => model.provider === selected?.provider && model.id === selected.modelId,
              )?.contextWindow;
              return typeof window === "number" && window > 0 ? window : undefined;
            },
            get nativeId() {
              return nativeId;
            },
            get resumeCursor() {
              return cursor;
            },
            ensureFresh,
            interruptBreaksSession: true,
            send: (turnInput, nativeTurnId) =>
              Effect.gen(function* () {
                if (
                  turnInput.runtimePolicy.runtimeMode !== "full-access" ||
                  turnInput.runtimePolicy.approvalPolicy !== undefined ||
                  turnInput.runtimePolicy.sandboxPolicy !== undefined
                )
                  return yield* new NativeSessionOperationError({
                    detail: `${target.name} supports only full access and has no native sandbox.`,
                  });
                const model =
                  turnInput.modelSelection.model === "default"
                    ? state.model === undefined
                      ? null
                      : { provider: state.model.provider, modelId: state.model.id }
                    : decodeOmpModelSlug(turnInput.modelSelection.model);
                if (!model)
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: `${target.name} did not report a default model or the selection is not provider/model.`,
                    }),
                  );
                if (model.provider.startsWith("scient_") && client.refreshModels)
                  yield* client.refreshModels();
                const prompt = yield* payload(turnInput.message, {
                  provider: model.provider,
                  id: model.modelId,
                });
                const selected = getModelSelectionStringOptionValue(
                  turnInput.modelSelection,
                  "thinkingLevel",
                );
                const requestedSlug = encodeOmpModelSlug(model.provider, model.modelId)!;
                const previous = yield* client.getState();
                if (
                  previous.hasPendingAsyncWork &&
                  ompCommandDecision(turnInput.message.text, runtime.catalog()) === "allowed"
                )
                  return yield* new NativeSessionOperationError({
                    detail: `${target.name} commands wait until background work settles.`,
                    breaksSession: false,
                  });
                const previousSlug =
                  previous.model && encodeOmpModelSlug(previous.model.provider, previous.model.id);
                let mutated = false;
                const restore = Effect.gen(function* () {
                  if (!mutated || !previous.model) return;
                  lastSelection = undefined;
                  yield* client
                    .setModel(previous.model.provider, previous.model.id)
                    .pipe(Effect.ignore);
                  const oldLevel = ompThinkingLevel(previous.thinkingLevel);
                  if (oldLevel) yield* client.setThinkingLevel(oldLevel).pipe(Effect.ignore);
                  const actual = yield* client.getState();
                  const actualSlug =
                    actual.model && encodeOmpModelSlug(actual.model.provider, actual.model.id);
                  if (actualSlug) yield* onUpdate({ type: "model", model: actualSlug });
                  if (
                    actualSlug !== previousSlug ||
                    actual.thinkingLevel !== previous.thinkingLevel
                  )
                    yield* onUpdate({
                      type: "tool",
                      id: `${nativeTurnId}:restore-warning`,
                      name: `${target.name} model restoration`,
                      status: "completed",
                      output: `${target.name} could not restore the previous selection; its current model is ${actualSlug ?? "unknown"} with ${actual.thinkingLevel ?? "unknown"} reasoning.`,
                    });
                });
                yield* Effect.gen(function* () {
                  const level = selected === undefined ? undefined : ompThinkingLevel(selected);
                  if (selected !== undefined && !level)
                    return yield* new NativeSessionOperationError({
                      detail: `Unsupported ${target.name} thinking level "${selected}".`,
                      breaksSession: false,
                    });
                  if (level !== undefined) {
                    const available = yield* refreshCatalog();
                    const selectedModel = available.models.find(
                      (candidate) =>
                        candidate.provider === model.provider && candidate.id === model.modelId,
                    );
                    const levels = selectedModel && ompModelThinkingLevels(selectedModel);
                    if (level !== "off" && selectedModel && !levels?.includes(level))
                      return yield* new NativeSessionOperationError({
                        detail: levels?.length
                          ? `The selected ${target.name} model does not offer "${level}" reasoning. It offers: ${levels.join(", ")}.`
                          : `The selected ${target.name} model has no reasoning levels, so "${level}" cannot be applied.`,
                        breaksSession: false,
                      });
                  }
                  const unchanged =
                    previousSlug === requestedSlug &&
                    (selected === undefined ||
                      previous.thinkingLevel === selected ||
                      (lastSelection?.model === requestedSlug &&
                        lastSelection.level === selected &&
                        lastSelection.appliedLevel === previous.thinkingLevel));
                  const previousReasoning =
                    catalog.find(
                      (candidate) =>
                        candidate.provider === previous.model?.provider &&
                        candidate.id === previous.model.id,
                    )?.reasoning === true;
                  if (!unchanged && previousReasoning && !ompThinkingLevel(previous.thinkingLevel))
                    return yield* new NativeSessionOperationError({
                      detail: `${target.name} did not report its current reasoning level; the selection was not changed.`,
                      breaksSession: false,
                    });
                  if (!unchanged) {
                    if (previousSlug !== requestedSlug) {
                      mutated = true;
                      yield* client.setModel(model.provider, model.modelId).pipe(
                        Effect.catchTag("OmpRpcCommandError", () =>
                          Effect.gen(function* () {
                            if (client.refreshModels) yield* client.refreshModels();
                            yield* refreshCatalog().pipe(Effect.ignore);
                            yield* client.setModel(model.provider, model.modelId);
                          }),
                        ),
                      );
                    }
                    const afterModel = yield* client.getState();
                    const desiredLevel =
                      level ??
                      (turnInput.modelSelection.model === "default"
                        ? ompThinkingLevel(previous.thinkingLevel)
                        : undefined);
                    if (desiredLevel !== undefined && desiredLevel !== afterModel.thinkingLevel) {
                      mutated = true;
                      yield* client.setThinkingLevel(desiredLevel);
                    }
                  }
                  const applied = yield* client.getState();
                  if (
                    applied.model?.provider !== model.provider ||
                    applied.model.id !== model.modelId
                  )
                    return yield* new NativeSessionOperationError({
                      detail: `${target.name} did not apply the requested model; the message was not sent.`,
                      breaksSession: false,
                    });
                  const appliedSlug = encodeOmpModelSlug(applied.model.provider, applied.model.id);
                  if (!appliedSlug)
                    return yield* new NativeSessionOperationError({
                      detail: `${target.name} reported an invalid model identity.`,
                    });
                  yield* onUpdate({ type: "model", model: appliedSlug });
                  if (!unchanged && selected !== undefined && applied.thinkingLevel !== selected)
                    yield* onUpdate({
                      type: "tool",
                      id: `${nativeTurnId}:reasoning-warning`,
                      name: `${target.name} reasoning selection`,
                      status: "completed",
                      output: `${target.name} applied ${applied.thinkingLevel ?? "its default"} reasoning instead of ${selected}.`,
                    });
                  lastSelection = {
                    model: appliedSlug,
                    level: selected,
                    appliedLevel: applied.thinkingLevel,
                  };
                }).pipe(
                  Effect.catch((cause) =>
                    restore.pipe(
                      Effect.andThen(
                        Effect.fail(
                          new NativeSessionOperationError({
                            detail: client.redaction.text(cause.message),
                            cause,
                            breaksSession: false,
                          }),
                        ),
                      ),
                    ),
                  ),
                );
                const admission = yield* runtime.begin(nativeTurnId);
                if (admission.steering) {
                  yield* restore;
                  return yield* new NativeSessionOperationError({
                    detail: `${target.name} resumed background work while preparing this message; the message was not sent.`,
                    breaksSession: false,
                  });
                }
                fresh = false;
                yield* onUpdate({ type: "offered", nativeTurnId });
                yield* client.prompt({ ...prompt, streamingBehavior: "steer" }).pipe(
                  // send() only writes/schedules the command. The correlated native
                  // reply, rather than that local return, owns prompt acceptance.
                  Effect.tap(() => onUpdate({ type: "accepted", nativeTurnId })),
                  Effect.flatMap((result) =>
                    runtime.accepted(
                      result.id ?? nativeTurnId,
                      isRecord(result.data) && typeof result.data.agentInvoked === "boolean"
                        ? result.data.agentInvoked
                        : undefined,
                      "prompt",
                      nativeTurnId,
                    ),
                  ),
                  Effect.catch((cause) =>
                    (cause._tag === "OmpRpcCommandError" ? restore : Effect.void).pipe(
                      Effect.andThen(
                        cause._tag === "OmpRpcCommandError"
                          ? runtime.commandFailed(nativeTurnId)
                          : Effect.void,
                      ),
                      Effect.andThen(
                        onUpdate({
                          type: "terminal",
                          status: "failed",
                          detail:
                            cause._tag === "OmpRpcCommandError"
                              ? client.redaction.text(cause.message)
                              : `${client.redaction.text(cause.message)} ${target.name} did not confirm this turn; its outcome is unknown.`,
                          ...(cause._tag === "OmpRpcCommandError"
                            ? {}
                            : { failureClass: "unknown" as const }),
                          broken: cause._tag !== "OmpRpcCommandError",
                        }),
                      ),
                      Effect.andThen(
                        cause._tag === "OmpRpcCommandError"
                          ? Effect.void
                          : closeSession(Exit.void).pipe(Effect.forkDetach, Effect.asVoid),
                      ),
                    ),
                  ),
                  Effect.forkIn(scope),
                );
              }).pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(safeFailure)),
            steer: (steerInput) =>
              Effect.gen(function* () {
                const prompt = yield* payload(steerInput.message);
                const result = yield* client.steer(prompt.message, prompt.images);
                yield* runtime.accepted(
                  result.id ?? String(steerInput.providerTurnId),
                  true,
                  "steer",
                );
              }).pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(safeFailure)),
            beforeOwnerClose: Effect.suspend(() => processLossPublished ?? Effect.void),
            interrupt: stopOwnedProcess.pipe(
              Effect.andThen(closeSession(Exit.void)),
              Effect.mapError(safeFailure),
            ),
            resume,
            respond: (id, response) =>
              Effect.gen(function* () {
                const question = runtime.lookupQuestion(id);
                if (!question)
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: `The ${target.name} dialog is no longer pending.`,
                    }),
                  );
                const answer = response.answers?.[id];
                const value = typeof answer === "string" ? answer : undefined;
                if (
                  value !== undefined &&
                  question.allowedValues &&
                  !question.allowedValues.includes(value)
                )
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: `The answer is not one of ${target.name}'s offered choices.`,
                    }),
                  );
                yield* client.extensionUiResponse(
                  question.method === "confirm"
                    ? {
                        id,
                        confirmed:
                          response.decision === "accept" ||
                          response.decision === "acceptForSession",
                      }
                    : value === undefined
                      ? { id, cancelled: true }
                      : { id, value },
                );
                runtime.removeQuestion(id);
              }).pipe(Effect.mapError(safeFailure)),
          };
          return native;
        }).pipe(
          Effect.timeout("2 minutes"),
          Effect.mapError(safeFailure),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? closeSession(exit) : Effect.void)),
        );
      }),
  });
}
