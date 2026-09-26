import {
  ApprovalRequestId,
  EventId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  OMP_HARD_MAX_FRAME_BYTES,
  OMP_RPC_PROTOCOL_V2,
  isRecord,
  type OmpRpcImage,
  type OmpRpcModel,
} from "effect-omp-rpc/schema";
import type { OmpRpcClient } from "effect-omp-rpc/client";
import type { OmpRpcError } from "effect-omp-rpc/errors";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ompCommandDecision } from "../omp/OmpCommandPolicy.ts";
import {
  decodeOmpModelSlug,
  encodeOmpModelSlug,
  ompModelSupportsImages,
  ompThinkingLevel,
} from "../omp/OmpModel.ts";
import {
  makeOmpRpcProcess,
  ompUserDetail,
  type OmpProcessExit,
  type OmpRpcProcessOptions,
} from "../omp/OmpRpcProcess.ts";
import { assertReadableOmpSessionFile, ompSessionFilesEqual } from "../omp/OmpSessionFile.ts";
import { isOmpBinaryUpdating } from "../omp/OmpProcessRegistry.ts";
import { acquireOmpSessionLock, releaseOmpSessionLock } from "../omp/OmpSessionLock.ts";
import {
  makeOmpSessionCursor,
  ompBinaryFingerprint,
  ompMajorCompatible,
  ompSessionDirectoryKey,
  ompStateScopeFingerprint,
  parseOmpSessionCursor,
  sessionFileInsideRoot,
  type OmpResumeIdentity,
  type OmpSessionCursor,
} from "../omp/OmpSessionCursor.ts";
import {
  makeOmpSessionRuntime,
  type OmpSessionRuntime,
  type OmpSessionUpdate,
} from "../omp/OmpSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const OMP_MAX_PROMPT_IMAGE_BYTES = 512 * 1024;
/**
 * Provider events are lossless. The adapter queue must not apply backpressure
 * to the runtime consumer: sendTurn can be waiting for turn.started while
 * holding the thread lock, so a full bounded queue would deadlock the session.
 * The RPC client still enforces its 16 MiB logical-frame budget before frames
 * reach this queue. Do not replace this with a bounded queue without a
 * non-blocking fail-closed shutdown path: bounded backpressure can deadlock
 * the turn.started/thread-lock handshake.
 */
const OMP_READY_TIMEOUT = "8 seconds";
const OMP_CANCEL_DEADLINE = "3 seconds";
const OMP_EVENT_QUEUE_MAX_ITEMS = 8192;
const OMP_EVENT_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

export interface OmpAdapterOptions {
  readonly binaryPath: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly homePath?: string | undefined;
  readonly profile?: string | undefined;
  /** Test/host override for the fail-closed event byte budget. */
  readonly eventQueueByteLimit?: number | undefined;
  /** Shared native provider-protocol event log (NDJSON). */
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  readonly makeProcess?: (options: OmpRpcProcessOptions) => Effect.Effect<
    OmpRpcClient & {
      readonly version: string;
      readonly binaryPathFingerprint?: string;
      readonly shutdown?: Effect.Effect<OmpProcessExit, OmpRpcError>;
    },
    OmpRpcError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
  >;
}

interface SessionContext {
  readonly client: OmpRpcClient & {
    readonly version: string;
    readonly binaryPathFingerprint?: string;
    readonly shutdown?: Effect.Effect<OmpProcessExit, OmpRpcError>;
  };
  runtime: OmpSessionRuntime;
  readonly scope: Scope.Scope;
  readonly sessionRoot: string;
  readonly resumeIdentity: OmpResumeIdentity;
  readonly lockPath: string;
  session: ProviderSession;
  cursor?: OmpSessionCursor | undefined;
  turnId?: TurnId | undefined;
  requestId?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  readonly assistantItemIds: Map<string, RuntimeItemId>;
  activeAssistantItemId: RuntimeItemId | undefined;
  readonly threadLock: Semaphore.Semaphore;
  readonly toolItems: Map<string, RuntimeItemId>;
  readonly knownModels: Set<string>;
  readonly imageModels: Set<string>;
  readonly subagentSeen: Set<string>;
  closing: boolean;
  stopped: boolean;
  warnedEscape: boolean;
  outcomeUncertain: boolean;
  finalized: boolean;
  protocolVersion: number;
}

const promptBytes = (message: string, images: ReadonlyArray<OmpRpcImage>): number =>
  Buffer.byteLength(message) +
  images.reduce((total, image) => total + image.data.length + image.mimeType.length + 48, 0) +
  256;

