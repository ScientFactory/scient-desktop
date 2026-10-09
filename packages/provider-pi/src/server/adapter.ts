/**
 * PiAdapterV2 — orchestrator-v2 adapter for the Pi coding agent
 * (https://pi.dev), driving `pi --mode rpc` over stdio JSONL via `PiRpc.ts`.
 *
 * Design intent: honor the user's Pi customizations. The process is spawned
 * with no `--no-*` flags, so the user's extensions, skills, prompt templates,
 * AGENTS.md / SYSTEM.md context, settings.json, custom models, and auth all
 * load exactly as they do in the `pi` TUI. Pi writes sessions into the
 * configured instance's private session directory; the file path is the durable
 * `nativeThreadRef`, so a thread started in T3 can be resumed from the TUI
 * and vice versa.
 *
 * Turn lifecycle: `agent_settled` is the only terminal signal. `agent_end`
 * merely closes one low-level run — compaction retries, auto-retries, and
 * queued continuations may still follow it, so the turn stays open until Pi
 * reports the session settled. An extension can start detached compaction as
 * that signal unwinds, so the adapter confirms Pi is idle before terminalizing.
 *
 * Extension UI: Pi extensions raise dialogs through `extension_ui_request`.
 * Dialog methods become v2 runtime requests (`confirm` → approval_request,
 * `select`/`input`/`editor` → user_input_request); answers travel back as
 * `extension_ui_response`. `notify` becomes a completed activity item.
 * Terminal-only decoration such as status, widget, title, and editor-text
 * updates has no matching T3 surface and is ignored.
 */
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import { PiSettings } from "../settings.ts";
import {
  getModelSelectionStringOptionValue,
  modelSelectionsEqual,
  MODEL_TOKEN_LIMIT_MESSAGE,
} from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import {
  expandPiSkillReference,
  parsePiCompactCommand,
  parsePiDiscoveredCommands,
  type PiCompactCommand,
} from "./commands.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { piContextErrorMessage } from "./contextError.ts";
import {
  allocateFreshPiSessionFile,
  cleanupFreshPiSessionFile,
  piInstanceStateRoot,
} from "./sessionFile.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { encodePiModelSlug } from "./model.ts";
import { applyPiModelSelection } from "./modelSelection.ts";
import {
  piNativeCommandNames,
  piNativeCommandWithAttachments,
  piHasImageAttachments,
  piModelRefusesImages,
} from "./inputCapabilities.ts";
import {
  decodeSelectionState,
  makePiSelectionClient,
  observedNativeEffort,
  piNativeSelection,
} from "./nativeSelection.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  PiRpcError,
  PiRpcTimeoutError,
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "./rpc.ts";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "./mcpInjection.ts";
import { PI_FILE_CHANGE_TOOLS } from "./mcpExtensionSource.ts";

export const PI_PROVIDER = ProviderDriverKind.make("pi");
const PI_DRIVER_KIND = PI_PROVIDER;
const DEFAULT_PI_SETTINGS = Schema.decodeSync(PiSettings)({});
const PiToolNameMapJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

/**
 * Sentinel model slug meaning "do not call set_model": Pi resolves the model
 * from the user's own settings.json (`defaultProvider`/`defaultModel`).
 */
const PI_INHERIT_MODEL_SLUG = "default";

const STREAM_FLUSH_MS = 50;
const PI_REQUEST_TIMEOUT_MS = 15_000;
// Session lifecycle hooks reload extensions, MCP servers and language servers.
const PI_SESSION_TIMEOUT_MS = 60_000;
const PI_SKILL_DISCOVERY_TIMEOUT_MS = 4_000;
const PI_UNSOLICITED_ACTIVITY_ERROR =
  "Pi started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.";
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);

export const PiProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // Mode changes restart this process so the injected permission hook gets
    // one immutable policy for its whole lifetime.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    // Pi exposes a blocking tool_call extension hook. The T3 bridge uses it
    // for supervised and auto-accept modes and forwards its confirmations
    // through the same extension UI protocol as user-installed extensions.
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    // T3 delegation uses the shared MCP `delegate_task` path. Installed Pi
    // subagent extensions are observed best-effort, but their official tool
    // runs children with --no-session and exposes no resumable child id.
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    // T3 delivers both full and delta handoffs through Pi's normal user-message
    // input, so neither strategy depends on a Pi-specific context hook.
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    // CommandPolicy.ensureRollback requires the snapshot whenever provider
    // rollback is enabled; rollbackThread returns the updated provider thread.
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface PiAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly makeConnection?: typeof makePiRpcConnection;
  /**
   * Where to offer a wake turn for provider-initiated work. Without one, such
   * work has no owner and the adapter stops it.
   */
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
  /** Application guidance to append to Pi's native runtime prompt. */
  readonly runtimeGuidance?: (capabilities: ReadonlySet<string> | undefined) => string;
  /** Canonical MCP tool name to host-projected model-visible name. */
  readonly toolNameMap?: Readonly<Record<string, string>>;
  /** Preserve the host's native-start receipt when mapping provider errors. */
  readonly mapTurnStartError?: (
    input: Pick<
      ProviderAdapter.ProviderAdapterV2TurnInput,
      "threadId" | "providerThread" | "runId"
    >,
    cause: unknown,
  ) => ProviderAdapter.ProviderAdapterTurnStartError;
}

/** Concatenate the `text` fields of a Pi content-block array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (recordField(block, "type") === "text") return recordString(block, "text") ?? "";
      return "";
    })
    .join("");
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: PI_PROVIDER, nativeId, strength };
}

// ── per-session state ─────────────────────────────────────────

interface PiStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

type PiCompactionStatus = "running" | "completed" | "failed" | "cancelled";

interface PiCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}

interface PiProviderRetryState {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

function compactionTitle(status: PiCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

interface ActivePiTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  /** Increments on assistant `message_start` so content indexes stay unique. */
  messageOrdinal: number;
  readonly streamItems: Map<string, PiStreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  /**
   * First-seen time per `toolCallId`. Later update/end events reuse it so a
   * tool keeps one start timestamp and reports a real duration.
   */
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  interrupted: boolean;
  broken: boolean;
  outputTruncated: boolean;
  modelFailure: OrchestrationV2ProviderFailure | null;
  contextRecoveryPending: boolean;
  /**
   * Whether any agent run activity was observed. Command-only prompts (pure
   * extension slash commands) never start an agent run and never emit
   * `agent_settled`; their deferred prompt ack plus an idle probe settles
   * the turn instead.
   */
  sawAgentActivity: boolean;
  /** A user prompt joined provider-native work whose settlement may already be queued. */
  adoptedWake: boolean;
  /** Only slash-command prompts can complete without starting an agent run. */
  readonly promptMayBeCommandOnly: boolean;
  /** Pi reports context as unknown immediately after compaction; keep its estimate for the meter. */
  latestCompactionAfterTokens: number | null;
  /** Last streamed usage total already emitted on the running turn. */
  lastLiveUsedTokens: number | null;
  /** Invalidates idle snapshots when new work starts after a settle probe. */
  settleProbeGeneration: number;
  pendingSteerCount: number;
  /** An extension may start compaction immediately after Pi emits agent_settled. */
  settleWhenIdle: boolean;
  sawCompaction: boolean;
  /** RPC compact is in flight; Pi abort does not cancel it. */
  manualCompactInFlight: boolean;
  activeCompaction: PiCompactionState | null;
  activeProviderRetry: PiProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  /** Native retry can recover its work without accepting a rejected joining prompt. */
  rejectedPromptFailure: ReturnType<typeof makeProviderFailure> | null;
  /** Session-tree refs read just before Stop terminates Pi, when no read is possible later. */
  stopTreeRefs?: PiTurnTreeRefs | null;
}

interface PiTurnTreeRefs {
  /** Omitted keeps the synthetic ref; null means the turn left nothing on the active branch. */
  readonly nativeTurnRef: OrchestrationV2ProviderRef | null | undefined;
  readonly leafId: string | null;
  /** Set after a native rewind: every user entry still on the active branch. */
  readonly retainedNativeTurnIds: ReadonlyArray<string> | undefined;
}

interface PendingPiPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  readonly approvalKey: string;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

/**
 * The T3 bridge confirms tool calls as `Allow <tool>?`. Edits surface as
 * file-change approvals so clients render them like other providers' edits;
 * every other confirmation, including ones from user extensions, is a command.
 */
function piApprovalRequestKind(title: string): "command" | "file-change" {
  const toolName = /^Allow (\S+)\?$/.exec(title)?.[1];
  return toolName !== undefined &&
    (PI_FILE_CHANGE_TOOLS as ReadonlyArray<string>).includes(toolName)
    ? "file-change"
    : "command";
}

interface BufferedPiWork {
  readonly workId: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly records: PiRpcRecord[];
}

interface PiThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActivePiTurn | null;
}

// ── adapter ───────────────────────────────────────────────────

