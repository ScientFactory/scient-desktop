import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  disposeRetiredEventConsumer,
  interruptAndJoinRetirement,
  retireUnusableOwner,
  makeSessionRetirement,
} from "./scient-provider/SessionRetirement.ts";
import { makeProviderTextSnapshots } from "./scient-provider/ProviderTextSnapshots.ts";
import { makePiSessionFileLeases } from "./scient-provider/PiSessionFileLeases.ts";
import { makeSessionAuthority } from "./scient-provider/SessionAuthority.ts";
import {
  makeStartupSessionReservations,
  registerStartupSessionReservations,
} from "./scient-provider/StartupSessionHold.ts";
import { requireEnabledProviderInstance } from "./scient-provider/ProviderInstanceEnabled.ts";
import { expandComposerCitationsForProvider } from "@t3tools/shared/composerCitations";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  ModelSelection,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { normalizeModelMetricLabel } from "../observability/Attributes.ts";
import {
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import {
  type ProviderTextSnapshotError,
  type ProviderTextSnapshotOwner,
  type CapturedProviderText,
  type ProviderAdapterV2InternalEvent,
  ProviderAdapterEventStreamError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderTextSnapshotSubscription,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2InitiatedWorkIdentity,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { scientSkillDeliveryForProvider } from "../scient/skills/ScientSkillSession.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
const RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000;

const busyTurnPrefix = (providerThreadId: ProviderThreadId) => `${providerThreadId}#`;
/** The identity a turn's start and its `turn.terminal` share. */
const busyTurnKey = (providerThreadId: ProviderThreadId, runOrdinal: number) =>
  `${busyTurnPrefix(providerThreadId)}${runOrdinal}`;
const UNLOAD_THREAD_TIMEOUT_MS = 10 * 1000;

export const ProviderSessionReleaseReason = Schema.Literals([
  "idle_timeout",
  "runtime_error",
  "manual_shutdown",
  "server_shutdown",
]);
export type ProviderSessionReleaseReason = typeof ProviderSessionReleaseReason.Type;

/**
 * ProviderSessionManager owns live session residency: open sessions, idle release,
 * explicit shutdown, and release-on-runtime-failure.
 *
 * It intentionally does not resurrect persisted sessions. Process-loss recovery
 * terminalizes provider-bound work and retires non-replayable effects; a later
 * user command or durable replay-safe operation opens a session lazily.
 */
export class ProviderSessionOpenError extends Schema.TaggedError<ProviderSessionOpenError>()(
  "ProviderSessionOpenError",
  {
    instanceId: ProviderInstanceId,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open provider instance ${this.instanceId} session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionLookupError extends Schema.TaggedError<ProviderSessionLookupError>()(
  "ProviderSessionLookupError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to look up provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionCloseError extends Schema.TaggedError<ProviderSessionCloseError>()(
  "ProviderSessionCloseError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionReleaseError extends Schema.TaggedError<ProviderSessionReleaseError>()(
  "ProviderSessionReleaseError",
  {
    providerSessionId: ProviderSessionId,
    reason: ProviderSessionReleaseReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to release provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionActivityError extends Schema.TaggedError<ProviderSessionActivityError>()(
  "ProviderSessionActivityError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to update provider session activity for ${this.providerSessionId}.`;
  }
}

export const ProviderSessionManagerV2Error = Schema.Union([
  ProviderSessionOpenError,
  ProviderWorkspaceMissingError,
  ProviderSessionLookupError,
  ProviderSessionCloseError,
  ProviderSessionReleaseError,
  ProviderSessionActivityError,
]);
export type ProviderSessionManagerV2Error = typeof ProviderSessionManagerV2Error.Type;

export interface ProviderSessionManagerV2Shape {
  readonly captureRunningForkText?: (
    owner: ProviderTextSnapshotOwner,
  ) => Effect.Effect<CapturedProviderText, ProviderTextSnapshotError>;
  readonly withCapturedForkText?: <A, E, R>(
    capture: CapturedProviderText,
    commit: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderTextSnapshotError, R>;
  readonly releaseCapturedForkText?: (capture: CapturedProviderText) => Effect.Effect<void>;

  readonly shutdown: Effect.Effect<void>;
  readonly withProviderWorkAdmission: <A, E, R>(
    identity: ProviderAdapterV2InitiatedWorkIdentity,
    expectedRuntime: ProviderAdapterV2SessionRuntime,
    commit: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;

  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly modelSelection: ModelSelection;
    readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
    readonly resumeFromSession?: OrchestrationV2ProviderSession;
    readonly initialNativeThreadId?: string;
    readonly initialProviderItemIdentityVersion?: 2;
    // SCIENT-FORK:START provider-enabled-at-open
    /** A deferred turn start refuses a provider turned off since its message was admitted. */
    readonly requireEnabledInstance?: boolean;
    // SCIENT-FORK:END provider-enabled-at-open
  }) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderSessionManagerV2Error>;
  readonly get: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<Option.Option<ProviderAdapterV2SessionRuntime>, ProviderSessionManagerV2Error>;
  /** Resolve execution authority only for the live native owner of this MCP credential. */
  readonly resolveMcpInvocationPolicy: (
    scope: Pick<McpThreadCaller, "threadId" | "providerInstanceId" | "providerSessionId">,
  ) => Effect.Effect<
    Option.Option<Pick<ProviderAdapterV2RuntimePolicy, "runtimeMode" | "interactionMode">>,
    ProviderSessionManagerV2Error
  >;
  readonly close: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  /** Internal teardown truth only; never an execution or native-reader release capability. */
  readonly getCloseState?: (providerSessionId: ProviderSessionId) => Effect.Effect<
    Option.Option<{
      readonly providerSessionId: ProviderSessionId;
      readonly instanceId: ProviderInstanceId;
      readonly state: "pending" | "failed";
    }>
  >;
  /** Closes live and retained retiring runtimes owned by one exact provider instance. */
  readonly closeInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly release: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: ProviderSessionReleaseReason;
    readonly detail?: string;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly detach: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly detail?: string;
    /**
     * True for terminal detaches (thread archived or deleted): the thread's
     * MCP credentials are revoked immediately instead of surviving for a
     * potential re-attach.
     */
    readonly revokeMcpCredential?: boolean;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
}

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("t3/orchestration-v2/ProviderSessionManager/ProviderSessionManagerV2") {}

interface LiveSessionEntry {
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly loadedProviderThreadKeyByThread: ReadonlyMap<ThreadId, string>;
  /**
   * MCP credential session id issued for each attached thread. Revocation on
   * detach/release is scoped to these ids so tearing down a superseded
   * session cannot revoke a replacement session's credential for the same
   * thread (the workspace-handoff sequence opens the replacement before the
   * outbox executes the old session's detach).
   */
  readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
  readonly supportsMultipleProviderThreads: boolean;
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapterV2SessionRuntime;
  readonly eventSubscribers: Ref.Ref<
    ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
  >;
  readonly requestEventPermit: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly eventPump: {
    fiber: Fiber.Fiber<void, never> | undefined;
    ended: boolean;
  };
  readonly eventConsumer?: {
    readonly dispose: Effect.Effect<void>;
  };
  readonly idleGeneration: number;
  /**
   * Turns this session is running, keyed by `busyTurnKey`. A turn's start adds
   * it and its `turn.terminal` (or a failed start) removes it, so a turn can
   * only clear itself and the session is idle when the set is empty.
   */
  readonly busyTurns: ReadonlySet<string>;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  /** Set when idle release is deferred for pending background work; bounds total deferral. */
  readonly pinnedSinceMs: number | null;
  /**
   * Shared runtimes only: the provider thread each attached app thread last
   * started a turn on, and the timer that unloads it once it has been idle
   * for `idleTimeoutMs`.
   */
  readonly idleThreadUnloads: ReadonlyMap<ThreadId, IdleThreadUnload>;
}

interface IdleThreadUnload {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

interface ClosingSessionEntry {
  entry: LiveSessionEntry;
  readonly reason: ProviderSessionReleaseReason;
  readonly operation: Fiber.Fiber<Exit.Exit<void, unknown>, never>;
  readonly firstRecordsAttempt: Deferred.Deferred<Exit.Exit<void, unknown>>;
  state: "pending" | "failed";
}

interface ReleaseEntryInput {
  readonly providerSessionId: ProviderSessionId;
  readonly reason: ProviderSessionReleaseReason;
  readonly detail?: string;
  readonly cancelIdleFiber?: boolean;
  readonly onlyIfIdleGeneration?: number;
  readonly gracefulSubscribers?: boolean;
  readonly expectedRuntime?: ProviderAdapterV2SessionRuntime;
  readonly onFirstRecordsAttempt?: (exit: Exit.Exit<void, unknown>) => Effect.Effect<void>;
}

type ProviderSessionEventSignal =
  | { readonly type: "event"; readonly event: ProviderAdapterV2InternalEvent }
  | {
      readonly type: "failure";
      readonly cause: Cause.Cause<ProviderAdapterV2Error>;
    };

export interface ProviderSessionManagerV2LayerOptions {
  readonly idleTimeoutMs?: number;
  /** Cap on how long idle release may be deferred for pending background work. */
  readonly maxIdlePinMs?: number;
  /** Test replay harnesses can omit T3's MCP server from provider protocol fixtures. */
  readonly configureMcp?: boolean;
}

function releaseStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2ProviderSession["status"] {
  return reason === "runtime_error" ? "error" : "stopped";
}

function releasedRuntimeRequestStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2RuntimeRequest["status"] {
  return reason === "manual_shutdown" || reason === "server_shutdown" ? "cancelled" : "expired";
}

function sessionKey(providerSessionId: ProviderSessionId): string {
  return String(providerSessionId);
}

/**
 * Runtime requests with no provider turn belong to the live session itself.
 * Their node and transcript item are runless too, so they bypass the normal
 * per-run subscriber and are persisted by the session event pump.
 */
function sessionScopedRuntimeRequestThreadId(event: ProviderAdapterV2Event): ThreadId | undefined {
  switch (event.type) {
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === null ? event.threadId : undefined;
    case "node.updated":
      return event.node.runId === null && event.node.runtimeRequestId !== null
        ? event.node.threadId
        : undefined;
    case "turn_item.updated":
      return event.turnItem.runId === null &&
        (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request")
        ? event.turnItem.threadId
        : undefined;
    default:
      return undefined;
  }
}

function providerThreadRuntimeKey(
  providerThread: Parameters<ProviderAdapterV2SessionRuntime["resumeThread"]>[0]["providerThread"],
): string {
  const nativeThreadRef = providerThread.nativeThreadRef;
  return nativeThreadRef === null
    ? String(providerThread.id)
    : `${nativeThreadRef.driver}:${nativeThreadRef.nativeId}`;
}

function providerThreadLoadKey(input: {
  readonly providerThread: Parameters<
    ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
}): string {
  return JSON.stringify({
    providerThreadId: input.providerThread.id,
    providerThread: providerThreadRuntimeKey(input.providerThread),
    modelSelection: input.modelSelection ?? null,
    runtimePolicy: input.runtimePolicy ?? null,
  });
}

export const layerWithOptions = (
  options: ProviderSessionManagerV2LayerOptions = {},
): Layer.Layer<
  ProviderSessionManagerV2,
  never,
  | EventSink.EventSinkV2
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpSessionRegistry.McpSessionRegistry
  | ProjectionStore.ProjectionStoreV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ProviderRegistry.ProviderRegistry
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mcpSessionRegistry = yield* McpSessionRegistry.McpSessionRegistry;
      /**
       * Optional so the many focused tests that assemble this layer by hand do
       * not each need a settings stub; the production composition always
       * provides it. When present, an unreadable settings file withholds
       * browser access rather than granting it — an explicit "off" silently
       * becoming "on" would violate the user's stated choice, whereas the
       * reverse costs an agent one toolset and is visible immediately (#7083).
       */
      const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      const projectService = yield* Effect.serviceOption(ProjectService.ProjectService);
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const agentAccessSettings = Effect.fn("ProviderSessionManagerV2.agentAccessSettings")(
        function* (threadId: ThreadId) {
          if (Option.isNone(serverSettings)) return { browser: true, device: false };
          return yield* Effect.gen(function* () {
            const settings = yield* serverSettings.value.getSettings;
            const thread = yield* projectionStore.getThread(threadId);
            const entries = Object.values(settings.projectSettingsOverrides);
            const browserOverridden = entries.some(
              (entry) => entry.enableAgentBrowserAccess !== undefined,
            );
            const deviceOverridden = entries.some(
              (entry) => entry.enableAgentDeviceAccess !== undefined,
            );
            if (browserOverridden || deviceOverridden) {
              const project = Option.isSome(projectService)
                ? yield* projectService.value.getById(thread.projectId)
                : Option.none();
              if (Option.isNone(project))
                return {
                  browser: browserOverridden ? false : settings.enableAgentBrowserAccess,
                  device: deviceOverridden ? false : settings.enableAgentDeviceAccess,
                };
            }
            const effective = resolveProjectSettings(settings, thread.projectId).settings;
            return {
              browser: effective.enableAgentBrowserAccess,
              device: effective.enableAgentDeviceAccess,
            };
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not resolve agent access; withholding browser and device tools.",
                { threadId, cause },
              ).pipe(Effect.as({ browser: false, device: false })),
            ),
          );
        },
      );
      const layerScope = yield* Effect.scope;
      const logReleaseFailure = (providerSessionId: ProviderSessionId) =>
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.driver-session.release-failed", {
            providerSessionId,
            cause,
          }),
        );
      const observeLateScopeClose = (
        closing: Fiber.Fiber<Exit.Exit<void, never>, never>,
        context: { readonly providerSessionId?: ProviderSessionId; readonly reason: string },
      ) =>
        Fiber.join(closing).pipe(
          Effect.flatMap((exit) =>
            Exit.isFailure(exit)
              ? Effect.logWarning("orchestration-v2.provider-session-scope-close-failed", {
                  ...context,
                  cause: exit.cause,
                })
              : Effect.logInfo(
                  "orchestration-v2.provider-session-scope-close-completed-late",
                  context,
                ),
          ),
          Effect.forkDetach,
        );
      const closeScopeWithin = (
        scope: Scope.Closeable,
        context: { readonly providerSessionId?: ProviderSessionId; readonly reason: string },
      ) =>
        Effect.gen(function* () {
          const closing = yield* Scope.close(scope, Exit.void).pipe(
            Effect.exit,
            Effect.forkDetach({ startImmediately: true }),
          );
          const result = yield* Fiber.join(closing).pipe(
            Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
          );
          if (Option.isNone(result)) {
            yield* Effect.logWarning("orchestration-v2.provider-session-scope-close-timeout", {
              ...context,
              timeoutMs: RELEASE_SCOPE_CLOSE_TIMEOUT_MS,
            });
            yield* observeLateScopeClose(closing, context);
            return;
          }
          if (Exit.isFailure(result.value)) return yield* Effect.failCause(result.value.cause);
        });

      // Ctrl+C, or a stop that signals the whole process group, reaches the
      // provider CLIs with the server. They report their own background work
      // stopped before shutdown captures restart continuations, so provider
      // events after the signal are dropped; restart recovery owns that state.
      const shutdownSignal = { received: false };
      const onShutdownSignal = () => {
        shutdownSignal.received = true;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGINT", onShutdownSignal);
          process.on("SIGTERM", onShutdownSignal);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGINT", onShutdownSignal);
            process.off("SIGTERM", onShutdownSignal);
          }),
      );
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());
      const releasingRuntimes = new WeakSet<ProviderAdapterV2SessionRuntime>();
      // SCIENT-FORK:START — running-fork text capture owners live in their owned module.
      const textSnapshotRegistry = yield* makeProviderTextSnapshots({
        sessions,
        sessionKey,
        releasingRuntimes,
      });
      // SCIENT-FORK:END

      // The same exact owner survives logical removal, timeout and failed scope
      // close. It has no execution rights; retries join its original operation.
      const closingSessions = new Map<string, ClosingSessionEntry>();
      // SCIENT-FORK:START — Pi session files admit one native writer per process scope.
      const { closeOwnedScope: closePiScope, claimPiFile } = makePiSessionFileLeases({
        fileSystem,
        path,
      });
      const ownedScopeCloses = new WeakMap<
        Scope.Closeable,
        Fiber.Fiber<Exit.Exit<void, never>, never>
      >();
      const parentScopeOwners = new WeakMap<
        Scope.Closeable,
        { readonly scope: Scope.Closeable; retiring: boolean; closed: boolean }
      >();
      // Scope.close marks a scope closed before its finalizers finish. All exact
      // owners must join the same physical close before releasing Pi file leases.
      const closeOwnedScope = (scope: Scope.Closeable) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let closing = ownedScopeCloses.get(scope);
            if (closing === undefined) {
              closing = yield* closePiScope(scope).pipe(
                Effect.onExit((exit) =>
                  Effect.suspend(() => {
                    const owner = parentScopeOwners.get(scope);
                    if (Exit.isFailure(exit) || owner === undefined) return Effect.void;
                    owner.closed = true;
                    return Scope.close(owner.scope, Exit.void);
                  }),
                ),
                Effect.exit,
                Effect.forkDetach({ startImmediately: true }),
              );
              ownedScopeCloses.set(scope, closing);
            }
            const result = yield* restore(Fiber.join(closing));
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          }),
        );
      // SCIENT-FORK:END
      const nextSubscriberId = yield* Ref.make(0);
      const sessionOpen = yield* KeyedLock.make<ProviderSessionId>();
      // Orders a thread's attach against a detach unloading it on the same session.
      const threadAttachment = yield* KeyedLock.make<string>();
      const threadAttachmentKey = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) => `${input.providerSessionId}\u0000${input.threadId}`;
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      const maxIdlePinMs = Math.max(0, options.maxIdlePinMs ?? DEFAULT_MAX_IDLE_PIN_MS);
      interface PreparedMcpCredential {
        readonly mcpCredentialId: string | undefined;
        /** True when this call minted the credential (vs reusing a live one). */
        readonly issued: boolean;
      }
      /**
       * Reservations protect a credential between prepareMcpSession handing it
       * out and the owning session entry becoming visible in `sessions`.
       * Adapters like ACP and OpenCode consume the credential eagerly during
       * openSession, so a racing release must not revoke it in that window
       * (rotating afterwards cannot repair an already-configured process).
       * The holder MUST drop the reservation once the entry is recorded or the
       * open fails.
       */
      const mcpCredentialReservations = new Map<
        string,
        { readonly count: number; readonly revocationPending: boolean }
      >();
      const mcpReservationKey = (threadId: ThreadId, mcpCredentialId: string) =>
        `${threadId}\0${mcpCredentialId}`;
      const reserveMcpCredential = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        const existing = mcpCredentialReservations.get(key);
        mcpCredentialReservations.set(key, {
          count: (existing?.count ?? 0) + 1,
          revocationPending: existing?.revocationPending ?? false,
        });
      };
      const dropMcpCredentialReservation = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        const existing = mcpCredentialReservations.get(key);
        if (existing === undefined) return;
        const count = Math.max(0, existing.count - 1);
        if (count === 0 && !existing.revocationPending) {
          mcpCredentialReservations.delete(key);
        } else {
          mcpCredentialReservations.set(key, { ...existing, count });
        }
      };
      const isMcpCredentialReserved = (threadId: ThreadId, credentialId: string) =>
        (mcpCredentialReservations.get(mcpReservationKey(threadId, credentialId))?.count ?? 0) > 0;
      const mcpPrepareLock = yield* KeyedLock.make<ThreadId>();
      /**
       * Resolves (or mints) the thread's MCP credential and returns it with a
       * reservation held; the caller must drop the reservation exactly once.
       * Serialized per thread so two concurrent prepares cannot interleave
       * their rotate steps and revoke each other's freshly minted credential.
       */
      const prepareMcpSession = (
        threadId: ThreadId,
        providerInstanceId: ProviderInstanceId,
        adapter: Pick<
          import("@t3tools/provider-core/server/ProviderAdapter").ProviderAdapterV2Shape,
          "driver" | "mcpSessionInjection"
        >,
      ): Effect.Effect<PreparedMcpCredential> =>
        mcpPrepareLock.withLock(
          threadId,
          Effect.gen(function* () {
            if (options.configureMcp === false || adapter.mcpSessionInjection !== true) {
              const configured = McpProviderSession.readMcpProviderSession(threadId);
              if (configured !== undefined) {
                const reservation = mcpCredentialReservations.get(
                  mcpReservationKey(threadId, configured.providerSessionId),
                );
                const owned = [...(yield* Ref.get(sessions)).values()].some(
                  (entry) =>
                    entry.mcpCredentialIdByThread.get(threadId) === configured.providerSessionId,
                );
                // No injection channel is not authority to revoke a predecessor.
                if ((reservation?.count ?? 0) === 0 && !owned) {
                  yield* clearMcpSession(threadId, configured.providerSessionId);
                }
              }
              return { mcpCredentialId: undefined, issued: false };
            }
            // Reuse a still-valid credential for this thread instead of
            // rotating: long-lived provider processes (codex app-server)
            // build their MCP client once per conversation and keep using
            // the credential it started with, so a thread that detaches and
            // re-attaches across a workspace handoff must come back to the
            // same token or the process's tool calls fail auth.
            const { browser: browserToolsAvailable, device: deviceToolsAvailable } =
              yield* agentAccessSettings(threadId);
            const capabilities = new Set<import("../mcp/McpInvocationContext.ts").McpCapability>([
              "orchestration",
              "worktree",
              "pull-requests",
              "documents:build",
              "compute:inventory",
              "sources:read",
              "sources:write",
              "threads:read",
            ]);
            if (scientSkillDeliveryForProvider(adapter.driver) === "mcp")
              capabilities.add("skills:read");
            if (browserToolsAvailable) capabilities.add("preview");
            if (deviceToolsAvailable) capabilities.add("device");
            const existing = McpProviderSession.readMcpProviderSession(threadId);
            if (existing !== undefined) {
              // Reserve before the async resolve so a release cannot
              // revoke the credential between validation and reservation.
              reserveMcpCredential(threadId, existing.providerSessionId);
              const rawToken = existing.authorizationHeader.replace(/^Bearer\s+/, "");
              const resolved = yield* mcpSessionRegistry
                .resolve(rawToken)
                .pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() =>
                      dropMcpCredentialReservation(threadId, existing.providerSessionId),
                    ),
                  ),
                );
              if (
                resolved !== undefined &&
                resolved.thread.threadId === threadId &&
                resolved.thread.providerInstanceId === providerInstanceId &&
                // Reuse binds the whole explicit policy, including owned Scient operations.
                resolved.capabilities.size === capabilities.size &&
                (!capabilities.has("skills:read") || resolved.skillScope !== undefined) &&
                [...capabilities].every((capability) => resolved.capabilities.has(capability))
              ) {
                return { mcpCredentialId: existing.providerSessionId, issued: false };
              }
              dropMcpCredentialReservation(threadId, existing.providerSessionId);
            }
            yield* mcpSessionRegistry.revokeThread(threadId);
            const credential = yield* mcpSessionRegistry.issue({
              threadId,
              providerInstanceId,
              browserToolsAvailable,
              capabilities,
              ...(capabilities.has("skills:read")
                ? {
                    skillScope: {
                      catalog: { status: "pending" as const },
                      releases: new Map(),
                      skills: [],
                    },
                  }
                : {}),
            });
            McpProviderSession.setMcpProviderSession(credential.config);
            reserveMcpCredential(threadId, credential.config.providerSessionId);
            return { mcpCredentialId: credential.config.providerSessionId, issued: true };
          }),
        );
      /**
       * With a credential id, revocation is scoped to that credential and the
       * config slot is cleared only while it still holds it; a replacement
       * session's newer credential survives. Without one (attach failed before
       * a credential was recorded), fall back to thread-wide revocation.
       */
      const clearMcpSession = (threadId: ThreadId, mcpCredentialId?: string) =>
        mcpCredentialId === undefined
          ? mcpSessionRegistry
              .revokeThread(threadId)
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
                ),
              )
          : mcpSessionRegistry.revokeProviderSession(mcpCredentialId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (
                    McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId ===
                    mcpCredentialId
                  ) {
                    McpProviderSession.clearMcpProviderSession(threadId);
                  }
                }),
              ),
            );

      // Transfer a failed/released owner's cleanup to the remaining exact-token
      // holders. The last reservation reclaims it unless a live entry took over.
      const reclaimUnusedMcpCredential = (
        threadId: ThreadId,
        mcpCredentialId: string,
        requestRevocation: boolean,
      ) =>
        mcpPrepareLock.withLock(
          threadId,
          Effect.gen(function* () {
            const key = mcpReservationKey(threadId, mcpCredentialId);
            const reservation = mcpCredentialReservations.get(key);
            if ((reservation?.count ?? 0) > 0) {
              if (requestRevocation && reservation !== undefined)
                mcpCredentialReservations.set(key, { ...reservation, revocationPending: true });
              return;
            }
            const current = yield* Ref.get(sessions);
            const heldByLiveEntry = Array.from(current.values()).some(
              (entry) => entry.mcpCredentialIdByThread.get(threadId) === mcpCredentialId,
            );
            if (!heldByLiveEntry && (requestRevocation || reservation?.revocationPending))
              yield* clearMcpSession(threadId, mcpCredentialId);
            mcpCredentialReservations.delete(key);
          }),
        );

      const publishToSubscribers = (
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        signal: ProviderSessionEventSignal,
      ) =>
        Ref.get(subscribers).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.values(), (queue) => Queue.offer(queue, signal), {
              discard: true,
            }),
          ),
        );

      const failSubscribers = (entry: LiveSessionEntry, detail: string) =>
        Effect.gen(function* () {
          const error = new ProviderAdapterEventStreamError({
            driver: entry.runtime.driver,
            providerSessionId: entry.runtime.providerSessionId,
            cause: detail,
          });
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) =>
              Queue.offer(queue, {
                type: "failure",
                cause: Cause.fail(error),
              }),
            { discard: true },
          );
        });

      const closeSubscribers = (entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) => Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue))),
            { discard: true },
          );
        });

      // Preserve already-published terminal events while ending subscriptions.
      // Server shutdown intentionally clears them; a provider-announced Stop
      // must let consumers drain them before the stream completes.
      const endSubscribers = (entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(subscribers.values(), (queue) => Queue.end(queue), {
            discard: true,
          });
        });

      const cancelIdleFiber = (fiber: Fiber.Fiber<void, never> | null) =>
        fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);

      const writeProviderSessionEvents = (input: {
        readonly runtime: ProviderAdapterV2SessionRuntime;
        readonly threadIds: Iterable<ThreadId>;
        readonly type: "provider-session.attached" | "provider-session.updated";
        readonly payload: OrchestrationV2ProviderSession;
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events = yield* Effect.forEach(input.threadIds, (threadId) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId: input.runtime.providerSessionId,
                }),
                type: input.type,
                threadId,
                driver: input.runtime.driver,
                providerInstanceId: input.runtime.instanceId,
                occurredAt: now,
                payload: input.payload,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          if (events.length > 0) {
            yield* eventSink.write({ events });
          }
        });

      const writeReleasedSessionEvents = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const payload: OrchestrationV2ProviderSession = {
            ...input.entry.runtime.providerSession,
            status: releaseStatusFor(input.reason),
            updatedAt: now,
            lastError:
              input.reason === "runtime_error"
                ? (input.detail ?? "Provider runtime failed.")
                : null,
          };
          yield* writeProviderSessionEvents({
            runtime: input.entry.runtime,
            threadIds: input.entry.attachedThreadIds,
            type: "provider-session.updated",
            payload,
          });
        });

      const writeReleasedRuntimeRequestEvents = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        /** Requests created later belong to a replacement session with the same id. */
        readonly releasedAt: DateTime.Utc;
      }) =>
        Effect.gen(function* () {
          const providerSessionId = input.entry.runtime.providerSessionId;
          const now = yield* DateTime.now;
          const status = releasedRuntimeRequestStatusFor(input.reason);
          const reason =
            input.reason === "runtime_error"
              ? "Provider session failed before this runtime request was resolved."
              : "Provider session was closed before this runtime request was resolved.";

          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const threadId of input.entry.attachedThreadIds) {
            const projection = yield* projectionStore.getThreadRecords(
              threadId,
              ["runtimeRequests", "nodes", "turnItems"],
              { turnItemTypes: ["approval_request", "user_input_request"] },
            );
            const releasedRequests = projection.runtimeRequests.filter(
              (request) =>
                request.status === "pending" &&
                request.responseCapability.type === "live" &&
                request.responseCapability.providerSessionId === providerSessionId &&
                DateTime.isLessThanOrEqualTo(request.createdAt, input.releasedAt),
            );

            for (const request of releasedRequests) {
              events.push({
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId,
                }),
                type: "runtime-request.updated",
                threadId,
                nodeId: request.nodeId,
                driver: input.entry.runtime.driver,
                occurredAt: now,
                payload: {
                  ...request,
                  status,
                  responseCapability: {
                    type: "not_resumable",
                    reason,
                  },
                  resolvedAt: now,
                },
              });

              const requestNode = projection.nodes.find((node) => node.id === request.nodeId);
              if (requestNode !== undefined) {
                events.push({
                  id: yield* idAllocator.allocate.event({
                    threadId,
                    providerSessionId,
                  }),
                  type: "node.updated",
                  threadId,
                  ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
                  nodeId: requestNode.id,
                  driver: input.entry.runtime.driver,
                  occurredAt: now,
                  payload: {
                    ...requestNode,
                    status: input.reason === "runtime_error" ? "failed" : "cancelled",
                    completedAt: now,
                  },
                });
              }

              const turnItem = projection.turnItems.find(
                (item) =>
                  (item.type === "approval_request" || item.type === "user_input_request") &&
                  item.requestId === request.id,
              );
              if (turnItem !== undefined) {
                events.push({
                  id: yield* idAllocator.allocate.event({
                    threadId,
                    providerSessionId,
                  }),
                  type: "turn-item.updated",
                  threadId,
                  ...(turnItem.runId === null ? {} : { runId: turnItem.runId }),
                  ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
                  driver: input.entry.runtime.driver,
                  occurredAt: now,
                  payload: {
                    ...turnItem,
                    status: input.reason === "runtime_error" ? "failed" : "cancelled",
                    completedAt: now,
                    updatedAt: now,
                  },
                });
              }
            }
          }

          if (events.length > 0) {
            yield* eventSink.write({ events });
          }
        });

      // SCIENT-FORK: abandonment belongs to the exact canonical consumer.
      const releaseEventConsumer = disposeRetiredEventConsumer;

      // SCIENT-FORK: captured data callbacks retain the existing physical/logical close order.
      const closeRetiringEntry = makeSessionRetirement({
        closeTimeoutMs: RELEASE_SCOPE_CLOSE_TIMEOUT_MS,
        reclaimCredential: (threadId, credentialId) =>
          reclaimUnusedMcpCredential(threadId, credentialId, true),
        closeScope: closeOwnedScope,
        cancelIdle: cancelIdleFiber,
        endSubscribers,
        closeSubscribers,
        failSubscribers,
        releaseConsumer: releaseEventConsumer,
        writeSession: (
          entry: LiveSessionEntry,
          input: ReleaseEntryInput & { readonly releasedAt: DateTime.Utc },
        ) =>
          writeReleasedSessionEvents({
            entry,
            reason: input.reason,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          }),
        writeRequests: (
          entry: LiveSessionEntry,
          input: ReleaseEntryInput & { readonly releasedAt: DateTime.Utc },
        ) =>
          writeReleasedRuntimeRequestEvents({
            entry,
            reason: input.reason,
            releasedAt: input.releasedAt,
          }),
      });

      const awaitClosingEntry = Effect.fnUntraced(function* (
        owner: ClosingSessionEntry,
        firstRecordsAttempt?: ClosingSessionEntry["firstRecordsAttempt"],
      ) {
        // First persistence and physical cleanup share one public waiter budget.
        const completion =
          firstRecordsAttempt === undefined
            ? Fiber.join(owner.operation)
            : Deferred.await(firstRecordsAttempt).pipe(
                Effect.flatMap((firstRecords) =>
                  Exit.isFailure(firstRecords)
                    ? Effect.succeed(firstRecords)
                    : Fiber.join(owner.operation),
                ),
              );
        const result = yield* completion.pipe(Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS));
        if (Option.isNone(result))
          return yield* new ProviderSessionReleaseError({
            providerSessionId: owner.entry.runtime.providerSessionId,
            reason: owner.reason,
            cause:
              "The exact native close is still pending; replacement or credential changes require its completion.",
          });
        if (Exit.isFailure(result.value))
          return yield* new ProviderSessionReleaseError({
            providerSessionId: owner.entry.runtime.providerSessionId,
            reason: owner.reason,
            cause: result.value.cause,
          });
      });

      const releaseEntry = (input: ReleaseEntryInput) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const key = sessionKey(input.providerSessionId);
            const prior = closingSessions.get(key);
            if (prior !== undefined) {
              if (
                input.expectedRuntime !== undefined &&
                prior.entry.runtime !== input.expectedRuntime
              )
                return;
              return yield* restore(awaitClosingEntry(prior));
            }
            const candidate = (yield* Ref.get(sessions)).get(key);
            if (
              candidate === undefined ||
              (input.expectedRuntime !== undefined && candidate.runtime !== input.expectedRuntime)
            )
              return;
            const begin = yield* Deferred.make<void>();
            const firstRecordsAttempt = yield* Deferred.make<Exit.Exit<void, unknown>>();
            let captured = candidate;
            let releasedAt = yield* DateTime.now;
            const operation = yield* Deferred.await(begin).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  closeRetiringEntry(captured, {
                    ...input,
                    releasedAt,
                    onFirstRecordsAttempt: (exit) =>
                      Deferred.succeed(firstRecordsAttempt, exit).pipe(Effect.asVoid),
                  }).pipe(
                    withMetrics({
                      counter: providerSessionsTotal,
                      attributes: {
                        provider: captured.runtime.driver,
                        operation: "release",
                        reason: input.reason,
                      },
                    }),
                  ),
                ),
              ),
              Effect.exit,
              Effect.tap((result) =>
                Deferred.succeed(firstRecordsAttempt, result).pipe(
                  Effect.asVoid,
                  Effect.andThen(
                    Effect.sync(() => {
                      const current = closingSessions.get(key);
                      if (
                        current?.entry.runtime !== captured.runtime ||
                        current.entry.scope !== captured.scope
                      )
                        return;
                      if (Exit.isFailure(result)) current.state = "failed";
                      else closingSessions.delete(key);
                    }),
                  ),
                ),
              ),
              Effect.forkDetach({ startImmediately: true }),
            );
            const owner: ClosingSessionEntry = {
              entry: candidate,
              reason: input.reason,
              state: "pending",
              operation,
              firstRecordsAttempt,
            };
            const reserveMutation = Ref.modify(sessions, (current) => {
              const existing = current.get(key);
              if (
                existing?.runtime !== candidate.runtime ||
                existing.scope !== candidate.scope ||
                releasingRuntimes.has(existing.runtime)
              )
                return [false, current] as const;
              if (
                input.onlyIfIdleGeneration !== undefined &&
                (existing.busyTurns.size > 0 ||
                  existing.idleGeneration !== input.onlyIfIdleGeneration)
              )
                return [false, current] as const;
              // SCIENT-FORK:START — a pending canonical start declines idle retirement.
              if (
                input.onlyIfIdleGeneration !== undefined &&
                startupReservations.declinesIdleRetirement(input.providerSessionId, existing)
              )
                return [false, current] as const;
              // SCIENT-FORK:END
              captured = existing;
              owner.entry = existing;
              // Queryable ownership is installed in the short generation handoff,
              // before logical removal and before restoring waiter interruption.
              closingSessions.set(key, owner);
              releasingRuntimes.add(existing.runtime);
              return [true, current] as const;
            });
            const reserve =
              candidate.runtime.textSnapshots === undefined
                ? reserveMutation
                : textSnapshotRegistry.permit.withPermit(
                    reserveMutation.pipe(
                      Effect.tap((reserved) =>
                        reserved ? textSnapshotRegistry.retire(candidate.runtime) : Effect.void,
                      ),
                    ),
                  );
            const invalidation = yield* (
              candidate.runtime.invalidateInitiatedWork === undefined
                ? reserve
                : candidate.runtime.invalidateInitiatedWork(reserve)
            ).pipe(Effect.exit);
            if (closingSessions.get(key) !== owner) {
              operation.interruptUnsafe();
              const concurrent = closingSessions.get(key);
              if (
                concurrent?.entry.runtime === candidate.runtime &&
                concurrent.entry.scope === candidate.scope
              )
                return yield* restore(awaitClosingEntry(concurrent));
              if (Exit.isFailure(invalidation))
                return yield* new ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: input.reason,
                  cause: invalidation.cause,
                });
              return;
            }
            yield* candidate.requestEventPermit.withPermits(1)(
              Effect.gen(function* () {
                yield* Ref.update(sessions, (current) => {
                  const existing = current.get(key);
                  if (existing?.runtime !== captured.runtime || existing.scope !== captured.scope)
                    return current;
                  captured = existing;
                  owner.entry = existing;
                  const updated = new Map(current);
                  updated.delete(key);
                  return updated;
                });
                releasedAt = yield* DateTime.now;
              }),
            );
            // Physical cleanup starts only after the generation permit is released.
            yield* Deferred.succeed(begin, undefined);
            if (Exit.isFailure(invalidation))
              return yield* new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
                cause: invalidation.cause,
              });
            return yield* restore(awaitClosingEntry(owner, owner.firstRecordsAttempt));
          }),
        );

      // Annotated to break the releaseIfStillIdle <-> scheduleIdleReleaseInternal
      // inference cycle introduced by the pin re-arm below.
      const releaseIfStillIdle = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly generation: number;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.runtime !== input.expectedRuntime ||
            entry.busyTurns.size > 0 ||
            entry.idleGeneration !== input.generation
          ) {
            return;
          }
          // Capture runtime identity before yielding: a replacement session
          // can reuse the same providerSessionId while this fiber is parked.
          const probedRuntime = entry.runtime;
          const hasPendingWork =
            probedRuntime.hasPendingBackgroundWork === undefined
              ? false
              : yield* probedRuntime.hasPendingBackgroundWork.pipe(
                  Effect.catchCause(() => Effect.succeed(false)),
                );
          if (hasPendingWork) {
            const now = yield* Clock.currentTimeMillis;
            const pinnedSinceMs = entry.pinnedSinceMs ?? now;
            if (now - pinnedSinceMs < maxIdlePinMs) {
              const shouldContinuePin = yield* Ref.modify(sessions, (latest) => {
                const latestEntry = latest.get(key);
                if (
                  latestEntry === undefined ||
                  latestEntry.busyTurns.size > 0 ||
                  latestEntry.idleGeneration !== input.generation ||
                  latestEntry.runtime !== probedRuntime
                ) {
                  return [false, latest] as const;
                }
                const updated = new Map(latest);
                updated.set(key, { ...latestEntry, pinnedSinceMs });
                return [true, updated] as const;
              });
              if (!shouldContinuePin) {
                // Generation or runtime advanced while we probed pending work;
                // the current owner of the entry owns idle release.
                return;
              }
              yield* Effect.logInfo("orchestration-v2.driver-session.idle-release-deferred", {
                providerSessionId: input.providerSessionId,
                pinnedForMs: now - pinnedSinceMs,
              });
              // Re-check on this fiber after another idle window. Do not call
              // scheduleIdleReleaseInternal: that cancels entry.idleFiber, which
              // is this fiber, and can self-deadlock on Fiber.interrupt.
              yield* Effect.sleep(Duration.millis(idleTimeoutMs));
              return yield* releaseIfStillIdle(input);
            }
            yield* Effect.logWarning("orchestration-v2.driver-session.idle-release-pin-expired", {
              providerSessionId: input.providerSessionId,
              pinnedForMs: now - pinnedSinceMs,
            });
          }
          // hasPendingBackgroundWork yields to the adapter, so the idle
          // decision above can go stale; the generation guard revalidates

          yield* releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: "idle_timeout",
            cancelIdleFiber: false,
            onlyIfIdleGeneration: input.generation,
            expectedRuntime: input.expectedRuntime,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.idle-release-failed", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        });

      const withActivityError = <A, E, R>(
        providerSessionId: ProviderSessionId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, ProviderSessionActivityError, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionActivityError({
                providerSessionId,
                cause,
              }),
            ),
          ),
        );

      const scheduleIdleReleaseInternal = (providerSessionId: ProviderSessionId) =>
        Effect.gen(function* () {
          const key = sessionKey(providerSessionId);
          const current = yield* Ref.get(sessions);
          const entry = current.get(key);
          if (entry === undefined || entry.busyTurns.size > 0) {
            return;
          }

          yield* cancelIdleFiber(entry.idleFiber);
          const generation = entry.idleGeneration + 1;
          const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(
              releaseIfStillIdle({ providerSessionId, generation, expectedRuntime: entry.runtime }),
            ),
            Effect.forkIn(layerScope),
          );
          const lastActivityAtMs = yield* Clock.currentTimeMillis;
          yield* Ref.update(sessions, (latest) => {
            const latestEntry = latest.get(key);
            if (
              latestEntry === undefined ||
              latestEntry.runtime !== entry.runtime ||
              latestEntry.busyTurns.size > 0
            ) {
              return latest;
            }
            const updated = new Map(latest);
            updated.set(key, {
              ...latestEntry,
              idleGeneration: generation,
              idleFiber,
              lastActivityAtMs,
            });
            return updated;
          });
        });

      const scheduleIdleRelease = (providerSessionId: ProviderSessionId) =>
        withActivityError(providerSessionId, scheduleIdleReleaseInternal(providerSessionId));

      // SCIENT-FORK:START — a pending canonical start keeps its session out of idle release.
      const startupReservations = makeStartupSessionReservations({
        sessions,
        sessionKey,
        isReleasing: (runtime) => releasingRuntimes.has(runtime),
        cancelIdleFiber,
        forkIdleTimer: (input) =>
          Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(releaseIfStillIdle(input)),
            Effect.forkIn(layerScope),
          ),
      });
      // SCIENT-FORK:END

      const touchActivity = (providerSessionId: ProviderSessionId) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(sessionKey(providerSessionId));
              if (entry === undefined) {
                return current;
              }
              const updated = new Map(current);
              updated.set(sessionKey(providerSessionId), {
                ...entry,
                lastActivityAtMs,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
          }),
        );

      /** Returns the runtime the thread was attached to, or undefined if it already was. */
      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (entry === undefined || entry.attachedThreadIds.has(input.threadId)) {
              return [undefined, current] as const;
            }
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return [entry.runtime, updated] as const;
          }),
        );

      /**
       * Undoes an attach to `runtime`. A replacement session that reopened under
       * the same id since is left alone.
       */
      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.runtime !== input.runtime ||
            !entry.attachedThreadIds.has(input.threadId)
          ) {
            return current;
          }
          const attachedThreadIds = new Set(entry.attachedThreadIds);
          attachedThreadIds.delete(input.threadId);
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.delete(input.threadId);
          const updated = new Map(current);
          updated.set(key, {
            ...entry,
            attachedThreadIds,
            loadedProviderThreadKeyByThread,
          });
          return updated;
        });

      const isProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
      }) =>
        Ref.get(sessions).pipe(
          Effect.map(
            (current) =>
              current
                .get(sessionKey(input.providerSessionId))
                ?.loadedProviderThreadKeyByThread.get(input.threadId) === input.providerThreadKey,
          ),
        );

      const markProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) {
            return current;
          }
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.set(input.threadId, input.providerThreadKey);
          const updated = new Map(current);
          updated.set(key, { ...entry, loadedProviderThreadKeyByThread });
          return updated;
        });

      const ensureThreadAttached = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
      }) =>
        Effect.suspend(() => {
          let attachedTo: ProviderAdapterV2SessionRuntime | undefined;
          let preparedForCleanup: PreparedMcpCredential | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && preparedForCleanup?.mcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, preparedForCleanup.mcpCredentialId);
            }
          };
          // The whole attach, including undoing a failed one, holds the
          // thread's lock: a concurrent attach of the same thread waits, so it
          // never sees an attachment that this call is about to roll back.
          const attach = Effect.gen(function* () {
            const attached = yield* attachThread(input).pipe(
              // Recorded with no gap for an interrupt: cleanup undoes only an
              // attach this call made, never one an earlier open made.
              Effect.tap((runtime) => Effect.sync(() => (attachedTo = runtime))),
              Effect.uninterruptible,
            );
            if (attached) {
              const attachedEntry = (yield* Ref.get(sessions)).get(
                sessionKey(input.providerSessionId),
              );
              if (attachedEntry === undefined) return;
              const prepared = yield* prepareMcpSession(
                input.threadId,
                input.providerInstanceId,
                attachedEntry.exposedRuntime,
              );
              preparedForCleanup = prepared;
              if (prepared.mcpCredentialId !== undefined) {
                const mcpCredentialId = prepared.mcpCredentialId;
                yield* Ref.update(sessions, (current) => {
                  const key = sessionKey(input.providerSessionId);
                  const entry = current.get(key);
                  if (entry === undefined) return current;
                  const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
                  mcpCredentialIdByThread.set(input.threadId, mcpCredentialId);
                  const updated = new Map(current);
                  updated.set(key, { ...entry, mcpCredentialIdByThread });
                  return updated;
                });
              }
              const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
              if (entry !== undefined) {
                yield* withActivityError(
                  input.providerSessionId,
                  writeProviderSessionEvents({
                    runtime: entry.runtime,
                    threadIds: [input.threadId],
                    type: "provider-session.attached",
                    payload: entry.runtime.providerSession,
                  }),
                );
              }
            }
          }).pipe(
            // An interrupted attach is undone too, so the next attach writes
            // the attachment instead of finding the thread already attached.
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? attachedTo === undefined
                  ? Effect.void
                  : removeThreadAttachment({ ...input, runtime: attachedTo }).pipe(
                      Effect.andThen(
                        Effect.suspend(() => {
                          dropReservation();
                          // Revoke only a credential this attach freshly minted: a
                          // REUSED credential is by definition held by another
                          // live provider process, and revoking it thread-wide
                          // would break that process's MCP client mid-conversation.
                          if (preparedForCleanup?.issued !== true) return Effect.void;
                          const mcpCredentialId = preparedForCleanup.mcpCredentialId;
                          const attachedRuntime = attachedTo;
                          // As in release: a replacement session (or an open
                          // configuring one) may have taken the credential up.
                          return Ref.get(sessions).pipe(
                            Effect.flatMap((current) =>
                              (mcpCredentialId !== undefined &&
                                isMcpCredentialReserved(input.threadId, mcpCredentialId)) ||
                              Array.from(current.values()).some(
                                (other) =>
                                  other.runtime !== attachedRuntime &&
                                  (other.attachedThreadIds.has(input.threadId) ||
                                    (mcpCredentialId !== undefined &&
                                      other.mcpCredentialIdByThread.get(input.threadId) ===
                                        mcpCredentialId)),
                              )
                                ? Effect.void
                                : clearMcpSession(input.threadId, mcpCredentialId),
                            ),
                          );
                        }),
                      ),
                    )
                : Effect.void,
            ),
          );
          return threadAttachment.withLock(threadAttachmentKey(input), attach).pipe(
            // The entry's own record (written above while the thread is
            // attached) guards the credential from here on; the reservation
            // is only needed until then. Ensuring covers defects/interrupts.
            Effect.ensuring(Effect.sync(dropReservation)),
          );
        });

      const markBusy = (providerSessionId: ProviderSessionId, turnKey: string) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const idleFiber = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return [null, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns: new Set(entry.busyTurns).add(turnKey),
                idleFiber: null,
                lastActivityAtMs: now,
                pinnedSinceMs: null,
              });
              return [entry.idleFiber, updated] as const;
            });
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      // Clearing a turn that is not marked busy (one whose failed start already
      // cleared it, or a subagent turn the manager never started) only
      // records activity.
      const markIdle = (
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
        runOrdinal: number,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return current;
              }
              const busyTurns = new Set(entry.busyTurns);
              busyTurns.delete(busyTurnKey(providerThreadId, runOrdinal));
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns,
                lastActivityAtMs: now,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
            yield* scheduleThreadUnload(providerSessionId, providerThreadId);
          }),
        );

      const hasBusyTurn = (entry: LiveSessionEntry, providerThreadId: ProviderThreadId) => {
        const prefix = busyTurnPrefix(providerThreadId);
        for (const turnKey of entry.busyTurns) {
          if (turnKey.startsWith(prefix)) return true;
        }
        return false;
      };

      const updateIdleThreadUnload = (
        providerSessionId: ProviderSessionId,
        threadId: ThreadId,
        update: (current: IdleThreadUnload | undefined) => IdleThreadUnload | undefined,
      ) =>
        Ref.modify(sessions, (current) => {
          const key = sessionKey(providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) return [undefined, current] as const;
          const previous = entry.idleThreadUnloads.get(threadId);
          const next = update(previous);
          const idleThreadUnloads = new Map(entry.idleThreadUnloads);
          if (next === undefined) idleThreadUnloads.delete(threadId);
          else idleThreadUnloads.set(threadId, next);
          const updated = new Map(current);
          updated.set(key, { ...entry, idleThreadUnloads });
          return [previous, updated] as const;
        });

      /**
       * Starts tracking the provider thread an app thread runs its turns on, and
       * stops any unload pending for it. Called before the thread is resumed or
       * given a turn, so an unload cannot land between a resume that found the
       * thread loaded and the turn that relies on it.
       */
      const holdThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
      }) =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
          if (
            entry === undefined ||
            !entry.supportsMultipleProviderThreads ||
            entry.exposedRuntime.unloadThread === undefined ||
            input.providerThread.nativeThreadRef === null
          ) {
            return;
          }
          const previous = yield* updateIdleThreadUnload(
            input.providerSessionId,
            input.threadId,
            (current) => ({
              providerThread: input.providerThread,
              generation: (current?.generation ?? 0) + 1,
              fiber: null,
            }),
          );
          yield* cancelIdleFiber(previous?.fiber ?? null);
        });

      /**
       * A shared runtime never goes idle while any of its threads is in use, so
       * its threads get the idle timeout one by one: a thread with no turn for
       * `idleTimeoutMs` is unloaded from the runtime, along with the native MCP
       * servers it started. Its next turn's resume loads it again.
       */
      const scheduleThreadUnload = (
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
      ) =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
          if (entry === undefined || hasBusyTurn(entry, providerThreadId)) return;
          const tracked = Array.from(entry.idleThreadUnloads).find(
            ([, pending]) => pending.providerThread.id === providerThreadId,
          );
          if (tracked === undefined) return;
          const [threadId, pending] = tracked;
          const generation = pending.generation + 1;
          const fiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(
              unloadIdleThread({
                providerSessionId,
                threadId,
                generation,
                expectedRuntime: entry.runtime,
              }),
            ),
            Effect.forkIn(layerScope),
          );
          // A turn that started meanwhile already moved the generation on.
          const previous = yield* updateIdleThreadUnload(providerSessionId, threadId, (current) =>
            current?.generation === pending.generation
              ? { ...current, generation, fiber }
              : current,
          );
          yield* cancelIdleFiber(
            previous?.generation === pending.generation ? previous.fiber : fiber,
          );
        });

      const unloadIdleThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly generation: number;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const outcome = yield* threadAttachment.withLock(
            threadAttachmentKey(input),
            Effect.gen(function* () {
              const key = sessionKey(input.providerSessionId);
              const entry = (yield* Ref.get(sessions)).get(key);
              const pending = entry?.idleThreadUnloads.get(input.threadId);
              const unloadThread = entry?.exposedRuntime.unloadThread;
              if (
                entry === undefined ||
                // SCIENT-FORK:START — an idle timer never unloads a replacement native owner.
                entry.runtime !== input.expectedRuntime ||
                releasingRuntimes.has(entry.runtime) ||
                // SCIENT-FORK:END
                pending === undefined ||
                pending.generation !== input.generation ||
                unloadThread === undefined ||
                !entry.attachedThreadIds.has(input.threadId) ||
                hasBusyTurn(entry, pending.providerThread.id)
              ) {
                return "skipped" as const;
              }
              // Unloading stops the native thread's background terminals, so a
              // thread still running background work stays loaded.
              const hasPendingWork =
                entry.runtime.hasPendingBackgroundWorkForThread === undefined
                  ? false
                  : yield* entry.runtime
                      .hasPendingBackgroundWorkForThread(pending.providerThread)
                      .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) return "deferred" as const;
              const unloading = yield* Ref.modify(sessions, (current) => {
                const latest = current.get(key);
                if (
                  latest?.runtime !== entry.runtime ||
                  latest.idleThreadUnloads.get(input.threadId)?.generation !== input.generation
                ) {
                  return [false, current] as const;
                }
                const loadedProviderThreadKeyByThread = new Map(
                  latest.loadedProviderThreadKeyByThread,
                );
                loadedProviderThreadKeyByThread.delete(input.threadId);
                const idleThreadUnloads = new Map(latest.idleThreadUnloads);
                idleThreadUnloads.delete(input.threadId);
                const updated = new Map(current);
                updated.set(key, {
                  ...latest,
                  loadedProviderThreadKeyByThread,
                  idleThreadUnloads,
                });
                return [true, updated] as const;
              });
              if (!unloading) return "skipped" as const;
              yield* unloadThread({ providerThread: pending.providerThread }).pipe(
                Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                Effect.catchCause((cause) =>
                  Effect.logWarning("orchestration-v2.driver-session.idle-unload-failed", {
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerThreadId: pending.providerThread.id,
                    cause,
                  }),
                ),
              );
              return "unloaded" as const;
            }),
          );
          // Re-check on this fiber after another idle window, outside the
          // lock so the thread's next attach is not held up meanwhile.
          if (outcome === "deferred") {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            return yield* unloadIdleThread(input);
          }
        });

      const observeActivity = (
        providerSessionId: ProviderSessionId,
        activity: Effect.Effect<void, ProviderSessionActivityError>,
      ) =>
        activity.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
              providerSessionId,
              cause,
            }),
          ),
        );

      const makeEventSubscription = (
        runtime: ProviderAdapterV2SessionRuntime,
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
      ): Effect.Effect<ProviderTextSnapshotSubscription> =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderSessionEventSignal, Cause.Done>();
          const subscriberId = yield* Ref.getAndUpdate(nextSubscriberId, (value) => value + 1);
          yield* Ref.update(subscribers, (current) => {
            const updated = new Map(current);
            updated.set(subscriberId, queue);
            return updated;
          });
          const removeSubscription = Ref.modify(subscribers, (current) => {
            if (!current.has(subscriberId)) {
              return [false, current] as const;
            }
            const updated = new Map(current);
            updated.delete(subscriberId);
            return [true, updated] as const;
          }).pipe(
            Effect.flatMap((removed) =>
              removed
                ? Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
                : Effect.void,
            ),
          );
          const close = Effect.uninterruptible(
            Effect.gen(function* () {
              // SCIENT-FORK: end this subscriber's running-fork text consumer first.
              const endingSnapshots = textSnapshotRegistry.endConsumer(subscriberId);
              if (endingSnapshots !== undefined) yield* endingSnapshots;
              yield* removeSubscription;
            }),
          );
          const events = Stream.fromQueue(queue).pipe(
            Stream.mapEffect((signal) =>
              signal.type === "event"
                ? Effect.succeed(signal.event)
                : Effect.failCause(signal.cause),
            ),
            Stream.ensuring(close),
          );
          return {
            events: events.pipe(
              Stream.filter(
                (event): event is ProviderAdapterV2Event => event.type !== "internal.text_snapshot",
              ),
            ),
            snapshotEvents: events,
            // SCIENT-FORK: running-fork text consumer bound to this exact subscriber.
            textSnapshotConsumer: textSnapshotRegistry.consumer(subscriberId, runtime, queue),
            close,
          } satisfies ProviderTextSnapshotSubscription;
        });

      const decorateRuntime = (
        runtime: ProviderAdapterV2SessionRuntime,
        mcpSessionInjection: boolean,
        eventSubscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        sessionScope: Scope.Closeable,
      ): ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        const subscribeEvents = makeEventSubscription(runtime, eventSubscribers);
        const subscriberRuntime = { ...runtime };
        delete subscriberRuntime.eventConsumer;
        delete subscriberRuntime.textSnapshots;
        // Every provider's turn operations pass through here, so this is where they are
        // counted. Only turn starts are timed: until the provider accepts the turn.
        const turnMetrics = (operation: string, model?: string) =>
          withMetrics({
            counter: providerTurnsTotal,
            ...(operation === "send" ? { timer: providerTurnDuration } : {}),
            attributes: {
              provider: runtime.driver,
              operation,
              modelFamily: normalizeModelMetricLabel(model),
            },
          });
        return {
          ...subscriberRuntime,
          mcpSessionInjection,
          subscribeTextSnapshotEvents: subscribeEvents,
          subscribeEvents: subscribeEvents.pipe(
            Effect.map(({ events, close }) => ({ events, close })),
          ),
          events: Stream.unwrap(
            subscribeEvents.pipe(Effect.map((subscription) => subscription.events)),
          ),
          ensureThread: (input) =>
            observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId: input.threadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
              Effect.andThen(
                claimPiFile(
                  sessionScope,
                  runtime.driver,
                  input.existingProviderThread?.nativeThreadRef?.nativeId,
                ),
              ),
              Effect.andThen(runtime.ensureThread(input)),
              Effect.tap((thread) =>
                claimPiFile(sessionScope, runtime.driver, thread.nativeThreadRef?.nativeId),
              ),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId: input.threadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    modelSelection: input.modelSelection,
                    runtimePolicy: input.runtimePolicy,
                  }),
                }),
              ),
            ),
          resumeThread: (input) => {
            const threadId = input.threadId ?? input.providerThread.appThreadId;
            if (threadId === null || threadId === undefined) {
              return runtime.resumeThread(input);
            }
            const providerThreadKey = providerThreadLoadKey({
              providerThread: input.providerThread,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
            });
            return claimPiFile(
              sessionScope,
              runtime.driver,
              input.providerThread.nativeThreadRef?.nativeId,
            )
              .pipe(
                // SCIENT-FORK:START — invalidate idle unloading before waiting for its attach lock.
                Effect.andThen(
                  holdThreadLoaded({
                    providerSessionId,
                    threadId,
                    providerThread: input.providerThread,
                  }),
                ),
                // SCIENT-FORK:END
                Effect.andThen(
                  observeActivity(
                    providerSessionId,
                    ensureThreadAttached({
                      providerSessionId,
                      threadId,
                      providerInstanceId: runtime.instanceId,
                    }),
                  ),
                ),
              )
              .pipe(
                Effect.andThen(
                  isProviderThreadLoaded({ providerSessionId, threadId, providerThreadKey }),
                ),
                Effect.flatMap((loaded) =>
                  loaded ? Effect.succeed(input.providerThread) : runtime.resumeThread(input),
                ),
                Effect.tap((providerThread) =>
                  markProviderThreadLoaded({
                    providerSessionId,
                    threadId,
                    providerThreadKey: providerThreadLoadKey({
                      providerThread,
                      ...(input.modelSelection === undefined
                        ? {}
                        : { modelSelection: input.modelSelection }),
                      ...(input.runtimePolicy === undefined
                        ? {}
                        : { runtimePolicy: input.runtimePolicy }),
                    }),
                  }),
                ),
              );
          },
          forkThread: (input) =>
            observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId: input.targetThreadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
              Effect.andThen(runtime.forkThread(input)),
              Effect.tap((thread) =>
                claimPiFile(sessionScope, runtime.driver, thread.nativeThreadRef?.nativeId),
              ),
              Effect.tap((providerThread) =>
                markProviderThreadLoaded({
                  providerSessionId,
                  threadId: input.targetThreadId,
                  providerThreadKey: providerThreadLoadKey({
                    providerThread,
                    ...(input.modelSelection === undefined
                      ? {}
                      : { modelSelection: input.modelSelection }),
                    ...(input.runtimePolicy === undefined
                      ? {}
                      : { runtimePolicy: input.runtimePolicy }),
                  }),
                }),
              ),
            ),
          startTurn: (input) =>
            // SCIENT-FORK:START — cancel pending unloads before attach; in-flight unloads own the lock.
            holdThreadLoaded({
              providerSessionId,
              threadId: input.threadId,
              providerThread: input.providerThread,
            }).pipe(
              Effect.andThen(
                observeActivity(
                  providerSessionId,
                  ensureThreadAttached({
                    providerSessionId,
                    threadId: input.threadId,
                    providerInstanceId: runtime.instanceId,
                  }),
                ),
              ),
              // SCIENT-FORK:END
              Effect.andThen(
                claimPiFile(
                  sessionScope,
                  runtime.driver,
                  input.providerThread.nativeThreadRef?.nativeId,
                ),
              ),
              // A start that fails or is stopped may never emit turn.terminal,
              // so it clears its own turn or the session never goes idle. If
              // the adapter emits the terminal anyway, clearing the same turn
              // again changes nothing, so another thread's turn on a shared
              // session stays busy either way.
              Effect.andThen(
                Effect.acquireUseRelease(
                  observeActivity(
                    providerSessionId,
                    markBusy(
                      providerSessionId,
                      busyTurnKey(input.providerThread.id, input.runOrdinal),
                    ),
                  ),
                  () =>
                    runtime
                      .startTurn({
                        ...input,
                        message: {
                          ...input.message,
                          text: expandComposerCitationsForProvider(input.message.text),
                        },
                      })
                      .pipe(turnMetrics("send", input.modelSelection.model)),
                  (_, exit) =>
                    Exit.isFailure(exit)
                      ? observeActivity(
                          providerSessionId,
                          markIdle(providerSessionId, input.providerThread.id, input.runOrdinal),
                        )
                      : Effect.void,
                ),
              ),
            ),
          steerTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime
                  .steerTurn({
                    ...input,
                    message: {
                      ...input.message,
                      text: expandComposerCitationsForProvider(input.message.text),
                    },
                  })
                  .pipe(turnMetrics("steer")),
              ),
            ),
          interruptTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                // SCIENT-FORK: preserve the pump/physical-close join outside native permits.
                interruptAndJoinRetirement({
                  runtime,
                  request: input,
                  readEntry: Ref.get(sessions).pipe(
                    Effect.map((entries) => entries.get(sessionKey(providerSessionId))),
                  ),
                  closeTimeoutMs: RELEASE_SCOPE_CLOSE_TIMEOUT_MS,
                  joinRetainedClose: () =>
                    Effect.suspend(() => {
                      const closing = closingSessions.get(sessionKey(providerSessionId));
                      return closing?.entry.runtime === runtime
                        ? awaitClosingEntry(closing)
                        : Effect.void;
                    }),
                }).pipe(turnMetrics("interrupt")),
              ),
            ),
          respondToRuntimeRequest: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime
                  .respondToRuntimeRequest(input)
                  .pipe(turnMetrics("runtime-request-response")),
              ),
            ),
        };
      };

      const persistProviderSessionUpdate = (
        entry: LiveSessionEntry,
        event: Extract<ProviderAdapterV2Event, { readonly type: "provider_session.updated" }>,
      ) =>
        Effect.gen(function* () {
          const current = (yield* Ref.get(sessions)).get(
            sessionKey(entry.runtime.providerSessionId),
          );
          if (current?.runtime !== entry.runtime) {
            return;
          }
          yield* writeProviderSessionEvents({
            runtime: entry.runtime,
            threadIds: current.attachedThreadIds,
            type: "provider-session.updated",
            payload: event.providerSession,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.status-persist-failed", {
              providerSessionId: entry.runtime.providerSessionId,
              cause,
            }),
          ),
        );

      const startEventPump = (entry: LiveSessionEntry) => {
        let stoppedByProvider = false;
        return (entry.runtime.textSnapshots?.events ?? entry.runtime.events).pipe(
          Stream.runForEach((event) => {
            if (shutdownSignal.received) return Effect.void;
            // SCIENT-FORK: running-fork text batches go only to their exact consumer.
            if (event.type === "internal.text_snapshot")
              return textSnapshotRegistry.route(entry.runtime, event);
            if (event.type === "authentication.invalidated") {
              // A single pump owns this observation, independently of run
              // subscribers. Never accept instance identity from the provider.
              return Effect.gen(function* () {
                const current = (yield* Ref.get(sessions)).get(
                  sessionKey(entry.runtime.providerSessionId),
                );
                if (current?.runtime !== entry.runtime || event.driver !== entry.runtime.driver)
                  return;
                yield* providerRegistry.setProviderAuthenticationFailure({
                  instanceId: entry.runtime.instanceId,
                  message: event.message,
                });
              });
            }
            if (
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped"
            ) {
              stoppedByProvider = true;
            }
            return observeActivity(
              entry.runtime.providerSessionId,
              event.type === "turn.terminal"
                ? markIdle(
                    entry.runtime.providerSessionId,
                    event.providerThreadId,
                    event.runOrdinal,
                  )
                : touchActivity(entry.runtime.providerSessionId),
            ).pipe(
              Effect.andThen(
                event.type === "provider_session.updated"
                  ? persistProviderSessionUpdate(entry, event)
                  : Effect.void,
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  // Some providers can block before a run subscriber exists
                  // (project trust, login, or session-switch hooks). Persist
                  // their runless request artifacts directly so the normal T3
                  // request UI can answer them and unblock session setup.
                  const threadId = sessionScopedRuntimeRequestThreadId(event);
                  if (threadId !== undefined) {
                    yield* Effect.gen(function* () {
                      const current = (yield* Ref.get(sessions)).get(
                        sessionKey(entry.runtime.providerSessionId),
                      );
                      if (current?.runtime !== entry.runtime) return;
                      yield* providerEventIngestor
                        .ingestNormalized({
                          providerSessionId: entry.runtime.providerSessionId,
                          providerInstanceId: entry.runtime.instanceId,
                          threadId,
                          event,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderAdapterEventStreamError({
                                driver: entry.runtime.driver,
                                providerSessionId: entry.runtime.providerSessionId,
                                cause,
                              }),
                          ),
                        );
                    }).pipe(entry.requestEventPermit.withPermits(1));
                    return;
                  }
                  yield* publishToSubscribers(entry.eventSubscribers, { type: "event", event });
                }),
              ),
            );
          }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              // A provider that exits on the shutdown signal is released by shutdown.
              if (shutdownSignal.received) return;
              yield* textSnapshotRegistry.retire(entry.runtime);
              entry.eventPump.ended = true;
              const current = (yield* Ref.get(sessions)).get(
                sessionKey(entry.runtime.providerSessionId),
              );
              if (current?.runtime !== entry.runtime) {
                return;
              }
              if (stoppedByProvider && Exit.isSuccess(exit)) {
                yield* releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  expectedRuntime: entry.runtime,
                  reason: "manual_shutdown",
                  gracefulSubscribers: true,
                }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
                return;
              }
              const cause = Exit.isFailure(exit)
                ? exit.cause
                : Cause.fail(
                    new ProviderAdapterEventStreamError({
                      driver: entry.runtime.driver,
                      providerSessionId: entry.runtime.providerSessionId,
                      cause: "Provider event stream ended unexpectedly.",
                    }),
                  );
              yield* publishToSubscribers(entry.eventSubscribers, {
                type: "failure",
                cause,
              });
              yield* Ref.set(entry.eventSubscribers, new Map());
              yield* releaseEntry({
                providerSessionId: entry.runtime.providerSessionId,
                expectedRuntime: entry.runtime,
                reason: "runtime_error",
                detail: Cause.pretty(cause),
              }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
            }),
          ),
          Effect.interruptible,
          Effect.forkIn(layerScope),
          Effect.tap((fiber) =>
            Effect.sync(() => {
              entry.eventPump.fiber = fiber;
            }),
          ),
        );
      };

      // Parent of every session scope. On layer close, shutdown releases the
      // live sessions first, then closes any session whose open is still in
      // flight, time-boxed so a stuck adapter cannot hold up server shutdown.
      // Parallel, so one session whose close hangs does not stop the rest from
      // closing within the time box.
      const sessionScopes = yield* Scope.make("parallel");
      const shutdown = Effect.gen(function* () {
        const activeSessions = [
          ...new Map([
            ...[...(yield* Ref.get(sessions)).values()].map(
              (entry) => [entry.runtime, entry] as const,
            ),
            ...[...closingSessions.values()].map(
              (owner) => [owner.entry.runtime, owner.entry] as const,
            ),
          ]).values(),
        ];
        yield* Effect.forEach(
          activeSessions,
          (entry) =>
            releaseEntry({
              providerSessionId: entry.runtime.providerSessionId,
              expectedRuntime: entry.runtime,
              reason: "server_shutdown",
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                  providerSessionId: entry.runtime.providerSessionId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        );
      });
      yield* Effect.addFinalizer(() =>
        shutdown.pipe(
          Effect.ensuring(closeScopeWithin(sessionScopes, { reason: "server_shutdown" })),
        ),
      );

      // SCIENT-FORK:START — execution authority of the exact live native owner.
      const sessionAuthority = makeSessionAuthority({
        sessions,
        sessionKey,
        releasingRuntimes,
        readThreadRecords: (invocation) =>
          projectionStore
            .getThreadRecords(invocation.threadId, ["runs", "attempts", "providerThreads"])
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionLookupError({
                    providerSessionId: ProviderSessionId.make(invocation.providerSessionId),
                    cause,
                  }),
              ),
            ),
      });
      // SCIENT-FORK:END

      const service = ProviderSessionManagerV2.of({
        // SCIENT-FORK:START — running-fork text capture.
        captureRunningForkText: textSnapshotRegistry.capture,
        withCapturedForkText: (capture, commit) =>
          textSnapshotRegistry.withCurrent(capture.token, undefined, commit),
        releaseCapturedForkText: (capture) => textSnapshotRegistry.release(capture.token),
        // SCIENT-FORK:END
        shutdown,
        // SCIENT-FORK:START — execution authority of the exact live native owner.
        withProviderWorkAdmission: sessionAuthority.withProviderWorkAdmission,
        resolveMcpInvocationPolicy: sessionAuthority.resolveMcpInvocationPolicy,
        // SCIENT-FORK:END
        open: (input) =>
          Effect.suspend(() => {
            let cleanupOpening: Effect.Effect<void> = Effect.void;
            let openedRuntime: ProviderAdapterV2SessionRuntime | undefined;
            return sessionOpen
              .withLock(
                input.providerSessionId,
                Effect.gen(function* () {
                  const cwd = input.runtimePolicy.cwd;
                  if (cwd !== null) {
                    const workspaceIsDirectory = yield* fileSystem.stat(cwd).pipe(
                      Effect.map((stat) => stat.type === "Directory"),
                      Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
                    );
                    if (!workspaceIsDirectory) {
                      return yield* new ProviderWorkspaceMissingError({
                        threadId: input.threadId,
                        cwd,
                      });
                    }
                  }
                  const key = sessionKey(input.providerSessionId);
                  const retiring = [...closingSessions.values()].find(
                    (owner) =>
                      sessionKey(owner.entry.runtime.providerSessionId) === key ||
                      (owner.entry.runtime.instanceId === input.modelSelection.instanceId &&
                        owner.entry.attachedThreadIds.has(input.threadId)),
                  );
                  if (retiring)
                    return yield* new ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause:
                        retiring.state === "failed"
                          ? "The prior native close failed; exact-owner recovery is required."
                          : "The prior native close is still pending.",
                    });
                  const existing = (yield* Ref.get(sessions)).get(key);
                  if (existing !== undefined) {
                    if (releasingRuntimes.has(existing.runtime))
                      return yield* new ProviderSessionOpenError({
                        instanceId: input.modelSelection.instanceId,
                        providerSessionId: input.providerSessionId,
                        cause: "The live provider session is logically closing.",
                      });
                    if (existing.runtime.instanceId !== input.modelSelection.instanceId) {
                      return yield* new ProviderSessionOpenError({
                        instanceId: input.modelSelection.instanceId,
                        providerSessionId: input.providerSessionId,
                        cause: "The live provider session belongs to another configured instance.",
                      });
                    }
                    // Single-workspace processes retain their opening authority. Pooled
                    // protocols may apply cwd independently to each native thread; both
                    // negotiated capabilities are required before sharing across projects.
                    // Omitted cwd retains the native default established at opening.
                    const perThreadWorkspace =
                      existing.supportsMultipleProviderThreads &&
                      existing.runtime.providerSession.capabilities.sessions
                        .supportsPerThreadWorkspace === true;
                    if (
                      !perThreadWorkspace &&
                      cwd !== null &&
                      cwd !== existing.runtime.providerSession.cwd
                    ) {
                      const sameWorkspace = yield* Effect.all([
                        fileSystem.realPath(cwd),
                        fileSystem.realPath(existing.runtime.providerSession.cwd),
                      ]).pipe(
                        Effect.map(([requested, current]) => requested === current),
                        Effect.mapError(
                          (cause) =>
                            new ProviderSessionOpenError({
                              instanceId: input.modelSelection.instanceId,
                              providerSessionId: input.providerSessionId,
                              cause,
                            }),
                        ),
                      );
                      if (!sameWorkspace) {
                        return yield* new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause: "A different workspace requires a replacement provider session.",
                        });
                      }
                    }
                    if (
                      !existing.attachedThreadIds.has(input.threadId) &&
                      !existing.supportsMultipleProviderThreads
                    ) {
                      return yield* new ProviderSessionOpenError({
                        instanceId: input.modelSelection.instanceId,
                        providerSessionId: input.providerSessionId,
                        cause: `Provider ${existing.runtime.driver} does not support attaching multiple app threads to one session.`,
                      });
                    }
                    // SCIENT-FORK: close exact known-unusable live owners before replacement.
                    if (
                      !(yield* retireUnusableOwner(existing.runtime, (reason) =>
                        releaseEntry({
                          providerSessionId: input.providerSessionId,
                          expectedRuntime: existing.runtime,
                          reason,
                          detail: "The existing native owner is no longer reusable.",
                        }).pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderSessionOpenError({
                                instanceId: input.modelSelection.instanceId,
                                providerSessionId: input.providerSessionId,
                                cause,
                              }),
                          ),
                        ),
                      ))
                    ) {
                      yield* ensureThreadAttached({
                        providerSessionId: input.providerSessionId,
                        threadId: input.threadId,
                        providerInstanceId: existing.runtime.instanceId,
                      });
                      yield* touchActivity(input.providerSessionId);
                      return existing.exposedRuntime;
                    }
                  }

                  const adapter = yield* registry.get(input.modelSelection.instanceId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause,
                        }),
                    ),
                  );
                  // SCIENT-FORK:START provider-enabled-at-open
                  yield* (
                    input.requireEnabledInstance === true
                      ? requireEnabledProviderInstance(registry, input.modelSelection.instanceId)
                      : Effect.void
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause,
                        }),
                    ),
                  );
                  // SCIENT-FORK:END provider-enabled-at-open
                  const prepared = yield* prepareMcpSession(
                    input.threadId,
                    input.modelSelection.instanceId,
                    adapter,
                  );
                  const mcpCredentialId = prepared.mcpCredentialId;
                  // The reservation from prepare protects the credential (which
                  // eager adapters bake into the provider process during
                  // openSession) from racing releases until this session's entry
                  // is recorded below. Dropped exactly once on every path.
                  let reservationDropped = mcpCredentialId === undefined;
                  const dropReservation = Effect.sync(() => {
                    if (!reservationDropped && mcpCredentialId !== undefined) {
                      reservationDropped = true;
                      dropMcpCredentialReservation(input.threadId, mcpCredentialId);
                    }
                  });
                  return yield* Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      const sessionScope = yield* Scope.make();
                      let published = false;
                      // SCIENT-FORK:START — layer-owned opening authority and physical close.
                      cleanupOpening = dropReservation.pipe(
                        Effect.andThen(
                          mcpCredentialId === undefined
                            ? Effect.void
                            : reclaimUnusedMcpCredential(
                                input.threadId,
                                mcpCredentialId,
                                prepared.issued,
                              ),
                        ),
                        Effect.ensuring(closeOwnedScope(sessionScope)),
                        Effect.ignoreCause({ log: true }),
                      );
                      const openingOwner = {
                        scope: yield* Scope.fork(sessionScopes),
                        retiring: false,
                        closed: false,
                      };
                      parentScopeOwners.set(sessionScope, openingOwner);
                      yield* Scope.addFinalizer(
                        openingOwner.scope,
                        Effect.suspend(() => {
                          if (openingOwner.closed) return Effect.void;
                          openingOwner.retiring = true;
                          return published && openedRuntime !== undefined
                            ? releaseEntry({
                                providerSessionId: input.providerSessionId,
                                expectedRuntime: openedRuntime,
                                reason: "server_shutdown",
                              }).pipe(
                                Effect.ensuring(closeOwnedScope(sessionScope)),
                                Effect.ignoreCause({ log: true }),
                              )
                            : cleanupOpening;
                        }),
                      );
                      const openingClosed = () =>
                        new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause: "The provider session owner shut down during opening.",
                        });
                      if (openingOwner.retiring || openingOwner.closed)
                        return yield* openingClosed();
                      // SCIENT-FORK:END
                      yield* restore(
                        claimPiFile(sessionScope, adapter.driver, input.initialNativeThreadId).pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderSessionOpenError({
                                instanceId: input.modelSelection.instanceId,
                                providerSessionId: input.providerSessionId,
                                cause,
                              }),
                          ),
                        ),
                      );
                      const runtime = yield* restore(
                        adapter
                          .openSession({
                            threadId: input.threadId,
                            providerSessionId: input.providerSessionId,
                            modelSelection: input.modelSelection,
                            runtimePolicy: input.runtimePolicy,
                            configureMcp:
                              options.configureMcp !== false &&
                              adapter.mcpSessionInjection === true,
                            ...(input.resumeFromSession === undefined
                              ? {}
                              : { resumeFromSession: input.resumeFromSession }),
                            ...(input.initialNativeThreadId === undefined
                              ? {}
                              : { initialNativeThreadId: input.initialNativeThreadId }),
                            ...(input.initialProviderItemIdentityVersion === undefined
                              ? {}
                              : {
                                  initialProviderItemIdentityVersion:
                                    input.initialProviderItemIdentityVersion,
                                }),
                          })
                          .pipe(
                            withMetrics({
                              counter: providerSessionsTotal,
                              attributes: { provider: adapter.driver, operation: "open" },
                            }),
                            Effect.provideService(Scope.Scope, sessionScope),
                            Effect.onExit((exit) =>
                              Exit.isFailure(exit) ? cleanupOpening : Effect.void,
                            ),
                            Effect.mapError(
                              (cause) =>
                                new ProviderSessionOpenError({
                                  instanceId: input.modelSelection.instanceId,
                                  providerSessionId: input.providerSessionId,
                                  cause,
                                }),
                            ),
                          ),
                      );
                      openedRuntime = runtime;
                      // SCIENT-FORK: a closed parent cannot adopt a late handshake result.
                      if (openingOwner.retiring || openingOwner.closed)
                        return yield* openingClosed();
                      const consumer = runtime.eventConsumer;
                      if (consumer)
                        yield* Scope.addFinalizer(
                          sessionScope,
                          Effect.suspend(() => (published ? Effect.void : consumer.dispose)),
                        );
                      return yield* restore(
                        Effect.gen(function* () {
                          if (consumer) yield* consumer.retain;
                          const eventSubscribers = yield* Ref.make<
                            ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
                          >(new Map());
                          const exposedRuntime = decorateRuntime(
                            runtime,
                            options.configureMcp !== false && adapter.mcpSessionInjection === true,
                            eventSubscribers,
                            sessionScope,
                          );
                          const now = yield* Clock.currentTimeMillis;
                          const entry: LiveSessionEntry = {
                            attachedThreadIds: new Set([input.threadId]),
                            loadedProviderThreadKeyByThread: new Map(),
                            mcpCredentialIdByThread:
                              mcpCredentialId === undefined
                                ? new Map()
                                : new Map([[input.threadId, mcpCredentialId]]),
                            supportsMultipleProviderThreads:
                              runtime.providerSession.capabilities.sessions
                                .supportsMultipleProviderThreadsPerSession,
                            runtime,
                            exposedRuntime,
                            eventSubscribers,
                            requestEventPermit: yield* Semaphore.make(1),
                            scope: sessionScope,
                            eventPump: { fiber: undefined, ended: false },
                            ...(consumer
                              ? {
                                  eventConsumer: {
                                    dispose: consumer.dispose,
                                  },
                                }
                              : {}),
                            idleGeneration: 0,
                            busyTurns: new Set(),
                            lastActivityAtMs: now,
                            idleFiber: null,
                            pinnedSinceMs: null,
                            idleThreadUnloads: new Map(),
                          };
                          // SCIENT-FORK:START — publication cannot resurrect a closing layer owner.
                          yield* Effect.suspend(() =>
                            openingOwner.retiring || openingOwner.closed
                              ? openingClosed()
                              : Ref.update(sessions, (current) => {
                                  const updated = new Map(current);
                                  updated.set(key, entry);
                                  published = true;
                                  return updated;
                                }),
                          );
                          // SCIENT-FORK:END
                          // The entry now guards the credential via its recorded id, so
                          // the pre-open reservation can be dropped.
                          yield* dropReservation;
                          if (mcpCredentialId !== undefined)
                            yield* reclaimUnusedMcpCredential(
                              input.threadId,
                              mcpCredentialId,
                              false,
                            );
                          yield* withActivityError(
                            input.providerSessionId,
                            writeProviderSessionEvents({
                              runtime,
                              threadIds: [input.threadId],
                              type: "provider-session.attached",
                              payload: runtime.providerSession,
                            }),
                          ).pipe(
                            Effect.tapError(() =>
                              releaseEntry({
                                providerSessionId: input.providerSessionId,
                                expectedRuntime: runtime,
                                reason: "runtime_error",
                                detail: "Failed to persist the provider-session attachment.",
                              }).pipe(Effect.ignore),
                            ),
                          );
                          yield* startEventPump(entry);
                          yield* scheduleIdleRelease(input.providerSessionId);
                          return exposedRuntime;
                        }),
                      );
                    }),
                  );
                }),
              )
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : Effect.gen(function* () {
                        const current = (yield* Ref.get(sessions)).get(
                          sessionKey(input.providerSessionId),
                        );
                        if (openedRuntime !== undefined && current?.runtime === openedRuntime) {
                          yield* releaseEntry({
                            providerSessionId: input.providerSessionId,
                            expectedRuntime: openedRuntime,
                            reason: "manual_shutdown",
                          }).pipe(Effect.ignoreCause({ log: true }));
                        }
                        yield* cleanupOpening;
                      }),
                ),
              );
          }),
        get: (providerSessionId) =>
          Effect.gen(function* () {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
            if (entry === undefined || releasingRuntimes.has(entry.runtime)) {
              return Option.none<ProviderAdapterV2SessionRuntime>();
            }
            yield* touchActivity(providerSessionId);
            return Option.some(entry.exposedRuntime);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionLookupError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        getCloseState: (providerSessionId) =>
          Effect.sync(() => {
            const owner = closingSessions.get(sessionKey(providerSessionId));
            return owner === undefined
              ? Option.none()
              : Option.some({
                  providerSessionId: owner.entry.runtime.providerSessionId,
                  instanceId: owner.entry.runtime.instanceId,
                  state: owner.state,
                });
          }),
        close: (providerSessionId) =>
          releaseEntry({ providerSessionId, reason: "manual_shutdown" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        closeInstance: (instanceId) =>
          Effect.gen(function* () {
            const active = [
              ...new Map([
                ...[...(yield* Ref.get(sessions)).values()].map(
                  (entry) => [entry.runtime, entry] as const,
                ),
                ...[...closingSessions.values()].map(
                  (owner) => [owner.entry.runtime, owner.entry] as const,
                ),
              ]).values(),
            ].filter((entry) => entry.runtime.instanceId === instanceId);
            const outcomes = yield* Effect.forEach(
              active,
              (entry) =>
                releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  expectedRuntime: entry.runtime,
                  reason: "manual_shutdown",
                  detail: `Provider instance ${instanceId} logged out.`,
                }).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            const failure = outcomes.find(Exit.isFailure);
            if (failure !== undefined && Exit.isFailure(failure)) {
              return yield* Effect.failCause(failure.cause);
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId: ProviderSessionId.make(
                    `provider-session:provider-instance:${instanceId}`,
                  ),
                  cause,
                }),
            ),
          ),
        release: releaseEntry,
        detach: (input) =>
          Effect.gen(function* () {
            const key = sessionKey(input.providerSessionId);
            const currentEntry = (yield* Ref.get(sessions)).get(key);
            let detachedProviderThreads: ReadonlyArray<OrchestrationV2ProviderThread> = [];
            if (currentEntry?.supportsMultipleProviderThreads === true) {
              const projection = yield* Effect.option(
                projectionStore.getThreadRecords(input.threadId, [
                  "providerThreads",
                  "providerTurns",
                ]),
              );
              if (Option.isSome(projection)) {
                const providerThreads = new Map(
                  projection.value.providerThreads
                    .filter((thread) => thread.providerSessionId === input.providerSessionId)
                    .map((thread) => [thread.id, thread] as const),
                );
                detachedProviderThreads = [...providerThreads.values()];
                const activeTurns = projection.value.providerTurns.filter(
                  (turn) => turn.status === "running" && providerThreads.has(turn.providerThreadId),
                );
                yield* Effect.forEach(
                  activeTurns,
                  (turn) =>
                    currentEntry.exposedRuntime
                      .interruptTurn({
                        providerThread: providerThreads.get(turn.providerThreadId)!,
                        providerTurnId: turn.id,
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-interrupt-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerTurnId: turn.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                  { concurrency: 1, discard: true },
                );
              }
            }
            const detachMutation = Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || !entry.attachedThreadIds.has(input.threadId)) {
                return [
                  Option.none<{
                    readonly entry: LiveSessionEntry;
                    readonly idleUnloadFiber: Fiber.Fiber<void, never> | null;
                  }>(),
                  current,
                ] as const;
              }
              const attachedThreadIds = new Set(entry.attachedThreadIds);
              attachedThreadIds.delete(input.threadId);
              const loadedProviderThreadKeyByThread = new Map(
                entry.loadedProviderThreadKeyByThread,
              );
              loadedProviderThreadKeyByThread.delete(input.threadId);
              // For a plain (workspace-change) detach, the credential id stays
              // recorded: the thread may re-attach and reuse it, and
              // releaseEntry revokes it when the provider process finally goes
              // away. A terminal detach (archive/delete) prunes the record so
              // nothing vetoes the revocation below.
              const mcpCredentialIdByThread =
                input.revokeMcpCredential === true
                  ? (() => {
                      const pruned = new Map(entry.mcpCredentialIdByThread);
                      pruned.delete(input.threadId);
                      return pruned;
                    })()
                  : entry.mcpCredentialIdByThread;
              // The detach unloads the thread itself below.
              const idleThreadUnloads = new Map(entry.idleThreadUnloads);
              idleThreadUnloads.delete(input.threadId);
              const updatedEntry = {
                ...entry,
                attachedThreadIds,
                loadedProviderThreadKeyByThread,
                mcpCredentialIdByThread,
                idleThreadUnloads,
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [
                Option.some({
                  entry: updatedEntry,
                  idleUnloadFiber: entry.idleThreadUnloads.get(input.threadId)?.fiber ?? null,
                }),
                updated,
              ] as const;
            });
            const detachResult = yield* currentEntry?.runtime.textSnapshots === undefined
              ? detachMutation
              : textSnapshotRegistry.permit.withPermit(
                  detachMutation.pipe(
                    Effect.tap(() =>
                      textSnapshotRegistry.retire(currentEntry.runtime, input.threadId),
                    ),
                  ),
                );
            if (Option.isSome(detachResult)) {
              yield* cancelIdleFiber(detachResult.value.idleUnloadFiber);
            }
            const detached = Option.map(detachResult, (result) => result.entry);
            // Plain detaches deliberately do not revoke: a detached thread's
            // provider process may still be alive (shared multi-thread codex
            // session across a workspace handoff) and holds its MCP client's
            // credential for the thread it will re-attach with. Credentials
            // are revoked when the session entry is released (process gone)
            // or rotated on the next attach if they stopped resolving.
            // Terminal detaches (thread archived or deleted) revoke the
            // thread's credentials immediately, even on a retry where the
            // entry is already gone: there is no legitimate future re-attach,
            // and the token must not outlive the thread.
            if (input.revokeMcpCredential === true) {
              yield* clearMcpSession(input.threadId);
            }
            if (Option.isNone(detached)) {
              return;
            }
            if (
              detached.value.attachedThreadIds.size === 0 &&
              !detached.value.supportsMultipleProviderThreads
            ) {
              yield* releaseEntry({
                providerSessionId: input.providerSessionId,
                expectedRuntime: detached.value.runtime,
                reason: "manual_shutdown",
                ...(input.detail === undefined ? {} : { detail: input.detail }),
              });
              return;
            }
            // The shared runtime stays up for other threads, so unload this
            // thread's native state rather than leaving it (and its MCP
            // servers) resident until the whole runtime is released.
            const unloadThread = detached.value.exposedRuntime.unloadThread;
            if (detached.value.supportsMultipleProviderThreads && unloadThread !== undefined) {
              // Serialized with re-attachment: a thread whose next turn
              // attaches first stays loaded, and one that attaches during the
              // unload waits for it, so its resume reloads the native thread.
              yield* threadAttachment.withLock(
                threadAttachmentKey(input),
                Effect.gen(function* () {
                  const entry = (yield* Ref.get(sessions)).get(key);
                  if (
                    entry?.runtime !== detached.value.runtime ||
                    entry.attachedThreadIds.has(input.threadId)
                  ) {
                    return;
                  }
                  yield* Effect.forEach(
                    detachedProviderThreads.filter((thread) => thread.nativeThreadRef !== null),
                    (providerThread) =>
                      unloadThread({ providerThread }).pipe(
                        // Bounded so a wedged provider cannot hold up the
                        // thread's next attach.
                        Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.driver-session.detach-unload-failed",
                            {
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerThreadId: providerThread.id,
                              cause,
                            },
                          ),
                        ),
                      ),
                    { concurrency: 1, discard: true },
                  );
                }),
              );
            }
            yield* scheduleIdleRelease(input.providerSessionId);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.fail(
                new ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                  cause,
                }),
              ),
            ),
          ),
      } satisfies ProviderSessionManagerV2Shape);
      // SCIENT-FORK: turn starts reserve sessions through this exact manager.
      registerStartupSessionReservations(service, startupReservations);
      return service;
    }),
  );

export const layer = layerWithOptions();
