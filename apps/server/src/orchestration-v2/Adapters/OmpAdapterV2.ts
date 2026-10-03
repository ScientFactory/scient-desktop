import {
  ProviderDriverKind,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type OmpSettings,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
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
import { expandHomePath } from "../../pathExpansion.ts";
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
import { planOmpImages } from "../../provider/Layers/OmpAdapter.ts";
import type * as ProviderAdapter from "../ProviderAdapter.ts";
import { AcpProviderCapabilitiesV2 } from "./AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  nativeSessionFailure,
  NativeSessionOperationError,
  type NativeSession,
  type NativeSessionAdapterV2Options,
} from "./NativeSessionAdapterV2.ts";

export interface OmpAdapterV2Options extends Pick<
  NativeSessionAdapterV2Options,
  "instanceId" | "idAllocator" | "continuations"
> {
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly serverConfig: ServerConfig["Service"];
  readonly makeProcess: OmpProcessFactory;
}
const JsonString = Schema.fromJsonString(Schema.String);
const encodeJsonString = Schema.encodeSync(JsonString);
const encodeJsonStringEffect = Schema.encodeEffect(JsonString);

export function makeOmpAdapterV2(options: OmpAdapterV2Options) {
  const locks = makeOmpSessionLockRegistry();
  return makeNativeSessionAdapterV2({
    ...options,
    defaultCwd: options.serverConfig.cwd,
    driver: ProviderDriverKind.make("omp"),
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
        if (
          input.runtimePolicy.runtimeMode !== "full-access" ||
          input.runtimePolicy.approvalPolicy !== undefined ||
          input.runtimePolicy.sandboxPolicy !== undefined
        )
          return yield* Effect.fail(
            new NativeSessionOperationError({
              detail: "Oh My Pi supports only full access and has no native sandbox.",
            }),
          );
        const { fileSystem: fs, path } = options;
        const scope = yield* Effect.scope;
        const cwd = yield* fs.realPath(input.runtimePolicy.cwd ?? options.serverConfig.cwd);
        const sessionRoot = path.join(
          options.serverConfig.stateDir,
          "omp-sessions",
          ompSessionDirectoryKey(options.instanceId, input.threadId),
        );
        yield* fs.makeDirectory(sessionRoot, { recursive: true });
        const root = yield* fs.realPath(sessionRoot);
        const stateRoot = yield* fs.realPath(options.serverConfig.stateDir);
        if (!sessionFileInsideRoot(stateRoot, root))
          return yield* Effect.fail(
            new NativeSessionOperationError({
              detail: "Oh My Pi session directory escaped Scient's state directory.",
            }),
          );
        yield* Effect.acquireRelease(
          acquireOmpSessionLock(path.join(root, ".session.lock"), locks),
          (lock) => releaseOmpSessionLock(lock, locks),
        );
        const mcp = readMcpProviderSession(input.threadId);
        if (mcp && mcp.providerInstanceId !== options.instanceId)
          return yield* Effect.fail(
            new NativeSessionOperationError({
              detail: "The tool session belongs to another provider instance.",
            }),
          );
        const extension = yield* writeOmpExtensionFiles({
          directory: root,
          name: `scient-extension-${yield* options.crypto.randomUUIDv4}`,
          source: ompScientExtensionSource,
          bootstrap: {
            endpoint: mcp?.endpoint ?? null,
            authorization: mcp?.authorizationHeader ?? null,
            awareness: buildScientAwareness(mcp?.capabilities),
          },
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        const client = yield* options
          .makeProcess({
            command: options.settings.binaryPath,
            cwd,
            env: withAgentDeviceEnvironment(options.environment, mcp),
            sessionDir: root,
            extraArgs: ["--extension", extension.extensionPath],
            secrets: [mcp?.authorizationHeader],
          })
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        yield* Effect.addFinalizer(() => client.shutdown.pipe(Effect.ignore));
        const home = expandHomePath(
          options.settings.homePath?.trim() ||
            options.environment.PI_CODING_AGENT_DIR?.trim() ||
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
            options.environment.OMP_PROFILE?.trim() ||
            options.environment.PI_PROFILE?.trim() ||
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
                detail: "Oh My Pi created a conversation outside its owned directory.",
              });
            nativeId = path.resolve(root, relative);
            const readable = yield* assertReadableOmpSessionFile({
              sessionRoot: root,
              relativeSessionFile: relative,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.option,
            );
            cursor = Option.isSome(readable)
              ? makeOmpSessionCursor({
                  identity,
                  sessionFile: nativeId,
                  ...(sessionId === undefined ? {} : { sessionId }),
                  ompVersion: client.version,
                  rpcProtocolVersion: OMP_RPC_PROTOCOL_V2,
                })
              : undefined;
          });
        const applyUpdate = (update: OmpSessionUpdate): Effect.Effect<void> => {
          switch (update.type) {
            case "assistant-delta":
              return onUpdate({
                type: "text",
                id: update.messageId,
                delta: client.redaction.text(update.delta),
              });
            case "reasoning-delta":
              return onUpdate({
                type: "text",
                id: `${update.messageId}:reasoning`,
                delta: client.redaction.text(update.delta),
                reasoning: true,
              });
            case "assistant-completed":
              return onUpdate({ type: "text-completed", id: update.messageId });
            case "tool":
              return onUpdate({
                type: "tool",
                id: update.toolCallId,
                name: update.name,
                status: update.status === "inProgress" ? "running" : update.status,
                ...(update.input === undefined
                  ? {}
                  : { input: client.redaction.log(update.input) }),
                ...(update.detail === undefined
                  ? {}
                  : { output: client.redaction.text(update.detail) }),
              });
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
                    yield* onUpdate({ type: "native-thread", id: nativeId, resumeCursor: cursor });
                  }).pipe(
                    Effect.mapError(nativeSessionFailure),
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
            case "turn-outcome":
              return onUpdate({
                type: "terminal",
                status:
                  update.stopReason === "abort"
                    ? "cancelled"
                    : update.outcome === "completed" || update.outcome === "local"
                      ? "completed"
                      : "failed",
                ...(update.detail === undefined
                  ? {}
                  : { detail: client.redaction.text(update.detail) }),
                ...(update.stopReason === undefined ? {} : { stopReason: update.stopReason }),
                broken: update.source === "process" || update.source === "unconfirmed",
              });
            case "process-exited":
              return onUpdate({
                type: "terminal",
                status: "failed",
                detail: "Oh My Pi exited before its turn could be confirmed.",
                broken: true,
              });
            case "error":
              return onUpdate({
                type: "tool",
                id: "native-error",
                name: "Oh My Pi error",
                status: "failed",
                output: client.redaction.text(update.message),
              });
            case "warning":
              return onUpdate({
                type: "tool",
                id: "native-warning",
                name: "Oh My Pi warning",
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
            case "open-url":
              return onUpdate({
                type: "tool",
                id: "open-url",
                name: "Oh My Pi requests a URL",
                status: "completed",
                output: client.redaction.text(update.instructions ?? update.url),
              });
            case "assistant-started":
            case "turn-started":
              return Effect.void;
            case "model-changed":
              return update.model ? onUpdate({ type: "model", model: update.model }) : Effect.void;
          }
        };
        const runtime = yield* makeOmpSessionRuntime({
          client,
          scope,
          continuationIdPrefix: yield* options.crypto.randomUUIDv4,
          onUpdate: applyUpdate,
        });
        const ready = yield* client.ready.pipe(Effect.timeout("8 seconds"));
        if (!ready.supportedProtocolVersions?.includes(OMP_RPC_PROTOCOL_V2))
          return yield* Effect.fail(
            new NativeSessionOperationError({ detail: "Oh My Pi did not offer RPC protocol v2." }),
          );
        yield* extension.discardUnconsumed;
        yield* client.setSubagentSubscription("progress");
        if (compareSemverVersions(client.version, "18.3.1") >= 0)
          yield* client.setEventFilter(OMP_KNOWN_EVENT_TYPES);
        const ensureFresh = () =>
          Effect.gen(function* () {
            if (fresh) return;
            const previous = yield* client.getState();
            const result = yield* client.command({ type: "new_session" });
            if (!result.success || (isRecord(result.data) && result.data.cancelled === true))
              return yield* new NativeSessionOperationError({
                detail: "Oh My Pi did not create a fresh conversation.",
              });
            const next = yield* client.getState();
            if (
              !next.sessionFile ||
              (previous.sessionFile !== undefined &&
                path.resolve(next.sessionFile) === path.resolve(previous.sessionFile))
            )
              return yield* new NativeSessionOperationError({
                detail:
                  "Oh My Pi acknowledged a new conversation without creating a fresh transcript.",
              });
            yield* refreshCursor(next.sessionFile, next.sessionId);
            fresh = true;
          }).pipe(Effect.mapError(nativeSessionFailure));
        const resume = (requestedId: string, resumeCursor?: unknown) =>
          Effect.gen(function* () {
            const validated = yield* parseOmpSessionCursor(resumeCursor, {
              identity,
              ompVersion: client.version,
              rpcProtocolVersion: OMP_RPC_PROTOCOL_V2,
            }).pipe(Effect.mapError((detail) => new NativeSessionOperationError({ detail })));
            yield* assertReadableOmpSessionFile({
              sessionRoot: root,
              relativeSessionFile: validated.relativeSessionFile,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.mapError((detail) => new NativeSessionOperationError({ detail })),
            );
            const real = yield* fs.realPath(requestedId);
            const expected = yield* fs.realPath(path.resolve(root, validated.relativeSessionFile));
            if (real !== expected || !sessionFileInsideRoot(root, real))
              return yield* new NativeSessionOperationError({
                detail: "Oh My Pi resume cursor does not name the requested conversation.",
              });
            // A failed or cancelled switch must leave ensureThread able to reset
            // whatever transcript the native process may have partially loaded.
            fresh = false;
            const result = yield* client.switchSession(real);
            if (result.cancelled)
              return yield* new NativeSessionOperationError({
                detail: "Oh My Pi cancelled the session switch.",
              });
            const resumed = yield* client.getState();
            const sameFile =
              resumed.sessionFile !== undefined &&
              (yield* ompSessionFilesEqual({
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
                detail: "Oh My Pi resumed a different conversation than the cursor requested.",
              });
            yield* refreshCursor(real, resumed.sessionId);
          }).pipe(Effect.mapError(nativeSessionFailure));
        // Eager native ids are unvalidated history. Activate only via
        // resumeThread, where a refused cursor follows portable fallback.
        yield* ensureFresh();
        const state = yield* client.getState();
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
                  detail:
                    "This Oh My Pi command changes provider configuration; use the provider settings instead.",
                }),
              );
            if (decision === "unavailable")
              return yield* Effect.fail(
                new NativeSessionOperationError({
                  detail: "That command is unavailable in this Oh My Pi conversation.",
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
                  new NativeSessionOperationError({ detail: "Invalid Oh My Pi attachment path." }),
                );
              const real = yield* fs.realPath(stored);
              const root = yield* fs.realPath(options.serverConfig.attachmentsDir);
              const info = yield* fs.stat(real);
              const limit =
                attachment.type === "image"
                  ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                  : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
              if (
                !sessionFileInsideRoot(root, real) ||
                info.type !== "File" ||
                Number(info.size) > limit
              )
                return yield* Effect.fail(
                  new NativeSessionOperationError({
                    detail: "Oh My Pi attachment escaped its directory or exceeded its size limit.",
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
              const available = yield* client.getModels();
              const model = available.models.find(
                (candidate) =>
                  candidate.provider === modelRef?.provider && candidate.id === modelRef?.id,
              );
              if (!model?.input?.includes("image"))
                return yield* Effect.fail(
                  new NativeSessionOperationError({
                    detail: "The selected Oh My Pi model does not advertise image support.",
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
                  detail: `The prompt exceeds Oh My Pi's ${maxFrameBytes}-byte frame limit.`,
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
                  detail: "Oh My Pi supports only full access and has no native sandbox.",
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
                    detail:
                      "Oh My Pi did not report a default model or the selection is not provider/model.",
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
              if (selected !== undefined) {
                const level = ompThinkingLevel(selected);
                if (!level)
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: "Unsupported Oh My Pi thinking level.",
                    }),
                  );
                const available = yield* client.getModels();
                const selectedModel = available.models.find(
                  (candidate) =>
                    candidate.provider === model.provider && candidate.id === model.modelId,
                );
                if (
                  level !== "off" &&
                  (!selectedModel || !ompModelThinkingLevels(selectedModel).includes(level))
                )
                  return yield* Effect.fail(
                    new NativeSessionOperationError({
                      detail: "The selected Oh My Pi model does not advertise that thinking level.",
                    }),
                  );
                yield* client.setModel(model.provider, model.modelId);
                yield* client.setThinkingLevel(level);
              }
              if (selected === undefined) {
                yield* client.setModel(model.provider, model.modelId);
                if (
                  turnInput.modelSelection.model === "default" &&
                  ompThinkingLevel(state.thinkingLevel)
                )
                  yield* client.setThinkingLevel(ompThinkingLevel(state.thinkingLevel)!);
              }
              const applied = yield* client.getState();
              if (applied.model?.provider !== model.provider || applied.model.id !== model.modelId)
                return yield* new NativeSessionOperationError({
                  detail: "Oh My Pi did not apply the requested model; the message was not sent.",
                });
              const appliedSlug = encodeOmpModelSlug(applied.model.provider, applied.model.id);
              if (!appliedSlug)
                return yield* new NativeSessionOperationError({
                  detail: "Oh My Pi reported an invalid model identity.",
                });
              yield* onUpdate({ type: "model", model: appliedSlug });
              if (selected !== undefined && applied.thinkingLevel !== selected)
                yield* onUpdate({
                  type: "tool",
                  id: `${nativeTurnId}:reasoning-warning`,
                  name: "Oh My Pi reasoning selection",
                  status: "completed",
                  output: `Oh My Pi applied ${applied.thinkingLevel ?? "its default"} reasoning instead of ${selected}.`,
                });
              yield* runtime.begin(nativeTurnId);
              fresh = false;
              yield* client.prompt({ ...prompt, streamingBehavior: "steer" }).pipe(
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
                  runtime.commandFailed(nativeTurnId).pipe(
                    Effect.andThen(
                      onUpdate({
                        type: "terminal",
                        status: "failed",
                        detail: client.redaction.text(cause.message),
                        broken:
                          cause._tag === "OmpRpcProcessExitedError" ||
                          cause._tag === "OmpRpcProtocolViolationError",
                      }),
                    ),
                  ),
                ),
                Effect.forkIn(scope),
              );
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(nativeSessionFailure),
            ),
          steer: (steerInput) =>
            Effect.gen(function* () {
              const prompt = yield* payload(steerInput.message);
              const result = yield* client.steer(prompt.message, prompt.images);
              yield* runtime.accepted(
                result.id ?? String(steerInput.providerTurnId),
                true,
                "steer",
              );
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(nativeSessionFailure),
            ),
          interrupt: client.shutdown.pipe(Effect.asVoid, Effect.mapError(nativeSessionFailure)),
          resume,
          respond: (id, response) =>
            Effect.gen(function* () {
              const question = runtime.lookupQuestion(id);
              if (!question)
                return yield* Effect.fail(
                  new NativeSessionOperationError({
                    detail: "The Oh My Pi dialog is no longer pending.",
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
                    detail: "The answer is not one of Oh My Pi's offered choices.",
                  }),
                );
              yield* client.extensionUiResponse(
                question.method === "confirm"
                  ? {
                      id,
                      confirmed:
                        response.decision === "accept" || response.decision === "acceptForSession",
                    }
                  : value === undefined
                    ? { id, cancelled: true }
                    : { id, value },
              );
              runtime.removeQuestion(id);
            }).pipe(Effect.mapError(nativeSessionFailure)),
        };
        return native;
      }).pipe(Effect.timeout("2 minutes"), Effect.mapError(nativeSessionFailure)),
  });
}