const runtimePoliciesEqual = Schema.toEquivalence(ProviderAdapter.ProviderAdapterV2RuntimePolicy);
const isTurnStartError = Schema.is(ProviderAdapter.ProviderAdapterTurnStartError);
export const makePiAdapterV2 = Effect.fn("makePiAdapterV2")(function* (
  options: PiAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const { continuationRequests } = options;
  const mapTurnStartError = (
    input: Pick<
      ProviderAdapter.ProviderAdapterV2TurnInput,
      "threadId" | "providerThread" | "runId"
    >,
    cause: unknown,
  ): ProviderAdapter.ProviderAdapterTurnStartError =>
    options.mapTurnStartError?.(input, cause) ??
    (isTurnStartError(cause)
      ? cause
      : new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: PI_PROVIDER,
          threadId: input.threadId,
          providerThreadId: input.providerThread.id,
          runId: input.runId,
          cause,
        }));

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: PI_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: PI_PROVIDER,
    mcpSessionInjection: true,
    getCapabilities: () => Effect.succeed(PiProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("PiAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (input.modelSelection.instanceId !== options.instanceId)
        return yield* protocolError("Pi selection belongs to another provider instance");
      if (input.runtimePolicy.runtimeMode === "auto")
        return yield* protocolError("Pi does not support automatic runtime mode.");
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const nativePath = path;
      const mcpSession =
        input.configureMcp === false
          ? undefined
          : McpProviderSession.readMcpProviderSession(input.threadId);
      const provideCacheFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: PI_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      // The extension owns both the optional MCP bridge and Pi's permission
      // hook. Materialize it even when this session has no MCP credential so
      // Supervised never silently degrades to unrestricted tool execution.
      const extensionPath = yield* provideCacheFs(
        materializePiT3McpExtension(host.paths.providerStatusCacheDir),
      );
      const resolvedLaunchArgs = resolvePiLaunchArgs(options.settings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* protocolError(resolvedLaunchArgs.message);
      }
      const toolNameMapJson =
        options.toolNameMap === undefined
          ? undefined
          : yield* Schema.encodeEffect(PiToolNameMapJson)(options.toolNameMap).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: PI_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            );
      const launch = buildPiRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        environment: {
          ...options.environment,
          ...(options.runtimeGuidance === undefined
            ? {}
            : { PI_RUNTIME_GUIDANCE: options.runtimeGuidance(mcpSession?.capabilities) }),
          ...(options.toolNameMap === undefined ? {} : { PI_TOOL_NAME_MAP: toolNameMapJson }),
        },
        mcpSession,
        extensionPath,
        runtimeMode: input.runtimePolicy.runtimeMode,
      });
      // Pi lazily creates its default session file. An owned empty file lets
      // Pi write the native header before an empty thread is published.
      // Startup cleanup stays ordered even when the caller closes its parent
      // scope finalizers in parallel. The file is released after the process.
      const connectionScope = yield* Scope.fork(scope, "sequential");
      let freshSession: { readonly sessionFile: string } | undefined;
      let freshSessionPublished = false;
      let initialBindingComplete = false;
      const initialSessionFile =
        input.initialNativeThreadId ??
        (yield* Effect.acquireRelease(
          piInstanceStateRoot({
            stateDir: host.paths.stateDir,
            instanceId: options.instanceId,
          }).pipe(
            Effect.flatMap((stateRoot) =>
              randomUuidV4.pipe(
                Effect.flatMap((fileId) => allocateFreshPiSessionFile({ stateRoot, fileId })),
              ),
            ),
            Effect.provideService(Path.Path, path),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: PI_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          ),
          (fresh) =>
            freshSessionPublished
              ? Effect.void
              : provideCacheFs(cleanupFreshPiSessionFile(fresh)).pipe(Effect.orDie),
        ).pipe(
          Scope.provide(connectionScope),
          Effect.map((fresh) => {
            freshSession = fresh;
            return fresh.sessionFile;
          }),
        ));
      const rollbackStartup = (exit: Exit.Exit<unknown, unknown>) =>
        freshSession === undefined || initialBindingComplete || Exit.isSuccess(exit)
          ? Effect.void
          : Scope.close(connectionScope, exit);
      const connection: PiRpcConnection = yield* (options.makeConnection ?? makePiRpcConnection)({
        command: options.settings.binaryPath || "pi",
        args: [...launch.args, "--session", initialSessionFile],
        cwd,
        env: launch.env,
      }).pipe(
        Scope.provide(connectionScope),
        Effect.onExit((exit) => rollbackStartup(exit)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: PI_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      let nativeCommandNames = new Set<string>(["compact"]);
      const discoverSkillNames = connection
        .request({ type: "get_commands" }, PI_SKILL_DISCOVERY_TIMEOUT_MS)
        .pipe(
          Effect.map((data) => {
            const commands = parsePiDiscoveredCommands(data);
            nativeCommandNames = piNativeCommandNames(commands);
            return new Set(commands.skills.map((skill) => skill.name));
          }),
        );
      let skillNames: Set<string> | null = null;
      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: PI_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: PiProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingPrompts = new Map<string, PendingPiPrompt>();
      const sessionApprovals = new Set<string>();
      // Answering a dialog and terminalizing a turn both publish lifecycle
      // events. Pi can settle immediately after `extension_ui_response`, so
      // serialize the two paths to stop `turn.terminal` from overtaking the
      // dialog's own resolution updates.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: PiThreadState | null = null;
      let expectedNativeSessionId: string | undefined;
      let boundThreadId = input.threadId;
      let registrationAttempted = false;
      let lastNativeThreadId: string | null = null;
      // User Stop intentionally tears down this RPC process after aborting.
      // Keep that intent beyond turn finalization so the later stdout close is
      // not mistaken for an unexpected transport failure.
      let stopRequested = false;
      let forcedSessionFailure: string | null = null;
      let unsolicitedActivityDetected = false;
      let bufferedWork: BufferedPiWork | null = null;
      let nativeSelection: ModelSelection | null = null;
      let workOrdinal = 0;
      // Only logical generation mutation/accepted SQL commit uses this fence.
      // Never acquire the mapper or thread lock, perform native I/O, or join a
      // process while holding it. Mapper → generation and thread → generation
      // → SQL are the only admission lock orders.
      const generationAdmissionFence = yield* Semaphore.make(1);
      let generationAdmissionClosed = false;
      const invalidateNativeGeneration = (
        stopping: boolean,
        work?: BufferedPiWork,
        reserve: Effect.Effect<boolean> = Effect.succeed(true),
      ) =>
        Effect.gen(function* () {
          if (work !== undefined && bufferedWork !== work) return false;
          if (!(yield* reserve)) return false;
          generationAdmissionClosed = true;
          bufferedWork = null;
          if (stopping) stopRequested = true;
          return true;
        }).pipe(generationAdmissionFence.withPermits(1));
      yield* Effect.addFinalizer(() => invalidateNativeGeneration(true));
      // The parent may close finalizers in parallel. Fence logical closure
      // first inside the ordered transport scope, before its native teardown.
      yield* Scope.addFinalizer(connectionScope, invalidateNativeGeneration(true));
      const capturedRuntimePolicy = { ...input.runtimePolicy, cwd };
      const captureNativeSelection = (data: unknown) => {
        // SCIENT-FORK: the live native selection, from its owned module.
        nativeSelection = piNativeSelection(data, options.instanceId);
      };
      let rollbackBarrier: Deferred.Deferred<
        void,
        ProviderAdapter.ProviderAdapterProtocolError
      > | null = null;
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          if (rollbackBarrier !== null)
            yield* Deferred.fail(
              rollbackBarrier,
              protocolError("Pi session closed during rollback"),
            );
        }),
      );
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      /** Last thread title synced into pi's session name (`/resume` listing). */
      let appliedSessionName: string | null = null;
      /** Extension failures raised during startup are attached to the next turn. */
      const outOfTurnExtensionErrors: Array<PiRpcRecord> = [];
      /**
       * Leaf entry id of the pi session tree as of the last turn boundary.
       * Turn-start user entries are located relative to it, giving each
       * provider turn a durable native ref for session-tree rollback.
       */
      let lastKnownLeaf: string | null = null;
      /**
       * Set when a `get_entries` capture failed. Pi may have advanced past
       * `lastKnownLeaf` since, so the cursor no longer bounds a single turn
       * and the next capture re-syncs it instead of trusting it.
       */
      let leafCursorStale = false;
      // Pi's own configured defaults, captured from the first `get_state` so
      // that selecting the displayed "Pi default" again can restore them. Pi
      // has no "unset" commands, so the baselines have to be replayed
      // explicitly.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      /** Context window of the model Pi currently runs, from get_state and set_model. */
      let contextWindow: number | null = null;
      const modelContextWindows = new Map<string, number>();
      let modelsDiscovered = false;
      // Prompt responses carry no id. Keep their session-wide send order and
      // owner so a late ack from a settled turn cannot affect the next turn.
      const pendingPromptResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];
      const pendingCompactResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];

      const compactRpcRecord = (command: PiCompactCommand): PiRpcRecord =>
        command.customInstructions === undefined
          ? { type: "compact" }
          : { type: "compact", customInstructions: command.customInstructions };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession = (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = sessionEntity.lastError,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: PI_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      const updateProviderThread = (
        state: PiThreadState,
        patch: Partial<OrchestrationV2ProviderThread>,
        retainedNativeTurnIds?: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: PI_PROVIDER,
            providerThread: state.providerThread,
            ...(retainedNativeTurnIds === undefined ? {} : { retainedNativeTurnIds }),
          });
        });

      const itemOrdinal = (turn: ActivePiTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const request = (
        record: PiRpcRecord,
        timeoutMs = PI_REQUEST_TIMEOUT_MS,
      ): Effect.Effect<unknown, PiRpcError | PiRpcTimeoutError> =>
        Effect.suspend(() =>
          closed
            ? Effect.fail(
                new PiRpcError({
                  operation: recordString(record, "type") ?? "request",
                  detail: "Pi session is closed",
                }),
              )
            : connection.request(record, timeoutMs),
        );

      const send = (record: PiRpcRecord): Effect.Effect<void, PiRpcError> =>
        Effect.suspend(() =>
          closed
            ? Effect.fail(
                new PiRpcError({
                  operation: recordString(record, "type") ?? "send",
                  detail: "Pi session is closed",
                }),
              )
            : connection.send(record),
        );

      const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
        const value = recordNumber(input, key);
        return value === undefined ? undefined : Math.max(0, Math.trunc(value));
      };

      const rememberModelContextWindow = (model: unknown): number | null => {
        const provider = recordString(model, "provider");
        const id = recordString(model, "id");
        const capacity = nonNegativeInteger(model, "contextWindow");
        if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
          const slug = encodePiModelSlug(provider, id);
          if (slug !== undefined) modelContextWindows.set(slug, capacity);
          return capacity;
        }
        return null;
      };

      const lifecycleRequest = (record: PiRpcRecord) =>
        request(record, PI_SESSION_TIMEOUT_MS).pipe(
          // A local timeout does not cancel Pi's lifecycle hook. Retire the
          // process before fallback can race its eventual switch/new-session.
          Effect.tapError((error) =>
            Effect.logWarning("Pi session lifecycle request failed", {
              providerSessionId: input.providerSessionId,
              operation: record["type"],
              errorTag: error._tag,
            }),
          ),
          Effect.catchTags({
            PiRpcTimeoutError: (error) =>
              invalidateNativeGeneration(false).pipe(
                Effect.andThen(connection.terminate),
                Effect.andThen(Effect.fail(error)),
              ),
          }),
          Effect.onInterrupt(() =>
            invalidateNativeGeneration(false).pipe(Effect.andThen(connection.terminate)),
          ),
        );

      const tokenUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;

        const totals = recordField(stats, "tokens");
        const inputTokens = nonNegativeInteger(totals, "input");
        const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
        const outputTokens = nonNegativeInteger(totals, "output");
        return {
          usedTokens,
          maxTokens,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          updatedAt: DateTime.formatIso(updatedAt),
        };
      };

      /**
       * Pi only reports context usage through `get_session_stats`, so the
       * settled turn carries it on the base's per-turn `tokenUsage` (#8144).
       * Usage is secondary telemetry: the request is bounded and a provider
       * version without stats simply leaves the turn without a report, which
       * keeps the meter on the last turn that had one.
       */
      const readTokenUsage = (fallbackUsedTokens: number | null, updatedAt: DateTime.Utc) =>
        request({ type: "get_session_stats" }, 2_000).pipe(
          Effect.map((stats) => tokenUsageFromStats(stats, fallbackUsedTokens, updatedAt)),
          Effect.orElseSucceed(() => undefined),
        );

      /**
       * Pi attaches the current message's cumulative usage to every streaming
       * update (0.84.2+). Emit it on the running turn only when the total
       * changes, so the meter moves live without a burst of no-op updates.
       */
      const markTurnAccepted = Effect.fnUntraced(function* (turn: ActivePiTurn) {
        if (threadState?.activeTurn !== turn || turn.providerTurn.acceptedAt !== undefined) return;
        turn.providerTurn = {
          ...turn.providerTurn,
          nativeAcceptance: "accepted",
          acceptedAt: yield* DateTime.now,
        };
        yield* emit({
          type: "provider_turn.updated",
          driver: PI_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: turn.providerTurn,
        });
      });

      const reportLiveUsage = (turn: ActivePiTurn, usage: unknown) =>
        Effect.gen(function* () {
          const usedTokens = nonNegativeInteger(usage, "totalTokens");
          if (
            usedTokens === undefined ||
            usedTokens === 0 ||
            usedTokens === turn.lastLiveUsedTokens ||
            contextWindow === null ||
            contextWindow === 0
          ) {
            return;
          }
          turn.lastLiveUsedTokens = usedTokens;
          const inputTokens = nonNegativeInteger(usage, "input");
          const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
          const outputTokens = nonNegativeInteger(usage, "output");
          const updatedAt = yield* DateTime.now;
          yield* emit({
            type: "provider_turn.updated",
            driver: PI_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              tokenUsage: {
                usedTokens,
                maxTokens: contextWindow,
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
                updatedAt: DateTime.formatIso(updatedAt),
              },
            },
          });
        });

      const baseItemFields = (
        turn: ActivePiTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActivePiTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: PI_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver: PI_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      const emitProviderRetry = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        providerRetry: PiProviderRetryState,
        status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        updatedAt: DateTime.Utc,
      ) {
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: makeProviderRetryTurnItem({
            idAllocator,
            driver: PI_PROVIDER,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: turn.turnInput.rootNodeId,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: providerRetry.itemOrdinal,
            failure: providerRetry.failure,
            retry: providerRetry.retry,
            status,
            startedAt: providerRetry.startedAt,
            updatedAt,
          }),
        });
      });

      const compactionNativeItemId = (turn: ActivePiTurn): string =>
        `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

      const emitCompaction = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        compaction: PiCompactionState,
        status: PiCompactionStatus,
        details: {
          readonly summary?: string;
          readonly beforeTokenCount?: number;
          readonly afterTokenCount?: number;
        } = {},
      ) {
        const emittedAt = yield* DateTime.now;
        const completedAt = status === "running" ? null : emittedAt;
        yield* emitItemNode(
          turn,
          compaction.nativeItemId,
          "system",
          status,
          compaction.startedAt,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
            status,
            title: compactionTitle(status),
            completedAt,
            type: "compaction",
            driver: PI_PROVIDER,
            ...details,
          },
        });
      });

      // ── streaming text / reasoning ────────────────────────

      const emitStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, streaming: boolean) =>
        Effect.gen(function* () {
          const emittedAt = yield* DateTime.now;
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            streaming ? "running" : "completed",
            item.startedAt,
            streaming ? null : emittedAt,
          );
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: PI_PROVIDER,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming,
              },
            });
            yield* emit({
              type: "message.updated",
              driver: PI_PROVIDER,
              message: {
                id: messageId,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: PI_PROVIDER,
                  nativeItemId: item.nativeItemId,
                }),
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt: emittedAt,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...base,
              status: streaming ? "running" : "completed",
              title: null,
              completedAt: streaming ? null : emittedAt,
              type: "reasoning",
              text: item.text,
              streaming,
            },
          });
        });

      const scheduleStreamFlush = (turn: ActivePiTurn, item: PiStreamItemState) =>
        Effect.gen(function* () {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        kind: PiStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: PiStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        // Ordinal reserved on first delta so items appear in stream order.
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActivePiTurn) =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) => completeStreamItem(turn, item),
          { discard: true },
        );

      // ── tools ─────────────────────────────────────────────

      const emitToolItem = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        event: PiRpcRecord,
        phase: "start" | "update" | "end",
      ) {
        const toolCallId = recordString(event, "toolCallId");
        const toolName = recordString(event, "toolName") ?? "tool";
        if (toolCallId === undefined) return;
        if (phase === "start") {
          turn.toolArgs.set(toolCallId, event["args"]);
        }
        const args = event["args"] ?? turn.toolArgs.get(toolCallId);
        const emittedAt = yield* DateTime.now;
        const startedAt = turn.toolStartedAt.get(toolCallId) ?? emittedAt;
        turn.toolStartedAt.set(toolCallId, startedAt);
        const completed = phase === "end";
        const isError = event["isError"] === true;
        const resultRecord = completed ? event["result"] : event["partialResult"];
        const outputText = contentText(recordField(resultRecord, "content"));
        // A Stop aborts in-flight tools, and pi reports those as error ends.
        // Present them as interrupted (matching the run) rather than failed.
        const status = completed
          ? isError
            ? turn.interrupted
              ? "interrupted"
              : "failed"
            : "completed"
          : "running";
        const base = baseItemFields(turn, toolCallId, startedAt, emittedAt);
        yield* emitItemNode(
          turn,
          toolCallId,
          "tool_call",
          status,
          startedAt,
          completed ? emittedAt : null,
        );
        const shared = {
          ...base,
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        if (toolName === "bash") {
          const exitCode = recordNumber(recordField(resultRecord, "details"), "exitCode");
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "command_execution",
              input: recordString(args, "command") ?? "",
              ...(outputText.length > 0 ? { output: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            },
          });
          return;
        }
        if (toolName === "edit" || toolName === "write") {
          const fileName = recordString(args, "path") ?? recordString(args, "file_path");
          if (fileName !== undefined) {
            const diffStr =
              recordString(recordField(resultRecord, "details"), "patch") ??
              recordString(recordField(resultRecord, "details"), "diff") ??
              (isError && outputText.trim().length > 0 ? outputText : undefined);
            const oldStr = recordString(args, "oldText");
            const newStr = recordString(args, "newText") ?? recordString(args, "content");
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...shared,
                title: toolName,
                type: "file_change",
                fileName,
                ...(diffStr === undefined ? {} : { diffStr }),
                ...(oldStr === undefined ? {} : { oldStr }),
                ...(newStr === undefined ? {} : { newStr }),
                changes: [{ operation: toolName, path: fileName }],
              },
            });
            return;
          }
        }
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName,
            type: "dynamic_tool",
            ...mcpToolPresentation({ toolName }),
            toolName,
            input: args ?? {},
            ...(outputText.length > 0 ? { output: outputText } : {}),
          },
        });
        if (toolName === "subagent") {
          yield* emitSubagentTasks(turn, toolCallId, resultRecord, completed);
        }
      });

      /**
       * Observe the result shape from Pi's official example subagent extension.
       * The extension runs children with --no-session, so these entries are
       * visible in T3's shared subagent UI without inventing a child thread.
       * Unknown or changed result shapes stay ordinary dynamic tool output.
       */
      const emitSubagentTasks = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        toolCallId: string,
        resultRecord: unknown,
        completed: boolean,
      ) {
        const results = recordField(recordField(resultRecord, "details"), "results");
        if (!Array.isArray(results)) return;
        const emittedAt = yield* DateTime.now;
        const parentNodeId = idAllocator.derive.nodeFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId: toolCallId,
        });
        for (const [index, result] of results.entries()) {
          const agent = recordString(result, "agent");
          const task = recordString(result, "task");
          if (agent === undefined || task === undefined) continue;
          const nativeTaskId = `${toolCallId}:subagent:${recordNumber(result, "step") ?? index}`;
          const subagentId = idAllocator.derive.nodeFromProviderItem({
            driver: PI_PROVIDER,
            nativeItemId: nativeTaskId,
          });
          const startedAt = turn.toolStartedAt.get(nativeTaskId) ?? emittedAt;
          turn.toolStartedAt.set(nativeTaskId, startedAt);
          const finished = completed || recordField(result, "finished") === true;
          const stopReason = recordString(result, "stopReason");
          const interrupted = finished && stopReason === "aborted";
          const failed =
            finished &&
            !interrupted &&
            ((recordNumber(result, "exitCode") ?? 0) !== 0 || stopReason === "error");
          const status = interrupted
            ? "interrupted"
            : failed
              ? "failed"
              : finished
                ? "completed"
                : "running";
          const outputText = piSubagentOutput(result);
          const progress =
            !finished && outputText.length > 0 ? { progress: outputText.slice(0, 200) } : {};
          const resultText = finished && outputText.length > 0 ? outputText.slice(0, 10_000) : null;
          yield* emit({
            type: "subagent.updated",
            driver: PI_PROVIDER,
            subagent: {
              id: subagentId,
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              parentNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              providerThreadId: turn.turnInput.providerThread.id,
              childThreadId: null,
              nativeTaskRef: providerRef(nativeTaskId),
              prompt: task,
              title: agent,
              model: recordString(result, "model") ?? null,
              status,
              ...progress,
              result: resultText,
              startedAt,
              completedAt: finished ? emittedAt : null,
              updatedAt: emittedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeTaskId, startedAt, emittedAt),
              status,
              title: agent,
              completedAt: finished ? emittedAt : null,
              type: "subagent",
              subagentId,
              origin: "provider_native",
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: null,
              prompt: task,
              ...progress,
              result: resultText,
            },
          });
        }
      });

      // ── extension UI prompts ──────────────────────────────

      const cancelPrompt = (pending: PendingPiPrompt, resolvedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          yield* send({
            type: "extension_ui_response",
            id: pending.nativeRequestId,
            cancelled: true,
          }).pipe(Effect.ignore);
          pending.runtimeRequest = {
            ...pending.runtimeRequest,
            status: "cancelled",
            resolvedAt,
          };
          yield* emit({
            type: "runtime_request.updated",
            driver: PI_PROVIDER,
            threadId: pending.node.threadId,
            runtimeRequest: pending.runtimeRequest,
          });
          yield* emit({
            type: "node.updated",
            driver: PI_PROVIDER,
            node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...pending.turnItem,
              status: "cancelled",
              completedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          });
        });

      const cancelPendingPrompts = (resolvedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const pending = Array.from(pendingPrompts.values());
          pendingPrompts.clear();
          yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
            discard: true,
          });
        });

      yield* Effect.addFinalizer(() =>
        sessionEventPermit.withPermits(1)(
          Effect.gen(function* () {
            yield* cancelPendingPrompts(yield* DateTime.now);
          }),
        ),
      );

      const handleExtensionUiRequest = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const method = recordString(event, "method");
        const nativeRequestId = recordString(event, "id");
        if (method === undefined) return;
        if (method === "notify") {
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          const message = recordString(event, "message") ?? "";
          if (turn === null || message.length === 0) return;
          if (message.startsWith("scient:context-recovery:")) turn.contextRecoveryPending = true;
          if (message.startsWith("scient:context-limit:")) {
            turn.contextRecoveryPending = false;
            turn.failure = makeProviderFailure({
              message:
                "Pi reached this model's context limit and automatic recovery could not make room. Saved messages and completed tool results are intact. Compact this conversation and then continue, or choose a larger-context model.",
              class: "provider_error",
              retryable: false,
            });
            if (state !== null) yield* finalizeTurn(state);
            return;
          }
          const emittedAt = yield* DateTime.now;
          const nativeItemId = `notify:${turn.nextItemOrdinal}`;
          yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
              status: "completed",
              completedAt: emittedAt,
              title: "notify",
              type: "dynamic_tool",
              toolName: "notify",
              input: {
                message,
                notifyType: recordString(event, "notifyType") ?? "info",
              },
            },
          });
          return;
        }
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor"
        ) {
          // Terminal decoration has no matching T3 surface.
          yield* Effect.logDebug("Ignoring pi extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        const approvalTitle = recordString(event, "title") ?? "";
        const approvalKey = `${approvalTitle.length}:${approvalTitle}${recordString(event, "message") ?? ""}`;
        if (method === "confirm" && sessionApprovals.has(approvalKey)) {
          yield* send({
            type: "extension_ui_response",
            id: nativeRequestId,
            confirmed: true,
          });
          return;
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        const createdAt = yield* DateTime.now;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: PI_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const title = recordString(event, "title") ?? method;
        const threadId =
          turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: method === "confirm" ? "command" : "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: method === "confirm" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          // Runless startup/session-switch requests are normalized into the
          // thread-level ordinal range by TurnItemPositionStore.
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          title,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const turnItem: OrchestrationV2TurnItem =
          method === "confirm"
            ? {
                ...itemBase,
                type: "approval_request",
                requestId,
                requestKind: piApprovalRequestKind(title),
                prompt: recordString(event, "message") ?? title,
              }
            : {
                ...itemBase,
                type: "user_input_request",
                requestId,
                questions: [piQuestion(nativeRequestId, method, title, event)],
              };
        const pending: PendingPiPrompt = {
          nativeRequestId,
          method,
          questionId: nativeRequestId,
          approvalKey,
          runtimeRequest,
          node,
          turnItem,
        };
        pendingPrompts.set(String(requestId), pending);
        const timeout = recordNumber(event, "timeout");
        if (timeout !== undefined && timeout >= 0) {
          yield* Effect.sleep(Duration.millis(timeout)).pipe(
            Effect.andThen(
              sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (pendingPrompts.get(String(requestId)) !== pending) return;
                  pendingPrompts.delete(String(requestId));
                  yield* cancelPrompt(pending, yield* DateTime.now);
                }),
              ),
            ),
            Effect.forkIn(scope),
          );
        }
        yield* emit({
          type: "runtime_request.updated",
          driver: PI_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: PI_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: PI_PROVIDER, turnItem });
      });

      const emitExtensionError = Effect.fnUntraced(function* (event: PiRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null) {
          outOfTurnExtensionErrors.push(event);
          return;
        }
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `extension-error:${turn.nextItemOrdinal}`;
        const extensionName = piExtensionDisplayName(recordString(event, "extensionPath"));
        const extensionEvent = recordString(event, "event");
        const detail = recordString(event, "error")?.trim();
        const message = [
          `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
          detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n");
        const failure = makeProviderFailure({
          message,
          class: "provider_error",
          retryable: false,
        });
        if (turn.contextRecoveryPending && extensionEvent === "send_message") {
          turn.contextRecoveryPending = false;
          turn.failure = makeProviderFailure({
            message: `${piContextErrorMessage("context limit")}\n\n${message}`,
            class: "provider_error",
            retryable: false,
          });
          if (state !== null) yield* finalizeTurn(state);
          return;
        }
        yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "failed",
            title: extensionName,
            completedAt: emittedAt,
            type: "error",
            failure,
          },
        });
      });

      const emitSteeringError = Effect.fnUntraced(function* (
        turn: ActivePiTurn,
        event: PiRpcRecord,
      ) {
        if (turn.interrupted) return;
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `steering-error:${turn.nextItemOrdinal}`;
        yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "failed",
            title: "Pi refused the steering message",
            completedAt: emittedAt,
            type: "error",
            failure: makeProviderFailure({
              message:
                recordString(event, "error")?.slice(0, 2_000) ?? "Pi refused the steering message.",
              class: "provider_error",
              retryable: false,
            }),
          },
        });
      });

      // ── turn lifecycle ────────────────────────────────────

      /** One `get_entries` listing, or null when the request failed or named no leaf. */
      const listSessionEntries = (since: string | null, timeoutMs: number) =>
        request({ type: "get_entries", ...(since === null ? {} : { since }) }, timeoutMs).pipe(
          Effect.map((data) => {
            const leafId = recordField(data, "leafId");
            const entries = piSessionEntries(recordField(data, "entries"));
            return entries !== null && (typeof leafId === "string" || leafId === null)
              ? { entries, leafId }
              : null;
          }),
          Effect.orElseSucceed(() => null),
        );

      /**
       * Locate this turn's first user entry and the new leaf in pi's session
       * tree. The user-entry id becomes the provider turn's native ref (the
       * point `fork` rolls back to); the leaf becomes the conversation head.
       * `get_entries` is append-ordered and keeps abandoned branches, so both
       * come from walking the leaf's `parentId` chain, never from list order.
       * A leaf that no longer descends from the previous one means something
       * outside T3 rewound the session, such as an extension calling
       * `navigateTree`. The user entries left on the active branch are then
       * returned so orchestration can roll back runs that fell off it.
       * Pure bookkeeping: failures degrade to the synthetic refs.
       */
      const captureTurnTreeRefs = Effect.fnUntraced(function* (
        timeoutMs = PI_REQUEST_TIMEOUT_MS,
      ): Effect.fn.Return<PiTurnTreeRefs | null> {
        const cursorWasStale = leafCursorStale;
        const previousLeaf = lastKnownLeaf;
        const fullListing = cursorWasStale || previousLeaf === null;
        const listing = yield* listSessionEntries(fullListing ? null : previousLeaf, timeoutMs);
        const turnWalk =
          listing === null ? null : walkPiBranch(listing.entries, listing.leafId, previousLeaf);
        const rewound = turnWalk !== null && previousLeaf !== null && !turnWalk.reachedStop;
        // A `since` window ends at the previous leaf; the rewound branch
        // continues past it, so its ancestry needs the whole tree.
        const tree = rewound && !fullListing ? yield* listSessionEntries(null, timeoutMs) : listing;
        if (listing === null || turnWalk === null || tree === null) {
          // The read failed or its ancestry loops. Pi may have advanced past
          // `lastKnownLeaf` meanwhile, so the cursor can no longer be trusted
          // to bound a single turn.
          leafCursorStale = true;
          return null;
        }
        lastKnownLeaf = listing.leafId;
        leafCursorStale = false;
        const turnStartEntryId = turnWalk.userEntryIds.at(-1);
        // Only a branch walked to its root lists every survivor; a partial or
        // cyclic walk would roll back runs that are still in the conversation.
        // A replaced session has a different tree. Only an old leaf still in
        // this tree proves an in-session rewind rather than a session switch.
        const branch =
          rewound && previousLeaf !== null && tree.entries.has(previousLeaf)
            ? walkPiBranch(tree.entries, listing.leafId, null)
            : undefined;
        return {
          // Without a trustworthy cursor the walk spans more than one turn, so
          // its earliest user entry belongs to an earlier turn. Keep the
          // synthetic ref rather than pointing rollback too far back; the next
          // turn gets an accurate ref again. A turn that left nothing on the
          // active branch (a command, or a rewind) gets no ref: a rollback
          // past it needs no fork of its own.
          nativeTurnRef: cursorWasStale
            ? undefined
            : turnStartEntryId !== undefined
              ? providerRef(turnStartEntryId)
              : turnWalk.entryCount === 0
                ? null
                : undefined,
          leafId: listing.leafId,
          retainedNativeTurnIds: branch?.reachedStop === true ? branch.userEntryIds : undefined,
        };
      });

      const settleResults = new WeakMap<
        PiRpcRecord,
        {
          tokenUsage: OrchestrationV2ProviderTurn["tokenUsage"];
          treeRefs: PiTurnTreeRefs | null;
        }
      >();
      const finalizeTurn = Effect.fnUntraced(function* (
        state: PiThreadState,
        readUsage = true,
        settled?: {
          tokenUsage: OrchestrationV2ProviderTurn["tokenUsage"];
          treeRefs: PiTurnTreeRefs | null;
        },
      ) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        if (turn.activeCompaction !== null) {
          const status = turn.interrupted
            ? "cancelled"
            : turn.failure === null
              ? "completed"
              : "failed";
          yield* emitCompaction(turn, turn.activeCompaction, status);
          turn.activeCompaction = null;
        }
        if (turn.activeProviderRetry !== null) {
          if (turn.interrupted) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
            turn.activeProviderRetry = null;
          } else if (turn.failure === null) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
            turn.activeProviderRetry = null;
          }
        }
        yield* cancelPendingPrompts(completedAt);
        const treeRefs =
          turn.stopTreeRefs !== undefined
            ? turn.stopTreeRefs
            : settled !== undefined
              ? settled.treeRefs
              : yield* captureTurnTreeRefs();
        const tokenUsage =
          settled !== undefined
            ? settled.tokenUsage
            : readUsage
              ? yield* readTokenUsage(turn.latestCompactionAfterTokens, completedAt)
              : undefined;
        const failure = turn.interrupted ? null : (turn.rejectedPromptFailure ?? turn.failure);
        if (failure === null && !turn.interrupted && turn.outputTruncated) {
          yield* emit({
            type: "turn_item.updated",
            driver: PI_PROVIDER,
            turnItem: {
              ...baseItemFields(
                turn,
                `output-truncated:${turn.providerTurn.id}`,
                completedAt,
                completedAt,
              ),
              nodeId: turn.turnInput.rootNodeId,
              type: "notification",
              status: "completed",
              title: null,
              completedAt,
              source: { kind: "output_truncated", stopReason: "length" },
              outcome: "completed",
              summary: MODEL_TOKEN_LIMIT_MESSAGE,
            },
          });
        }
        yield* emit({
          type: "provider_turn.updated",
          driver: PI_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(treeRefs === null || treeRefs.nativeTurnRef === undefined
              ? {}
              : { nativeTurnRef: treeRefs.nativeTurnRef }),
            status: turn.interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
          },
        });
        yield* updateProviderThread(
          state,
          {
            status: "idle",
            ...(treeRefs === null
              ? {}
              : {
                  nativeConversationHeadRef:
                    treeRefs.leafId === null ? null : providerRef(treeRefs.leafId),
                }),
          },
          treeRefs?.retainedNativeTurnIds,
        );
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          if (turn.activeProviderRetry !== null) {
            yield* emitProviderRetry(
              turn,
              { ...turn.activeProviderRetry, failure },
              "failed",
              completedAt,
            );
          } else {
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...baseItemFields(turn, failureItemId, completedAt, completedAt),
                status: "failed",
                title: null,
                completedAt,
                type: "error",
                failure,
              },
            });
          }
          yield* emit({
            type: "turn.terminal",
            driver: PI_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            ...(turn.activeProviderRetry === null
              ? {}
              : {
                  retry: turn.activeProviderRetry.retry,
                  retryStartedAt: turn.activeProviderRetry.startedAt,
                }),
            threadDisposition: turn.broken ? "broken" : "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: PI_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: turn.interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: turn.broken ? "broken" : "reusable",
          });
        }
      });

      const assertSessionIdentity = Effect.fnUntraced(function* (data: unknown) {
        const state = threadState;
        if (state === null) return;
        if (
          recordString(data, "sessionFile") === state.providerThread.nativeThreadRef?.nativeId &&
          (expectedNativeSessionId === undefined ||
            recordString(data, "sessionId") === expectedNativeSessionId)
        )
          return;
        const message = "Pi native session identity changed unexpectedly.";
        forcedSessionFailure = message;
        yield* invalidateNativeGeneration(true);
        if (state.activeTurn !== null) {
          state.activeTurn.broken = true;
          state.activeTurn.failure = makeProviderFailure({
            message,
            class: "transport_error",
            retryable: false,
          });
          yield* finalizeTurn(state, false, { treeRefs: null, tokenUsage: undefined });
        }
        yield* connection.terminate;
        yield* updateProviderSession("error", message);
        return yield* protocolError(message);
      });

      // ── event pump ────────────────────────────────────────

      const scheduleSettleProbe = (
        turn: ActivePiTurn,
        settleAfterAgentActivity = false,
        attempt = 1,
      ) => {
        const providerTurnId = turn.providerTurn.id;
        const settleProbeGeneration = turn.settleProbeGeneration;
        return Effect.gen(function* () {
          let data = yield* request({ type: "get_state" }, 2_000);
          const event: PiRpcRecord = {
            type: "t3.settle_probe",
            providerTurnId,
            settleAfterAgentActivity,
            settleProbeGeneration,
            attempt,
            data,
            initialData: data,
          };
          if (
            recordField(data, "isStreaming") !== true &&
            recordField(data, "isCompacting") !== true &&
            (recordNumber(data, "pendingMessageCount") ?? 0) === 0
          ) {
            // Do not hold the event permit during telemetry/tree reads. Native
            // events and a steer can invalidate this snapshot while they wait.
            const tokenUsage = yield* readTokenUsage(
              turn.latestCompactionAfterTokens,
              yield* DateTime.now,
            );
            const treeRefs = yield* captureTurnTreeRefs(2_000);
            data = yield* request({ type: "get_state" }, 2_000);
            event.data = data;
            settleResults.set(event, { tokenUsage, treeRefs });
          }
          return event;
        }).pipe(
          Effect.matchEffect({
            onSuccess: (event) => Queue.offer(connection.events, event),
            // A failed probe still has to reach the pump. Dropping it would
            // leave a command-only turn active forever, because Pi never emits
            // agent events for one.
            onFailure: () =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                probeFailed: true,
              }),
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      };

      const disposeBufferedWork = (work: BufferedPiWork) =>
        Effect.gen(function* () {
          if (yield* invalidateNativeGeneration(true, work)) {
            yield* cancelPendingPrompts(yield* DateTime.now);
            yield* connection.terminate;
          }
        });
      const offerBufferedWork = Effect.fnUntraced(function* (work: BufferedPiWork) {
        const bus = options.continuationRequests;
        if (bus === undefined) return;
        const isCurrent = () => bufferedWork === work && !stopRequested;
        const request: ProviderContinuationRequests.ProviderInitiatedWorkRequest = {
          threadId: boundThreadId,
          providerThreadId: work.providerThread.id,
          driver: PI_PROVIDER,
          detail: "Pi extension started native work",
          delivery: "adapter_buffered",
          initiated: {
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            workId: work.workId,
            modelSelection: work.modelSelection,
            runtimePolicy: work.runtimePolicy,
          },
          dispatchIfCurrent: (dispatch) =>
            Effect.suspend(() => {
              if (!isCurrent()) return Effect.succeedNone;
              return dispatch.pipe(Effect.map(Option.some));
            }),
          clearIfCurrent: () => disposeBufferedWork(work),
        };
        yield* bus.offer(request).pipe(Effect.tapError(() => disposeBufferedWork(work)));
      });

      const refuseUnownedWork = Effect.fnUntraced(function* (detail: string) {
        yield* invalidateNativeGeneration(true);
        forcedSessionFailure = detail;
        yield* updateProviderSession("error", detail);
        yield* connection.terminate;
      });

      const handleSessionEvent = Effect.fnUntraced(function* (event: PiRpcRecord) {
        // Model-selection hooks can await a dialog before startTurn can claim
        // a wake. Keep interactive requests session-scoped until a turn owns
        // them; buffer native output and notifications for that turn.
        const interactiveUiRequest =
          event["type"] === "extension_ui_request" &&
          ["select", "confirm", "input", "editor"].includes(String(event["method"]));
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null && bufferedWork !== null) {
          // Correlated responses are transport-owned, and old deferred acks
          // or idle probes must not become a new generation's acceptance.
          if (
            !interactiveUiRequest &&
            !String(event["type"]).startsWith("t3.") &&
            event["type"] !== "response"
          ) {
            bufferedWork.records.push(event);
            if (event["type"] === "agent_settled") yield* updateProviderSession("ready", null);
            return;
          }
        }
        switch (event["type"]) {
          case "agent_start": {
            if (turn === null) {
              if (rollbackBarrier !== null) {
                yield* invalidateNativeGeneration(true);
                yield* cancelPendingPrompts(yield* DateTime.now);
                yield* connection.terminate;
                return;
              }
              if (
                options.continuationRequests !== undefined &&
                state !== null &&
                state.providerThread.appThreadId != null
              ) {
                const data = yield* request({ type: "get_state" }).pipe(
                  Effect.orElseSucceed(() => undefined),
                );
                if (data === undefined) {
                  yield* refuseUnownedWork("Pi native work state could not be captured.");
                  return;
                }
                yield* assertSessionIdentity(data);
                captureNativeSelection(data);
                contextWindow = rememberModelContextWindow(recordField(data, "model"));
                if (!nativePath.isAbsolute(cwd) || nativeSelection === null) {
                  yield* refuseUnownedWork(
                    "Pi native work requires an absolute captured cwd and a known native model.",
                  );
                  return;
                }
              }
              if (
                state !== null &&
                nativeSelection !== null &&
                options.continuationRequests !== undefined &&
                nativePath.isAbsolute(cwd)
              ) {
                const work: BufferedPiWork = {
                  workId: `${input.providerSessionId}:native-generation:${++workOrdinal}`,
                  providerThread: state.providerThread,
                  modelSelection: nativeSelection,
                  runtimePolicy: capturedRuntimePolicy,
                  records: [event],
                };
                const captured = yield* Effect.sync(() => {
                  if (generationAdmissionClosed || stopRequested) return false;
                  bufferedWork = work;
                  return true;
                }).pipe(generationAdmissionFence.withPermits(1));
                if (!captured) return;
                sessionEntity = { ...sessionEntity, model: nativeSelection.model };
                yield* updateProviderSession("running", null);
                yield* offerBufferedWork(work).pipe(Effect.forkIn(scope));
                return;
              }
            }
            if (turn === null) {
              unsolicitedActivityDetected = true;
              yield* invalidateNativeGeneration(true);
              yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
              yield* connection.terminate;
              return;
            }
            yield* markTurnAccepted(turn);
            turn.pendingSteerCount = 0;
            turn.sawAgentActivity = true;
            turn.contextRecoveryPending = false;
            turn.settleProbeGeneration += 1;
            return;
          }
          case "message_start": {
            if (turn !== null && recordString(event["message"], "role") === "assistant") {
              turn.sawAgentActivity = true;
              turn.messageOrdinal += 1;
            }
            return;
          }
          case "message_update": {
            if (turn === null) return;
            turn.sawAgentActivity = true;
            yield* reportLiveUsage(turn, event["usage"]);
            const delta = event["assistantMessageEvent"];
            const deltaType = recordString(delta, "type");
            const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
            if (deltaType === "text_delta" || deltaType === "thinking_delta") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_delta" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              item.text += recordString(delta, "delta") ?? "";
              yield* scheduleStreamFlush(turn, item);
              return;
            }
            if (deltaType === "text_end" || deltaType === "thinking_end") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_end" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              yield* completeStreamItem(
                turn,
                item,
                recordString(delta, "content") ?? recordString(delta, "thinking"),
              );
              return;
            }
            return;
          }
          case "message_end": {
            if (turn === null) return;
            const message = event["message"];
            if (recordString(message, "role") !== "assistant") return;
            turn.outputTruncated = recordString(message, "stopReason") === "length";
            const content = recordField(message, "content");
            if (Array.isArray(content)) {
              for (const [index, block] of content.entries()) {
                const kind = recordString(block, "type");
                if (kind !== "text" && kind !== "thinking") continue;
                const text = recordString(block, kind === "text" ? "text" : "thinking");
                if (text === undefined || text.length === 0) continue;
                const item = yield* streamItemFor(
                  turn,
                  kind === "text" ? "assistant_message" : "reasoning",
                  index,
                );
                yield* completeStreamItem(turn, item, text);
              }
            }
            yield* completeOpenStreamItems(turn);
            if (
              recordString(message, "stopReason") === "stop" &&
              turn.failure === turn.modelFailure
            ) {
              turn.failure = null;
              turn.modelFailure = null;
            }
            if (recordString(message, "stopReason") === "error" && turn.failure === null) {
              turn.failure = makeProviderFailure({
                message: piContextErrorMessage(
                  recordString(message, "errorMessage") ?? "Pi reported a model error.",
                ),
                class: "provider_error",
              });
              turn.modelFailure = turn.failure;
            }
            return;
          }
          case "tool_execution_start":
            if (turn !== null) {
              turn.sawAgentActivity = true;
              yield* emitToolItem(turn, event, "start");
            }
            return;
          case "tool_execution_update":
            if (turn !== null) yield* emitToolItem(turn, event, "update");
            return;
          case "tool_execution_end":
            if (turn !== null) yield* emitToolItem(turn, event, "end");
            return;
          case "compaction_start": {
            if (turn === null) return;
            yield* markTurnAccepted(turn);
            turn.settleProbeGeneration += 1;
            turn.sawCompaction = true;
            if (turn.activeCompaction !== null) {
              yield* emitCompaction(turn, turn.activeCompaction, "cancelled");
            }
            const startedAt = yield* DateTime.now;
            const compaction = {
              nativeItemId: compactionNativeItemId(turn),
              startedAt,
            } satisfies PiCompactionState;
            turn.activeCompaction = compaction;
            yield* emitCompaction(turn, compaction, "running");
            return;
          }
          case "compaction_end": {
            if (turn === null) return;
            const observedAt = yield* DateTime.now;
            const compaction = turn.activeCompaction ?? {
              nativeItemId: compactionNativeItemId(turn),
              startedAt: observedAt,
            };
            turn.activeCompaction = null;
            const result = event["result"];
            if (result === null || result === undefined) {
              if (event["aborted"] === true) {
                yield* emitCompaction(turn, compaction, "cancelled");
                if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                  yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
                }
                return;
              }
              const errorMessage =
                recordString(event, "errorMessage") ?? "Pi context compaction failed.";
              yield* emitCompaction(turn, compaction, "failed", {
                summary: errorMessage.slice(0, 1_000),
              });
              if (turn.settleWhenIdle || !turn.sawAgentActivity) {
                yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
              }
              return;
            }
            // An overflow can surface as a model error (`message_end` with
            // stopReason error) before Pi compacts and retries the turn. Clear
            // that failure only when Pi confirms that compaction will retry;
            // a successful non-retrying compaction must not erase an exhausted
            // provider retry.
            if (event["willRetry"] === true) turn.failure = null;
            turn.latestCompactionAfterTokens =
              nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
            const summary = recordString(result, "summary");
            const beforeTokenCount = nonNegativeInteger(result, "tokensBefore");
            const afterTokenCount = nonNegativeInteger(result, "estimatedTokensAfter");
            yield* emitCompaction(turn, compaction, "completed", {
              ...(summary === undefined ? {} : { summary }),
              ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
              ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
            });
            if (turn.settleWhenIdle || !turn.sawAgentActivity) {
              yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          case "auto_retry_start": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const maxAttempts = Math.max(
              attempt,
              Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
            );
            const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
            const failure = makeProviderFailure({
              message: recordString(event, "errorMessage") ?? "Pi provider request failed.",
              class: "provider_error",
              retryable: true,
            });
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: { attempt, maxAttempts, retryDelayMs },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            yield* emitProviderRetry(turn, providerRetry, "running", emittedAt);
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            if (event["success"] === true) {
              // The retry recovered. Pi emits the erroring `message_end`
              // before retrying, so leaving that failure in place would make
              // `agent_settled` terminalize a successful turn as failed.
              if (turn.activeProviderRetry !== null) {
                const attempt = Math.max(
                  1,
                  Math.trunc(
                    recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
                  ),
                );
                const recoveredRetry = {
                  ...turn.activeProviderRetry,
                  retry: { ...turn.activeProviderRetry.retry, attempt },
                };
                yield* emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
                turn.activeProviderRetry = null;
              }
              turn.failure = null;
              return;
            }
            const failure = makeProviderFailure({
              message: recordString(event, "finalError") ?? "Pi auto-retry failed.",
              class: "provider_error",
              retryable: false,
            });
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: {
                attempt,
                maxAttempts: current?.retry.maxAttempts ?? attempt,
                retryDelayMs: current?.retry.retryDelayMs ?? null,
              },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies PiProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            turn.failure = failure;
            yield* emitProviderRetry(turn, providerRetry, "failed", emittedAt);
            return;
          }
          case "extension_ui_request":
            yield* handleExtensionUiRequest(event);
            return;
          case "extension_error": {
            yield* emitExtensionError(event);
            return;
          }
          case "agent_settled": {
            if (turn?.interrupted === true) {
              if (state !== null) yield* finalizeTurn(state);
              return;
            }
            if (turn !== null) {
              turn.settleWhenIdle = true;
              turn.settleProbeGeneration += 1;
              // A wake can settle while the newly joined user prompt is still
              // expanding. Its acknowledgement opens the idle-probe barrier.
              if (
                turn.adoptedWake &&
                pendingPromptResponses.some(
                  (pending) =>
                    pending.providerTurnId === turn.providerTurn.id &&
                    pending.kind === "turn_start",
                )
              )
                return;
              yield* scheduleSettleProbe(turn, true);
            }
            return;
          }
          case "response": {
            // Correlated responses never reach the pump; an id-less response
            // is the deferred ack of a fire-and-forget prompt/steer/compact.
            const command = recordString(event, "command");
            if (command === "compact") {
              const pendingCompact = pendingCompactResponses.shift();
              const compactTurn =
                pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
              if (compactTurn !== null) {
                compactTurn.manualCompactInFlight = false;
                if (pendingCompact?.kind === "steer") {
                  compactTurn.pendingSteerCount = Math.max(0, compactTurn.pendingSteerCount - 1);
                  if (compactTurn.settleWhenIdle) yield* scheduleSettleProbe(compactTurn, true);
                }
              }
              if (event["success"] === true) {
                if (pendingCompact?.kind === "turn_start" && compactTurn !== null)
                  yield* markTurnAccepted(compactTurn);
                if (
                  pendingCompact?.kind === "turn_start" &&
                  compactTurn !== null &&
                  compactTurn.promptMayBeCommandOnly &&
                  !compactTurn.sawAgentActivity
                ) {
                  yield* scheduleSettleProbe(compactTurn);
                }
                return;
              }
              if (event["success"] !== false) return;
              if (compactTurn === null) return;
              if (compactTurn.activeCompaction !== null) return;
              if (pendingCompact?.kind === "steer") {
                yield* Effect.logWarning("Pi rejected a compact steer.", {
                  errorLength: recordString(event, "error")?.length,
                });
                yield* emitSteeringError(compactTurn, event);
                return;
              }
              if (!compactTurn.sawCompaction) {
                if (compactTurn.providerTurn.acceptedAt === undefined)
                  compactTurn.providerTurn = {
                    ...compactTurn.providerTurn,
                    nativeAcceptance: "pending",
                  };
                compactTurn.failure = makeProviderFailure({
                  message: recordString(event, "error") ?? "Pi compact failed.",
                  class: "provider_error",
                });
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (!compactTurn.sawAgentActivity) {
                yield* scheduleSettleProbe(compactTurn);
              }
              return;
            }
            const pendingPrompt = command === "prompt" ? pendingPromptResponses.shift() : undefined;
            const responseTurn =
              pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
            if (pendingPrompt?.kind === "steer" && responseTurn !== null) {
              responseTurn.pendingSteerCount = Math.max(0, responseTurn.pendingSteerCount - 1);
              if (responseTurn.settleWhenIdle) yield* scheduleSettleProbe(responseTurn, true);
            }
            if (event["success"] === true) {
              if (pendingPrompt?.kind === "turn_start" && responseTurn !== null)
                yield* markTurnAccepted(responseTurn);
              // Deferred success ack. Command-only prompts (pure extension
              // slash commands) never start an agent run and never emit
              // `agent_settled`, so probe for idleness. The probe result is
              // re-queued behind any events Pi emitted before answering
              // get_state, which keeps the check stream-ordered.
              if (
                pendingPrompt?.kind === "turn_start" &&
                responseTurn !== null &&
                ((responseTurn.promptMayBeCommandOnly && !responseTurn.sawAgentActivity) ||
                  (responseTurn.adoptedWake &&
                    (responseTurn.settleWhenIdle || responseTurn.promptMayBeCommandOnly)))
              ) {
                yield* scheduleSettleProbe(responseTurn, responseTurn.adoptedWake);
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer" || pendingPrompt?.kind === "steer") {
              // A rejected steer only means that one message was refused. The
              // turn it was aimed at is still running on Pi, so terminalizing
              // here would report a failure while output keeps streaming.
              yield* Effect.logWarning("Pi rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              if (responseTurn !== null) yield* emitSteeringError(responseTurn, event);
              return;
            }
            const failedTurn =
              command === "prompt" && pendingPrompt?.kind === "turn_start"
                ? responseTurn
                : command === "parse"
                  ? turn
                  : null;
            if (failedTurn !== null) {
              if (failedTurn.providerTurn.acceptedAt === undefined)
                failedTurn.providerTurn = {
                  ...failedTurn.providerTurn,
                  nativeAcceptance: "pending",
                };
              const failure = makeProviderFailure({
                message: recordString(event, "error") ?? "Pi rejected the prompt.",
                class: "provider_error",
              });
              if (failedTurn.adoptedWake && command === "prompt") {
                failedTurn.rejectedPromptFailure = failure;
                failedTurn.settleWhenIdle = true;
                yield* scheduleSettleProbe(failedTurn, true);
              } else {
                failedTurn.failure = failure;
                if (state !== null) yield* finalizeTurn(state);
              }
            }
            return;
          }
          case "t3.flush_extension_errors": {
            // Startup extension failures are informational and do not block
            // Pi, so attach them to the next real turn instead of creating a
            // standalone failed run.
            for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
              yield* emitExtensionError(extensionError);
            }
            return;
          }
          case "t3.rollback_barrier": {
            if (rollbackBarrier !== null && event["barrier"] === rollbackBarrier)
              yield* Deferred.succeed(rollbackBarrier, undefined);
            return;
          }
          case "t3.settle_probe": {
            // New work increments the generation before the pump can consume
            // a stale idle snapshot, so only a current snapshot may settle.
            const data = event["data"];
            const probeFailed = event["probeFailed"] === true;
            const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            if (
              turn === null ||
              turn.providerTurn.acceptedAt === undefined ||
              turn.pendingSteerCount > 0 ||
              turn.providerTurn.id !== event["providerTurnId"] ||
              turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
              (!settleAfterAgentActivity && turn.sawAgentActivity) ||
              turn.activeCompaction !== null ||
              turn.contextRecoveryPending
            ) {
              return;
            }
            if (!probeFailed) {
              yield* assertSessionIdentity(event.initialData ?? data).pipe(Effect.ignore);
              if (state?.activeTurn !== turn) return;
              yield* assertSessionIdentity(data).pipe(Effect.ignore);
              if (state?.activeTurn !== turn) return;
            }
            if (probeFailed) {
              if (!settleAfterAgentActivity) {
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
                yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
                  Effect.andThen(scheduleSettleProbe(turn, true, attempt + 1)),
                  Effect.forkIn(scope),
                );
                return;
              }
              yield* invalidateNativeGeneration(true);
              yield* connection.terminate;
              return;
            }
            if (
              recordField(data, "isStreaming") !== true &&
              recordField(data, "isCompacting") !== true &&
              (recordNumber(data, "pendingMessageCount") ?? 0) === 0
            ) {
              turn.settleWhenIdle = false;
              if (state !== null) yield* finalizeTurn(state, false, settleResults.get(event));
            }
            return;
          }
          default:
            return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          yield* sessionEventPermit.withPermits(1)(handleSessionEvent(event));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              const hadPendingWork = bufferedWork !== null;
              yield* invalidateNativeGeneration(false);
              // Transport death finalizes any live turn. Stop-with-restart
              // closes the provider stream cleanly; only an unexpected death
              // is surfaced as an event-stream failure.
              const state = threadState;
              if (rollbackBarrier !== null)
                yield* Deferred.fail(
                  rollbackBarrier,
                  protocolError("Pi transport closed during rollback"),
                );
              const interrupted = state?.activeTurn?.interrupted === true;
              if (state?.activeTurn != null) {
                state.activeTurn.broken = !interrupted;
                state.activeTurn.failure = interrupted
                  ? null
                  : makeProviderFailure({
                      cause,
                      message: "Pi process exited unexpectedly.",
                      class: "transport_error",
                    });
                yield* finalizeTurn(state, false);
              } else if (hadPendingWork) {
                yield* cancelPendingPrompts(yield* DateTime.now);
              }
              if (forcedSessionFailure !== null) {
                yield* updateProviderSession("error", forcedSessionFailure);
                yield* Queue.end(events);
              } else if (unsolicitedActivityDetected) {
                yield* updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
                yield* Queue.end(events);
              } else if (stopRequested) {
                yield* updateProviderSession("stopped", null);
                yield* Queue.end(events);
              } else {
                yield* updateProviderSession(
                  "error",
                  interrupted ? "Pi process was stopped." : "Pi process exited unexpectedly.",
                );
                yield* Queue.fail(
                  events,
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: PI_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
                );
              }
            }),
          ),
        ),
        Effect.forkIn(scope),
      );

      // ── session runtime ───────────────────────────────────

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        publish = true,
        allowForkBinding = false,
      ) {
        if (closed) return yield* protocolError("Pi session is closed");
        if (rollbackBarrier !== null)
          return yield* protocolError("Cannot register a Pi thread during rollback");
        if (threadState !== null && threadState.activeTurn !== null) {
          return yield* protocolError("Cannot register a Pi thread while a turn is active");
        }
        if (bufferedWork !== null) {
          const state = threadState;
          if (
            state !== null &&
            state.providerThread.id === bufferedWork.providerThread.id &&
            state.providerThread.appThreadId === threadInput.threadId &&
            (threadInput.existingProviderThread === undefined ||
              threadInput.existingProviderThread.nativeThreadRef?.nativeId ===
                state.providerThread.nativeThreadRef?.nativeId)
          )
            return state.providerThread;
          return yield* protocolError(
            "Cannot switch Pi threads while native work is awaiting a turn",
          );
        }
        const existing = threadInput.existingProviderThread;
        if (
          (!allowForkBinding && threadInput.threadId !== boundThreadId) ||
          threadInput.modelSelection.instanceId !== options.instanceId ||
          (existing !== undefined &&
            (existing.driver !== PI_PROVIDER ||
              existing.providerInstanceId !== options.instanceId ||
              existing.appThreadId !== threadInput.threadId ||
              (existing.nativeThreadRef !== null &&
                existing.nativeThreadRef.driver !== PI_PROVIDER)))
        ) {
          return yield* protocolError("Pi thread belongs to another runtime owner");
        }
        const resumeId = existing?.nativeThreadRef?.nativeId;
        const needsNewSession = resumeId == null && registrationAttempted;
        const launchState =
          resumeId != null && !registrationAttempted && input.initialNativeThreadId === resumeId
            ? yield* request({ type: "get_state" })
            : undefined;
        const launchAlreadyBound =
          launchState !== undefined && recordString(launchState, "sessionFile") === resumeId;
        registrationAttempted = true;
        if ((resumeId != null && !launchAlreadyBound) || needsNewSession) {
          lastNativeThreadId = resumeId ?? lastNativeThreadId;
          // Even a failed lifecycle operation can change Pi's native session.
          // Never leave the old app binding or model defaults usable afterward.
          threadState = null;
          appliedModel = null;
          appliedThinking = null;
          appliedSessionName = null;
          baselineModel = null;
          baselineThinking = null;
          contextWindow = null;
          const result = yield* lifecycleRequest(
            resumeId != null
              ? { type: "switch_session", sessionPath: resumeId }
              : { type: "new_session" },
          );
          if (recordField(result, "cancelled") === true) {
            return yield* protocolError("A Pi extension cancelled the session switch");
          }
        }
        const stateData = launchAlreadyBound ? launchState : yield* request({ type: "get_state" });
        captureNativeSelection(stateData);
        if (!modelsDiscovered) {
          const modelsData = yield* request({ type: "get_available_models" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const models = recordField(modelsData, "models");
          if (Array.isArray(models)) {
            for (const model of models) rememberModelContextWindow(model);
            modelsDiscovered = true;
          }
        }
        contextWindow = rememberModelContextWindow(recordField(stateData, "model"));
        // Each baseline is captured independently, and only while nothing has
        // been applied yet, so a `get_state` that arrives after our own
        // selection cannot record that selection as Pi's default.
        if (baselineModel === null && appliedModel === null) {
          const stateModel = recordField(stateData, "model");
          const provider = recordString(stateModel, "provider");
          const modelId = recordString(stateModel, "id");
          if (provider !== undefined && modelId !== undefined) {
            baselineModel = { provider, modelId };
          }
        }
        if (baselineThinking === null && appliedThinking === null) {
          baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
        }
        // switch_session accepts a file path, not Pi's display session UUID.
        const nativeId = recordString(stateData, "sessionFile");
        if (nativeId === undefined) {
          return yield* protocolError("get_state returned no persisted sessionFile", stateData);
        }
        if (needsNewSession && nativeId === lastNativeThreadId) {
          return yield* protocolError("Pi did not create a distinct session file");
        }
        lastNativeThreadId = nativeId;
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(nativeId),
                ...(needsNewSession ? { nativeConversationHeadRef: null, contextUsage: null } : {}),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: PI_PROVIDER,
                  nativeThreadId: nativeId,
                }),
                driver: PI_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        boundThreadId = threadInput.threadId;
        threadState = { providerThread, activeTurn: null };
        expectedNativeSessionId = recordString(stateData, "sessionId");
        // Baseline the session-tree leaf so the first turn's user entry can
        // be located with a `since` cursor instead of a full entry scan.
        const baselineEntries = yield* request({ type: "get_entries" }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
        // A successful full baseline makes the cursor trustworthy again. Only
        // a failed one leaves it stale, so a recovered session does not keep
        // skipping turn refs. An empty tree is a success with no leafId.
        leafCursorStale = baselineEntries === undefined;
        if (publish)
          yield* emit({
            type: "provider_thread.updated",
            driver: PI_PROVIDER,
            providerThread,
          });
        if (nativeId === freshSession?.sessionFile) freshSessionPublished = true;
        initialBindingComplete = true;
        return providerThread;
      });

      // SCIENT-FORK: the same confirmed native selection policy as discovery and one-shot generation.
      const selectionClient = makePiSelectionClient((record) => request(record));
      const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
        const thinking =
          getModelSelectionStringOptionValue(modelSelection, "thinkingLevel") ??
          getModelSelectionStringOptionValue(modelSelection, "thinking");
        const inherit = modelSelection.model === PI_INHERIT_MODEL_SLUG;
        let selected = inherit ? baselineModel : parsePiModelSlug(modelSelection.model);
        // An untouched native default remains native authority; no model/effort writes.
        if (
          inherit &&
          appliedModel === null &&
          appliedThinking === null &&
          thinking === undefined
        ) {
          const response = yield* request({ type: "get_state" }, 2_000).pipe(Effect.option);
          if (Option.isNone(response)) return undefined;
          // Validate ownership before optional metadata parsing can discard malformed state.
          yield* assertSessionIdentity(response.value);
          const observed = yield* decodeSelectionState(response.value).pipe(Effect.option);
          return Option.isSome(observed) ? observedNativeEffort(observed.value) : undefined;
        }
        if (inherit && selected === null && thinking !== undefined) {
          const state = yield* selectionClient
            .getState()
            .pipe(Effect.mapError((cause) => protocolError(cause.detail, cause)));
          if (state.model !== undefined)
            selected = { provider: state.model.provider, modelId: state.model.id };
        }
        if (selected === null)
          return yield* protocolError(
            inherit
              ? "Pi default model is not known; cannot confirm an explicit override."
              : `Pi model '${modelSelection.model}' must use canonical provider/model format`,
          );
        const restoredThinking =
          inherit && thinking === undefined && appliedThinking !== null
            ? (baselineThinking ?? undefined)
            : thinking;
        const confirmed = yield* applyPiModelSelection(
          selectionClient,
          selected,
          restoredThinking,
          {
            // Preserve inherited effort unless the caller explicitly selected it.
            messageCount: 1,
          },
        ).pipe(Effect.mapError((cause) => protocolError(cause.detail, cause)));
        yield* assertSessionIdentity(confirmed.state);
        contextWindow = rememberModelContextWindow(confirmed.state.model);
        captureNativeSelection(confirmed.state);
        appliedModel = inherit ? null : modelSelection.model;
        appliedThinking =
          inherit && thinking === undefined ? null : (confirmed.confirmedThinkingLevel ?? null);
        const updatedAt = yield* DateTime.now;
        sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
        yield* emit({
          type: "provider_session.updated",
          driver: PI_PROVIDER,
          providerSession: sessionEntity,
        });
        return confirmed.confirmedThinkingLevel;
      });

      const resolvePromptPayload = Effect.fnUntraced(function* (
        text: string,
        attachments: ReadonlyArray<ChatAttachment>,
        nativeState?: unknown,
      ) {
        // Provider discovery and the live session are separate Pi processes.
        // Retry a failed session-local lookup once at first use so a transient
        // startup failure cannot leave a visible $ skill inert for this session.
        if (skillNames === null && text.includes("$")) {
          skillNames = yield* discoverSkillNames.pipe(
            Effect.orElseSucceed(() => new Set<string>()),
          );
        }
        const expandedText = skillNames === null ? text : expandPiSkillReference(text, skillNames);
        // A discovered `$skill` reference becomes a native `/skill:` command
        // internally, but its attachment path can still be included in the
        // skill's prompt. Keep the guard scoped to commands the user entered.
        if (piNativeCommandWithAttachments(text, attachments, nativeCommandNames))
          return yield* protocolError("Pi native commands do not support attachments.");
        if (piHasImageAttachments(attachments)) {
          const state = nativeState ?? (yield* request({ type: "get_state" }));
          if (piModelRefusesImages(state))
            return yield* protocolError("The selected Pi model has no image support.");
        }
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const extraLines: Array<string> = [];
        for (const attachment of attachments) {
          const path = host.resolveAttachmentPath(attachment);
          if (path === null || !(yield* fileSystem.exists(path)))
            return yield* protocolError(`Pi attachment ${attachment.name} is unavailable.`);
          if (attachment.mimeType.startsWith("image/")) {
            const bytes = yield* fileSystem.readFile(path);
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          } else {
            extraLines.push(`[Attachment saved at ${path}]`);
          }
        }
        const message =
          extraLines.length === 0 ? expandedText : `${expandedText}\n\n${extraLines.join("\n")}`;
        return { message, images };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: PI_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        invalidateInitiatedWork: (reserve) => invalidateNativeGeneration(true, undefined, reserve),
        withInitiatedWorkAdmission: (identity, commit) =>
          Effect.gen(function* () {
            const work = bufferedWork;
            if (
              generationAdmissionClosed ||
              stopRequested ||
              work === null ||
              identity.threadId !== boundThreadId ||
              identity.providerThreadId !== work.providerThread.id ||
              identity.providerSessionId !== input.providerSessionId ||
              identity.providerInstanceId !== options.instanceId ||
              identity.driver !== PI_PROVIDER ||
              identity.workId !== work.workId ||
              !modelSelectionsEqual(identity.modelSelection, work.modelSelection) ||
              !runtimePoliciesEqual(identity.runtimePolicy, work.runtimePolicy)
            )
              return Option.none();
            return Option.some(yield* commit);
          }).pipe(generationAdmissionFence.withPermits(1)),
        events: Stream.fromQueue(events),
        hasPendingBackgroundWork: Effect.sync(() => bufferedWork !== null),
        hasPendingBackgroundWorkForThread: (thread) =>
          Effect.sync(() => bufferedWork?.providerThread.id === thread.id),
        getModelContextWindow: (selection) => {
          if (selection.instanceId !== options.instanceId) return undefined;
          const slug =
            selection.model === PI_INHERIT_MODEL_SLUG
              ? baselineModel === null
                ? undefined
                : encodePiModelSlug(baselineModel.provider, baselineModel.modelId)
              : selection.model;
          return slug === undefined ? undefined : modelContextWindows.get(slug);
        },
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.onExit((exit) =>
              threadInput.existingProviderThread?.nativeThreadRef?.nativeId == null
                ? rollbackStartup(exit)
                : Effect.void,
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: PI_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: PI_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        // The run executor routes a bare `/compact` here instead of startTurn.
        // Pi's start path already turns that text into the RPC compact call.
        compactThread: (turnInput) =>
          runtime.startTurn({
            ...turnInput,
            message: { ...turnInput.message, text: "/compact" },
          }),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            if (closed) return yield* protocolError("Pi session is closed");
            if (rollbackBarrier !== null)
              return yield* protocolError("Cannot start a Pi turn during rollback");
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.activeTurn !== null) {
              return yield* protocolError(
                `Pi provider thread ${turnInput.providerThread.id} already has an active turn`,
              );
            }
            if (
              state.providerThread.nativeThreadRef?.nativeId !==
              turnInput.providerThread.nativeThreadRef?.nativeId
            ) {
              return yield* protocolError("Pi turn requested for a different native session");
            }
            if (
              turnInput.threadId !== boundThreadId ||
              turnInput.appThread.id !== boundThreadId ||
              turnInput.modelSelection.instanceId !== options.instanceId ||
              turnInput.providerThread.providerInstanceId !== options.instanceId ||
              turnInput.providerThread.driver !== PI_PROVIDER
            )
              return yield* protocolError("Pi turn belongs to another runtime owner");
            const source = turnInput.message.notification?.source;
            const continuation =
              turnInput.message.createdBy === "agent" &&
              turnInput.message.creationSource === "provider";
            const pendingWork = bufferedWork;
            const joiningWork =
              source?.kind !== "provider_work" && !continuation && pendingWork !== null;
            if (joiningWork) {
              const confirmed = yield* request({ type: "get_state" });
              yield* assertSessionIdentity(confirmed);
              captureNativeSelection(confirmed);
              const requested =
                turnInput.modelSelection.model === PI_INHERIT_MODEL_SLUG
                  ? nativeSelection === null
                    ? null
                    : {
                        ...nativeSelection,
                        ...(turnInput.modelSelection.options === undefined
                          ? {}
                          : { options: turnInput.modelSelection.options }),
                      }
                  : turnInput.modelSelection;
              if (
                requested === null ||
                !modelSelectionsEqual(requested, pendingWork.modelSelection) ||
                !runtimePoliciesEqual(
                  { ...turnInput.runtimePolicy, cwd: turnInput.runtimePolicy.cwd ?? cwd },
                  pendingWork.runtimePolicy,
                )
              )
                return yield* protocolError(
                  "Pi native work cannot join a different captured model or runtime policy",
                );
            }
            const adoptedWork =
              source?.kind === "provider_work" || joiningWork ? pendingWork : null;
            if (
              source?.kind === "provider_work" &&
              (adoptedWork === null ||
                adoptedWork.workId !== source.workId ||
                source.providerSessionId !== input.providerSessionId ||
                source.providerThreadId !== state.providerThread.id ||
                !modelSelectionsEqual(adoptedWork.modelSelection, source.modelSelection) ||
                !runtimePoliciesEqual(adoptedWork.runtimePolicy, source.runtimePolicy) ||
                !modelSelectionsEqual(adoptedWork.modelSelection, turnInput.modelSelection) ||
                !runtimePoliciesEqual(adoptedWork.runtimePolicy, turnInput.runtimePolicy))
            )
              return yield* protocolError("Pi native generation no longer owns this captured run");
            if (adoptedWork === null && bufferedWork !== null)
              return yield* protocolError("Pi native work is waiting for its own run");
            // The orchestrator adopts a fork under its already-allocated row.
            // Future session updates must retain that authoritative identity.
            state.providerThread = turnInput.providerThread;
            // Adopted work began before this call; later state cannot describe its generation.
            const observedEffort =
              adoptedWork === null && !continuation
                ? yield* applySelection(turnInput.modelSelection)
                : undefined;
            if (
              threadState !== state ||
              generationAdmissionClosed ||
              stopRequested ||
              state.providerThread.id !== turnInput.providerThread.id ||
              state.activeTurn !== null
            )
              return yield* protocolError("Pi root owner changed while observing native state");
            // Mirror the thread title into pi's session name so the session
            // stays identifiable in pi's own /resume listing. Best-effort:
            // naming must never block a turn.
            if (adoptedWork === null && turnInput.appThread.title !== appliedSessionName) {
              yield* request({
                type: "set_session_name",
                name: turnInput.appThread.title,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => (appliedSessionName = turnInput.appThread.title)),
                ),
                Effect.ignore,
              );
            }
            // Resolved before the turn is installed: a failure here (an
            // unreadable attachment) must not leave `activeTurn` set, which
            // would reject every later turn as already active.
            // Orchestration instructions reach pi through the T3 MCP
            // extension's before_agent_start system-prompt hook, never by
            // wrapping the user text: a wrapped first message would no
            // longer start with "/" and slash commands would stop expanding.
            const compactCommand = continuation
              ? null
              : parsePiCompactCommand(turnInput.message.text);
            if (compactCommand !== null && turnInput.message.attachments.length > 0)
              return yield* protocolError("Pi native commands do not support attachments.");
            const payload =
              !continuation && (adoptedWork === null || joiningWork) && compactCommand === null
                ? yield* resolvePromptPayload(turnInput.message.text, turnInput.message.attachments)
                : null;
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: PI_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              nativeAcceptance: "pending",
              ...(observedEffort === undefined ? {} : { observedEffort }),
              startedAt,
              completedAt: null,
            };
            const activeTurn: ActivePiTurn = {
              turnInput,
              providerTurn,
              startedAt,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              messageOrdinal: 0,
              streamItems: new Map(),
              toolArgs: new Map(),
              toolStartedAt: new Map(),
              interrupted: false,
              broken: false,
              outputTruncated: false,
              modelFailure: null,
              contextRecoveryPending: false,
              sawAgentActivity: false,
              adoptedWake: joiningWork,
              promptMayBeCommandOnly:
                compactCommand !== null || (payload?.message.trimStart().startsWith("/") ?? false),
              latestCompactionAfterTokens: null,
              lastLiveUsedTokens: null,
              settleProbeGeneration: 0,
              pendingSteerCount: 0,
              settleWhenIdle: false,
              sawCompaction: false,
              manualCompactInFlight: compactCommand !== null,
              activeCompaction: null,
              activeProviderRetry: null,
              failure: null,
              rejectedPromptFailure: null,
            };
            // Only the install/send/start-event boundary excludes the event
            // pump. Earlier correlated requests must leave the pump free so
            // project trust, login, and session-switch dialogs can be shown
            // and answered instead of deadlocking the caller.
            yield* Effect.gen(function* () {
              if (
                threadState !== state ||
                state.activeTurn !== null ||
                closed ||
                stopRequested ||
                rollbackBarrier !== null ||
                state.providerThread.nativeThreadRef?.nativeId !==
                  turnInput.providerThread.nativeThreadRef?.nativeId
              )
                return yield* protocolError("Pi turn ownership changed before it could start");
              if (
                turnInput.shouldStartProviderTurn !== undefined &&
                !(yield* turnInput.shouldStartProviderTurn())
              ) {
                if (adoptedWork !== null) {
                  yield* disposeBufferedWork(adoptedWork);
                }
                return yield* Effect.interrupt;
              }
              if (adoptedWork !== null && bufferedWork !== adoptedWork)
                return yield* protocolError("Pi native generation was disposed before adoption");
              if (adoptedWork === null && bufferedWork !== null)
                return yield* protocolError(
                  "Pi native work started while a prompt was being prepared",
                );
              const transferred = yield* Effect.sync(() => {
                if (
                  generationAdmissionClosed ||
                  stopRequested ||
                  (adoptedWork !== null && bufferedWork !== adoptedWork)
                )
                  return false;
                state.activeTurn = activeTurn;
                if (adoptedWork !== null) bufferedWork = null;
                return true;
              }).pipe(generationAdmissionFence.withPermits(1));
              if (!transferred)
                return yield* protocolError("Pi native generation was disposed before adoption");
              activeTurn.providerTurn = { ...activeTurn.providerTurn, nativeAcceptance: "unknown" };
              if (!continuation && compactCommand !== null) {
                yield* send(compactRpcRecord(compactCommand));
                pendingCompactResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              } else if (payload !== null) {
                yield* send({
                  type: "prompt",
                  message: payload.message,
                  ...(joiningWork ? { streamingBehavior: "steer" } : {}),
                  ...(payload.images.length === 0 ? {} : { images: payload.images }),
                });
                pendingPromptResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              }
              yield* emit({
                type: "provider_turn.updated",
                driver: PI_PROVIDER,
                threadId: turnInput.threadId,
                providerTurn: activeTurn.providerTurn,
              });
              yield* updateProviderThread(state, {
                status: "active",
                firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                lastRunOrdinal: turnInput.runOrdinal,
              });
              yield* updateProviderSession("running", null);
              if (continuation && adoptedWork === null) yield* finalizeTurn(state);
              if (outOfTurnExtensionErrors.length > 0) {
                yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
              }
              if (adoptedWork !== null) {
                for (const record of adoptedWork.records) {
                  if (joiningWork && record["type"] === "agent_settled") {
                    activeTurn.settleWhenIdle = true;
                    continue;
                  }
                  yield* handleSessionEvent(record);
                }
              }
            }).pipe(
              sessionEventPermit.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: PI_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    providerTurn: activeTurn.providerTurn,
                    cause,
                  }),
              ),
              Effect.tapError(() =>
                Effect.gen(function* () {
                  if (state.activeTurn === activeTurn) state.activeTurn = null;
                  yield* invalidateNativeGeneration(true);
                  forcedSessionFailure = "Pi prompt delivery could not be confirmed.";
                  yield* updateProviderSession(
                    "error",
                    "Pi prompt delivery could not be confirmed.",
                  );
                  yield* connection.terminate;
                }),
              ),
            );
            // Pi acks `prompt` only after slash-command expansion completes,
            // and extension commands may block on user dialogs indefinitely.
            // Rejections therefore return later as id-less response records
            // handled by the event pump.
          }).pipe(Effect.mapError((cause) => mapTurnStartError(turnInput, cause))),
        steerTurn: (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) =>
          Effect.suspend(() => {
            const turn = threadState?.activeTurn ?? null;
            return Effect.gen(function* () {
              if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
                return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
              }
              if (
                steerInput.threadId !== boundThreadId ||
                steerInput.providerThread.id !== turn.providerTurn.providerThreadId ||
                steerInput.providerThread.providerInstanceId !== options.instanceId
              )
                return yield* protocolError("Pi steer belongs to another runtime owner");
              const steerState = yield* request({ type: "get_state" });
              yield* assertSessionIdentity(steerState);
              const compactCommand = parsePiCompactCommand(steerInput.message.text);
              if (compactCommand !== null && steerInput.message.attachments.length > 0)
                return yield* protocolError("Pi native commands do not support attachments.");
              const payload =
                compactCommand === null
                  ? yield* resolvePromptPayload(
                      steerInput.message.text,
                      steerInput.message.attachments,
                      steerState,
                    )
                  : null;
              // Prompt with streamingBehavior steer is atomic on Pi's side: it
              // queues during an active run and starts a new run if settlement
              // won the race. A direct `steer` sent after Pi became idle would
              // remain queued forever. Send fire-and-forget under the session
              // permit so a slash-command dialog cannot block the turn, and so
              // settlement cannot overtake the active-turn check.
              // /compact is not a prompt: Pi's compact RPC aborts the agent first.
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (turn.interrupted) return yield* Effect.interrupt;
                  if (threadState?.activeTurn !== turn) {
                    return yield* protocolError(
                      `Pi turn ${steerInput.providerTurnId} is not active`,
                    );
                  }
                  if (compactCommand !== null) {
                    turn.manualCompactInFlight = true;
                    yield* send(compactRpcRecord(compactCommand));
                    pendingCompactResponses.push({
                      providerTurnId: turn.providerTurn.id,
                      kind: "steer",
                    });
                  } else if (payload !== null) {
                    yield* send({
                      type: "prompt",
                      message: payload.message,
                      streamingBehavior: "steer",
                      ...(payload.images.length === 0 ? {} : { images: payload.images }),
                    });
                    pendingPromptResponses.push({
                      providerTurnId: turn.providerTurn.id,
                      kind: "steer",
                    });
                  }
                  turn.settleProbeGeneration += 1;
                  turn.pendingSteerCount += 1;
                }),
              );
            }).pipe(
              Effect.catchCause((cause) =>
                turn?.interrupted === true ? Effect.interrupt : Effect.failCause(cause),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: PI_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            );
          }),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const turn = threadState?.activeTurn ?? null;
            // Stop on a settled turn: Pi runs nothing between prompts, so
            // nothing of that turn is left to stop.
            if (turn === null && interruptInput.requestRuntimeRestart === true) {
              if (bufferedWork !== null)
                yield* sessionEventPermit.withPermits(1)(disposeBufferedWork(bufferedWork));
              return;
            }
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(`Pi turn ${interruptInput.providerTurnId} is not active`);
            }
            turn.interrupted = true;
            if (
              interruptInput.requestRuntimeRestart === true ||
              turn.settleWhenIdle ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight
            ) {
              // Pi's generic abort does not cancel manual compaction. Terminate
              // so Stop covers user /compact as well as detached recovery compact.
              yield* invalidateNativeGeneration(true);
              if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
              }
              // Terminating fails every later request, so read the stopped
              // turn's session-tree refs first: rolling back past this turn
              // forks at its user entry. Holding the event permit also lets a
              // finalize that is already reading them finish before the kill.
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (threadState?.activeTurn === turn && turn.stopTreeRefs === undefined) {
                    turn.stopTreeRefs = yield* captureTurnTreeRefs(2_000);
                  }
                  yield* connection.terminate;
                }),
              );
              return;
            }
            yield* request({ type: "abort" }).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: PI_PROVIDER,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.gen(function* () {
            const pending = pendingPrompts.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(
                `No pending Pi extension request ${requestInput.requestId}`,
              );
            }
            const response = piUiResponse(pending, requestInput.decision, requestInput.answers);
            if (response === undefined) return yield* protocolError("Invalid Pi extension answer.");
            yield* send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              ...response,
            });
            // Dropped only once Pi has the answer, so a failed send leaves the
            // request retryable and still cancellable during teardown.
            pendingPrompts.delete(String(requestInput.requestId));
            if (pending.method === "confirm" && requestInput.decision === "acceptForSession") {
              sessionApprovals.add(pending.approvalKey);
            }
            const resolvedAt = yield* DateTime.now;
            pending.runtimeRequest = {
              ...pending.runtimeRequest,
              status: "resolved",
              resolvedAt,
            };
            yield* emit({
              type: "runtime_request.updated",
              driver: PI_PROVIDER,
              threadId: pending.node.threadId,
              runtimeRequest: pending.runtimeRequest,
            });
            yield* emit({
              type: "node.updated",
              driver: PI_PROVIDER,
              node: { ...pending.node, status: "completed", completedAt: resolvedAt },
            });
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                ...pending.turnItem,
                status: "completed",
                completedAt: resolvedAt,
                updatedAt: resolvedAt,
              },
            });
          }).pipe(
            sessionEventPermit.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: PI_PROVIDER,
                  requestId: requestInput.requestId,
                  cause,
                }),
            ),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.gen(function* () {
            const state = threadState;
            const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
              return yield* protocolError(
                "Pi snapshot requested for a thread this session does not host",
              );
            }
            // get_messages is Pi's active-branch view. get_entries returns the
            // whole session tree, including abandoned branches after /tree or
            // fork, which would leak discarded conversation into handoffs.
            const messagesData = yield* request({ type: "get_messages" });
            const activeMessages = recordField(messagesData, "messages");
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
              (message, index) => {
                const role = recordString(message, "role");
                if (role !== "user" && role !== "assistant") return [];
                const text = contentText(recordField(message, "content"));
                if (text.length === 0) return [];
                const timestamp = recordNumber(message, "timestamp");
                const at = Option.getOrElse(
                  DateTime.make(timestamp ?? Number.NaN),
                  () => state.providerThread.createdAt,
                );
                return [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: PI_PROVIDER,
                      // RPC messages do not expose session-tree entry ids. The
                      // active-branch index is stable for the lifetime of this
                      // snapshot and keeps abandoned branch ids out of it.
                      nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                    }),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: role as "user" | "assistant",
                    text,
                    attachments: [],
                    streaming: false,
                    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                    creationSource: "provider" as const,
                    createdAt: at,
                    updatedAt: at,
                  },
                ];
              },
            );
            return {
              providerThread: state.providerThread,
              providerTurns: [],
              messages,
              runtimeRequests: [],
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: PI_PROVIDER,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (rollbackInput) =>
          Effect.gen(function* () {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Pi session has no registered thread");
            }
            if (state.providerThread.id !== rollbackInput.providerThread.id) {
              return yield* protocolError(
                "Pi rollback requested for a thread this session does not host",
              );
            }
            if (state.activeTurn !== null) {
              return yield* protocolError("Cannot roll back while a Pi turn is active");
            }
            if (bufferedWork !== null) {
              return yield* protocolError("Cannot roll back while native Pi work awaits a turn");
            }
            // `fork(entryId)` re-roots the active branch before that user
            // message, so the rollback boundary is the first user entry of
            // the earliest turn being discarded.
            const forkEntryId = piRollbackForkEntry(rollbackInput);
            if (forkEntryId === null) {
              // Nothing after the target: the conversation is already there.
              return piThreadSnapshot(state.providerThread);
            }
            if (forkEntryId === undefined) {
              return yield* protocolError("Pi rollback target has no captured session-tree entry");
            }
            return yield* Effect.acquireUseRelease(
              sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    rollbackBarrier !== null ||
                    threadState !== state ||
                    state.activeTurn !== null ||
                    bufferedWork !== null ||
                    closed ||
                    stopRequested
                  )
                    return yield* protocolError(
                      "Pi rollback ownership changed before its fork could start",
                    );
                  const barrier = yield* Deferred.make<
                    void,
                    ProviderAdapter.ProviderAdapterProtocolError
                  >();
                  rollbackBarrier = barrier;
                  return barrier;
                }),
              ),
              (barrier) =>
                Effect.gen(function* () {
                  const forkData = yield* lifecycleRequest({ type: "fork", entryId: forkEntryId });
                  if (recordField(forkData, "cancelled") === true)
                    return yield* protocolError("A Pi extension cancelled the session fork");
                  const forkState = yield* request({ type: "get_state" }).pipe(
                    Effect.onError(() =>
                      Effect.sync(() => {
                        threadState = null;
                      }),
                    ),
                  );
                  const forkSessionFile = recordString(forkState, "sessionFile");
                  if (forkSessionFile === undefined) {
                    threadState = null;
                    return yield* protocolError("Pi fork did not return a persisted session file");
                  }
                  // SCIENT-FORK:START — a confirmed native fork remains recoverable if later probes fail.
                  yield* sessionEventPermit.withPermits(1)(
                    Effect.gen(function* () {
                      if (threadState !== state || state.activeTurn !== null)
                        return yield* protocolError(
                          "Pi rollback binding changed before its native identity could be recorded",
                        );
                      lastNativeThreadId = forkSessionFile;
                      expectedNativeSessionId = recordString(forkState, "sessionId");
                      appliedModel = null;
                      appliedThinking = null;
                      appliedSessionName = null;
                      yield* updateProviderThread(state, {
                        nativeThreadRef: providerRef(forkSessionFile),
                      });
                    }),
                  );
                  // SCIENT-FORK:END
                  const entriesData = yield* request({ type: "get_entries" }).pipe(
                    // Command-level probes may be unavailable; a lost transport cannot
                    // confirm the rollback ordering barrier and must remain a failure.
                    Effect.catch((error) =>
                      error._tag === "PiRpcError" &&
                      ["read", "write", "exit", "terminate"].includes(error.operation)
                        ? Effect.fail(error)
                        : Effect.succeed(undefined),
                    ),
                  );
                  const leafId = recordString(entriesData, "leafId") ?? null;
                  // RPC responses bypass the pump. Drain preceding native events
                  // before deciding whether this fork can replace their binding.
                  const queued = yield* Queue.offer(connection.events, {
                    type: "t3.rollback_barrier",
                    barrier,
                  });
                  if (!queued) return yield* protocolError("Pi transport closed during rollback");
                  yield* Deferred.await(barrier);
                  return yield* sessionEventPermit.withPermits(1)(
                    Effect.gen(function* () {
                      if (bufferedWork !== null) {
                        yield* disposeBufferedWork(bufferedWork);
                        return yield* protocolError(
                          "Native Pi work started while rollback was changing the session",
                        );
                      }
                      if (
                        threadState !== state ||
                        state.activeTurn !== null ||
                        closed ||
                        stopRequested
                      )
                        return yield* protocolError(
                          "Pi rollback ownership changed during its fork",
                        );
                      lastKnownLeaf = leafId;
                      leafCursorStale = entriesData === undefined;
                      yield* updateProviderThread(state, {
                        nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
                      });
                      rollbackBarrier = null;
                      return piThreadSnapshot(state.providerThread);
                    }),
                  );
                }).pipe(Effect.onInterrupt(() => connection.terminate)),
              (barrier) =>
                Effect.sync(() => {
                  if (rollbackBarrier === barrier) rollbackBarrier = null;
                }),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver: PI_PROVIDER,
                  providerThreadId: rollbackInput.providerThread.id,
                  checkpointId: rollbackInput.target.checkpointId,
                  cause,
                }),
            ),
          ),
        forkThread: (forkInput) =>
          Effect.gen(function* () {
            if (closed) return yield* protocolError("Pi session is closed");
            if (threadState?.activeTurn != null) {
              return yield* protocolError("Cannot fork while a Pi turn is active");
            }
            const source = forkInput.sourceProviderThread;
            const sourceFile = source.nativeThreadRef?.nativeId;
            if (sourceFile == null)
              return yield* protocolError("Pi fork source has no session file");
            const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
              (turn) => turn.providerThreadId === source.id,
            );
            const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && target === undefined) {
              return yield* protocolError("Pi fork target turn is missing");
            }
            const beforeEntry =
              target === undefined
                ? null
                : piRollbackForkEntry({
                    target: { type: "provider_turn", providerTurn: target },
                    providerThreadTurns: sourceTurns,
                  });
            if (beforeEntry === undefined) {
              return yield* protocolError("Pi fork boundary has no captured session-tree entry");
            }
            // CLI --fork uses Pi's own session format and sets the destination
            // cwd. RPC switch_session/clone alone would retain the source cwd.
            // This short-lived process never prompts or runs user extensions.
            const forkLaunch = buildPiRpcLaunch({
              launchArgs: resolvedLaunchArgs.args,
              environment: options.environment,
              mcpSession: undefined,
              extensionPath: undefined,
              disableExtensions: true,
              disableTools: true,
            });
            const nativeId = yield* Effect.scoped(
              Effect.gen(function* () {
                const forkConnection = yield* (options.makeConnection ?? makePiRpcConnection)({
                  command: options.settings.binaryPath || "pi",
                  args: [...forkLaunch.args, "--fork", sourceFile],
                  cwd,
                  env: forkLaunch.env,
                });
                yield* Stream.fromQueue(forkConnection.events).pipe(
                  Stream.runDrain,
                  Effect.ignore,
                  Effect.forkScoped,
                );
                if (beforeEntry !== null) {
                  const result = yield* forkConnection.request({
                    type: "fork",
                    entryId: beforeEntry,
                  });
                  if (recordField(result, "cancelled") === true) {
                    return yield* protocolError("A Pi extension cancelled the session fork");
                  }
                }
                const state = yield* forkConnection.request({ type: "get_state" });
                const file = recordString(state, "sessionFile");
                if (file === undefined || file === sourceFile) {
                  return yield* protocolError("Pi fork did not create a distinct session file");
                }
                return file;
              }),
            ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            const now = yield* DateTime.now;
            return yield* registerThread(
              {
                threadId: forkInput.targetThreadId,
                modelSelection: forkInput.modelSelection ?? input.modelSelection,
                runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
                existingProviderThread: {
                  ...source,
                  id: idAllocator.derive.providerThread({
                    driver: PI_PROVIDER,
                    nativeThreadId: nativeId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: options.instanceId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
              false,
              true,
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterForkThreadError({
                  driver: PI_PROVIDER,
                  providerThreadId: forkInput.sourceProviderThread.id,
                  cause,
                }),
            ),
          ),
      };
      return runtime;
    }),
  });
});

