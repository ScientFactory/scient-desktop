// SCIENT-FORK: exact native consumer and known-unusable owner retirement.
import {
  disposeRetiredEventConsumer,
  interruptAndJoinRetirement,
  retireUnusableOwner,
  makeSessionRetirement,
} from "./scient-provider/SessionRetirement.ts";
// SCIENT-FORK: running-fork text capture owners.
import { makeProviderTextSnapshots } from "./scient-provider/ProviderTextSnapshots.ts";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import {
  type ProviderTextSnapshotError,
  type ProviderTextSnapshotOwner,
  type CapturedProviderText,
  type ProviderAdapterV2InternalEvent,
  ProviderAdapterEventStreamError,
  ProviderAdapterProtocolError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderTextSnapshotSubscription,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2InitiatedWorkIdentity,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { scientSkillDeliveryForProvider } from "../scient/skills/ScientSkillSession.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
const RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000;
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
  }) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderSessionManagerV2Error>;
  readonly get: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<Option.Option<ProviderAdapterV2SessionRuntime>, ProviderSessionManagerV2Error>;
  /** Resolve execution authority only for the live native owner of this MCP credential. */
  readonly resolveMcpInvocationPolicy: (
    scope: Pick<McpInvocationScope, "threadId" | "providerInstanceId" | "providerSessionId">,
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
  readonly busyCount: number;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  /** Set when idle release is deferred for pending background work; bounds total deferral. */
  readonly pinnedSinceMs: number | null;
}