export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (options: OmpAdapterOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const adapterScope = yield* Scope.Scope;
  const makeProcess = options.makeProcess ?? makeOmpRpcProcess;
  const sessions = new Map<ThreadId, SessionContext>();
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const eventQueueByteLimit = Math.max(1, options.eventQueueByteLimit ?? OMP_EVENT_QUEUE_MAX_BYTES);
  const nativeEventLogger = options.nativeEventLogger;
  // Never block a turn.started/settlement producer on a stalled consumer. The
  // dropping queue is paired with a byte budget and a fail-closed overflow path.
  const events = yield* Queue.dropping<ProviderRuntimeEvent, Cause.Done>(OMP_EVENT_QUEUE_MAX_ITEMS);
  let queuedEventBytes = 0;
  let eventsOverflowed = false;
  const stoppingThreads = new Set<ThreadId>();
  let overflowHandler: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<void> = () =>
    Effect.void;
  const binaryFingerprint = ompBinaryFingerprint(options.binaryPath);
  const effectiveHomeIdentity =
    options.homePath?.trim() ||
    options.environment.PI_CODING_AGENT_DIR?.trim() ||
    options.environment.HOME?.trim() ||
    options.environment.USERPROFILE?.trim() ||
    "";
  const effectiveProfileIdentity =
    options.profile?.trim() ||
    options.environment.OMP_PROFILE?.trim() ||
    options.environment.PI_PROFILE?.trim() ||
    "";
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "randomUUIDv4",
          detail: "Failed to create an event id.",
          cause,
        }),
    ),
  );
  const getThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocks, (locks) => {
      const existing = locks.get(threadId);
      if (existing) return Effect.succeed([existing, locks] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(locks).set(threadId, lock)] as const),
      );
    });
  const releaseThreadLock = (threadId: ThreadId, expected: Semaphore.Semaphore) =>
    SynchronizedRef.update(threadLocks, (locks) => {
      if (sessions.has(threadId) || locks.get(threadId) !== expected) return locks;
      const next = new Map(locks);
      next.delete(threadId);
      return next;
    });
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) =>
      lock
        .withPermit(effect)
        .pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? releaseThreadLock(threadId, lock) : Effect.void,
          ),
        ),
    );
  const locally = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const resumeIdentityFor = (sessionRoot: string, workspace: string) => ({
    providerInstanceId: String(options.providerInstanceId),
    sessionRoot,
    workspace,
    binaryPathFingerprint: binaryFingerprint,
    homeIdentity: effectiveHomeIdentity ? path.resolve(effectiveHomeIdentity) : "",
    profileIdentity: effectiveProfileIdentity,
  });

  const validation = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
  const externalHttpUrl = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  const request = (method: string, detail: string, cause?: unknown) => {
    const normalized = detail.replace(/\s+/gu, " ").trim();
    const safeDetail = normalized.length > 512 ? `${normalized.slice(0, 512)}…` : normalized;
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: ompUserDetail(safeDetail || "The Oh My Pi request failed."),
      ...(cause === undefined ? {} : { cause }),
    });
  };
  const refs = (ctx: SessionContext, providerItemId?: string) => {
    const providerRequestId = ctx.requestId?.trim();
    const itemId = providerItemId?.trim();
    if (!providerRequestId && !itemId) return {};
    return {
      providerRefs: {
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(itemId ? { providerItemId: ProviderItemId.make(itemId) } : {}),
      },
    };
  };
  const runtimeEventBytes = (event: ProviderRuntimeEvent): number => {
    try {
      return Buffer.byteLength(JSON.stringify(event));
    } catch {
      return eventQueueByteLimit + 1;
    }
  };
  /** New sessions wait for a failed turn's cleanup instead of racing it. */
  const awaitEventRecovery = Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000 && eventsOverflowed; attempt += 1) {
      yield* Effect.yieldNow;
    }
    if (eventsOverflowed) {
      return yield* request(
        "startSession",
        "Oh My Pi event delivery is still recovering. Try again in a moment.",
      );
    }
  });
  const triggerEventOverflow = Effect.gen(function* () {
    if (eventsOverflowed) return;
    eventsOverflowed = true;
    // Keep the shared stream subscribed. Ending it would permanently strand
    // ProviderService after this adapter instance overflowed. Stop the current
    // sessions, then reopen the event budget for future sessions.
    // Sessions created after the overflow must survive the cleanup, so the
    // cleanup target list is fixed at overflow time and new sessions wait for
    // recovery instead of racing it.
    const overflowedThreads = [...sessions.keys()];
    yield* Effect.forkDetach(
      overflowHandler(overflowedThreads).pipe(
        Effect.andThen(
          Effect.sync(() => {
            eventsOverflowed = false;
            queuedEventBytes = 0;
          }),
        ),
      ),
    );
  });
  const offer = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (eventsOverflowed) return;
      // A stopped or replaced session can still have queued runtime updates.
      // Publishing them would both resurrect dead turns and let a finished
      // turn keep re-triggering queue overflow against healthy sessions. A
      // session that is currently shutting down may still publish its own
      // terminal events.
      if (
        event.type !== "session.exited" &&
        !sessions.has(event.threadId) &&
        !stoppingThreads.has(event.threadId)
      )
        return;
      const bytes = runtimeEventBytes(event);
      if (bytes > eventQueueByteLimit || queuedEventBytes + bytes > eventQueueByteLimit) {
        yield* triggerEventOverflow;
        return;
      }
      const accepted = yield* Queue.offer(events, event);
      if (!accepted) {
        yield* triggerEventOverflow;
        return;
      }
      queuedEventBytes += bytes;
    });
  const eventBase = (ctx: SessionContext) =>
    Effect.all({ eventId: Effect.map(uuid, EventId.make), createdAt: now }).pipe(
      Effect.map((stamp) => ({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: options.providerInstanceId,
        threadId: ctx.session.threadId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      })),
    );
  const offerUncertain = (ctx: SessionContext) =>
    Effect.gen(function* () {
      if (ctx.outcomeUncertain) return;
      ctx.outcomeUncertain = true;
      const base = yield* eventBase(ctx);
      const request = ctx.requestId?.trim();
      yield* offer({
        type: "runtime.warning",
        ...base,
        ...refs(ctx),
        payload: {
          message: request
            ? `Oh My Pi outcome uncertain for request ${request}.`
            : "Oh My Pi outcome uncertain.",
        },
      });
      yield* offer({
        type: "turn.aborted",
        ...base,
        ...refs(ctx),
        payload: { reason: "uncertain" },
      });
    });

  const refreshCursor = (
    ctx: SessionContext,
    sessionFile: string | undefined,
    sessionId: string | undefined,
  ) =>
    Effect.gen(function* () {
      if (!sessionFile) return;
      const relative = sessionFileInsideRoot(ctx.sessionRoot, sessionFile);
      if (!relative) {
        if (!ctx.warnedEscape) {
          ctx.warnedEscape = true;
          const base = yield* eventBase(ctx);
          yield* offer({
            type: "runtime.warning",
            ...base,
            payload: {
              message:
                "Oh My Pi kept this transcript outside Scient's session directory, so this conversation cannot be resumed.",
            },
          });
        }
        return;
      }
      const readable = yield* assertReadableOmpSessionFile({
        sessionRoot: ctx.sessionRoot,
        relativeSessionFile: relative,
      }).pipe(Effect.option);
      if (readable._tag === "None") return;
      const built = makeOmpSessionCursor({
        identity: ctx.resumeIdentity,
        sessionFile,
        ...(sessionId ? { sessionId } : {}),
        ompVersion: ctx.client.version,
        rpcProtocolVersion: ctx.protocolVersion,
        ...(ctx.requestId ? { lastRequestId: ctx.requestId } : {}),
      });
      if (!built) return;
      ctx.cursor = built;
      ctx.session = { ...ctx.session, resumeCursor: built, updatedAt: yield* now };
    });

  const applyUpdate = (ctx: SessionContext, update: OmpSessionUpdate) =>
    Effect.gen(function* () {
      if (update.type === "process-exited") {
        if (ctx.finalized) return;
        ctx.finalized = true;
        ctx.closing = true;
        ctx.stopped = true;
        sessions.delete(ctx.session.threadId);
        yield* Effect.forkIn(finalizeUnexpectedProcess(ctx), adapterScope);
        return;
      }
      if (update.type === "turn-started") {
        ctx.turnId = TurnId.make(update.turnId);
        ctx.outcomeUncertain = false;
        ctx.assistantItemIds.clear();
        ctx.activeAssistantItemId = undefined;
        ctx.toolItems.clear();
        const base = yield* eventBase(ctx);
        yield* offer({ type: "turn.started", ...base, payload: {} });
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: ctx.turnId,
          updatedAt: yield* now,
        };
        return;
      }
      if (update.type === "turn-outcome") {
        if (update.requestId) ctx.requestId = update.requestId;
        const base = yield* eventBase(ctx);
        const stamped = { ...base, ...refs(ctx) };
        if (update.outcome === "interrupted") {
          yield* offer({ type: "turn.aborted", ...stamped, payload: { reason: "cancelled" } });
        } else if (update.outcome === "unknown") {
          yield* offerUncertain(ctx);
        } else if (update.outcome === "failed") {
          yield* offer({
            type: "turn.completed",
            ...stamped,
            payload: {
              state: "failed",
              errorMessage: update.detail ?? "Oh My Pi failed this turn.",
            },
          });
        } else {
          yield* offer({ type: "turn.completed", ...stamped, payload: { state: "completed" } });
        }
        const { activeTurnId: _active, ...session } = ctx.session;
        ctx.session = {
          ...session,
          status:
            update.outcome === "failed"
              ? "error"
              : update.outcome === "unknown" && update.source === "process"
                ? "closed"
                : "ready",
          ...(ctx.cursor ? { resumeCursor: ctx.cursor } : {}),
          updatedAt: yield* now,
        };
        ctx.turnId = undefined;
        ctx.activeAssistantItemId = undefined;
        return;
      }
      if (update.type === "assistant-started" && ctx.turnId) {
        if (ctx.assistantItemIds.has(update.messageId)) return;
        const itemId = RuntimeItemId.make(`omp-assistant:${ctx.turnId}:${update.messageId}`);
        ctx.assistantItemIds.set(update.messageId, itemId);
        ctx.activeAssistantItemId = itemId;
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "item.started",
          ...base,
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        return;
      }
      if (update.type === "assistant-delta" && ctx.turnId) {
        const itemId = ctx.assistantItemIds.get(update.messageId);
        if (!itemId) return;
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "content.delta",
          ...base,
          itemId,
          payload: { streamKind: "assistant_text", delta: update.delta },
        });
        return;
      }
      if (update.type === "assistant-completed" && ctx.turnId) {
        const itemId = ctx.assistantItemIds.get(update.messageId);
        if (!itemId) return;
        ctx.assistantItemIds.delete(update.messageId);
        if (ctx.activeAssistantItemId === itemId) ctx.activeAssistantItemId = undefined;
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "item.completed",
          ...base,
          itemId,
          payload: { itemType: "assistant_message", status: "completed" },
        });
        return;
      }
      if (update.type === "reasoning-delta" && ctx.turnId) {
        const itemId = ctx.assistantItemIds.get(update.messageId);
        if (!itemId) return;
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "content.delta",
          ...base,
          itemId,
          payload: { streamKind: "reasoning_text", delta: update.delta },
        });
        return;
      }
      if (update.type === "tool") {
        const itemId =
          ctx.toolItems.get(update.toolCallId) ??
          RuntimeItemId.make(`omp-tool:${ctx.turnId ?? "turn"}:${update.toolCallId}`);
        ctx.toolItems.set(update.toolCallId, itemId);
        const base = yield* eventBase(ctx);
        const payload = {
          itemType: "dynamic_tool_call" as const,
          status: update.status,
          title: update.name,
          ...(update.detail ? { detail: update.detail } : {}),
          ...(update.data !== undefined ? { data: update.data } : {}),
        };
        yield* offer({
          type:
            update.phase === "started"
              ? "item.started"
              : update.phase === "updated"
                ? "item.updated"
                : "item.completed",
          ...base,
          itemId,
          ...refs(ctx, update.toolCallId),
          payload,
        });
        return;
      }
      if (update.type === "subagent") {
        const seen = ctx.subagentSeen.has(update.id);
        ctx.subagentSeen.add(update.id);
        const base = yield* eventBase(ctx);
        const stamped = { ...base, ...refs(ctx, update.id) };
        const title = update.title.trim().length > 0 ? update.title.trim() : "Subagent";
        const taskId = RuntimeTaskId.make(update.id);
        const linkage = { taskId, taskType: "subagent" as const, title };
        if (!seen) {
          yield* offer({
            type: "task.started",
            ...stamped,
            payload: {
              ...linkage,
              ...(update.detail ? { description: update.detail } : {}),
            },
          });
        }
        if (update.status === "inProgress") {
          if (seen) {
            yield* offer({
              type: "task.progress",
              ...stamped,
              payload: { ...linkage, description: update.detail ?? title },
            });
          }
          return;
        }
        yield* offer({
          type: "task.completed",
          ...stamped,
          payload: {
            ...linkage,
            status:
              update.status === "failed"
                ? "failed"
                : update.status === "stopped"
                  ? "stopped"
                  : "completed",
            ...(update.detail ? { summary: update.detail } : {}),
          },
        });
        return;
      }
      if (update.type === "command-output" && ctx.turnId) {
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "content.delta",
          ...base,
          payload: { streamKind: "command_output", delta: update.delta },
        });
        return;
      }
      if (update.type === "question") {
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "user-input.requested",
          ...base,
          requestId: RuntimeRequestId.make(update.id),
          payload: {
            questions: [
              {
                id: update.id,
                header: update.title,
                question: update.message,
                options: update.options,
                allowCustomAnswer: update.method === "input" || update.method === "editor",
                multiSelect: false,
              },
            ],
          },
        });
        return;
      }
      if (update.type === "question-resolved" || update.type === "questions-cleared") {
        const ids = update.type === "question-resolved" ? [update.id] : update.ids;
        for (const id of ids) {
          const base = yield* eventBase(ctx);
          yield* offer({
            type: "user-input.resolved",
            ...base,
            requestId: RuntimeRequestId.make(id),
            payload: { answers: {} },
          });
        }
        return;
      }
      if (update.type === "open-url") {
        const url = externalHttpUrl(update.url);
        if (!url) {
          const base = yield* eventBase(ctx);
          yield* offer({
            type: "runtime.warning",
            ...base,
            payload: { message: "Oh My Pi requested an invalid browser URL." },
          });
          return;
        }
        const launchUrl = externalHttpUrl(update.launchUrl);
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "runtime.warning",
          ...base,
          payload: {
            message: update.instructions ?? "Oh My Pi requested a browser action.",
            detail: {
              kind: "open-url",
              url,
              ...(launchUrl ? { launchUrl } : {}),
            },
          },
        });
        return;
      }
      if (update.type === "compacted") {
        const base = yield* eventBase(ctx);
        yield* offer({ type: "thread.state.changed", ...base, payload: { state: "compacted" } });
        return;
      }
      if (update.type === "model-changed") {
        if (update.model) ctx.model = update.model;
        if (update.thinkingLevel) ctx.thinkingLevel = update.thinkingLevel;
        ctx.session = {
          ...ctx.session,
          ...(update.model ? { model: update.model } : {}),
          updatedAt: yield* now,
        };
        return;
      }
      if (update.type === "warning") {
        const base = yield* eventBase(ctx);
        yield* offer({ type: "runtime.warning", ...base, payload: { message: update.message } });
        return;
      }
      if (update.type === "error") {
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "runtime.error",
          ...base,
          payload: { message: update.message, class: "provider_error" },
        });
        return;
      }
      if (update.type === "session-info") {
        yield* refreshCursor(ctx, update.sessionFile, update.sessionId);
      }
    });

  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId: String(threadId) }),
      );
    }
    return Effect.succeed(ctx);
  };

  const finalizeUnexpectedProcess = (ctx: SessionContext) =>
    Effect.gen(function* () {
      if (ctx.turnId) yield* offerUncertain(ctx);
      yield* ctx.client.close();
      yield* Scope.close(ctx.scope, Exit.void);
      yield* releaseOmpSessionLock(ctx.lockPath);
      yield* releaseThreadLock(ctx.session.threadId, ctx.threadLock);
      const base = yield* eventBase(ctx);
      ctx.session = {
        ...ctx.session,
        status: "closed",
        updatedAt: yield* now,
      };
      yield* offer({
        type: "session.exited",
        ...base,
        ...refs(ctx),
        payload: {
          reason: "Oh My Pi exited before the runtime could confirm the session was idle.",
          exitKind: "error",
        },
      });
    }).pipe(Effect.ignore);

  const stopSessionUnlocked = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) return;
      const openAtStop = Boolean(ctx.turnId);
      ctx.outcomeUncertain = false;
      ctx.closing = true;
      ctx.stopped = true;
      ctx.finalized = true;
      sessions.delete(threadId);
      stoppingThreads.add(threadId);
      const exit = ctx.client.shutdown
        ? yield* ctx.client.shutdown.pipe(
            Effect.orElseSucceed(() => ({ code: null, forced: true, stderrTail: "" })),
          )
        : { code: 0 as number | null, forced: false, stderrTail: "" };
      yield* ctx.client.close();
      yield* ctx.runtime.requestProcessExit().pipe(Effect.timeout("1 second"), Effect.ignore);
      if (ctx.turnId) yield* offerUncertain(ctx);
      yield* Scope.close(ctx.scope, Exit.void);
      yield* releaseOmpSessionLock(ctx.lockPath);
      yield* releaseThreadLock(threadId, ctx.threadLock);
      const base = yield* eventBase(ctx);
      const tail = exit.stderrTail.trim();
      if (tail.length > 0) {
        yield* offer({
          type: "runtime.warning",
          ...base,
          payload: { message: tail.length > 240 ? `${tail.slice(0, 240)}…` : tail },
        });
      }
      const uncertain = ctx.outcomeUncertain || (openAtStop && Boolean(ctx.turnId));
      const failed = uncertain || exit.forced || (exit.code !== null && exit.code !== 0);
      yield* offer({
        type: "session.exited",
        ...base,
        ...refs(ctx),
        payload: {
          reason: uncertain
            ? "Oh My Pi stopped before the turn's outcome was known."
            : failed
              ? "Oh My Pi stopped after a process error."
              : "stopped",
          exitKind: failed ? "error" : "graceful",
        },
      });
      stoppingThreads.delete(threadId);
    }).pipe(Effect.uninterruptible);

  const recordKnownModels = (ctx: SessionContext, models: ReadonlyArray<OmpRpcModel>) => {
    for (const model of models) {
      const slug = encodeOmpModelSlug(model.provider, model.id);
      if (!slug) continue;
      ctx.knownModels.add(slug);
      if (ompModelSupportsImages(model)) ctx.imageModels.add(slug);
    }
  };

  /**
   * Apply a model selection. The catalog this session read at startup can be
   * stale: a custom model added while the conversation is open, or one added by
   * a different instance, is rejected by OMP. Refresh the catalog once and
   * retry before failing the turn, so a model the user just configured works
   * without restarting the conversation.
   */
  const applyModelSelection = (
    ctx: SessionContext,
    client: SessionContext["client"],
    provider: string,
    modelId: string,
  ) =>
    Effect.gen(function* () {
      const first = yield* client.setModel(provider, modelId).pipe(
        Effect.mapError((cause) => request("set_model", cause.message, cause)),
        Effect.exit,
      );
      if (first._tag === "Success") return;
      const models = yield* client.getModels().pipe(Effect.option);
      if (models._tag === "Some") recordKnownModels(ctx, models.value.models);
      yield* client
        .setModel(provider, modelId)
        .pipe(Effect.mapError((cause) => request("set_model", cause.message, cause)));
    }).pipe(Effect.uninterruptible);

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    locally(
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const threadLock = yield* getThreadLock(input.threadId);
          yield* awaitEventRecovery;
          if (input.runtimeMode !== "full-access") {
            return yield* validation(
              "startSession",
              "Oh My Pi currently supports only full access.",
            );
          }
          if (!input.cwd)
            return yield* validation("startSession", "Oh My Pi requires a workspace directory.");
          if (isOmpBinaryUpdating(options.binaryPath)) {
            return yield* validation(
              "startSession",
              "Oh My Pi is being updated. Try again in a moment.",
            );
          }
          const cwd = yield* fs
            .realPath(input.cwd)
            .pipe(
              Effect.mapError((cause) =>
                request("startSession", "Failed to resolve the Oh My Pi workspace.", cause),
              ),
            );
          if (sessions.has(input.threadId)) {
            return yield* validation(
              "startSession",
              "This thread already has an Oh My Pi session.",
            );
          }
          const sessionRoot = path.join(
            options.stateDir,
            "omp-sessions",
            ompSessionDirectoryKey(options.providerInstanceId, input.threadId),
          );
          yield* fs
            .makeDirectory(sessionRoot, { recursive: true })
            .pipe(
              Effect.mapError((cause) =>
                request("startSession", "Failed to create the Oh My Pi session directory.", cause),
              ),
            );
          const stateReal = yield* fs
            .realPath(options.stateDir)
            .pipe(
              Effect.mapError((cause) =>
                request("startSession", "Failed to resolve Scient's state directory.", cause),
              ),
            );
          const rootReal = yield* fs
            .realPath(sessionRoot)
            .pipe(
              Effect.mapError((cause) =>
                request("startSession", "Failed to resolve the Oh My Pi session directory.", cause),
              ),
            );
          if (!sessionFileInsideRoot(stateReal, rootReal)) {
            return yield* validation(
              "startSession",
              "Oh My Pi session directory escaped Scient's state directory.",
            );
          }
          const lockPath = path.join(rootReal, ".session.lock");
          yield* acquireOmpSessionLock(lockPath).pipe(
            Effect.mapError((issue) => validation("startSession", issue)),
          );
          const scope = yield* Scope.make("sequential");
          const baseResumeIdentity = resumeIdentityFor(rootReal, cwd);
          const session = yield* Effect.gen(function* () {
            const cursor = input.resumeCursor
              ? yield* parseOmpSessionCursor(input.resumeCursor, {
                  identity: baseResumeIdentity,
                  rpcProtocolVersion: OMP_RPC_PROTOCOL_V2,
                  deferBinaryIdentity: true,
                }).pipe(Effect.mapError((issue) => validation("startSession", issue)))
              : undefined;
            if (cursor) {
              yield* assertReadableOmpSessionFile({
                sessionRoot: rootReal,
                relativeSessionFile: cursor.relativeSessionFile,
              }).pipe(Effect.mapError((issue) => validation("startSession", issue)));
            }
            const client = yield* makeProcess({
              command: options.binaryPath,
              cwd,
              env: options.environment,
              sessionDir: rootReal,
              extraArgs: [],
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError((cause) => request("startSession", cause.message, cause)),
            );
            const resumeIdentity = client.binaryPathFingerprint
              ? {
                  ...baseResumeIdentity,
                  binaryPathFingerprint: client.binaryPathFingerprint,
                }
              : baseResumeIdentity;
            if (cursor && cursor.binaryPathFingerprint !== resumeIdentity.binaryPathFingerprint) {
              return yield* validation(
                "startSession",
                "Oh My Pi resume cursor was written by a different executable.",
              );
            }
            if (
              cursor &&
              cursor.stateScopeFingerprint !== ompStateScopeFingerprint(resumeIdentity)
            ) {
              return yield* validation(
                "startSession",
                "Oh My Pi resume cursor does not match this session scope.",
              );
            }
            const ctx: SessionContext = {
              client,
              runtime: undefined as unknown as OmpSessionRuntime,
              scope,
              sessionRoot: rootReal,
              resumeIdentity,
              lockPath,
              threadLock,
              session: {
                provider: PROVIDER,
                providerInstanceId: options.providerInstanceId,
                status: "ready",
                runtimeMode: "full-access",
                cwd,
                threadId: input.threadId,
                createdAt: yield* now,
                updatedAt: yield* now,
              },
              assistantItemIds: new Map(),
              activeAssistantItemId: undefined,
              toolItems: new Map(),
              knownModels: new Set(),
              imageModels: new Set(),
              subagentSeen: new Set(),
              closing: false,
              stopped: false,
              warnedEscape: false,
              outcomeUncertain: false,
              finalized: false,
              protocolVersion: OMP_RPC_PROTOCOL_V2,
            };
            sessions.set(input.threadId, ctx);
            ctx.runtime = yield* makeOmpSessionRuntime({
              client,
              scope,
              onUpdate: (update) => locally(applyUpdate(ctx, update)).pipe(Effect.ignore),
              ...(nativeEventLogger
                ? {
                    onNativeNotification: (notification) =>
                      Effect.gen(function* () {
                        const observedAt = yield* now;
                        yield* nativeEventLogger.write(
                          {
                            observedAt,
                            event: {
                              id: yield* uuid,
                              kind: "notification",
                              provider: PROVIDER,
                              createdAt: observedAt,
                              method:
                                notification._tag === "Event"
                                  ? notification.event.type
                                  : notification._tag,
                              threadId: input.threadId,
                              ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
                              payload: notification,
                            },
                          },
                          input.threadId,
                        );
                      }).pipe(Effect.catchCause(() => Effect.void)),
                  }
                : {}),
            }).pipe(Effect.provideService(Scope.Scope, scope));
            const ready = yield* client.ready.pipe(
              Effect.timeoutOrElse({
                duration: OMP_READY_TIMEOUT,
                orElse: () => Effect.fail(request("ready", "Oh My Pi did not finish starting.")),
              }),
              Effect.mapError((cause) =>
                cause._tag === "ProviderAdapterRequestError"
                  ? cause
                  : request("ready", cause.message, cause),
              ),
            );
            if (!ready.supportedProtocolVersions?.includes(OMP_RPC_PROTOCOL_V2)) {
              return yield* request("ready", "Oh My Pi did not offer RPC protocol v2.");
            }
            if (cursor && !ompMajorCompatible(cursor.ompVersion, client.version)) {
              return yield* validation(
                "startSession",
                "Oh My Pi resume cursor was written by a different major version.",
              );
            }
            const subscribed = yield* client.setSubagentSubscription("progress").pipe(Effect.exit);
            if (Exit.isFailure(subscribed)) {
              const base = yield* eventBase(ctx);
              yield* offer({
                type: "runtime.warning",
                ...base,
                payload: {
                  message:
                    "Oh My Pi did not enable subagent updates, so subagent activity stays hidden for this conversation.",
                },
              });
            }
            if (cursor) {
              const switched = yield* client
                .switchSession(path.resolve(rootReal, cursor.relativeSessionFile))
                .pipe(Effect.mapError((cause) => request("switch_session", cause.message, cause)));
              if (switched.cancelled) {
                return yield* validation(
                  "startSession",
                  "Oh My Pi cancelled the requested session switch.",
                );
              }
            }
            const state = yield* client
              .getState()
              .pipe(Effect.mapError((cause) => request("get_state", cause.message, cause)));
            if (cursor) {
              const sameFile = state.sessionFile
                ? yield* ompSessionFilesEqual({
                    sessionRoot: rootReal,
                    expectedRelativeFile: cursor.relativeSessionFile,
                    reportedFile: state.sessionFile,
                  }).pipe(Effect.mapError((issue) => request("get_state", issue)))
                : false;
              if (
                !sameFile ||
                (cursor.sessionId !== undefined && state.sessionId !== cursor.sessionId)
              ) {
                return yield* validation(
                  "startSession",
                  "Oh My Pi resumed a different session than the cursor requested.",
                );
              }
            }
            const initialModel = state.model
              ? encodeOmpModelSlug(state.model.provider, state.model.id)
              : undefined;
            if (initialModel) {
              ctx.model = initialModel;
              ctx.session = { ...ctx.session, model: initialModel };
            }
            if (state.thinkingLevel) ctx.thinkingLevel = state.thinkingLevel;
            const models = yield* client.getModels().pipe(Effect.option);
            if (models._tag === "Some") {
              recordKnownModels(ctx, models.value.models);
            } else {
              const base = yield* eventBase(ctx);
              yield* offer({
                type: "runtime.warning",
                ...base,
                payload: {
                  message:
                    "Oh My Pi did not report model capabilities; image inputs may be rejected.",
                },
              });
            }
            yield* refreshCursor(ctx, state.sessionFile, state.sessionId);
            const commands = yield* client.getCommands().pipe(Effect.option);
            if (commands._tag === "Some") ctx.runtime.replaceCatalog(commands.value.commands);
            else {
              const base = yield* eventBase(ctx);
              yield* offer({
                type: "runtime.warning",
                ...base,
                payload: {
                  message:
                    "Oh My Pi did not report its command list. Slash commands are unavailable.",
                },
              });
            }
            return ctx.session;
          }).pipe(
            Effect.onExit((exit) =>
              exit._tag === "Success"
                ? Effect.void
                : releaseOmpSessionLock(lockPath).pipe(
                    Effect.andThen(Effect.sync(() => sessions.delete(input.threadId))),
                    Effect.andThen(Scope.close(scope, Exit.void)),
                    Effect.andThen(releaseThreadLock(input.threadId, threadLock)),
                  ),
            ),
          );
          return session;
        }),
      ),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    locally(
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const nativeText = input.originalInput ?? input.input ?? "";
          if (!nativeText && (!input.attachments || input.attachments.length === 0)) {
            return yield* validation("sendTurn", "Oh My Pi requires text or an attachment.");
          }
          const decision = ompCommandDecision(nativeText, ctx.runtime.catalog());
          if (decision === "mutator") {
            return yield* validation("sendTurn", "Scient does not forward that Oh My Pi command.");
          }
          if (decision === "unavailable") {
            return yield* validation(
              "sendTurn",
              "That command is not available in this Oh My Pi conversation.",
            );
          }
          const steering = ctx.session.status === "running" && ctx.turnId !== undefined;
          if (!steering && ctx.session.status === "running") {
            return yield* validation("sendTurn", "Wait for the current Oh My Pi turn to finish.");
          }
          if (decision === "allowed" && input.attachments && input.attachments.length > 0) {
            return yield* validation(
              "sendTurn",
              "Send attachments separately from an Oh My Pi command.",
            );
          }
          if (
            input.modelSelection &&
            input.modelSelection.instanceId !== options.providerInstanceId
          ) {
            return yield* validation(
              "sendTurn",
              "Model selection belongs to another provider instance.",
            );
          }
          if (input.modelSelection) {
            const selected = decodeOmpModelSlug(input.modelSelection.model);
            if (!selected)
              return yield* validation(
                "sendTurn",
                "Oh My Pi model selection must use provider/model.",
              );
            const selectedModel = encodeOmpModelSlug(selected.provider, selected.modelId);
            if (selectedModel && selectedModel !== ctx.model) {
              if (steering) {
                return yield* validation(
                  "sendTurn",
                  "Wait for the current Oh My Pi turn before changing its model.",
                );
              }
              yield* applyModelSelection(ctx, ctx.client, selected.provider, selected.modelId);
              ctx.model = selectedModel;
              ctx.session = { ...ctx.session, model: selectedModel, updatedAt: yield* now };
            }
            const level = ompThinkingLevel(
              getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel"),
            );
            if (level && level !== ctx.thinkingLevel) {
              if (steering) {
                return yield* validation(
                  "sendTurn",
                  "Wait for the current Oh My Pi turn before changing its thinking level.",
                );
              }
              yield* ctx.client
                .setThinkingLevel(level)
                .pipe(
                  Effect.mapError((cause) => request("set_thinking_level", cause.message, cause)),
                );
              ctx.thinkingLevel = level;
            }
          }
          const requestedModel = input.modelSelection
            ? (() => {
                const selected = decodeOmpModelSlug(input.modelSelection?.model ?? "");
                return selected
                  ? encodeOmpModelSlug(selected.provider, selected.modelId)
                  : undefined;
              })()
            : ctx.model;
          if (
            input.attachments?.some((attachment) => attachment.type === "image") &&
            requestedModel &&
            (!ctx.knownModels.has(requestedModel) || !ctx.imageModels.has(requestedModel))
          ) {
            const discovered = yield* ctx.client
              .getModels()
              .pipe(Effect.mapError((cause) => request("get_models", cause.message, cause)));
            for (const model of discovered.models) {
              const slug = encodeOmpModelSlug(model.provider, model.id);
              if (!slug) continue;
              ctx.knownModels.add(slug);
              if (ompModelSupportsImages(model)) ctx.imageModels.add(slug);
            }
          }
          if (
            input.attachments?.some((attachment) => attachment.type === "image") &&
            (!requestedModel ||
              !ctx.knownModels.has(requestedModel) ||
              !ctx.imageModels.has(requestedModel))
          ) {
            return yield* validation(
              "sendTurn",
              "The selected Oh My Pi model does not advertise image input support.",
            );
          }
          const images: Array<OmpRpcImage> = [];
          const filePaths: Array<string> = [];
          const attachmentsRoot =
            input.attachments && input.attachments.length > 0
              ? yield* fs
                  .realPath(options.attachmentsDir)
                  .pipe(
                    Effect.mapError((cause) =>
                      request(
                        "prompt",
                        "Failed to resolve the Scient attachments directory.",
                        cause,
                      ),
                    ),
                  )
              : undefined;
          const imageLimit = Math.min(
            PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
            OMP_MAX_PROMPT_IMAGE_BYTES,
          );
          yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: options.attachmentsDir,
                attachment,
              });
              if (!attachmentPath)
                return yield* request("prompt", `Invalid attachment id '${attachment.id}'.`);
              const attachmentReal = yield* fs
                .realPath(attachmentPath)
                .pipe(
                  Effect.mapError((cause) =>
                    request("prompt", "Failed to resolve the attachment path.", cause),
                  ),
                );
              if (!attachmentsRoot || !sessionFileInsideRoot(attachmentsRoot, attachmentReal)) {
                return yield* validation(
                  "sendTurn",
                  "Attachment path escapes the Scient attachments directory.",
                );
              }
              const info = yield* fs
                .stat(attachmentReal)
                .pipe(
                  Effect.mapError((cause) =>
                    request("prompt", "Failed to read an attachment.", cause),
                  ),
                );
              const limit =
                attachment.type === "image" ? imageLimit : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
              if (info.type !== "File" || info.size > BigInt(limit)) {
                return yield* validation(
                  "sendTurn",
                  attachment.type === "image"
                    ? "Images sent to Oh My Pi must fit in one RPC frame."
                    : "Attachment exceeds the upload size limit.",
                );
              }
              if (attachment.type !== "image") {
                filePaths.push(attachmentReal);
                return;
              }
              const bytes = yield* fs
                .readFile(attachmentReal)
                .pipe(
                  Effect.mapError((cause) =>
                    request("prompt", "Failed to read an image attachment.", cause),
                  ),
                );
              images.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }),
          );
          const message = [
            decision === "allowed" ? nativeText : (input.input ?? ""),
            ...(filePaths.length > 0
              ? [
                  "Attached local files (use tools to inspect them):",
                  ...filePaths.map((file) => JSON.stringify(file)),
                ]
              : []),
          ]
            .filter((part) => part.length > 0)
            .join("\n\n");
          if (promptBytes(message, images) > OMP_HARD_MAX_FRAME_BYTES) {
            return yield* validation(
              "sendTurn",
              "This Oh My Pi message exceeds the 1 MiB RPC frame limit.",
            );
          }
          let turnId = ctx.turnId;
          if (!steering) {
            turnId = TurnId.make(yield* uuid);
            yield* ctx.runtime.begin(turnId);
          }
          if (!turnId) return yield* request("prompt", "Oh My Pi has no active turn.");
          const response = yield* (
            steering ? ctx.client.steer(message, images) : ctx.client.prompt({ message, images })
          ).pipe(
            Effect.tapError(() =>
              steering ? Effect.void : ctx.runtime.commandFailed(String(turnId)),
            ),
            Effect.mapError((cause) =>
              request(steering ? "steer" : "prompt", cause.message, cause),
            ),
          );
          const agentInvoked = steering
            ? true
            : isRecord(response.data) && typeof response.data.agentInvoked === "boolean"
              ? response.data.agentInvoked
              : undefined;
          const requestId = response.id ?? String(turnId);
          if (!steering) {
            ctx.requestId = requestId;
            if (ctx.cursor) {
              ctx.cursor = { ...ctx.cursor, lastRequestId: requestId };
              ctx.session = { ...ctx.session, resumeCursor: ctx.cursor, updatedAt: yield* now };
            }
          }
          yield* ctx.runtime.accepted(requestId, agentInvoked, steering ? "steer" : "prompt");
          return {
            threadId: input.threadId,
            turnId,
            ...(ctx.cursor ? { resumeCursor: ctx.cursor } : {}),
          };
        }),
      ),
    );

  overflowHandler = (threadIds) =>
    Effect.forEach(threadIds, (threadId) => locally(stopSessionUnlocked(threadId)), {
      discard: true,
      concurrency: "unbounded",
    }).pipe(Effect.ignore);

  const stopSession = (threadId: ThreadId) => locally(stopSessionUnlocked(threadId));

  const unsupported = (operation: string, threadId: ThreadId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: operation,
        detail: `Oh My Pi does not support ${operation} for ${String(threadId)}.`,
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.keys()], (threadId) => locally(stopSessionUnlocked(threadId)), {
      discard: true,
      concurrency: "unbounded",
    }).pipe(Effect.ignore),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
    },
    startSession,
    sendTurn,
    interruptTurn: (threadId, turnId) =>
      locally(
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (!ctx.turnId) return;
          if (turnId && ctx.turnId !== turnId) {
            return yield* validation("interruptTurn", "No matching active Oh My Pi turn.");
          }
          yield* ctx.runtime.requestCancel();
          // Abort is graceful first. If OMP accepts it before an agent starts,
          // confirm the local cancellation immediately; otherwise wait for the
          // terminal event plus idle-state barrier. Past the deadline the
          // process is killed and the outcome stays uncertain.
          const cancellation = yield* Effect.gen(function* () {
            const aborted = yield* ctx.client
              .abort()
              .pipe(Effect.timeout(OMP_CANCEL_DEADLINE), Effect.exit);
            if (aborted._tag === "Success") yield* ctx.runtime.confirmCancel();
            yield* ctx.runtime.awaitTurnSettled();
            return aborted;
          }).pipe(Effect.timeout(OMP_CANCEL_DEADLINE), Effect.option);
          if (cancellation._tag === "None") {
            yield* stopSessionUnlocked(threadId);
            return;
          }
          if (cancellation.value._tag === "Failure") {
            const base = yield* eventBase(ctx);
            yield* offer({
              type: "runtime.warning",
              ...base,
              ...refs(ctx),
              payload: {
                message:
                  "Oh My Pi did not acknowledge abort, but the turn reached terminal settlement.",
              },
            });
          }
        }),
      ),
    respondToRequest: (threadId) => unsupported("respondToRequest", threadId),
    respondToUserInput: (threadId, requestId, answers) =>
      locally(
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* respondToQuestion(ctx, requestId, answers);
        }),
      ),
    readThread: (threadId) =>
      unsupported("readThread", threadId) as Effect.Effect<
        ProviderThreadSnapshot,
        ProviderAdapterError
      >,
    rollbackThread: (threadId) =>
      unsupported("rollbackThread", threadId) as Effect.Effect<
        ProviderThreadSnapshot,
        ProviderAdapterError
      >,
    stopSession,
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    stopAll: () =>
      Effect.forEach([...sessions.keys()], (threadId) => locally(stopSessionUnlocked(threadId)), {
        discard: true,
        concurrency: "unbounded",
      }),
    streamEvents: Stream.fromQueue(events).pipe(
      Stream.mapEffect((event) =>
        Effect.sync(() => {
          queuedEventBytes = Math.max(0, queuedEventBytes - runtimeEventBytes(event));
          return event;
        }),
      ),
    ),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;

  function respondToQuestion(
    ctx: SessionContext,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) {
    const id = String(requestId);
    const pending = ctx.runtime.lookupQuestion(id);
    if (!pending)
      return Effect.fail(request("extension_ui_response", "This question is no longer active."));
    const raw = answers[id];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || (value.length === 0 && pending.method !== "editor")) {
      return Effect.fail(validation("respondToUserInput", "Oh My Pi requires an answer."));
    }
    if (pending.allowedValues && !pending.allowedValues.includes(value)) {
      return Effect.fail(
        validation("respondToUserInput", "Choose one of Oh My Pi's offered answers."),
      );
    }
    const response =
      pending.method === "confirm" ? { id, confirmed: value === "true" } : { id, value };
    return ctx.client.extensionUiResponse(response).pipe(
      Effect.tap(() => Effect.sync(() => ctx.runtime.removeQuestion(id))),
      Effect.tap(() =>
        eventBase(ctx).pipe(
          Effect.flatMap((base) =>
            offer({
              type: "user-input.resolved",
              ...base,
              requestId: RuntimeRequestId.make(id),
              payload: { answers: { [id]: value } },
            }),
          ),
        ),
      ),
      Effect.mapError((cause) => request("extension_ui_response", cause.message, cause)),
    );
  }
});