interface PiSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
}

/** Index a `get_entries` listing, rejecting ambiguous ancestry. */
function piSessionEntries(entries: unknown): ReadonlyMap<string, PiSessionEntry> | null {
  const byId = new Map<string, PiSessionEntry>();
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const id = recordString(entry, "id");
    const parentId = recordField(entry, "parentId");
    if (id === undefined || byId.has(id) || (parentId !== null && typeof parentId !== "string"))
      return null;
    byId.set(id, {
      parentId,
      isUserMessage:
        recordField(entry, "type") === "message" &&
        recordString(recordField(entry, "message"), "role") === "user",
    });
  }
  return byId;
}

/**
 * Walk pi's active branch from `leafId` towards the root through `entries`,
 * stopping at `stopAt`. Returns how many entries it passed, the user entries
 * among them (newest first), and whether the walk reached `stopAt`. Leaving a
 * partial listing anywhere else means the branch does not descend from `stopAt`.
 * Returns null when the `parentId` chain loops, which only corrupted session
 * data can produce; callers treat that like a failed listing.
 */
function walkPiBranch(
  entries: ReadonlyMap<string, PiSessionEntry>,
  leafId: string | null,
  stopAt: string | null,
): {
  readonly entryCount: number;
  readonly userEntryIds: ReadonlyArray<string>;
  readonly reachedStop: boolean;
} | null {
  const visited = new Set<string>();
  const userEntryIds: Array<string> = [];
  let current = leafId;
  while (current !== null && current !== stopAt) {
    const entry = entries.get(current);
    if (entry === undefined) break;
    if (visited.has(current)) return null;
    visited.add(current);
    if (entry.isUserMessage) userEntryIds.push(current);
    current = entry.parentId;
  }
  return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

/**
 * Resolve the pi session-tree entry `fork` should re-root at for a rollback.
 * Turns without a ref left nothing on the active branch, so the boundary is
 * the first discarded turn that has one. Returns `null` when no such turn
 * follows the target (nothing to discard) and `undefined` when the boundary
 * turn has no captured entry ref (only turn-boundary refs recorded by
 * `captureTurnTreeRefs` are strong).
 */
function piRollbackForkEntry(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): string | null | undefined {
  const boundaryOrdinal =
    input.target.type === "thread_start" ? 0 : input.target.providerTurn.ordinal;
  const ref = input.providerThreadTurns
    .filter((turn) => turn.ordinal > boundaryOrdinal && turn.nativeTurnRef !== null)
    .sort((a, b) => a.ordinal - b.ordinal)[0]?.nativeTurnRef;
  if (ref == null) return null;
  if (ref.strength !== "strong" || ref.nativeId === null) return undefined;
  return ref.nativeId;
}

/**
 * Human-readable output for one subagent-extension task result: the last
 * assistant text from its transcript, or the error/stderr when it failed.
 */
function piSubagentOutput(result: unknown): string {
  const stopReason = recordString(result, "stopReason");
  const failed =
    (recordNumber(result, "exitCode") ?? 0) !== 0 ||
    stopReason === "error" ||
    stopReason === "aborted";
  if (failed) {
    // Falsy fallback, not `??`: an empty `errorMessage` must not suppress a
    // non-empty `stderr`, which is often the only description of the failure.
    const failure = recordString(result, "errorMessage") || recordString(result, "stderr");
    if (failure !== undefined && failure.length > 0) return failure;
  }
  const messages = recordField(result, "messages");
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (recordString(message, "role") !== "assistant") continue;
    const text = contentText(recordField(message, "content"));
    if (text.length > 0) return text;
  }
  return "";
}

function piExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Pi extension";
  const normalized = extensionPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return name.length === 0 ? "Pi extension" : name;
}

function piThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
}

function piQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: PiRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({ label: option || "Empty value", description: option, value: option }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  const question = recordString(event, "message") ?? recordString(event, "placeholder") ?? title;
  return {
    id: questionId,
    header: title,
    question,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    options,
    multiSelect: false,
    allowCustomAnswer: method === "input" || method === "editor",
  };
}

function piUiResponse(
  pending: PendingPiPrompt,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): PiRpcRecord | undefined {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    if (decision === "cancel") return { cancelled: true };
    const answer = answers?.[pending.questionId];
    if (answer === "true") return { confirmed: true };
    if (answer === "false") return { confirmed: false };
    return undefined;
  }
  const answer = answers?.[pending.questionId];
  // An empty string is a valid dialog value per the RPC spec (the extension
  // receives ""), distinct from cancelling (the extension receives undefined).
  if (typeof answer === "string") return { value: answer };
  return decision === "cancel" ? { cancelled: true } : undefined;
}

// ── driver ────────────────────────────────────────────────────

/** Enable native work only when the host supplied its live continuation queue. */
export const piContinuationRequestsIfProvided = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  if (!context.mapUnsafe.has(ProviderContinuationRequests.ProviderContinuationRequests.key))
    return undefined;
  return yield* ProviderContinuationRequests.ProviderContinuationRequests;
});

export type PiAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost;

export const PiAdapterV2Driver: ProviderAdapterDriver<PiSettings, PiAdapterV2DriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => DEFAULT_PI_SETTINGS,
  create: Effect.fn("PiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PiSettings>) {
      const hostContext = yield* Effect.context<never>();
      const hostEnvironment = Context.get(hostContext, HostProcessEnvironment);
      const continuationRequests = yield* piContinuationRequestsIfProvided;
      return yield* makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        ...(continuationRequests === undefined ? {} : { continuationRequests }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PI_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Pi adapter.",
              cause,
            }),
        ),
      ),
  ),
};
