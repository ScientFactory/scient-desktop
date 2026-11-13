// SCIENT-FORK: confirmed process ownership and lock release.
import { makeOmpProcessOwnership } from "../scient-provider/OmpProcessOwnership.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ThreadTokenUsageSnapshot,
  type ModelSelection,
  type OmpSettings,
} from "@t3tools/contracts";
// SCIENT-FORK: /goal drives Scient Agent's goal command.
import { parseGoalCommand } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";
import {
  OMP_KNOWN_EVENT_TYPES,
  OMP_RPC_PROTOCOL_V2,
  isRecord,
  type OmpRpcImage,
} from "effect-omp-rpc/schema";
import type { OmpRpcFrameTrace, OmpRpcNotification } from "effect-omp-rpc/client";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { toMcpCapabilities } from "../../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import {
  type OmpDashboardCommand,
  ompDashboardThroughLink,
  ompDashboardUrl,
  ompDashboardCommand,
  ompDashboardLink,
  ompDashboardProgress,
} from "../../provider/omp/OmpDashboardPage.ts";
import { ompTarget, type OmpTarget } from "../../provider/omp/OmpTarget.ts";
import { OmpToolRows } from "../../provider/omp/OmpToolRows.ts";
import { OmpSessionTree, branchBefore } from "../../provider/omp/OmpSessionTree.ts";
import { OmpWaitRows } from "../../provider/omp/OmpWaitRows.ts";
import { makeOmpLiveVoice } from "../../provider/omp/OmpLiveVoice.ts";
// SCIENT-FORK: idle compaction times itself to the one-hour prompt cache.
import { withOmpPromptCacheExpiry } from "../../provider/omp/OmpPromptCache.ts";
// SCIENT-FORK: /goal drives Scient Agent's goal command.
import { ompGoalUpdate, runOmpGoalTurn } from "../../provider/omp/OmpGoal.ts";
// SCIENT-FORK: /plan drives Scient Agent's plan mode.
import {
  ompProposedPlan,
  parseOmpPlanCommand,
  runOmpPlanTurn,
} from "../../provider/omp/OmpPlan.ts";
import {
  assertReadableOmpSessionFile,
  ompSessionFilesEqual,
} from "../../provider/omp/OmpSessionFile.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import type { ServerConfig } from "../../config.ts";
import { withAgentDeviceEnvironment } from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ompCommandDecision } from "../../provider/omp/OmpCommandPolicy.ts";
import { writeOmpExtensionFiles } from "../../provider/omp/OmpExtensionBootstrap.ts";
import { ompScientExtensionSource } from "../../provider/omp/OmpScientExtension.ts";
import { buildOmpScientGuidance } from "../../provider/omp/OmpScientGuidance.ts";
import {
  OMP_SUBAGENT_TRANSCRIPT_START,
  type OmpSubagentStep,
  type OmpSubagentTranscriptCursor,
  readOmpSubagentTranscript,
} from "../../provider/omp/OmpSubagentTranscript.ts";
import { makeOmpRedaction, type OmpRpcProcess } from "../../provider/omp/OmpRpcProcess.ts";
import type { EventNdjsonLogger } from "@t3tools/provider-core/server/ProviderEventLoggers";
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
import {
  ompCommandOutputText,
  ompMessageUsage,
  ompRequestUsage,
  ompStatsUsage,
  ompTodoSteps,
} from "../../provider/omp/OmpDesktopPresentation.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { OmpProcessFactory } from "../../provider/OmpProvider.ts";
import { formatOmpBytes, planOmpImages } from "../../provider/omp/OmpImagePrompt.ts";
import { ompAskAnswers } from "../../provider/omp/OmpAsk.ts";
import { ompUsageLimitNotice } from "../../provider/omp/OmpUsageLimit.ts";
import { linkScientAgentSessions } from "../../provider/scient/ScientAgentSessionsLink.ts";
import {
  browserActionUrl,
  browserActionText,
  browserActionDiagnostic,
} from "../../provider/omp/OmpBrowserAction.ts";
import {
  ompComputerPermissionsNeeded,
  ompComputerPresentation,
  ompComputerStatusErrors,
  ompToolImages,
  retainedComputerPresentation,
} from "../../provider/omp/OmpComputerPresentation.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
// SCIENT-FORK: Scient's wording for an account the agent signed out.
import { scientAgentSignedOutNotice } from "../../provider/scient/ScientAgentSignedOut.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
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
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly serverConfig: ServerConfig["Service"];
  readonly makeProcess: OmpProcessFactory;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly eventQueueByteLimit?: number;
  readonly eventQueueItemLimit?: number;
  // SCIENT-FORK: a model account the agent signed out refreshes the provider's account list.
  readonly onAccountSignedOut?: Effect.Effect<void>;
}
const JsonString = Schema.fromJsonString(Schema.String);
const decodeSubagentCancellation = Schema.decodeUnknownEffect(
  Schema.Struct({ cancelled: Schema.Boolean }),
);
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

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  options: OmpAdapterV2Options,
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  // SCIENT-FORK: the conversation's browser shows the pages the agent's dashboard commands start.
  const previewBroker = yield* Effect.serviceOption(PreviewAutomationBroker);
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment);
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const target = options.target ?? ompTarget;
  const locks = makeOmpSessionLockRegistry();
  return makeNativeSessionAdapterV2({
    settleIdleSubagents: true,
    ...options,
    eventQueueLimits: {
      maxBytes: Math.max(1, options.eventQueueByteLimit ?? 32 * 1024 * 1024),
      maxItems: Math.max(1, options.eventQueueItemLimit ?? 8192),
      globalFactor: 4,
    },
    eventQueueStorage: {
      fileSystem: options.fileSystem,
      path: options.path,
      directory: options.serverConfig.stateDir,
    },
    mcpSessionInjection: true,
    defaultCwd: options.serverConfig.cwd,
    driver: target.driverKind,
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
      threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: true },
      turns: {
        ...AcpProviderCapabilitiesV2.turns,
        supportsActiveSteering: true,
        supportsQueuedMessages: true,
        // SCIENT-FORK: /goal drives Scient Agent's goal command.
        supportsNativeGoals: target.driverKind === "scient",
      },
      streaming: {
        ...AcpProviderCapabilitiesV2.streaming,
        streamsReasoning: true,
        streamsToolOutput: true,
      },
      tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
      // The agent runs with --approval-mode yolo, so it never asks before a command or file change.
      approvals: {
        ...AcpProviderCapabilitiesV2.approvals,
        supportsCommandApproval: false,
        supportsFileReadApproval: false,
        supportsFileChangeApproval: false,
      },
      planning: {
        ...AcpProviderCapabilitiesV2.planning,
        emitsPlanUpdated: false,
        emitsTodoList: true,
        // SCIENT-FORK: /plan drives Scient Agent's plan mode.
        emitsProposedPlan: target.driverKind === "scient",
      },
      subagents: {
        ...AcpProviderCapabilitiesV2.subagents,
        supportsSubagents: true,
        emitsSubagentLifecycle: true,
      },
      checkpointing: {
        ...AcpProviderCapabilitiesV2.checkpointing,
        providerCanRollbackConversation: true,
        providerRollbackReturnsSnapshot: true,
      },
    },
    open: Effect.fn("OmpAdapterV2.open")(function* (input, onUpdate) {
      const mcp =
        input.configureMcp === false ? undefined : yield* mcpSessions.read(input.threadId);
      let redaction = makeOmpRedaction(options.environment, [mcp?.authorizationHeader]);
      const safeFailure = (cause: unknown) => {
        const failure = nativeSessionFailure(cause);
        return new NativeSessionOperationError({
          detail: redaction.text(failure.detail),
          ...(failure.breaksSession === undefined ? {} : { breaksSession: failure.breaksSession }),
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
          return yield* new NativeSessionOperationError({
            detail: `${target.name} supports only full access and has no native sandbox.`,
          });
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
        const agentRoot = options.environment?.SCIENT_AGENT_ROOT;
        const sessionsLink =
          target.driverKind === "scient" && agentRoot
            ? yield* linkScientAgentSessions({ agentRoot, sessionsRoot: path.dirname(root) })
            : undefined;
        const dashboardSessions =
          sessionsLink === undefined ? undefined : { root: path.dirname(root), link: sessionsLink };
        const stateRoot = yield* fs.realPath(options.serverConfig.stateDir);
        if (!sessionFileInsideRoot(stateRoot, root))
          return yield* new NativeSessionOperationError({
            detail: `${target.name} session directory escaped Scient's state directory.`,
          });
        let ownedShutdown: OmpRpcProcess["shutdown"] | undefined;
        const sessionLock = yield* Effect.acquireRelease(
          acquireOmpSessionLock(target, path.join(root, ".session.lock"), locks),
          (lock) =>
            Effect.gen(function* () {
              if (ownedShutdown !== undefined) {
                const exit = yield* ownedShutdown.pipe(Effect.option);
                if (Option.isNone(exit) || (exit.value.code === null && exit.value.exited !== true))
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
        if (mcp && mcp.providerInstanceId !== options.instanceId)
          return yield* new NativeSessionOperationError({
            detail: "The tool session belongs to another provider instance.",
          });
        const extension = yield* writeOmpExtensionFiles({
          target,
          directory: root,
          name: `scient-extension-${yield* options.random.uuidV4()}`,
          source: (bootstrapPath) => ompScientExtensionSource(target, bootstrapPath),
          bootstrap: {
            endpoint: mcp?.endpoint ?? null,
            authorization: mcp?.authorizationHeader ?? null,
            awareness: buildOmpScientGuidance({
              target,
              capabilities:
                mcp?.capabilities === undefined ? undefined : toMcpCapabilities(mcp.capabilities),
            }),
            ...(mcp === undefined || mcp.connectors.length === 0
              ? {}
              : {
                  connectors: mcp.connectors.map(({ serverName, displayName, url }) => ({
                    serverName,
                    displayName,
                    url,
                  })),
                }),
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
                      id: yield* options.random.uuidV4(),
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
        // SCIENT-FORK: retained shutdown confirmation owns the lock lifetime.
        const processOwnership = yield* makeOmpProcessOwnership({
          shutdown: () => client.shutdown,
          releaseLock: () => releaseOmpSessionLock(sessionLock, locks),
          unconfirmed: () =>
            Effect.fail(
              new NativeSessionOperationError({
                detail: `${target.name} shutdown could not confirm process exit; its conversation remains locked.`,
              }),
            ),
        });
        const shutdownObserved = processOwnership.shutdown;
        ownedShutdown = shutdownObserved;
        yield* Effect.addFinalizer(() => shutdownObserved.pipe(Effect.ignore));
        const stopOwnedProcess = processOwnership.stop;
        let catalog: Effect.Success<ReturnType<typeof client.getModels>>["models"] = [];
        let catalogCurrent = false;
        let closed = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        // The open, payload and send spans already own catalog refreshes.
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
          homeDirectory,
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
        const refreshCursor = Effect.fn("OmpAdapterV2.refreshCursor")(function* (
          sessionFile: string,
          sessionId?: string,
        ) {
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
        let processLossReported = false;
        let processLossDescription = `${target.name} process lost.`;
        // compact's response owns its item; its notification can arrive after that response.
        let manualCompaction = false;
        // `/stats` and `/trace` answer with a local page, which opens beside the conversation.
        let dashboardRequested: OmpDashboardCommand | undefined;
        const openDashboard = (url: string) =>
          Option.isNone(previewBroker) || Option.isNone(serverEnvironment)
            ? Effect.void
            : serverEnvironment.value.getEnvironmentId.pipe(
                Effect.flatMap((environmentId) =>
                  previewBroker.value.invoke({
                    // The user's own command: its tab stays apart from the agent's browsing.
                    scope: {
                      environmentId,
                      threadId: input.threadId,
                      providerSessionId: `dashboard:${input.threadId}`,
                      providerInstanceId: options.instanceId,
                      capabilities: new Set(["preview"] as const),
                      issuedAt: 0,
                    },
                    operation: "open",
                    input: { url, open: true, reuseExistingTab: true },
                  }),
                ),
                Effect.tapError((cause) =>
                  Effect.logWarning("OmpAdapterV2.openDashboard", { cause }),
                ),
                Effect.ignore,
              );
        let activeModel = decodeOmpModelSlug(input.modelSelection.model);
        let processLossPublished: Effect.Effect<void> | undefined;
        const publishProcessLoss = Effect.fn("OmpAdapterV2.publishProcessLoss")(function* (
          publish: Effect.Effect<void>,
        ) {
          const published = yield* Deferred.make<void>();
          const previous = processLossPublished;
          processLossPublished =
            previous === undefined
              ? Deferred.await(published)
              : previous.pipe(Effect.andThen(Deferred.await(published)));
          yield* stopOwnedProcess.pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.gen(function* () {
                if (processLossReported) return;
                processLossReported = true;
                const exit = yield* shutdownObserved.pipe(Effect.option);
                const detail = Option.isSome(exit)
                  ? `Exit code: ${exit.value.code ?? "unavailable"}.${exit.value.stderrTail ? `\n${exit.value.stderrTail.split("\n").slice(-8).join("\n").slice(-2048)}` : ""}`
                  : "Exit status unavailable.";
                processLossDescription = client.redaction.text(
                  `${target.name} process lost. ${detail}`,
                );
                yield* notice(processLossDescription, true, "native-process-loss");
              }),
            ),
            Effect.andThen(publish),
            Effect.ensuring(Deferred.succeed(published, undefined)),
          );
        });
        // SCIENT-FORK: costs are authoritative session totals, including billed cache refreshes.
        let contextUsage: ThreadTokenUsageSnapshot | undefined;
        // A repeated message_end must not count its model request twice.
        const countedRequests = new Set<string>();
        let statsUnsupported = false;
        const contextWindow = (provider?: string, modelId?: string) => {
          const window = catalog.find(
            (model) => model.provider === provider && model.id === modelId,
          )?.contextWindow;
          return typeof window === "number" && Number.isFinite(window) && window > 0
            ? Math.trunc(window)
            : undefined;
        };
        const refreshUsage = Effect.fn("OmpAdapterV2.refreshUsage")(function* (includeTurn = true) {
          if (statsUnsupported) return;
          const response = yield* client.command({ type: "get_session_stats" }).pipe(
            Effect.timeout("2 seconds"),
            Effect.catch((error) => {
              if (
                error._tag === "OmpRpcCommandError" &&
                (error.code === "unknown_command" || /unknown command/i.test(error.message))
              )
                statsUnsupported = true;
              return Effect.void;
            }),
          );
          const usage = response?.success ? ompStatsUsage(response.data, contextUsage) : undefined;
          if (!usage) return;
          contextUsage = usage;
          yield* onUpdate({
            type: "usage",
            contextUsage: usage,
            ...(includeTurn
              ? { tokenUsage: { usedTokens: usage.usedTokens, maxTokens: usage.maxTokens ?? null } }
              : {}),
          });
        });
        let todosShown = false;
        const publishTodos = (phases: unknown) => {
          const steps = ompTodoSteps(phases);
          // An agent reports an empty list on every state read; it only matters once cleared.
          if (steps !== undefined && steps.length > 0) todosShown = true;
          return steps === undefined || (steps.length === 0 && !todosShown)
            ? Effect.void
            : onUpdate({
                type: "item",
                id: "todos",
                status: "completed",
                item: {
                  type: "todo_list",
                  steps: steps.map((step) => ({ ...step, text: client.redaction.text(step.text) })),
                },
              });
        };
        let usageLimitNotice: string | undefined;
        // SCIENT-FORK: todos and the usage limit have no event of their own past a settled run.
        const refreshSettledState = Effect.fn("OmpAdapterV2.refreshSettledState")(function* () {
          const state = yield* client.getState().pipe(Effect.option);
          if (Option.isNone(state)) return;
          if (state.value.todoPhases !== undefined) yield* publishTodos(state.value.todoPhases);
          const usageLimit = ompUsageLimitNotice(state.value.usageLimit);
          if (usageLimit !== undefined && usageLimit !== usageLimitNotice)
            yield* notice(usageLimit);
          usageLimitNotice = usageLimit;
        });
        let nextWarningOrdinal = 0;
        // SCIENT-FORK: each plan the agent proposes is its own card.
        let proposedPlans = 0;
        let retrySequence = 0;
        let retryId: string | undefined;
        let retryProgress:
          | { attempt: number; maxAttempts: number | null; retryDelayMs: number | null }
          | undefined;
        const notice = (
          message: string,
          error = false,
          id = `native-notice-${++nextWarningOrdinal}`,
        ) =>
          onUpdate({
            type: "item",
            id,
            status: error ? "failed" : "completed",
            item: error
              ? {
                  type: "error",
                  failure: makeProviderFailure({
                    message: client.redaction.text(message),
                    class: "provider_error",
                  }),
                }
              : { type: "system_notice", message: client.redaction.text(message) },
          });

        const ordinaryTools = new Map<string, Extract<NativeSessionUpdate, { type: "tool" }>>();
        const waitRows = new OmpWaitRows();
        const toolRows = new OmpToolRows((text) => client.redaction.text(text));
        const sessionTree = new OmpSessionTree();
        /** When this process last sent the user's message; its turn's entry is found from it. */
        let promptSentAt: number | undefined;
        const recordTurnEntry = Effect.suspend(() => {
          const sentAt = promptSentAt;
          promptSentAt = undefined;
          return sentAt === undefined
            ? Effect.void
            : sessionTree
                .turnStart(client.command, nativeId, sentAt)
                .pipe(
                  Effect.flatMap((entryId) =>
                    entryId === undefined ? Effect.void : onUpdate({ type: "turn-entry", entryId }),
                  ),
                );
        });
        // Native subagents' own steps, read from the conversation OMP saves for each:
        // at most once a second while one runs, then twice after it ends, since its last
        // record can land after its ending frame. Two reads run at a time per session.
        const subagentTranscripts = new Map<
          string,
          {
            readonly file: string;
            cursor: OmpSubagentTranscriptCursor;
            checked: boolean;
            reading: boolean;
            dirty: boolean;
            ended: boolean;
            endedReads: number;
          }
        >();
        const transcriptReads = yield* Semaphore.make(2);
        const subagentStep = (
          step: OmpSubagentStep,
        ): Extract<NativeSessionUpdate, { type: "subagent-steps" }>["steps"][number] =>
          step.kind === "text"
            ? { ...step, text: client.redaction.exact(step.text) }
            : step.kind === "tool"
              ? {
                  kind: "tool",
                  id: step.id,
                  name: step.name,
                  status: step.status,
                  ...(step.input === undefined
                    ? {}
                    : { input: boundedToolInput(client.redaction.log(step.input)) }),
                  ...(step.output === undefined
                    ? {}
                    : { output: boundedToolText(client.redaction.text(step.output)) }),
                }
              : {
                  kind: "notice",
                  id: step.id,
                  message: `A step of ${(step.bytes / 1024 / 1024).toFixed(1)} MB is too large to show here.`,
                };
        const readSubagentSteps = Effect.fnUntraced(function* (id: string, final: boolean) {
          const state = subagentTranscripts.get(id);
          if (!state) return;
          if (!state.checked) {
            // The file appears with the subagent's first record; it must stay in this session's folder.
            const real = yield* fs.realPath(state.file).pipe(Effect.option);
            if (Option.isSome(real)) {
              if (sessionFileInsideRoot(root, real.value) === undefined) {
                subagentTranscripts.delete(id);
                return yield* onUpdate({ type: "subagent-steps", id, steps: [], final: true });
              }
              state.checked = true;
            }
          }
          let more = state.checked;
          let sentFinal = false;
          while (more) {
            const read = yield* transcriptReads
              .withPermits(1)(readOmpSubagentTranscript(state.file, state.cursor))
              .pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.option);
            if (Option.isNone(read)) break;
            state.cursor = read.value.cursor;
            more = read.value.more;
            const last = final && !more;
            if (read.value.steps.length > 0 || last)
              yield* onUpdate({
                type: "subagent-steps",
                id,
                steps: read.value.steps.map(subagentStep),
                ...(last ? { final: true } : {}),
              });
            sentFinal ||= last;
          }
          if (final && !sentFinal)
            yield* onUpdate({ type: "subagent-steps", id, steps: [], final: true });
        });
        const drainSubagentSteps = Effect.fnUntraced(function* (id: string) {
          while (true) {
            const state = subagentTranscripts.get(id);
            if (!state) return;
            state.dirty = false;
            const final = state.ended && state.endedReads > 0;
            if (state.ended) state.endedReads += 1;
            yield* readSubagentSteps(id, final);
            if (final) return;
            yield* Effect.sleep(state.ended ? "2 seconds" : "1 second");
            if (!state.dirty && !state.ended) {
              state.reading = false;
              return;
            }
          }
        });
        const followSubagentSteps = Effect.fnUntraced(function* (
          id: string,
          file: string | undefined,
          ended: boolean,
        ) {
          let state = subagentTranscripts.get(id);
          if (!state) {
            if (file === undefined) return;
            state = {
              file,
              cursor: OMP_SUBAGENT_TRANSCRIPT_START,
              checked: false,
              reading: false,
              dirty: false,
              ended: false,
              endedReads: 0,
            };
            subagentTranscripts.set(id, state);
          }
          state.dirty = true;
          if (ended) state.ended = true;
          else if (state.ended && !state.reading) {
            // A reopened subagent is read again as it runs.
            state.ended = false;
            state.endedReads = 0;
          }
          if (state.reading) return;
          state.reading = true;
          yield* drainSubagentSteps(id).pipe(Effect.forkIn(scope));
        });
        let compactionOrdinal = 0;
        let runningCompaction: string | undefined;
        // A refused compaction starts and ends within a millisecond and shows no row.
        let compactionRowShown = false;
        let manualCompactionStopped: Deferred.Deferred<string | undefined> | undefined;
        const compactionItemId = () => {
          runningCompaction ??= `native-compaction-${++compactionOrdinal}`;
          return runningCompaction;
        };
        const finishedCompactionId = () => {
          const id = compactionItemId();
          runningCompaction = undefined;
          compactionRowShown = false;
          return id;
        };
        const publishCompaction = (resultValue: unknown) => {
          const result = isRecord(resultValue) ? resultValue : {};
          const counter = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0
              ? Math.trunc(value)
              : undefined;
          const before = counter(result.tokensBefore);
          const after = counter(result.estimatedTokensAfter);
          return onUpdate({
            type: "item",
            id: finishedCompactionId(),
            status: "completed",
            item: {
              type: "compaction",
              ...(typeof result.summary === "string"
                ? { summary: client.redaction.text(result.summary) }
                : {}),
              ...(before === undefined ? {} : { beforeTokenCount: before }),
              ...(after === undefined ? {} : { afterTokenCount: after }),
            },
          }).pipe(Effect.andThen(refreshUsage()));
        };
        const applyUpdate = (update: OmpSessionUpdate): Effect.Effect<void> => {
          switch (update.type) {
            // SCIENT-FORK: translate RPC observations into the existing provider-neutral UI.
            case "observation": {
              const event = update.event;
              if (event.type === "message_end" && isRecord(event.message)) {
                const usage = ompMessageUsage(
                  event.message.usage,
                  contextWindow(
                    typeof event.message.provider === "string" ? event.message.provider : undefined,
                    typeof event.message.model === "string" ? event.message.model : undefined,
                  ) ??
                    contextWindow(activeModel?.provider, activeModel?.modelId) ??
                    contextUsage?.maxTokens,
                );
                const messageId = typeof event.messageId === "string" ? event.messageId : undefined;
                const request =
                  messageId !== undefined && countedRequests.has(messageId)
                    ? undefined
                    : ompRequestUsage(event.message);
                if (request !== undefined && messageId !== undefined) {
                  if (countedRequests.size >= 1_000) countedRequests.clear();
                  countedRequests.add(messageId);
                }
                if (!usage)
                  return request === undefined ? Effect.void : onUpdate({ type: "usage", request });
                contextUsage = {
                  ...contextUsage,
                  ...usage,
                  ...(usage.maxTokens ? { maxTokens: usage.maxTokens } : { maxTokens: undefined }),
                };
                return onUpdate({
                  type: "usage",
                  // SCIENT-FORK: idle compaction times itself to the one-hour prompt cache.
                  tokenUsage: withOmpPromptCacheExpiry(usage, event),
                  contextUsage,
                  ...(request === undefined ? {} : { request }),
                });
              }
              if (event.type === "cache_warming_end")
                return event.usage === undefined ? Effect.void : refreshUsage(false);
              // SCIENT-FORK: the thread's goal row follows the agent's goal.
              if (event.type === "goal_updated") {
                const update = ompGoalUpdate(event);
                return update === undefined ? Effect.void : onUpdate({ type: "goal", ...update });
              }
              // SCIENT-FORK: the plan the agent proposes shows as a plan card.
              if (event.type === "plan_proposed") {
                const markdown = ompProposedPlan(event);
                return markdown === undefined
                  ? Effect.void
                  : onUpdate({
                      type: "item",
                      id: `proposed-plan-${++proposedPlans}`,
                      status: "completed",
                      item: { type: "proposed_plan", markdown: client.redaction.text(markdown) },
                    });
              }
              if (event.type === "todo_auto_clear") return publishTodos([]);
              if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
                const starting = event.type === "auto_retry_start";
                if ((starting || event.success === false) && retryId === undefined) {
                  retryId = `native-retry-${++retrySequence}`;
                  retryProgress = undefined;
                }
                if (retryId === undefined) return Effect.void;
                const id = retryId;
                const attempt = Math.max(
                  1,
                  Math.trunc(event.attempt ?? retryProgress?.attempt ?? 1),
                );
                const retry = {
                  attempt,
                  maxAttempts:
                    event.maxAttempts === undefined
                      ? (retryProgress?.maxAttempts ?? null)
                      : Math.max(attempt, Math.trunc(event.maxAttempts)),
                  retryDelayMs:
                    event.delayMs === undefined
                      ? (retryProgress?.retryDelayMs ?? null)
                      : Math.max(0, Math.trunc(event.delayMs)),
                };
                retryProgress = retry;
                if (!starting) retryId = undefined;
                return onUpdate({
                  type: "item",
                  id,
                  status: starting ? "running" : event.success ? "completed" : "failed",
                  item: {
                    type: "error",
                    failure: makeProviderFailure({
                      message: client.redaction.text(
                        event.errorMessage ??
                          event.finalError ??
                          (event.success
                            ? `${target.name} model request recovered.`
                            : `${target.name} model request failed.`),
                      ),
                      class: "provider_error",
                      retryable: starting,
                    }),
                    retry,
                  },
                });
              }
              if (event.type === "retry_fallback_applied")
                return notice(
                  `${target.name} switched from ${event.from ?? "the requested model"} to ${event.to ?? "a fallback model"}${event.reason ? `: ${event.reason}` : "."}`,
                );
              // SCIENT-FORK: the agent's "Run /login" advice becomes Scient's, and the accounts refresh.
              const signedOut =
                event.type === "notice" ? scientAgentSignedOutNotice(event) : undefined;
              if (signedOut !== undefined)
                return Effect.andThen(options.onAccountSignedOut ?? Effect.void, notice(signedOut));
              if (event.type === "notice" || event.method === "notify")
                return notice(
                  `${event.source ? `${event.source}: ` : ""}${event.message ?? `${target.name} notification.`}`,
                  event.level === "error" || event.notifyType === "error",
                );
              return Effect.void;
            }
            case "assistant-delta":
              waitRows.noteActivity();
              return onUpdate({
                type: "text",
                id: update.messageId,
                delta: client.redaction.exact(update.delta),
              });
            case "reasoning-delta":
              waitRows.noteActivity();
              return onUpdate({
                type: "text",
                id: update.messageId,
                delta: client.redaction.exact(update.delta),
                reasoning: true,
              });
            case "content-snapshot":
              return onUpdate({
                type: "text-snapshot",
                id: update.messageId,
                text: client.redaction.exact(update.text),
                reasoning: update.reasoning,
                status: update.status,
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
              const name = update.name === "tool" && previous ? previous.name : update.name;
              const waitTitle = waitRows.isWait(name)
                ? waitRows.title(
                    update.toolCallId,
                    update.status === "inProgress" ? "running" : update.status,
                    update.data,
                  )
                : undefined;
              if (waitRows.isWait(name)) {
                if (waitTitle === undefined) return Effect.void;
              } else waitRows.noteActivity();
              const computer =
                ompComputerPresentation(
                  name,
                  update.input ?? previous?.input,
                  update.data,
                  client.redaction.text,
                ) ?? retainedComputerPresentation(previous);
              const images = ompToolImages(update.data);
              const permissionsNeeded = computer
                ? ompComputerPermissionsNeeded(
                    [rawOutput, ...ompComputerStatusErrors(update.data)].join("\n"),
                  )
                : [];
              const status = update.status === "inProgress" ? "running" : update.status;
              const row =
                computer || images.length > 0 || previous?.images !== undefined
                  ? undefined
                  : toolRows.row(update.toolCallId, name, {
                      input: update.input,
                      data: update.data,
                      output: rawOutput,
                      status,
                    });
              const item: Extract<NativeSessionUpdate, { type: "tool" }> = {
                type: "tool",
                id: update.toolCallId,
                name,
                ...(row === undefined ? {} : { row }),
                ...(waitTitle === undefined ? {} : { title: waitTitle }),
                ...computer,
                ...(images.length > 0
                  ? { images }
                  : previous?.images === undefined
                    ? {}
                    : { images: previous.images }),
                ...(permissionsNeeded.length > 0
                  ? { permissionsNeeded }
                  : previous?.permissionsNeeded === undefined
                    ? {}
                    : { permissionsNeeded: previous.permissionsNeeded }),
                status,
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
              if (
                item.name === "todo" &&
                update.phase === "completed" &&
                item.status === "completed"
              ) {
                const details =
                  isRecord(update.data) && isRecord(update.data.details)
                    ? update.data.details
                    : undefined;
                return onUpdate(item).pipe(
                  Effect.andThen(
                    details && ompTodoSteps(details.phases) !== undefined
                      ? publishTodos(details.phases)
                      : refreshSettledState(),
                  ),
                );
              }
              return onUpdate(item);
            }
            case "question":
              return onUpdate({
                ...update,
                message: client.redaction.text(update.message),
                title: client.redaction.text(update.title),
                options: update.options.map((option) => ({
                  ...option,
                  label: client.redaction.text(option.label),
                  description: client.redaction.text(option.description),
                })),
                ...(update.questions === undefined
                  ? {}
                  : {
                      questions: update.questions.map((question) => ({
                        ...question,
                        question: client.redaction.text(question.question),
                        options: question.options.map((option) => ({
                          ...option,
                          label: client.redaction.text(option.label),
                          description: client.redaction.text(option.description),
                        })),
                      })),
                    }),
                ...(update.initialAnswer === undefined
                  ? {}
                  : { initialAnswer: client.redaction.text(update.initialAnswer) }),
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
                    ...(update.failureClass === undefined
                      ? {}
                      : { failureClass: update.failureClass }),
                    ...(update.resetAt === undefined ? {} : { resetAt: update.resetAt }),
                    ...(update.failureCode === undefined
                      ? {}
                      : { failureCode: update.failureCode }),
                    ...(update.httpStatus === undefined ? {} : { httpStatus: update.httpStatus }),
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
              return broken
                ? publishProcessLoss(publish)
                : refreshUsage().pipe(
                    Effect.andThen(refreshSettledState()),
                    Effect.andThen(recordTurnEntry),
                    Effect.andThen(publish),
                  );
            }
            case "process-exited":
              return publishProcessLoss(
                Effect.suspend(() =>
                  onUpdate({
                    type: "terminal",
                    status: "failed",
                    detail: `${processLossDescription} Its turn outcome is unknown.`,
                    failureClass: "unknown",
                    failureCode: "process_exit",
                    broken: true,
                  }),
                ),
              ).pipe(
                Effect.andThen(closeSession(Exit.void).pipe(Effect.forkDetach, Effect.asVoid)),
              );
            case "error":
              return notice(update.message, true);
            case "warning":
              return notice(update.message);
            case "subagent":
              // Only a settled subagent whose row shows its outcome makes a wait's copy redundant.
              waitRows.noteSubagent(
                update.id,
                update.status !== "inProgress" &&
                  (update.detail !== undefined ||
                    (target.driverKind === "scient" && update.result !== undefined)),
              );
              return Effect.andThen(
                onUpdate({
                  type: "subagent",
                  id: update.id,
                  ...(update.sessionFile === undefined && !subagentTranscripts.has(update.id)
                    ? {}
                    : { stepsFollow: true }),
                  title:
                    target.driverKind === "scient"
                      ? client.redaction.text(update.title)
                      : update.title,
                  status:
                    update.status === "inProgress"
                      ? "running"
                      : update.status === "stopped"
                        ? "cancelled"
                        : update.status,
                  ...(update.detail === undefined
                    ? {}
                    : { detail: client.redaction.text(update.detail) }),
                  ...(target.driverKind !== "scient"
                    ? {}
                    : {
                        ...(update.prompt === undefined
                          ? {}
                          : { prompt: client.redaction.text(update.prompt) }),
                        ...(update.progress === undefined
                          ? {}
                          : { progress: client.redaction.text(update.progress) }),
                        ...(update.result === undefined
                          ? {}
                          : { result: client.redaction.text(update.result) }),
                        ...(update.model === undefined
                          ? {}
                          : { model: client.redaction.text(update.model) }),
                        ...(update.presentation === undefined
                          ? {}
                          : {
                              presentation: {
                                ...update.presentation,
                                ...(update.presentation.role === undefined
                                  ? {}
                                  : { role: client.redaction.text(update.presentation.role) }),
                                ...(update.presentation.effort === undefined
                                  ? {}
                                  : { effort: client.redaction.text(update.presentation.effort) }),
                                ...(update.presentation.lastToolName === undefined
                                  ? {}
                                  : {
                                      lastToolName: client.redaction.text(
                                        update.presentation.lastToolName,
                                      ),
                                    }),
                              },
                            }),
                      }),
                }),
                followSubagentSteps(update.id, update.sessionFile, update.status !== "inProgress"),
              );
            case "session-settled":
              return refreshUsage(false).pipe(
                Effect.andThen(onUpdate({ type: "background", pending: false })),
              );
            case "command-output": {
              const command = dashboardRequested;
              if (command !== undefined && ompDashboardProgress(update.delta)) return Effect.void;
              const pageUrl =
                command === undefined
                  ? undefined
                  : ompDashboardUrl(ompDashboardThroughLink(update.delta, dashboardSessions));
              if (pageUrl !== undefined) dashboardRequested = undefined;
              return onUpdate({
                type: "text",
                id: "command-output",
                delta: client.redaction.text(
                  ompCommandOutputText(
                    command !== undefined && pageUrl !== undefined
                      ? ompDashboardLink(command, pageUrl)
                      : update.delta,
                  ),
                ),
              }).pipe(
                Effect.andThen(
                  pageUrl === undefined
                    ? Effect.void
                    : openDashboard(pageUrl).pipe(Effect.forkIn(scope), Effect.asVoid),
                ),
              );
            }
            case "background-result":
              return update.detail
                ? onUpdate({
                    type: "tool",
                    id: update.id,
                    name: "Background result",
                    status: "completed",
                    output: client.redaction.text(update.detail),
                  })
                : Effect.void;
            case "compaction-started": {
              const id = compactionItemId();
              return Effect.sleep("250 millis").pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (runningCompaction !== id) return Effect.void;
                    compactionRowShown = true;
                    return onUpdate({
                      type: "item",
                      id,
                      status: "running",
                      item: { type: "compaction" },
                    });
                  }),
                ),
                Effect.forkIn(scope),
                Effect.asVoid,
              );
            }
            case "compaction-stopped": {
              const shown = compactionRowShown;
              const id = runningCompaction === undefined ? undefined : finishedCompactionId();
              return (
                shown && id !== undefined
                  ? onUpdate({ type: "item", id, status: "failed", item: { type: "compaction" } })
                  : Effect.void
              ).pipe(
                Effect.andThen(
                  manualCompactionStopped
                    ? Deferred.succeed(manualCompactionStopped, update.skippedReason)
                    : Effect.void,
                ),
              );
            }
            case "compacted":
              return manualCompaction ? Effect.void : publishCompaction(update.result);
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
              manualCompaction = false;
              ordinaryTools.clear();
              toolRows.clear();
              waitRows.reset();
              return onUpdate({ type: "continuation-started" });
            case "model-changed":
              if (update.model) activeModel = decodeOmpModelSlug(update.model);
              return update.model ? onUpdate({ type: "model", model: update.model }) : Effect.void;
          }
        };
        // SCIENT-FORK: live voice frames bypass the turn machine.
        const liveVoice = makeOmpLiveVoice(client);
        const runtime = yield* makeOmpSessionRuntime({
          target,
          client,
          scope,
          liveVoice,
          continuationIdPrefix: yield* options.random.uuidV4(),
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
          return yield* new NativeSessionOperationError({
            detail: `${target.name} did not offer RPC protocol v2.`,
          });
        yield* refreshCatalog().pipe(Effect.ignore);
        yield* extension.discardUnconsumed;
        yield* client.setSubagentSubscription("progress");
        if (compareSemverVersions(client.runtimeVersion, "18.3.1") >= 0)
          // Streaming updates are read only for their delta. Full snapshots grow
          // quadratically with a message and, when this host falls behind, are
          // spooled to an unbounded temporary file by the agent.
          yield* client
            .setEventFilter(OMP_KNOWN_EVENT_TYPES, { messageUpdates: "delta" })
            .pipe(Effect.catchTags({ OmpRpcCommandError: () => Effect.void }));
        // SCIENT-FORK: one dialog for all of an `ask` call's questions. An agent without
        // the command asks them one at a time through select and input requests.
        yield* client
          .command({ type: "set_ask_dialog", enabled: true })
          .pipe(Effect.catchTags({ OmpRpcCommandError: () => Effect.void }));
        const ensureFresh = Effect.fn("OmpAdapterV2.ensureFresh")(
          function* () {
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
          },
          (effect) => effect.pipe(Effect.mapError(safeFailure)),
        );
        const resume = Effect.fn("OmpAdapterV2.resume")(
          function* (requestedId: string, resumeCursor?: unknown, modelSelection?: ModelSelection) {
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
            const expected = yield* fs.realPath(path.resolve(root, validated.relativeSessionFile));
            if (real !== expected || !sessionFileInsideRoot(root, real))
              return yield* new NativeSessionOperationError({
                detail: `${target.name} resume cursor does not name the requested conversation.`,
              });
            // A failed or cancelled switch must leave ensureThread able to reset
            // whatever transcript the native process may have partially loaded.
            fresh = false;
            // Bind the thread's own model to preserve native conversation on switches. Only
            // unknown-pair rejection proves no session mutation and permits plain-switch fallback;
            // other failures may already have changed state.
            const bound =
              modelSelection &&
              modelSelection.model !== "default" &&
              compareSemverVersions(client.runtimeVersion, "18.6.3") >= 0
                ? decodeOmpModelSlug(modelSelection.model)
                : null;
            if (bound?.provider.startsWith("scient_") && client.refreshModels)
              yield* client.refreshModels().pipe(Effect.ignore);
            const result = yield* bound
              ? client.switchSession(real, bound).pipe(
                  Effect.catchTags({
                    OmpRpcCommandError: (error) =>
                      error.detail.startsWith("Model not found")
                        ? client.switchSession(real)
                        : Effect.fail(error),
                  }),
                )
              : client.switchSession(real);
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
          },
          (effect, _argument0: string, _argument1?: unknown, _argument2?: ModelSelection) =>
            effect.pipe(Effect.timeout("2 minutes"), Effect.mapError(safeFailure)),
        );
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
        // SCIENT-FORK: a refused command is an answer to the user, not a failed turn.
        const commandRefusal = (text: string) => {
          const decision = ompCommandDecision(text, runtime.catalog());
          if (decision === "unavailable")
            return `That command is unavailable in this ${target.name} conversation.`;
          if (decision !== "mutator") return undefined;
          return /^\/fast\b/.test(text.trimStart())
            ? "Use the Standard and Fast switch in the model menu."
            : `This ${target.name} command changes provider configuration; use the provider settings instead.`;
        };
        const payload = Effect.fn("OmpAdapterV2.payload")(function* (
          message: ProviderAdapter.ProviderAdapterV2TurnMessage,
          selected?: { provider: string; id: string },
        ) {
          const refusal = commandRefusal(message.text);
          if (refusal !== undefined)
            return yield* new NativeSessionOperationError({
              detail: refusal,
              breaksSession: false,
            });
          const imageFiles: Array<{ path: string; size: number; mimeType: string }> = [];
          const attachmentPaths = new Map<ChatAttachment, string>();
          for (const attachment of message.attachments) {
            const stored = resolveAttachmentPath({
              attachmentsDir: options.serverConfig.attachmentsDir,
              attachment,
            });
            if (!stored)
              return yield* new NativeSessionOperationError({
                detail: `Invalid ${target.name} attachment path.`,
              });
            const real = yield* fs.realPath(stored);
            const root = yield* fs.realPath(options.serverConfig.attachmentsDir);
            const info = yield* fs.stat(real);
            const limit =
              attachment.type === "image"
                ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
            if (!sessionFileInsideRoot(root, real) || info.type !== "File")
              return yield* new NativeSessionOperationError({
                detail: `${target.name} attachment escaped its directory or is not a file.`,
              });
            if (Number(info.size) > limit)
              return yield* new NativeSessionOperationError({
                detail: `${target.name} ${attachment.type} attachment exceeds the ${formatOmpBytes(limit)} limit.`,
              });
            attachmentPaths.set(attachment, real);
            if (isProviderNativeImageAttachment(attachment))
              imageFiles.push({
                path: real,
                size: Number(info.size),
                mimeType: attachment.mimeType,
              });
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
              return yield* new NativeSessionOperationError({
                detail:
                  model?.input === undefined
                    ? `Couldn't verify image support for the selected ${target.name} model. Text messages still work.`
                    : `The selected ${target.name} model does not support images.`,
                breaksSession: false,
              });
          }
          const { maxFrameBytes } = yield* client.limits;
          let text = message.text;
          // The frame keeps the attachment lines; a private prompt file holds only the text.
          const attachmentContext = yield* providerMessageTextWithAttachmentPaths({
            text: "",
            attachments: message.attachments,
            resolveAttachmentPath: (attachment) => attachmentPaths.get(attachment) ?? null,
            resolveExtractedTextPath: (path) =>
              DocumentText.resolveExtractedTextPath(path).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              ),
            preserveOverflow: true,
          });
          const plan = () =>
            planOmpImages({
              images: imageFiles,
              maxFrameBytes,
              buildMessage: (externalImages) =>
                [
                  ...(text ? [text] : []),
                  ...(attachmentContext ? [attachmentContext] : []),
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
              `scient-prompt-${yield* options.random.uuidV4()}.txt`,
            );
            yield* fs.writeFileString(promptPath, text, { mode: 0o600 });
            yield* Effect.addFinalizer(() => fs.remove(promptPath).pipe(Effect.ignore));
            const encodedPromptPath = yield* encodeJsonStringEffect(promptPath);
            text = `Read the entire conversation and current request from this UTF-8 file before answering: ${encodedPromptPath}. Read successive ranges if needed; a preview is not the complete history. Answer the current request, treating historical messages as context.`;
            delivery = plan();
          }
          if ("messageBytes" in delivery)
            return yield* new NativeSessionOperationError({
              detail: `The prompt exceeds ${target.name}'s ${maxFrameBytes}-byte frame limit.`,
            });
          const images: OmpRpcImage[] = [];
          for (const image of delivery.inline)
            images.push({
              type: "image",
              data: Buffer.from(yield* fs.readFile(image.path)).toString("base64"),
              mimeType: image.mimeType,
            });
          return { message: delivery.message, images };
        });
        let interruptBreaksSession = false;
        const interrupt = Effect.fn("OmpAdapterV2.interrupt")(function* () {
          const graceful = Effect.gen(function* () {
            const { settled } = yield* runtime.pause;
            const result = yield* client.command({ type: "abort_and_restore_queue" });
            const data = result.data;
            if (isRecord(data)) {
              const withdrawn = [data.steering, data.followUp].flatMap((queue) =>
                Array.isArray(queue)
                  ? queue.flatMap((entry) =>
                      isRecord(entry) && typeof entry.text === "string" ? [entry.text] : [],
                    )
                  : [],
              );
              if (withdrawn.length > 0 || data.imagesDropped === true || data.truncated === true)
                yield* applyUpdate({
                  type: "warning",
                  message: [
                    "Stop withdrew unused queued input from the agent. Send it again if still wanted:",
                    ...withdrawn,
                    ...(data.imagesDropped === true
                      ? ["The runtime omitted withdrawn images."]
                      : []),
                    ...(data.truncated === true
                      ? ["The runtime omitted some withdrawn messages."]
                      : []),
                  ].join("\n\n"),
                });
            }
            yield* settled;
            yield* recordTurnEntry;
            yield* onUpdate({ type: "background", pending: false });
          });
          // Bound command acknowledgement and event settlement together. A hung RPC
          // must take the same owned-process cleanup path as a failed abort.
          yield* graceful.pipe(
            Effect.timeout("3 seconds"),
            Effect.catch(() =>
              Effect.gen(function* () {
                interruptBreaksSession = true;
                yield* stopOwnedProcess;
                yield* closeSession(Exit.void);
              }).pipe(Effect.uninterruptible),
            ),
          );
        });
        const native: NativeSession = {
          stopSubagent: Effect.fn("OmpAdapterV2.stopSubagent")(
            function* (nativeTaskId: string) {
              const response = yield* client
                .command({
                  type: "cancel_subagent",
                  subagentId: nativeTaskId,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new NativeSessionOperationError({
                        detail:
                          cause._tag === "OmpRpcCommandError" &&
                          /unknown command|unsupported|not supported/i.test(cause.message)
                            ? `${target.name} runtime does not support stopping individual subagents. Update the runtime and try again.`
                            : `${target.name} could not stop this subagent: ${client.redaction.text(cause.message)}`,
                      }),
                  ),
                );
              yield* decodeSubagentCancellation(response.data).pipe(
                Effect.mapError(
                  () =>
                    new NativeSessionOperationError({
                      detail: `${target.name} returned an invalid subagent cancellation response.`,
                    }),
                ),
              );
            },
            (effect, nativeTaskId) =>
              effect.pipe(
                Effect.tapError((cause) =>
                  notice(cause.detail, false, `subagent-stop:${nativeTaskId}`),
                ),
              ),
          ),
          // SCIENT-FORK: older agents can reject compact without breaking the conversation.
          compact: Effect.fn("OmpAdapterV2.compact")(function* (_turnInput, nativeTurnId) {
            const state = yield* client.getState().pipe(Effect.mapError(safeFailure));
            if (
              state.hasPendingAsyncWork === true ||
              state.isSettled === false ||
              state.isStreaming === true ||
              state.isCompacting === true
            )
              return yield* new NativeSessionOperationError({
                detail: `${target.name} compaction waits until background work settles.`,
                breaksSession: false,
              });
            yield* onUpdate({ type: "offered", nativeTurnId });
            manualCompaction = true;
            const stopped = yield* Deferred.make<string | undefined>();
            manualCompactionStopped = stopped;
            const response = yield* client.compact().pipe(
              // SCIENT-FORK: nothing to compact refuses the command, but no turn failed.
              Effect.catchTags({
                OmpRpcCommandError: (cause) =>
                  compareSemverVersions(client.runtimeVersion, "18.13.3") < 0
                    ? Effect.fail(cause)
                    : Deferred.await(stopped).pipe(
                        Effect.timeoutOption("1 second"),
                        Effect.flatMap((reason) =>
                          Option.isSome(reason) && reason.value !== undefined
                            ? Effect.succeed(reason.value)
                            : Effect.fail(cause),
                        ),
                      ),
              }),
              Effect.mapError(
                (cause) =>
                  new NativeSessionOperationError({
                    detail: client.redaction.text(cause.message),
                    breaksSession: cause._tag !== "OmpRpcCommandError",
                  }),
              ),
            );
            yield* onUpdate({ type: "accepted", nativeTurnId });
            if (typeof response === "string") yield* notice(response);
            else yield* publishCompaction(response.data);
            yield* onUpdate({ type: "terminal", status: "completed" });
          }),
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
          completeInterruptOnCancellation: true,
          get interruptBreaksSession() {
            return interruptBreaksSession;
          },
          send: Effect.fn("OmpAdapterV2.send")(
            function* (turnInput, nativeTurnId) {
              manualCompaction = false;
              dashboardRequested = ompDashboardCommand(turnInput.message.text);
              // SCIENT-FORK:START - /goal drives Scient Agent's goal command.
              const goalCommand =
                target.driverKind === "scient" ? parseGoalCommand(turnInput.message) : null;
              const planCommand =
                target.driverKind === "scient" ? parseOmpPlanCommand(turnInput.message.text) : null;
              const refusal =
                goalCommand === null && planCommand === null
                  ? commandRefusal(turnInput.message.text)
                  : undefined;
              // SCIENT-FORK:END
              if (refusal !== undefined) {
                yield* onUpdate({ type: "offered", nativeTurnId });
                yield* onUpdate({ type: "accepted", nativeTurnId });
                yield* notice(refusal);
                yield* onUpdate({ type: "terminal", status: "completed" });
                return;
              }
              activeModel = decodeOmpModelSlug(turnInput.modelSelection.model);
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
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} did not report a default model or the selection is not provider/model.`,
                });
              if (model.provider.startsWith("scient_") && client.refreshModels)
                yield* client.refreshModels();
              // SCIENT-FORK: a /plan message sends its task as the prompt.
              const prompt = yield* payload(
                planCommand?.type === "enter"
                  ? { ...turnInput.message, text: planCommand.task }
                  : turnInput.message,
                {
                  provider: model.provider,
                  id: model.modelId,
                },
              );
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
                if (actualSlug !== previousSlug || actual.thinkingLevel !== previous.thinkingLevel)
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
                      Effect.catchTags({
                        // The enclosing operation owns the span for this inline handler.
                        OmpRpcCommandError: Effect.fnUntraced(function* () {
                          if (client.refreshModels) yield* client.refreshModels();
                          yield* refreshCatalog().pipe(Effect.ignore);
                          yield* client.setModel(model.provider, model.modelId);
                        }),
                      }),
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
                // SCIENT-FORK: the turn runs either way; the agent says when a tier is unavailable.
                const fastMode =
                  getModelSelectionBooleanOptionValue(turnInput.modelSelection, "fastMode") ===
                  true;
                if (applied.fastModeEnabled !== undefined && applied.fastModeEnabled !== fastMode)
                  yield* client.command({ type: "set_fast_mode", enabled: fastMode }).pipe(
                    Effect.catchTags({
                      OmpRpcCommandError: (error) =>
                        onUpdate({
                          type: "tool",
                          id: `${nativeTurnId}:fast-mode-warning`,
                          name: `${target.name} fast mode`,
                          status: "completed",
                          output: client.redaction.text(error.detail),
                        }),
                    }),
                  );
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
              promptSentAt = DateTime.toEpochMillis(yield* DateTime.now);
              if (admission.steering) {
                yield* restore;
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} resumed background work while preparing this message; the message was not sent.`,
                  breaksSession: false,
                });
              }
              fresh = false;
              // SCIENT-FORK:START - /goal drives Scient Agent's goal command.
              if (goalCommand !== null)
                return yield* runOmpGoalTurn({
                  client,
                  command: goalCommand,
                  nativeTurnId,
                  runtime,
                  onUpdate,
                  notice: (message) => notice(message),
                  redact: (text) => client.redaction.text(text),
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new NativeSessionOperationError({
                        detail: client.redaction.text(cause.message),
                        cause,
                      }),
                  ),
                );
              // SCIENT-FORK:END
              // SCIENT-FORK:START - /plan drives Scient Agent's plan mode.
              if (
                planCommand !== null &&
                (yield* runOmpPlanTurn({
                  client,
                  command: planCommand,
                  nativeTurnId,
                  runtime,
                  onUpdate,
                  notice: (message) => notice(message),
                  redact: (text) => client.redaction.text(text),
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new NativeSessionOperationError({
                        detail: client.redaction.text(cause.message),
                        cause,
                      }),
                  ),
                ))
              )
                return;
              // SCIENT-FORK:END
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
                          ? {
                              failureCode:
                                cause.code === "timeout" ? "command_timeout" : "command_rejected",
                            }
                          : {
                              failureClass: "unknown" as const,
                              // A pending prompt whose process exited is a process loss.
                              failureCode:
                                cause._tag === "OmpRpcProcessExitedError"
                                  ? "process_exit"
                                  : "rpc_failed",
                            }),
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
            },
            (effect, _argument0, _argument1) =>
              effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(safeFailure)),
          ),
          steer: Effect.fn("OmpAdapterV2.steer")(
            function* (steerInput, validateOwner) {
              const prompt = yield* payload(steerInput.message);
              // SCIENT-FORK: recheck the captured owner after payload preparation.
              yield* validateOwner?.() ?? Effect.void;
              const result = yield* client.steer(prompt.message, prompt.images);
              yield* runtime.accepted(
                result.id ?? String(steerInput.providerTurnId),
                true,
                "steer",
              );
            },
            (effect, _argument0, _argument1) =>
              effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(safeFailure)),
          ),
          beforeOwnerClose: Effect.suspend(() => processLossPublished ?? Effect.void),
          // SCIENT-FORK: Scient Agent predicts the user's next message; an agent without the
          // command, or one that fails to answer, offers none.
          ...(target.driverKind === "scient"
            ? {
                predictNextMessage: client.command({ type: "predict_next_message" }).pipe(
                  Effect.map((result) =>
                    isRecord(result.data) && typeof result.data.text === "string"
                      ? result.data.text
                      : null,
                  ),
                  Effect.catchTags({
                    OmpRpcCommandError: (cause) =>
                      Effect.logDebug("orchestration-v2.omp-next-message-unavailable", {
                        detail: cause.detail,
                      }).pipe(Effect.as(null)),
                  }),
                  Effect.mapError(safeFailure),
                ),
              }
            : {}),
          // SCIENT-FORK: a spoken conversation through Scient Agent's ChatGPT sign-in.
          ...(target.driverKind === "scient" ? { liveVoice: liveVoice.runtime } : {}),
          interrupt: interrupt().pipe(Effect.mapError(safeFailure)),
          resume,
          rewindBefore: Effect.fn("OmpAdapterV2.rewindBefore")(
            function* (entryId: string) {
              if (yield* branchBefore(client.command, entryId))
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} cancelled the rewind.`,
                });
              const state = yield* client.getState();
              if (!state.sessionFile)
                return yield* new NativeSessionOperationError({
                  detail: `${target.name} did not save the rewound conversation.`,
                });
              yield* refreshCursor(state.sessionFile, state.sessionId);
              sessionTree.reset(nativeId);
              return { nativeId, ...(cursor === undefined ? {} : { resumeCursor: cursor }) };
            },
            (effect, _entryId) => effect.pipe(Effect.mapError(safeFailure)),
          ),
          respond: Effect.fn("OmpAdapterV2.respond")(
            function* (id, response) {
              const question = runtime.lookupQuestion(id);
              if (!question)
                return yield* new NativeSessionOperationError({
                  detail: `The ${target.name} dialog is no longer pending.`,
                });
              if (question.method === "ask") {
                const answers =
                  response.answers && ompAskAnswers(question.questions ?? [], response.answers);
                yield* client.extensionUiResponse(
                  answers ? { id, answers } : { id, cancelled: true },
                );
                runtime.removeQuestion(id);
                return;
              }
              const answer = response.answers?.[id];
              const value = typeof answer === "string" ? answer : undefined;
              if (
                value !== undefined &&
                question.allowedValues &&
                !question.allowedValues.includes(value)
              )
                return yield* new NativeSessionOperationError({
                  detail: `The answer is not one of ${target.name}'s offered choices.`,
                });
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
            },
            (effect, _argument0, _argument1) => effect.pipe(Effect.mapError(safeFailure)),
          ),
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
});