interface ClosingSessionEntry {
  entry: LiveSessionEntry;
  readonly reason: ProviderSessionReleaseReason;
  readonly operation: Fiber.Fiber<Exit.Exit<void, unknown>, never>;
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
      // Pi session files admit only one native writer, including during startup.
      // The process scope releases its leases after native teardown completes.
      const piFileLeases = new Map<string, Scope.Closeable>();
      const closedLeaseScopes = new WeakSet<Scope.Closeable>();
      const failedLeaseScopes = new WeakSet<Scope.Closeable>();
      const closeOwnedScope = (scope: Scope.Closeable) =>
        Effect.suspend(() => {
          closedLeaseScopes.add(scope);
          if (failedLeaseScopes.has(scope))
            return Effect.die(
              "The native process scope previously failed to close; its Pi file leases remain held.",
            );
          return Scope.close(scope, Exit.void).pipe(
            Effect.onError(() => Effect.sync(() => failedLeaseScopes.add(scope))),
            Effect.andThen(
              Effect.sync(() => {
                for (const [file, owner] of piFileLeases)
                  if (owner === scope) piFileLeases.delete(file);
              }),
            ),
          );
        });
      const claimPiFile = (
        scope: Scope.Closeable,
        driver: ProviderAdapterV2SessionRuntime["driver"],
        nativeId?: string | null,
      ) =>
        driver !== "pi" || nativeId == null
          ? Effect.void
          : fileSystem.realPath(nativeId).pipe(
              Effect.catch((cause) =>
                cause.reason._tag === "NotFound"
                  ? Effect.succeed(path.resolve(nativeId))
                  : Effect.fail(
                      new ProviderAdapterProtocolError({
                        driver,
                        detail: "Cannot resolve the native Pi session file.",
                        payload: cause,
                      }),
                    ),
              ),
              Effect.flatMap((file) =>
                Effect.suspend(() => {
                  if (
                    closedLeaseScopes.has(scope) ||
                    (piFileLeases.has(file) && piFileLeases.get(file) !== scope)
                  )
                    return new ProviderAdapterProtocolError({
                      driver,
                      detail:
                        "The native Pi session file already has a live writer, or this writer has closed.",
                    });
                  piFileLeases.set(file, scope);
                  return Effect.void;
                }),
              ),
            );
      const nextSubscriberId = yield* Ref.make(0);
      const sessionOpen = yield* makeKeyedSerialExecutor<ProviderSessionId>();
      // Orders a thread's attach against a detach unloading it on the same session.
      const threadAttachment = yield* makeKeyedSerialExecutor<string>();
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
      const mcpPrepareLock = yield* makeKeyedSerialExecutor<ThreadId>();
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
          import("./ProviderAdapter.ts").ProviderAdapterV2Shape,
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
              const resolved = yield* mcpSessionRegistry.resolve(rawToken);
              if (
                resolved !== undefined &&
                resolved.threadId === threadId &&
                resolved.providerInstanceId === providerInstanceId &&
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
                request.responseCapability.providerSessionId === providerSessionId,
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
        writeSession: (entry: LiveSessionEntry, input: ReleaseEntryInput) =>
          writeReleasedSessionEvents({
            entry,
            reason: input.reason,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          }),
        writeRequests: (entry: LiveSessionEntry, input: ReleaseEntryInput) =>
          writeReleasedRuntimeRequestEvents({ entry, reason: input.reason }),
      });

      const awaitClosingEntry = Effect.fnUntraced(function* (owner: ClosingSessionEntry) {
        const result = yield* Fiber.join(owner.operation).pipe(
          Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
        );
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
            let captured = candidate;
            const operation = yield* Deferred.await(begin).pipe(
              Effect.andThen(Effect.suspend(() => closeRetiringEntry(captured, input))),
              Effect.exit,
              Effect.tap((result) =>
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
              Effect.forkDetach({ startImmediately: true }),
            );
            const owner: ClosingSessionEntry = {
              entry: candidate,
              reason: input.reason,
              state: "pending",
              operation,
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
                (existing.busyCount > 0 || existing.idleGeneration !== input.onlyIfIdleGeneration)
              )
                return [false, current] as const;
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
            // Physical cleanup starts only after the generation permit is released.
            yield* Deferred.succeed(begin, undefined);
            if (Exit.isFailure(invalidation))
              return yield* new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
                cause: invalidation.cause,
              });
            return yield* restore(awaitClosingEntry(owner));
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
            entry.busyCount > 0 ||
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
                  latestEntry.busyCount > 0 ||
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
          // busyCount and idleGeneration inside releaseEntry's reservation
          // before native invalidation and compare-removal.
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
          if (entry === undefined || entry.busyCount > 0) {
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
              latestEntry.busyCount > 0
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

      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (entry === undefined || entry.attachedThreadIds.has(input.threadId)) {
              return [false, current] as const;
            }
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return [true, updated] as const;
          }),
        );

      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry === undefined || !entry.attachedThreadIds.has(input.threadId)) {
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
          let preparedForCleanup: PreparedMcpCredential | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && preparedForCleanup?.mcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, preparedForCleanup.mcpCredentialId);
            }
          };
          return Effect.gen(function* () {
            const attached = yield* threadAttachment.withLock(
              threadAttachmentKey(input),
              attachThread(input),
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
            Effect.onExit((exit) =>
              (Exit.isFailure(exit) ? removeThreadAttachment(input) : Effect.void).pipe(
                Effect.ignoreCause({ log: true }),
                Effect.andThen(
                  Effect.suspend(() => {
                    dropReservation();
                    const credentialId = preparedForCleanup?.mcpCredentialId;
                    return credentialId === undefined
                      ? Effect.void
                      : reclaimUnusedMcpCredential(
                          input.threadId,
                          credentialId,
                          Exit.isFailure(exit) && preparedForCleanup?.issued === true,
                        );
                  }),
                ),
                Effect.ignoreCause({ log: true }),
              ),
            ),
          );
        });

      const markBusy = (providerSessionId: ProviderSessionId) =>
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
                busyCount: entry.busyCount + 1,
                idleFiber: null,
                lastActivityAtMs: now,
                pinnedSinceMs: null,
              });
              return [entry.idleFiber, updated] as const;
            });
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      const markIdle = (providerSessionId: ProviderSessionId) =>
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
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyCount: Math.max(0, entry.busyCount - 1),
                lastActivityAtMs: now,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
          }),
        );

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
                  input.providerThread.nativeThreadRef?.nativeId,
                ),
              ),
              Effect.andThen(observeActivity(providerSessionId, markBusy(providerSessionId))),
              Effect.andThen(
                runtime.startTurn({
                  ...input,
                  message: {
                    ...input.message,
                    text: expandComposerCitationsForProvider(input.message.text),
                  },
                }),
              ),
              Effect.catch((error) =>
                observeActivity(providerSessionId, markIdle(providerSessionId)).pipe(
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            ),
          steerTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime.steerTurn({
                  ...input,
                  message: {
                    ...input.message,
                    text: expandComposerCitationsForProvider(input.message.text),
                  },
                }),
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
                }),
              ),
            ),
          respondToRuntimeRequest: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.respondToRuntimeRequest(input)),
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
                ? markIdle(entry.runtime.providerSessionId)
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
                }).pipe(Effect.ignore);
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
              }).pipe(Effect.ignore);
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
      yield* Effect.addFinalizer(() => shutdown);

      return ProviderSessionManagerV2.of({
        // SCIENT-FORK:START — running-fork text capture.
        captureRunningForkText: textSnapshotRegistry.capture,
        withCapturedForkText: (capture, commit) =>
          textSnapshotRegistry.withCurrent(capture.token, undefined, commit),
        releaseCapturedForkText: (capture) => textSnapshotRegistry.release(capture.token),
        // SCIENT-FORK:END
        shutdown,
        withProviderWorkAdmission: <A, E, R>(
          identity: ProviderAdapterV2InitiatedWorkIdentity,
          expectedRuntime: ProviderAdapterV2SessionRuntime,
          commit: Effect.Effect<A, E, R>,
        ) =>
          Effect.gen(function* () {
            const key = sessionKey(identity.providerSessionId);
            const entry = (yield* Ref.get(sessions)).get(key);
            if (
              entry === undefined ||
              entry.exposedRuntime !== expectedRuntime ||
              !entry.attachedThreadIds.has(identity.threadId) ||
              entry.runtime.driver !== identity.driver ||
              entry.runtime.instanceId !== identity.providerInstanceId ||
              entry.runtime.withInitiatedWorkAdmission === undefined
            )
              return Option.none<A>();
            return yield* entry.runtime
              .withInitiatedWorkAdmission(
                identity,
                Effect.gen(function* () {
                  const current = (yield* Ref.get(sessions)).get(key);
                  if (
                    current?.runtime !== entry.runtime ||
                    current.scope !== entry.scope ||
                    current.exposedRuntime !== expectedRuntime ||
                    !current.attachedThreadIds.has(identity.threadId) ||
                    releasingRuntimes.has(current.runtime)
                  )
                    return Option.none<A>();
                  return Option.some(yield* commit);
                }),
              )
              .pipe(Effect.map(Option.flatten));
          }),
        resolveMcpInvocationPolicy: Effect.fn(
          "ProviderSessionManagerV2.resolveMcpInvocationPolicy",
        )(function* (
          invocation: Parameters<ProviderSessionManagerV2Shape["resolveMcpInvocationPolicy"]>[0],
        ) {
          const entries = [...(yield* Ref.get(sessions)).values()].filter(
            (entry) =>
              !releasingRuntimes.has(entry.runtime) &&
              entry.runtime.instanceId === invocation.providerInstanceId &&
              entry.attachedThreadIds.has(invocation.threadId) &&
              entry.mcpCredentialIdByThread.get(invocation.threadId) ===
                invocation.providerSessionId,
          );
          if (entries.length === 0) return Option.none();
          const projection = yield* projectionStore
            .getThreadRecords(invocation.threadId, ["runs", "attempts", "providerThreads"])
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionLookupError({
                    providerSessionId: ProviderSessionId.make(invocation.providerSessionId),
                    cause,
                  }),
              ),
            );
          if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
            return Option.none();
          const run = projection.runs
            .filter((candidate) => ["starting", "running", "waiting"].includes(candidate.status))
            .toSorted((left, right) => right.ordinal - left.ordinal)[0];
          if (
            run === undefined ||
            !["starting", "running", "waiting"].includes(run.status) ||
            run.providerInstanceId !== invocation.providerInstanceId ||
            run.runtimeMode === undefined ||
            run.interactionMode === undefined
          )
            return Option.none();
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === run.activeAttemptId,
          );
          const nativeThread = projection.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          );
          if (
            attempt === undefined ||
            nativeThread === undefined ||
            !["pending", "running"].includes(attempt.status) ||
            attempt.runId !== run.id ||
            attempt.rootNodeId !== run.rootNodeId ||
            attempt.providerInstanceId !== invocation.providerInstanceId ||
            attempt.providerThreadId !== nativeThread?.id ||
            nativeThread.appThreadId !== invocation.threadId ||
            nativeThread.providerInstanceId !== invocation.providerInstanceId
          )
            return Option.none();
          const current = yield* Ref.get(sessions);
          const owner = entries.find(
            (entry) =>
              !releasingRuntimes.has(entry.runtime) &&
              entry.runtime.providerSessionId === nativeThread.providerSessionId &&
              current.get(sessionKey(entry.runtime.providerSessionId))?.runtime === entry.runtime &&
              current
                .get(sessionKey(entry.runtime.providerSessionId))
                ?.attachedThreadIds.has(invocation.threadId) === true &&
              current
                .get(sessionKey(entry.runtime.providerSessionId))
                ?.mcpCredentialIdByThread.get(invocation.threadId) === invocation.providerSessionId,
          );
          return owner === undefined
            ? Option.none()
            : Option.some({ runtimeMode: run.runtimeMode, interactionMode: run.interactionMode });
        }),
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
                      cleanupOpening = closeOwnedScope(sessionScope).pipe(
                        Effect.andThen(dropReservation),
                        Effect.andThen(
                          mcpCredentialId === undefined
                            ? Effect.void
                            : reclaimUnusedMcpCredential(
                                input.threadId,
                                mcpCredentialId,
                                prepared.issued,
                              ),
                        ),
                        Effect.ignoreCause({ log: true }),
                      );
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
                            Effect.provideService(Scope.Scope, sessionScope),
                            Effect.onExit((exit) =>
                              Exit.isFailure(exit)
                                ? closeOwnedScope(sessionScope).pipe(
                                    Effect.ignoreCause({ log: true }),
                                    Effect.andThen(dropReservation),
                                    // A failed open drops ownership. Fresh credentials start
                                    // cleanup; the last pending holder completes it unless
                                    // a live entry adopted this exact credential.
                                    Effect.andThen(
                                      mcpCredentialId === undefined
                                        ? Effect.void
                                        : reclaimUnusedMcpCredential(
                                            input.threadId,
                                            mcpCredentialId,
                                            prepared.issued,
                                          ),
                                    ),
                                    // Preserve the native failure or caller interruption.
                                    Effect.ignoreCause({ log: true }),
                                  )
                                : Effect.void,
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
                      let published = false;
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
                            busyCount: 0,
                            lastActivityAtMs: now,
                            idleFiber: null,
                            pinnedSinceMs: null,
                          };
                          yield* Ref.update(sessions, (current) => {
                            const updated = new Map(current);
                            updated.set(key, entry);
                            published = true;
                            return updated;
                          });
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
                return [Option.none<LiveSessionEntry>(), current] as const;
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
              const updatedEntry = {
                ...entry,
                attachedThreadIds,
                loadedProviderThreadKeyByThread,
                mcpCredentialIdByThread,
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [Option.some(updatedEntry), updated] as const;
            });
            const detached = yield* currentEntry?.runtime.textSnapshots === undefined
              ? detachMutation
              : textSnapshotRegistry.permit.withPermit(
                  detachMutation.pipe(
                    Effect.tap(() =>
                      textSnapshotRegistry.retire(currentEntry.runtime, input.threadId),
                    ),
                  ),
                );
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
    }),
  );

export const layer = layerWithOptions();
