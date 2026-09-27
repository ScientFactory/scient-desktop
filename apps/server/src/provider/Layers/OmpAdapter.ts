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
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  OMP_KNOWN_EVENT_TYPES,
  OMP_RPC_PROTOCOL_V2,
  isRecord,
  type OmpRpcImage,
  type OmpRpcModel,
  type OmpThinkingLevel,
} from "effect-omp-rpc/schema";
import type { OmpRpcClient, OmpRpcFrameTrace } from "effect-omp-rpc/client";
import type { OmpRpcError } from "effect-omp-rpc/errors";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  readMcpProviderSession,
  withAgentDeviceEnvironment,
} from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ompCommandDecision } from "../omp/OmpCommandPolicy.ts";
import { writeOmpExtensionFiles } from "../omp/OmpExtensionBootstrap.ts";
import {
  ompScientExtensionSource,
  type OmpScientExtensionBootstrap,
} from "../omp/OmpScientExtension.ts";
import { buildScientAwareness } from "../ScientAwareness.ts";
import {
  decodeOmpModelSlug,
  encodeOmpModelSlug,
  ompModelSupportsImages,
  ompModelThinkingLevels,
  ompThinkingLevel,
} from "../omp/OmpModel.ts";
import {
  makeOmpRedaction,
  ompUserDetail,
  type OmpProcessExit,
  type OmpRedaction,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "../omp/OmpRpcProcess.ts";
import { assertReadableOmpSessionFile, ompSessionFilesEqual } from "../omp/OmpSessionFile.ts";
import {
  acquireOmpSessionLock,
  makeOmpSessionLockRegistry,
  releaseOmpSessionLock,
} from "../omp/OmpSessionLock.ts";
import {
  makeOmpSessionCursor,
  ompMajorCompatible,
  ompSessionDirectoryKey,
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
const encodeOmpJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const OMP_READY_TIMEOUT = "8 seconds";
/**
 * Bound on the whole startup, including a resume's switch_session (which the
 * client allows 10 minutes), so a stuck start cannot hold the thread forever.
 */
const OMP_START_DEADLINE = "2 minutes";
/**
 * First release with `set_event_filter`. Earlier releases answer an unknown
 * command without a request id, which the client must treat as a protocol
 * violation, so the filter is never sent to them.
 */
const OMP_EVENT_FILTER_MINIMUM_VERSION = "18.3.1";
/** Longer than the process shutdown's own grace, kill, and reap steps. */
const OMP_PROCESS_RELEASE_DEADLINE = "10 seconds";
/** Overall bound on releasing a session's scope before its close reports done. */
const OMP_CLOSE_DEADLINE = "15 seconds";
/**
 * Provider events are lossless and never block the runtime consumer: sendTurn
 * can be waiting for turn.started while holding the thread lock, so a full
 * bounded queue would deadlock the session. The queue is unbounded; admission
 * is budgeted per session instead. A session over its budget is closed alone,
 * and control events (turn and session lifecycle) are always admitted.
 */
const OMP_EVENT_QUEUE_MAX_ITEMS = 8192;
const OMP_EVENT_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** Total budget across sessions, for a consumer that stopped reading entirely. */
const OMP_EVENT_QUEUE_GLOBAL_FACTOR = 4;
/** Tool payloads are clipped so one event cannot exhaust a session budget. */
const OMP_TOOL_DATA_MAX_BYTES = 256 * 1024;
const OMP_TOOL_DATA_PREVIEW_CHARS = 4096;
const OMP_CONTROL_EVENT_TYPES: ReadonlySet<ProviderRuntimeEvent["type"]> = new Set([
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "session.started",
  "session.state.changed",
  "session.exited",
  "runtime.error",
]);

type OmpCloseReason =
  | "user-stop"
  | "stop-all"
  | "start-failed"
  | "process-exit"
  | "protocol-fatal"
  | "overflow"
  | "adapter-close";

const OMP_EXIT_REASONS: Record<Exclude<OmpCloseReason, "start-failed">, string> = {
  "user-stop": "Oh My Pi stopped after a process error.",
  "stop-all": "Oh My Pi stopped after a process error.",
  "adapter-close": "Oh My Pi stopped after a process error.",
  "process-exit": "Oh My Pi exited before the runtime could confirm the session was idle.",
  "protocol-fatal": "Oh My Pi sent output Scient could not read, so the session was closed.",
  overflow:
    "Oh My Pi produced events faster than Scient could deliver them, so the session was closed.",
};

const forcedExit: OmpProcessExit = { code: null, forced: true, stderrTail: "" };

/** The command's process is gone; whether OMP acted on it is unknown. */
const ompOutcomeLostWithProcess = (error: OmpRpcError): boolean =>
  error._tag === "OmpRpcProcessExitedError" || error._tag === "OmpRpcProtocolViolationError";

interface QueuedEvent {
  readonly event: ProviderRuntimeEvent;
  readonly bytes: number;
}

interface EventBacklog {
  items: number;
  bytes: number;
}

type SessionClient = OmpRpcClient & {
  readonly version: string;
  readonly shutdown?: Effect.Effect<OmpProcessExit, OmpRpcError>;
  /** Present on the custom-model bridge: wait for OMP to register Scient's models. */
  readonly refreshModels?: OmpRpcProcess["refreshModels"];
  /** The process's redaction, which knows secrets the adapter never sees. */
  readonly redaction?: OmpRedaction;
};

export interface OmpAdapterOptions {
  readonly binaryPath: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly homePath?: string | undefined;
  readonly profile?: string | undefined;
  /** Per-session budget of undelivered event bytes (test/host override). */
  readonly eventQueueByteLimit?: number | undefined;
  /** Shared native provider-protocol event log (NDJSON). */
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  /**
   * Starts one OMP process. Required, so the adapter never falls back to an
   * ungated spawn: the driver passes the custom-model factory, which leases
   * each executable from the server's gate.
   */
  readonly makeProcess: (
    options: OmpRpcProcessOptions,
  ) => Effect.Effect<
    SessionClient,
    OmpRpcError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
  >;
}

/** The process and its runtime, which exist only once startup created them. */
interface SessionHandles {
  readonly client: SessionClient;
  readonly runtime: OmpSessionRuntime;
}

/**
 * One owner for every resource of a conversation. The session scope holds, in
 * acquisition order, the lock, the process, and the runtime fibers; closing it
 * releases them in reverse, so the lock is freed only after the process is
 * gone. `closeSession` is the only path that closes it.
 */
interface SessionContext {
  /** Assigned once the process and runtime started. */
  handles?: SessionHandles | undefined;
  readonly scope: Scope.Closeable;
  readonly sessionRoot: string;
  /**
   * Applied to everything this session emits or logs. Replaced by the
   * process's own once it starts, which also knows the custom-model keys and
   * endpoint token.
   */
  redaction: OmpRedaction;
  resumeIdentity: OmpResumeIdentity;
  session: ProviderSession;
  /** The startup fiber while the session is connecting. */
  startFiber?: Fiber.Fiber<void, ProviderAdapterError> | undefined;
  started: boolean;
  closing: boolean;
  closeReason?: OmpCloseReason | undefined;
  /** Completes when a close begins, so in-flight sends stop waiting on the runtime. */
  readonly closeStarted: Deferred.Deferred<void>;
  /** Completes when every resource is released and the map entry is gone. */
  readonly closeDone: Deferred.Deferred<void>;
  processExit?: OmpProcessExit | undefined;
  cursor?: OmpSessionCursor | undefined;
  turnId?: TurnId | undefined;
  requestId?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  /**
   * The last model or level Scient asked for that OMP answered with
   * something else (a fallback model, a clamped level), with what OMP
   * applied. The same request again, while OMP still holds that answer, is
   * already satisfied: it neither blocks a steer nor re-sends the change.
   */
  requestedModel?: OmpRequestedSelection | undefined;
  requestedLevel?: (OmpRequestedSelection & { readonly model: string | undefined }) | undefined;
  readonly assistantItemIds: Map<string, RuntimeItemId>;
  activeAssistantItemId: RuntimeItemId | undefined;
  readonly threadLock: Semaphore.Semaphore;
  readonly toolItems: Map<string, RuntimeItemId>;
  readonly knownModels: Set<string>;
  readonly imageModels: Set<string>;
  /** Reasoning levels each known model lists (from `thinking.efforts`). */
  readonly modelLevels: Map<string, ReadonlyArray<string>>;
  readonly subagentSeen: Set<string>;
  /** Subagent tasks shown as running, with the turn that started each. */
  readonly openSubagents: Map<string, { readonly title: string; readonly turnId?: TurnId }>;
  backgroundPending: boolean;
  backgroundSequence: number;
  warnedEscape: boolean;
  outcomeUncertain: boolean;
  protocolVersion: number;
}

interface OmpRequestedSelection {
  readonly requested: string;
  readonly effective: string | undefined;
}

/** The session already runs what `slug` asks for, directly or as OMP's answer to it. */
const ompModelSatisfied = (ctx: SessionContext, slug: string): boolean =>
  slug === ctx.model ||
  (ctx.requestedModel?.requested === slug && ctx.requestedModel.effective === ctx.model);

const ompLevelSatisfied = (ctx: SessionContext, level: string): boolean =>
  level === ctx.thinkingLevel ||
  (ctx.requestedLevel?.requested === level &&
    ctx.requestedLevel.effective === ctx.thinkingLevel &&
    ctx.requestedLevel.model === ctx.model);

/** A session whose process and runtime exist. */
type LiveSessionContext = SessionContext & { readonly handles: SessionHandles };

const isLiveSession = (ctx: SessionContext): ctx is LiveSessionContext => ctx.handles !== undefined;

/** A short size for limit messages: 10 MB, 1.2 MB, 512 KB. */
const formatOmpBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`
    : `${Math.ceil(bytes / 1024)} KB`;

/** Room for the numeric request id the client adds to every command. */
const OMP_FRAME_ID_RESERVE = encodeOmpJson({ id: "9".repeat(20) }).length;

interface OmpImageAttachment {
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
}

/**
 * Exact JSONL bytes of a prompt (or steer) frame with this message and no
 * images, including the request id and newline the client adds.
 */
const ompBaseFrameBytes = (message: string): number =>
  Buffer.byteLength(encodeOmpJson({ type: "follow_up", message })) + OMP_FRAME_ID_RESERVE + 1;

/** Bytes one inline image adds to a frame: its JSON object, base64 data, and separator. */
const ompInlineImageBytes = (image: OmpImageAttachment): number =>
  Buffer.byteLength(encodeOmpJson({ type: "image", data: "", mimeType: image.mimeType })) +
  4 * Math.ceil(image.size / 3) +
  1;

/** `,"images":[]` around the inline images. */
const OMP_IMAGES_ARRAY_BYTES = Buffer.byteLength(',"images":[]');

/**
 * Decide which images travel inline and which as attached local files. Inline
 * images must fit, with the message, in the physical frame OMP advertised in
 * `ready.maxFrameBytes` (OMP reads commands unchunked). Images that do not fit
 * are listed as local files instead: OMP 18.3.1's `read` tool returns image
 * content for image files to image-capable models, which reaches the next
 * model request. Moving an image to a file lengthens the message, so the plan
 * is recomputed until it is stable.
 */
const planOmpImages = (input: {
  readonly buildMessage: (imageFiles: ReadonlyArray<string>) => string;
  readonly images: ReadonlyArray<OmpImageAttachment>;
  readonly maxFrameBytes: number;
}):
  | {
      readonly message: string;
      readonly inline: ReadonlyArray<OmpImageAttachment>;
    }
  | { readonly messageBytes: number } => {
  const viaFile = new Set<OmpImageAttachment>();
  while (true) {
    const message = input.buildMessage(
      input.images.filter((image) => viaFile.has(image)).map((image) => image.path),
    );
    const base = ompBaseFrameBytes(message);
    if (base > input.maxFrameBytes) return { messageBytes: base };
    const inline: Array<OmpImageAttachment> = [];
    let used = base + OMP_IMAGES_ARRAY_BYTES;
    let moved = false;
    for (const image of input.images) {
      if (viaFile.has(image)) continue;
      const cost = ompInlineImageBytes(image);
      if (used + cost <= input.maxFrameBytes) {
        inline.push(image);
        used += cost;
      } else {
        viaFile.add(image);
        moved = true;
      }
    }
    if (!moved) return { message, inline };
  }
};

export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (options: OmpAdapterOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const adapterScope = yield* Scope.Scope;
  const makeProcess = options.makeProcess;
  const sessions = new Map<ThreadId, SessionContext>();
  /**
   * Starts that have not registered their session yet: waiting for the
   * thread lock, or for the thread's previous session to finish closing. A
   * stop in that window has no session to close, so it cancels these.
   */
  const pendingStarts = new Map<ThreadId, Set<{ stopped: boolean }>>();
  const cancelPendingStarts = (threadId?: ThreadId) => {
    const groups =
      threadId === undefined ? [...pendingStarts.values()] : [pendingStarts.get(threadId)];
    for (const group of groups) for (const pending of group ?? []) pending.stopped = true;
  };
  const hasPendingStart = (threadId: ThreadId) =>
    [...(pendingStarts.get(threadId) ?? [])].some((pending) => !pending.stopped);
  const lockRegistry = makeOmpSessionLockRegistry();
  // Thread semaphores live as long as the adapter, so a semaphore is never
  // deleted while a start, send, or stop could still hold it.
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  // Session scopes hang off this child scope. It is registered before the
  // adapter finalizer, so the finalizer closes every session first and this
  // scope only catches what a failed close left behind.
  const sessionsScope = yield* Scope.fork(adapterScope, "sequential");
  let adapterClosed = false;
  const eventQueueByteLimit = Math.max(1, options.eventQueueByteLimit ?? OMP_EVENT_QUEUE_MAX_BYTES);
  const eventQueueItemLimit = OMP_EVENT_QUEUE_MAX_ITEMS;
  const toolDataByteLimit = Math.max(
    1024,
    Math.min(OMP_TOOL_DATA_MAX_BYTES, Math.floor(eventQueueByteLimit / 4)),
  );
  const nativeEventLogger = options.nativeEventLogger;
  const events = yield* Queue.unbounded<QueuedEvent, Cause.Done>();
  /** Undelivered events per thread. Decremented on delivery, never reset. */
  const backlogs = new Map<ThreadId, EventBacklog>();
  const queued: EventBacklog = { items: 0, bytes: 0 };
  // Expanded as the child's PI_CODING_AGENT_DIR is, so "~/x" and its
  // absolute path are one home.
  const effectiveHomeIdentity = expandHomePath(
    options.homePath?.trim() ||
      options.environment.PI_CODING_AGENT_DIR?.trim() ||
      options.environment.HOME?.trim() ||
      options.environment.USERPROFILE?.trim() ||
      "",
  );
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
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));
  const locally = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const resumeIdentityFor = (sessionRoot: string, workspace: string) => ({
    providerInstanceId: String(options.providerInstanceId),
    sessionRoot,
    workspace,
    homeIdentity: effectiveHomeIdentity ? path.resolve(effectiveHomeIdentity) : "",
    profileIdentity: effectiveProfileIdentity,
  });

  const validation = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
  /**
   * An http(s) URL reduced to its origin and path. Browser actions are stored
   * in the thread's activity history, and an OAuth authorization URL carries
   * its `state` and other one-time parameters in the query and fragment.
   */
  const externalHttpUrl = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? `${url.origin}${url.pathname}`
        : undefined;
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
  /**
   * A failed OMP command of this session. OMP's text can echo a credential (a
   * provider rejecting a key), so it is redacted with every secret the
   * session's process knows; the raw cause is kept only when nothing in its
   * text needed redacting.
   */
  const commandFailed = (
    ctx: SessionContext,
    method: string,
    cause: { readonly message: string },
  ) => {
    const detail = ctx.redaction.text(cause.message);
    return request(method, detail, detail === cause.message ? cause : undefined);
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
  const backlogOf = (threadId: ThreadId): EventBacklog => {
    const existing = backlogs.get(threadId);
    if (existing) return existing;
    const created = { items: 0, bytes: 0 };
    backlogs.set(threadId, created);
    return created;
  };
  const delivered = (item: QueuedEvent) => {
    const backlog = backlogs.get(item.event.threadId);
    if (backlog) {
      backlog.items = Math.max(0, backlog.items - 1);
      backlog.bytes = Math.max(0, backlog.bytes - item.bytes);
      if (backlog.items === 0 && !sessions.has(item.event.threadId)) {
        backlogs.delete(item.event.threadId);
      }
    }
    queued.items = Math.max(0, queued.items - 1);
    queued.bytes = Math.max(0, queued.bytes - item.bytes);
    return item.event;
  };
  /** The open session holding the most undelivered bytes. */
  const largestBacklog = (): SessionContext | undefined => {
    let largest: SessionContext | undefined;
    let largestBytes = -1;
    for (const ctx of sessions.values()) {
      if (ctx.closing) continue;
      const bytes = backlogs.get(ctx.session.threadId)?.bytes ?? 0;
      if (bytes > largestBytes) {
        largest = ctx;
        largestBytes = bytes;
      }
    }
    return largest;
  };
  /**
   * Admit one event. Only the thread's current session publishes: a replaced
   * or closed session's late updates would resurrect dead turns. Data events
   * are budgeted per session; a session over budget is closed on its own.
   * Control events, and events `closeSession` emits itself, always pass.
   */
  const offer = (
    raw: ProviderRuntimeEvent,
    lane: "data" | "control" = "data",
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const ctx = sessions.get(raw.threadId);
      if (!ctx) return Effect.void;
      const control = lane === "control" || OMP_CONTROL_EVENT_TYPES.has(raw.type);
      if (!control && ctx.closing) return Effect.void;
      // Any text OMP produced (an echoed key in a provider error, tool
      // output, a question) loses the session's exact secrets, and nothing else.
      const event = ctx.redaction.exact(raw);
      const bytes = runtimeEventBytes(event);
      const backlog = backlogOf(event.threadId);
      if (!control) {
        if (
          backlog.items + 1 > eventQueueItemLimit ||
          backlog.bytes + bytes > eventQueueByteLimit
        ) {
          return beginClose(ctx, "overflow");
        }
        if (
          queued.items + 1 > eventQueueItemLimit * OMP_EVENT_QUEUE_GLOBAL_FACTOR ||
          queued.bytes + bytes > eventQueueByteLimit * OMP_EVENT_QUEUE_GLOBAL_FACTOR
        ) {
          // The consumer is stalled for everyone. Shed the largest backlog;
          // other sessions stay within their own budgets.
          const largest = largestBacklog();
          if (largest && largest !== ctx) {
            return beginClose(largest, "overflow").pipe(
              Effect.andThen(Effect.suspend(() => admit(event, bytes, backlog))),
            );
          }
          return beginClose(ctx, "overflow");
        }
      }
      return admit(event, bytes, backlog);
    });
  const admit = (event: ProviderRuntimeEvent, bytes: number, backlog: EventBacklog) =>
    Effect.suspend(() => {
      backlog.items += 1;
      backlog.bytes += bytes;
      queued.items += 1;
      queued.bytes += bytes;
      return Queue.offer(events, { event, bytes }).pipe(Effect.asVoid);
    });
  const clipToolData = (data: unknown): unknown => {
    let text: string | undefined;
    try {
      text = JSON.stringify(data);
    } catch {
      text = undefined;
    }
    if (text !== undefined && Buffer.byteLength(text) <= toolDataByteLimit) return data;
    return {
      truncated: true,
      ...(text === undefined
        ? {}
        : {
            originalBytes: Buffer.byteLength(text),
            preview: text.slice(0, OMP_TOOL_DATA_PREVIEW_CHARS),
          }),
    };
  };
  const eventBase = (ctx: SessionContext, turnId: TurnId | undefined = ctx.turnId) =>
    Effect.all({ eventId: Effect.map(uuid, EventId.make), createdAt: now }).pipe(
      Effect.map((stamp) => ({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: options.providerInstanceId,
        threadId: ctx.session.threadId,
        ...(turnId ? { turnId } : {}),
      })),
    );
  /**
   * Take ownership of the open turn's terminal outcome. Synchronous, so the
   * runtime's settlement and a closing session can never both report it.
   */
  const claimTurn = (ctx: SessionContext): TurnId | undefined => {
    const turnId = ctx.turnId;
    ctx.turnId = undefined;
    ctx.activeAssistantItemId = undefined;
    if (turnId) {
      const { activeTurnId: _active, ...session } = ctx.session;
      ctx.session = session;
    }
    return turnId;
  };
  const offerUncertain = (ctx: SessionContext, turnId: TurnId) =>
    Effect.gen(function* () {
      if (ctx.outcomeUncertain) return;
      ctx.outcomeUncertain = true;
      const base = yield* eventBase(ctx, turnId);
      const request = ctx.requestId?.trim();
      yield* offer(
        {
          type: "runtime.warning",
          ...base,
          ...refs(ctx),
          payload: {
            message: request
              ? `Oh My Pi outcome uncertain for request ${request}.`
              : "Oh My Pi outcome uncertain.",
          },
        },
        "control",
      );
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
      const ompVersion = ctx.handles?.client.version;
      if (!sessionFile || ompVersion === undefined) return;
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
        ompVersion,
        rpcProtocolVersion: ctx.protocolVersion,
        ...(ctx.requestId ? { lastRequestId: ctx.requestId } : {}),
      });
      if (!built) return;
      ctx.cursor = built;
      ctx.session = { ...ctx.session, resumeCursor: built, updatedAt: yield* now };
    });

  /**
   * End every subagent task still shown as running once nothing can report
   * its end: OMP settled the session (no background work is left), or the
   * session is closing. A turn settling does not end them: OMP's subagents
   * run as background jobs that outlive their turn and an abort, and report
   * their own end later. Stopped unless the session failed. Control lane: a
   * closing session still reports it.
   */
  const closeOpenSubagents = (ctx: SessionContext, status: "stopped" | "failed") =>
    Effect.gen(function* () {
      const open = [...ctx.openSubagents];
      ctx.openSubagents.clear();
      for (const [id, task] of open) {
        const base = yield* eventBase(ctx, task.turnId);
        yield* offer(
          {
            type: "task.completed",
            ...base,
            ...refs(ctx, id),
            payload: {
              taskId: RuntimeTaskId.make(id),
              taskType: "subagent",
              title: task.title,
              status,
            },
          },
          "control",
        );
      }
    });

  const reportBackground = (
    ctx: SessionContext,
    pending: boolean,
    status: "completed" | "stopped" = "completed",
  ) =>
    Effect.gen(function* () {
      if (ctx.backgroundPending === pending) return;
      ctx.backgroundPending = pending;
      if (pending) ctx.backgroundSequence += 1;
      const base = yield* eventBase(ctx);
      const taskId = RuntimeTaskId.make(
        `omp-background:${ctx.session.createdAt}:${ctx.backgroundSequence}`,
      );
      const payload = {
        taskId,
        taskType: "monitor",
        title: "Waiting for Oh My Pi background work",
      };
      yield* offer(
        pending
          ? { ...base, type: "task.started", payload: { ...payload, description: payload.title } }
          : { ...base, type: "task.completed", payload: { ...payload, status } },
        ctx.closing ? "control" : "data",
      );
    });

  const applyUpdate = (ctx: SessionContext, update: OmpSessionUpdate) =>
    Effect.gen(function* () {
      // A closing session reports its own terminal events.
      if (ctx.closing) return;
      if (update.type === "process-exited") {
        yield* beginClose(ctx, update.cause === "protocol" ? "protocol-fatal" : "process-exit");
        return;
      }
      if (update.type === "turn-started") {
        ctx.turnId = TurnId.make(update.turnId);
        ctx.requestId = undefined;
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
        const turnId = claimTurn(ctx);
        if (!turnId) return;
        if (update.requestId) ctx.requestId = update.requestId;
        const base = yield* eventBase(ctx, turnId);
        const stamped = { ...base, ...refs(ctx) };
        const errorMessage =
          update.outcome === "failed"
            ? ctx.redaction.text(update.detail ?? "Oh My Pi failed this turn.")
            : undefined;
        if (update.outcome === "interrupted") {
          yield* offer({ type: "turn.aborted", ...stamped, payload: { reason: "cancelled" } });
        } else if (update.outcome === "unknown") {
          yield* offerUncertain(ctx, turnId);
        } else if (errorMessage !== undefined) {
          // A model failure is a provider error on a healthy session, as in
          // Pi. A rejected prompt command is already reported by its sender.
          if (update.source !== "command") {
            yield* offer({
              type: "runtime.error",
              ...stamped,
              payload: { message: errorMessage, class: "provider_error" },
            });
          }
          yield* offer({
            type: "turn.completed",
            ...stamped,
            payload: {
              state: "failed",
              errorMessage,
              ...(update.stopReason ? { stopReason: update.stopReason } : {}),
            },
          });
        } else {
          yield* offer({
            type: "turn.completed",
            ...stamped,
            payload: {
              state: "completed",
              ...(update.stopReason ? { stopReason: update.stopReason } : {}),
            },
          });
        }
        const { activeTurnId: _active, lastError: _lastError, ...session } = ctx.session;
        ctx.session = {
          ...session,
          status: update.outcome === "unknown" && update.source === "process" ? "closed" : "ready",
          ...(errorMessage !== undefined ? { lastError: errorMessage } : {}),
          ...(ctx.cursor ? { resumeCursor: ctx.cursor } : {}),
          updatedAt: yield* now,
        };
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
          payload: { itemType: "assistant_message", status: update.status ?? "completed" },
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
          ...(update.data !== undefined ? { data: clipToolData(update.data) } : {}),
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
        const open = ctx.openSubagents.get(update.id);
        // A task that ended, or was closed when the session settled, stays closed.
        if (seen && !open) return;
        ctx.subagentSeen.add(update.id);
        // A background task reports under the turn that started it, whichever
        // turn (if any) is open now.
        const base = yield* eventBase(ctx, open ? open.turnId : ctx.turnId);
        const stamped = { ...base, ...refs(ctx, update.id) };
        const title = update.title.trim().length > 0 ? update.title.trim() : "Subagent";
        const taskId = RuntimeTaskId.make(update.id);
        const linkage = { taskId, taskType: "subagent" as const, title };
        if (!seen) {
          ctx.openSubagents.set(update.id, {
            title,
            ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
          });
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
        ctx.openSubagents.delete(update.id);
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
      if (update.type === "background-work") {
        yield* reportBackground(ctx, update.pending);
        return;
      }
      if (update.type === "session-settled") {
        yield* reportBackground(ctx, false);
        yield* closeOpenSubagents(ctx, "stopped");
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
        yield* offer({
          type: "runtime.warning",
          ...base,
          payload: { message: ctx.redaction.text(update.message) },
        });
        return;
      }
      if (update.type === "error") {
        const base = yield* eventBase(ctx);
        yield* offer({
          type: "runtime.error",
          ...base,
          payload: { message: ctx.redaction.text(update.message), class: "provider_error" },
        });
        return;
      }
      if (update.type === "session-info") {
        yield* refreshCursor(ctx, update.sessionFile, update.sessionId);
      }
    });

  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    if (!ctx || !ctx.started || ctx.closing || !isLiveSession(ctx)) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId: String(threadId) }),
      );
    }
    return Effect.succeed(ctx);
  };
  const isOpen = (ctx: SessionContext | undefined): ctx is SessionContext =>
    ctx !== undefined && !ctx.closing && ctx.session.status !== "closed";

  /** Stop, then reap, the session's process. Bounded; records how it exited. */
  const releaseProcess = (ctx: SessionContext, client: SessionClient) =>
    Effect.gen(function* () {
      if (client.shutdown) {
        ctx.processExit = yield* client.shutdown.pipe(Effect.orElseSucceed(() => forcedExit));
      } else {
        yield* client.close();
        ctx.processExit = { code: 0, forced: false, stderrTail: "" };
      }
      yield* client.close();
    }).pipe(
      Effect.timeoutOrElse({
        duration: OMP_PROCESS_RELEASE_DEADLINE,
        orElse: () =>
          Effect.sync(() => {
            ctx.processExit ??= forcedExit;
          }),
      }),
    );

  const exitReport = (ctx: SessionContext, reason: Exclude<OmpCloseReason, "start-failed">) => {
    const exit = ctx.processExit ?? forcedExit;
    const cleanProcess = !exit.forced && (exit.code === null || exit.code === 0);
    const requested = reason === "user-stop" || reason === "stop-all" || reason === "adapter-close";
    const graceful = requested && cleanProcess;
    return {
      reason: graceful ? "stopped" : OMP_EXIT_REASONS[reason],
      exitKind: graceful ? ("graceful" as const) : ("error" as const),
    };
  };

  /**
   * The close itself. Runs detached from every caller, so it always finishes:
   * settle the open turn, cancel a start in flight, release the session scope
   * (runtime fibers, then the process, then the lock), report the exit, and
   * only then give up the map entry and complete `closeDone`.
   */
  const closeBody = (ctx: SessionContext, reason: OmpCloseReason): Effect.Effect<void> => {
    const threadId = ctx.session.threadId;
    /** Reporting is best effort: a failure there must not skip the release. */
    const report = <E>(effect: Effect.Effect<void, E>) => effect.pipe(Effect.ignoreCause);
    return Effect.gen(function* () {
      yield* Deferred.succeed(ctx.closeStarted, undefined);
      yield* report(reportBackground(ctx, false, "stopped"));
      yield* report(
        closeOpenSubagents(
          ctx,
          reason === "user-stop" || reason === "stop-all" || reason === "adapter-close"
            ? "stopped"
            : "failed",
        ),
      );
      const turnId = claimTurn(ctx);
      if (turnId) {
        yield* report(
          reason === "user-stop"
            ? Effect.gen(function* () {
                const base = yield* eventBase(ctx, turnId);
                yield* offer({
                  type: "turn.aborted",
                  ...base,
                  ...refs(ctx),
                  payload: { reason: "cancelled" },
                });
              })
            : offerUncertain(ctx, turnId),
        );
      }
      ctx.session = { ...ctx.session, status: "closed", updatedAt: yield* now };
      const startFiber = ctx.startFiber;
      if (startFiber) {
        yield* Fiber.interrupt(startFiber).pipe(
          Effect.timeoutOption(OMP_CLOSE_DEADLINE),
          Effect.asVoid,
        );
      }
      // The scope close runs on its own fiber: past the deadline the close
      // still reports done, while the lock stays held until the process is
      // finally reaped, so a new start fails closed instead of racing it.
      const released = yield* Scope.close(ctx.scope, Exit.void).pipe(
        Effect.forkDetach,
        Effect.flatMap((fiber) => Fiber.await(fiber)),
        Effect.timeoutOption(OMP_CLOSE_DEADLINE),
      );
      if (released._tag === "None") {
        yield* Effect.logWarning("Oh My Pi session resources were not released in time.", {
          threadId,
        });
      }
      if (ctx.started && reason !== "start-failed") {
        yield* report(
          Effect.gen(function* () {
            const base = yield* eventBase(ctx, undefined);
            const tail = ctx.processExit?.stderrTail.trim() ?? "";
            if (tail.length > 0) {
              yield* offer(
                {
                  type: "runtime.warning",
                  ...base,
                  payload: { message: tail.length > 240 ? `${tail.slice(0, 240)}…` : tail },
                },
                "control",
              );
            }
            yield* offer({
              type: "session.exited",
              ...base,
              ...refs(ctx),
              payload: exitReport(ctx, reason),
            });
          }),
        );
      }
    }).pipe(
      Effect.ignoreCause,
      // Joiners wait on closeDone: the entry goes and closeDone completes
      // however the body ended.
      Effect.ensuring(
        Effect.suspend(() => {
          if (sessions.get(threadId) === ctx) sessions.delete(threadId);
          return Deferred.succeed(ctx.closeDone, undefined);
        }),
      ),
      Effect.uninterruptible,
    );
  };

  /** Start closing without waiting. Safe from any fiber, including the session's own. */
  const beginClose = (ctx: SessionContext, reason: OmpCloseReason): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (ctx.closing) return Effect.void;
      ctx.closing = true;
      ctx.closeReason = reason;
      return closeBody(ctx, reason).pipe(Effect.forkDetach, Effect.asVoid);
    });

  /**
   * The single close path for every exit: stop, stopAll, start failure,
   * process exit, protocol failure, overflow, and adapter
   * close. Idempotent; a second caller joins the first close.
   */
  const closeSession = (ctx: SessionContext, reason: OmpCloseReason) =>
    beginClose(ctx, reason).pipe(Effect.andThen(Deferred.await(ctx.closeDone)));

  const recordKnownModels = (ctx: SessionContext, models: ReadonlyArray<OmpRpcModel>) => {
    for (const model of models) {
      const slug = encodeOmpModelSlug(model.provider, model.id);
      if (!slug) continue;
      ctx.knownModels.add(slug);
      if (ompModelSupportsImages(model)) ctx.imageModels.add(slug);
      ctx.modelLevels.set(slug, ompModelThinkingLevels(model));
    }
  };

  /**
   * A level must be one the model lists. "off" is always accepted: OMP lists
   * it for every model, and it is not an effort.
   */
  const checkLevelListed = (ctx: SessionContext, slug: string, level: string) => {
    const listed = ctx.modelLevels.get(slug);
    if (listed === undefined || level === "off" || listed.includes(level)) return undefined;
    return validation(
      "sendTurn",
      listed.length === 0
        ? `The Oh My Pi model ${slug} has no reasoning levels, so "${level}" cannot be applied.`
        : `The Oh My Pi model ${slug} does not offer the "${level}" reasoning level. It offers: ${listed.join(", ")}.`,
    );
  };

  const warn = (ctx: SessionContext, message: string) =>
    Effect.gen(function* () {
      const base = yield* eventBase(ctx);
      yield* offer({ type: "runtime.warning", ...base, payload: { message } });
    });

  /**
   * Select a model. The catalog this session read at startup can be stale: a
   * custom model added while the conversation is open is unknown to OMP until
   * the custom-model bridge has registered it. An unknown Scient custom model
   * waits for that refresh before the first `set_model`, and a rejected model
   * is retried once after a refresh and a fresh catalog read.
   */
  const setModelWithRefresh = (
    ctx: LiveSessionContext,
    provider: string,
    modelId: string,
    slug: string,
  ) =>
    Effect.gen(function* () {
      const client = ctx.handles.client;
      const refresh = client.refreshModels
        ? client
            .refreshModels()
            .pipe(Effect.mapError((cause) => commandFailed(ctx, "set_model", cause)))
        : Effect.void;
      if (provider.startsWith("scient_") && !ctx.knownModels.has(slug)) yield* refresh;
      const first = yield* client.setModel(provider, modelId).pipe(
        Effect.mapError((cause) => commandFailed(ctx, "set_model", cause)),
        Effect.exit,
      );
      if (first._tag === "Success") return;
      yield* refresh;
      const models = yield* client.getModels().pipe(Effect.option);
      if (models._tag === "Some") recordKnownModels(ctx, models.value.models);
      yield* client
        .setModel(provider, modelId)
        .pipe(Effect.mapError((cause) => commandFailed(ctx, "set_model", cause)));
    });

  const readState = (ctx: LiveSessionContext) =>
    ctx.handles.client
      .getState()
      .pipe(Effect.mapError((cause) => commandFailed(ctx, "get_state", cause)));

  /**
   * Apply a model and reasoning level transactionally, reading OMP's effective
   * state back after each change. `set_model` re-applies the model's default
   * level, so the requested level is compared with what OMP reports, not with
   * the level before the switch. A level OMP changes (clamps) is stored as
   * applied and reported as a warning. The caller restores the previous
   * selection if this or the send fails.
   */
  const applyModelSelection = (
    ctx: LiveSessionContext,
    change: {
      readonly model?:
        | { readonly provider: string; readonly modelId: string; readonly slug: string }
        | undefined;
      readonly level?: OmpThinkingLevel | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (change.model) {
        const { provider, modelId, slug } = change.model;
        yield* setModelWithRefresh(ctx, provider, modelId, slug);
        const state = yield* readState(ctx);
        const reported = state.model
          ? encodeOmpModelSlug(state.model.provider, state.model.id)
          : undefined;
        if (reported && reported !== slug) {
          yield* warn(ctx, `Oh My Pi selected ${reported} instead of ${slug}.`);
        }
        const effective = reported ?? slug;
        ctx.model = effective;
        ctx.thinkingLevel = state.thinkingLevel;
        ctx.requestedModel = effective === slug ? undefined : { requested: slug, effective };
        ctx.session = { ...ctx.session, model: effective, updatedAt: yield* now };
        if (!ctx.modelLevels.has(effective)) {
          const models = yield* ctx.handles.client.getModels().pipe(Effect.option);
          if (models._tag === "Some") recordKnownModels(ctx, models.value.models);
        }
      }
      const level = change.level;
      if (level === undefined) return;
      const target = ctx.model;
      const unlisted = target ? checkLevelListed(ctx, target, level) : undefined;
      if (unlisted) return yield* unlisted;
      if (level === ctx.thinkingLevel) return;
      yield* ctx.handles.client
        .setThinkingLevel(level)
        .pipe(Effect.mapError((cause) => commandFailed(ctx, "set_thinking_level", cause)));
      const applied = (yield* readState(ctx)).thinkingLevel ?? level;
      if (applied !== level) {
        yield* warn(
          ctx,
          `Oh My Pi applied the "${applied}" reasoning level instead of "${level}".`,
        );
      }
      ctx.thinkingLevel = applied;
      ctx.requestedLevel =
        applied === level ? undefined : { requested: level, effective: applied, model: ctx.model };
    }).pipe(Effect.uninterruptible);

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.suspend(() => {
      const pending = { stopped: false };
      const group = pendingStarts.get(input.threadId) ?? new Set();
      group.add(pending);
      pendingStarts.set(input.threadId, group);
      const settled = Effect.sync(() => {
        group.delete(pending);
        if (group.size === 0 && pendingStarts.get(input.threadId) === group) {
          pendingStarts.delete(input.threadId);
        }
      });
      return startSessionOnce(input, pending, settled).pipe(Effect.ensuring(settled));
    });

  const startSessionOnce = (
    input: Parameters<ProviderAdapterShape<ProviderAdapterError>["startSession"]>[0],
    pending: { readonly stopped: boolean },
    registered: Effect.Effect<void>,
  ) =>
    locally(
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const threadLock = yield* getThreadLock(input.threadId);
          if (adapterClosed) {
            return yield* request("startSession", "Oh My Pi is shutting down.");
          }
          if (input.runtimeMode !== "full-access") {
            return yield* validation(
              "startSession",
              "Oh My Pi currently supports only full access.",
            );
          }
          if (!input.cwd)
            return yield* validation("startSession", "Oh My Pi requires a workspace directory.");
          const cwd = yield* fs
            .realPath(input.cwd)
            .pipe(
              Effect.mapError((cause) =>
                request("startSession", "Failed to resolve the Oh My Pi workspace.", cause),
              ),
            );
          const existing = sessions.get(input.threadId);
          // A session that is still closing is joined, not reported as open.
          if (existing?.closing) yield* Deferred.await(existing.closeDone);
          else if (existing) {
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
          const scope = yield* Scope.fork(sessionsScope, "sequential");
          const resumeIdentity = resumeIdentityFor(rootReal, cwd);
          const startedAt = yield* now;
          const ctx: SessionContext = {
            scope,
            sessionRoot: rootReal,
            redaction: makeOmpRedaction(options.environment, []),
            resumeIdentity,
            threadLock,
            session: {
              provider: PROVIDER,
              providerInstanceId: options.providerInstanceId,
              // Connecting until the handshake completes, so shared activity
              // checks see a session that is still starting.
              status: "connecting",
              runtimeMode: "full-access",
              cwd,
              threadId: input.threadId,
              createdAt: startedAt,
              updatedAt: startedAt,
            },
            started: false,
            closing: false,
            closeStarted: yield* Deferred.make<void>(),
            closeDone: yield* Deferred.make<void>(),
            assistantItemIds: new Map(),
            activeAssistantItemId: undefined,
            toolItems: new Map(),
            knownModels: new Set(),
            imageModels: new Set(),
            modelLevels: new Map(),
            subagentSeen: new Set(),
            openSubagents: new Map(),
            backgroundPending: false,
            backgroundSequence: 0,
            warnedEscape: false,
            outcomeUncertain: false,
            protocolVersion: OMP_RPC_PROTOCOL_V2,
          };
          // A stop issued while this start waited (for the lock, or for the
          // previous session's close) applies to it.
          if (pending.stopped) {
            yield* Scope.close(scope, Exit.void);
            return yield* request(
              "startSession",
              "Oh My Pi was stopped before the session finished starting.",
            );
          }
          sessions.set(input.threadId, ctx);
          // From here a stop closes this session instead.
          yield* registered;
          const start = Effect.gen(function* () {
            // A stop that arrived before this fiber ran already owns the close.
            if (ctx.closing) return yield* Effect.interrupt;
            // The executable is not part of resume identity; the major
            // version is checked once the process reports it.
            // Acquired into the session scope in this order, so they are
            // released in reverse: runtime fibers, process, then the lock.
            yield* Effect.acquireRelease(
              acquireOmpSessionLock(lockPath, lockRegistry).pipe(
                Effect.mapError((issue) => validation("startSession", issue)),
              ),
              (lock) => releaseOmpSessionLock(lock, lockRegistry),
            );
            const cursor = input.resumeCursor
              ? yield* parseOmpSessionCursor(input.resumeCursor, {
                  identity: resumeIdentity,
                  rpcProtocolVersion: OMP_RPC_PROTOCOL_V2,
                }).pipe(Effect.mapError((issue) => validation("startSession", issue)))
              : undefined;
            if (cursor) {
              yield* assertReadableOmpSessionFile({
                sessionRoot: rootReal,
                relativeSessionFile: cursor.relativeSessionFile,
              }).pipe(Effect.mapError((issue) => validation("startSession", issue)));
            }
            // Scient's tools, skills and awareness reach OMP the way they
            // reach Pi: through a session-local extension that proxies this
            // thread's MCP credential. The extension file holds no secret;
            // the endpoint, token and awareness are in a 0600 bootstrap file
            // the extension deletes while OMP loads, never in OMP's
            // environment, which its shell tools can read. Both sit in the
            // session scope between the lock and the process, so they are
            // removed after the process is gone on every close path.
            const mcp = readMcpProviderSession(input.threadId);
            if (mcp && mcp.providerInstanceId !== options.providerInstanceId) {
              return yield* validation(
                "startSession",
                "Scient tool session belongs to another provider instance.",
              );
            }
            const bootstrap: OmpScientExtensionBootstrap = {
              endpoint: mcp?.endpoint ?? null,
              authorization: mcp?.authorizationHeader ?? null,
              awareness: buildScientAwareness(mcp?.capabilities),
            };
            const extension = yield* writeOmpExtensionFiles({
              directory: rootReal,
              name: `scient-extension-${yield* uuid}`,
              source: ompScientExtensionSource,
              bootstrap: { ...bootstrap },
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError((cause) => request("startSession", cause.detail, cause)),
            );
            const processEnvironment = withAgentDeviceEnvironment(options.environment, mcp);
            ctx.redaction = makeOmpRedaction(processEnvironment, [mcp?.authorizationHeader]);
            // One native log record per notification, command and response.
            // Every payload is redacted before it reaches the shared logger,
            // which bounds each record and the log's size and retention.
            const writeNative = (record: {
              readonly kind: "notification" | "command" | "response";
              readonly method: string;
              readonly payload: unknown;
            }) =>
              nativeEventLogger
                ? Effect.gen(function* () {
                    const observedAt = yield* now;
                    yield* nativeEventLogger.write(
                      {
                        observedAt,
                        event: {
                          id: yield* uuid,
                          kind: record.kind,
                          provider: PROVIDER,
                          createdAt: observedAt,
                          method: record.method,
                          threadId: input.threadId,
                          ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
                          payload: record.payload,
                        },
                      },
                      input.threadId,
                    );
                  }).pipe(Effect.catchCause(() => Effect.void))
                : Effect.void;
            const client: SessionClient = yield* Effect.acquireRelease(
              makeProcess({
                command: options.binaryPath,
                cwd,
                env: processEnvironment,
                sessionDir: rootReal,
                // The custom-model factory appends its own `--extension`.
                extraArgs: ["--extension", extension.extensionPath],
                secrets: [mcp?.authorizationHeader],
                ...(nativeEventLogger
                  ? {
                      // Already redacted by the process with its final environment.
                      onFrame: ({ direction, frame }: OmpRpcFrameTrace) =>
                        writeNative({
                          kind: direction === "outbound" ? "command" : "response",
                          method:
                            frame.type === "response" && typeof frame.command === "string"
                              ? frame.command
                              : String(frame.type),
                          payload: frame,
                        }),
                    }
                  : {}),
              }).pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError((cause) => commandFailed(ctx, "startSession", cause)),
              ),
              (started) => releaseProcess(ctx, started),
              { interruptible: true },
            );
            if (client.redaction) ctx.redaction = client.redaction;
            const runtime = yield* makeOmpSessionRuntime({
              client,
              continuationIdPrefix: yield* uuid,
              scope,
              onUpdate: (update) => locally(applyUpdate(ctx, update)).pipe(Effect.ignore),
              ...(nativeEventLogger
                ? {
                    onNativeNotification: (notification) =>
                      writeNative({
                        kind: "notification",
                        method:
                          notification._tag === "Event"
                            ? notification.event.type
                            : notification._tag,
                        payload: ctx.redaction.log(notification),
                      }),
                  }
                : {}),
            });
            ctx.handles = { client, runtime };
            const ready = yield* client.ready.pipe(
              Effect.timeoutOrElse({
                duration: OMP_READY_TIMEOUT,
                orElse: () => Effect.fail(request("ready", "Oh My Pi did not finish starting.")),
              }),
              Effect.mapError((cause) =>
                cause._tag === "ProviderAdapterRequestError"
                  ? cause
                  : commandFailed(ctx, "ready", cause),
              ),
            );
            if (!ready.supportedProtocolVersions?.includes(OMP_RPC_PROTOCOL_V2)) {
              return yield* request("ready", "Oh My Pi did not offer RPC protocol v2.");
            }
            // Explicit extensions load before OMP reports ready. A bootstrap
            // still on disk means Scient's extension never ran; it must not
            // stay readable to the agent's tools.
            yield* extension.discardUnconsumed;
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
            // Pin the event kinds this client understands, so a new OMP event
            // cannot break or flood the conversation. Optional: without it
            // unknown kinds are still reported once and ignored.
            if (compareSemverVersions(client.version, OMP_EVENT_FILTER_MINIMUM_VERSION) >= 0) {
              const filtered = yield* client
                .setEventFilter(OMP_KNOWN_EVENT_TYPES)
                .pipe(Effect.exit);
              if (Exit.isFailure(filtered)) {
                yield* Effect.logDebug("Oh My Pi did not accept the session event filter.", {
                  threadId: input.threadId,
                  cause: Cause.pretty(filtered.cause),
                });
              }
            } else {
              yield* Effect.logDebug(
                "Oh My Pi predates set_event_filter; events stay unfiltered.",
                {
                  threadId: input.threadId,
                  version: client.version,
                },
              );
            }
            if (cursor) {
              const switched = yield* client
                .switchSession(path.resolve(rootReal, cursor.relativeSessionFile))
                .pipe(Effect.mapError((cause) => commandFailed(ctx, "switch_session", cause)));
              if (switched.cancelled) {
                return yield* validation(
                  "startSession",
                  "Oh My Pi cancelled the requested session switch.",
                );
              }
            }
            const state = yield* client
              .getState()
              .pipe(Effect.mapError((cause) => commandFailed(ctx, "get_state", cause)));
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
            if (commands._tag === "Some") runtime.replaceCatalog(commands.value.commands);
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
            ctx.started = true;
            ctx.session = { ...ctx.session, status: "ready", updatedAt: yield* now };
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.timeoutOrElse({
              duration: OMP_START_DEADLINE,
              orElse: () =>
                Effect.fail(
                  request("startSession", "Oh My Pi did not finish starting within 2 minutes."),
                ),
            }),
          );
          // The start runs on its own fiber so a stop can cancel it without
          // interrupting this caller, which then joins the stop's close.
          const startFiber = yield* Effect.forkDetach(start);
          ctx.startFiber = startFiber;
          const started = yield* Fiber.await(startFiber).pipe(
            Effect.onInterrupt(() => closeSession(ctx, "start-failed")),
          );
          ctx.startFiber = undefined;
          if (Exit.isSuccess(started) && ctx.started && !ctx.closing) return ctx.session;
          const reason = ctx.closeReason;
          yield* closeSession(ctx, "start-failed");
          if (Exit.isFailure(started) && !Cause.hasInterruptsOnly(started.cause)) {
            return yield* Effect.failCause(started.cause);
          }
          return yield* request(
            "startSession",
            reason === "user-stop" || reason === "stop-all" || reason === "adapter-close"
              ? "Oh My Pi was stopped before the session finished starting."
              : "Oh My Pi exited before the session finished starting.",
          );
        }),
      ),
    );

  /**
   * Put back the model and level a failed send changed, then read back what
   * OMP really holds: a refused restore leaves OMP on the new selection, and
   * the session must know that so the next send selects again. Best effort:
   * the turn already failed, and a closing session has nothing to restore.
   */
  const restorePreviousSelection = (ctx: LiveSessionContext, modelChanged: boolean) => {
    const previousModel = ctx.model;
    const previousLevel = ctx.thinkingLevel;
    const previousRequestedModel = ctx.requestedModel;
    const previousRequestedLevel = ctx.requestedLevel;
    return Effect.gen(function* () {
      if (ctx.closing) return;
      const model = previousModel ? decodeOmpModelSlug(previousModel) : undefined;
      if (model && modelChanged) {
        yield* ctx.handles.client.setModel(model.provider, model.modelId).pipe(Effect.ignore);
      }
      const level = ompThinkingLevel(previousLevel);
      if (level) yield* ctx.handles.client.setThinkingLevel(level).pipe(Effect.ignore);
      // The remembered requests hold only while OMP still gives the same answer.
      ctx.requestedModel = previousRequestedModel;
      ctx.requestedLevel = previousRequestedLevel;
      const state = yield* readState(ctx).pipe(Effect.option);
      if (state._tag === "None") {
        // Unknown: the next send re-applies its whole selection.
        ctx.model = undefined;
        ctx.thinkingLevel = undefined;
        yield* warn(ctx, "Oh My Pi did not report its model after the failed turn.");
        return;
      }
      const effectiveModel = state.value.model
        ? encodeOmpModelSlug(state.value.model.provider, state.value.model.id)
        : undefined;
      ctx.model = effectiveModel ?? previousModel;
      ctx.thinkingLevel = state.value.thinkingLevel;
      if (ctx.model !== previousModel) {
        yield* warn(
          ctx,
          `Oh My Pi is still using ${ctx.model ?? "another model"}; Scient could not restore ${previousModel ?? "the previous model"}.`,
        );
      } else if (previousLevel !== undefined && ctx.thinkingLevel !== previousLevel) {
        yield* warn(
          ctx,
          `Oh My Pi kept the "${ctx.thinkingLevel ?? "default"}" reasoning level; Scient could not restore "${previousLevel}".`,
        );
      }
      const { model: _model, ...session } = ctx.session;
      ctx.session = {
        ...session,
        ...(ctx.model ? { model: ctx.model } : {}),
        updatedAt: yield* now,
      };
    });
  };

  /** A send stops waiting on the runtime as soon as its session starts closing. */
  const untilClosed =
    (threadId: ThreadId, method: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        if (!ctx) return effect;
        return Effect.raceFirst(
          effect,
          Deferred.await(ctx.closeStarted).pipe(
            Effect.andThen(Effect.fail(request(method, "Oh My Pi closed this conversation."))),
          ),
        );
      });

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
          const decision = ompCommandDecision(nativeText, ctx.handles.runtime.catalog());
          if (decision === "mutator") {
            return yield* validation("sendTurn", "Scient does not forward that Oh My Pi command.");
          }
          if (decision === "unavailable") {
            return yield* validation(
              "sendTurn",
              "That command is not available in this Oh My Pi conversation.",
            );
          }
          let steering = ctx.session.status === "running" && ctx.turnId !== undefined;
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
          // Resolve the selection only. Nothing changes in Oh My Pi until every
          // check below has passed.
          let modelChange:
            | { readonly provider: string; readonly modelId: string; readonly slug: string }
            | undefined;
          let levelChange: OmpThinkingLevel | undefined;
          if (input.modelSelection) {
            const selected = decodeOmpModelSlug(input.modelSelection.model);
            if (!selected)
              return yield* validation(
                "sendTurn",
                "Oh My Pi model selection must use provider/model.",
              );
            const selectedModel = encodeOmpModelSlug(selected.provider, selected.modelId);
            if (selectedModel && !ompModelSatisfied(ctx, selectedModel)) {
              if (steering) {
                return yield* validation(
                  "sendTurn",
                  "Wait for the current Oh My Pi turn before changing its model.",
                );
              }
              modelChange = { ...selected, slug: selectedModel };
            }
            const requestedLevel = getModelSelectionStringOptionValue(
              input.modelSelection,
              "thinkingLevel",
            );
            const level = ompThinkingLevel(requestedLevel);
            if (requestedLevel !== undefined && level === undefined) {
              return yield* validation(
                "sendTurn",
                `Oh My Pi does not have a "${requestedLevel}" reasoning level.`,
              );
            }
            // After a model switch OMP applies the new model's default level,
            // so the requested level is always re-applied then.
            if (level && (modelChange !== undefined || !ompLevelSatisfied(ctx, level))) {
              if (steering) {
                return yield* validation(
                  "sendTurn",
                  "Wait for the current Oh My Pi turn before changing its thinking level.",
                );
              }
              levelChange = level;
            }
            // Reject a level the target model does not list. A model this
            // session has not seen yet is checked once it is selected.
            const target = modelChange?.slug ?? ctx.model;
            const unlisted =
              levelChange && target ? checkLevelListed(ctx, target, levelChange) : undefined;
            if (unlisted) return yield* unlisted;
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
            const discovered = yield* ctx.handles.client
              .getModels()
              .pipe(Effect.mapError((cause) => commandFailed(ctx, "get_models", cause)));
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
          const imageAttachments: Array<OmpImageAttachment> = [];
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
              const size = Number(info.size);
              const limit =
                attachment.type === "image"
                  ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                  : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
              if (info.type !== "File" || size > limit) {
                return yield* validation(
                  "sendTurn",
                  attachment.type === "image"
                    ? `Images sent to Oh My Pi can be at most ${formatOmpBytes(limit)}; this one is ${formatOmpBytes(size)}.`
                    : `Files sent to Oh My Pi can be at most ${formatOmpBytes(limit)}; this one is ${formatOmpBytes(size)}.`,
                );
              }
              if (attachment.type === "image") {
                imageAttachments.push({
                  path: attachmentReal,
                  size,
                  mimeType: attachment.mimeType,
                });
              } else {
                filePaths.push(attachmentReal);
              }
            }),
          );
          const { maxFrameBytes } = yield* ctx.handles.client.limits;
          const plan = planOmpImages({
            images: imageAttachments,
            maxFrameBytes,
            buildMessage: (imageFiles) =>
              [
                decision === "allowed" ? nativeText : (input.input ?? ""),
                ...(filePaths.length > 0
                  ? [
                      "Attached local files (use tools to inspect them):",
                      ...filePaths.map((file) => JSON.stringify(file)),
                    ]
                  : []),
                ...(imageFiles.length > 0
                  ? [
                      "Attached images (open each with the read tool to view it):",
                      ...imageFiles.map((file) => JSON.stringify(file)),
                    ]
                  : []),
              ]
                .filter((part) => part.length > 0)
                .join("\n\n"),
          });
          if ("messageBytes" in plan) {
            return yield* validation(
              "sendTurn",
              `This message is ${formatOmpBytes(plan.messageBytes)}; Oh My Pi accepts at most ${formatOmpBytes(maxFrameBytes)} per message. Send long text as a file attachment.`,
            );
          }
          const message = plan.message;
          const images: Array<OmpRpcImage> = [];
          for (const image of plan.inline) {
            const bytes = yield* fs
              .readFile(image.path)
              .pipe(
                Effect.mapError((cause) =>
                  request("prompt", "Failed to read an image attachment.", cause),
                ),
              );
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: image.mimeType,
            });
          }
          // Validation passed: apply the selection. A later failure restores
          // the previous model and level.
          const restoreSelection =
            modelChange || levelChange
              ? restorePreviousSelection(ctx, modelChange !== undefined)
              : Effect.void;
          if (modelChange || levelChange) {
            yield* applyModelSelection(ctx, { model: modelChange, level: levelChange }).pipe(
              Effect.tapError(() => restoreSelection),
            );
          }
          // Admission shares the native event queue: a background wake-up
          // during preparation must be steered, never overwritten by begin.
          const admitted = yield* ctx.handles.runtime.begin(yield* uuid);
          steering = admitted.steering;
          const turnId = TurnId.make(admitted.turnId);
          const response = yield* (
            steering
              ? ctx.handles.client.steer(message, images)
              : ctx.handles.client.prompt({ message, images })
          ).pipe(
            // A prompt that died with its process (or with a protocol
            // violation that ends it) may have reached OMP, so its outcome
            // is uncertain and the process exit settles it. Only a
            // rejection, or a prompt never written, fails the turn.
            Effect.tapError((cause) =>
              steering || ompOutcomeLostWithProcess(cause)
                ? Effect.void
                : ctx.handles.runtime.commandFailed(turnId),
            ),
            Effect.mapError((cause) => commandFailed(ctx, steering ? "steer" : "prompt", cause)),
            Effect.tapError(() => (steering ? Effect.void : restoreSelection)),
          );
          const agentInvoked = steering
            ? true
            : isRecord(response.data) && typeof response.data.agentInvoked === "boolean"
              ? response.data.agentInvoked
              : undefined;
          const requestId = response.id ?? String(turnId);
          if (!steering && ctx.turnId === turnId) {
            ctx.requestId = requestId;
            if (ctx.cursor) {
              ctx.cursor = { ...ctx.cursor, lastRequestId: requestId };
              ctx.session = { ...ctx.session, resumeCursor: ctx.cursor, updatedAt: yield* now };
            }
          }
          yield* ctx.handles.runtime.accepted(
            requestId,
            agentInvoked,
            steering ? "steer" : "prompt",
            turnId,
          );
          return {
            threadId: input.threadId,
            turnId,
            ...(ctx.cursor ? { resumeCursor: ctx.cursor } : {}),
          };
        }).pipe(untilClosed(input.threadId, "sendTurn")),
      ),
    );

  /** Stop does not take the thread lock, so it stays available during a send. */
  const stopSession = (threadId: ThreadId) =>
    locally(
      Effect.suspend(() => {
        cancelPendingStarts(threadId);
        const ctx = sessions.get(threadId);
        return ctx ? closeSession(ctx, "user-stop") : Effect.void;
      }),
    );
  const closeAll = (reason: OmpCloseReason) =>
    Effect.suspend(() => {
      cancelPendingStarts();
      return Effect.forEach([...sessions.values()], (ctx) => locally(closeSession(ctx, reason)), {
        discard: true,
        concurrency: "unbounded",
      });
    });

  const unsupported = (operation: string, threadId: ThreadId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: operation,
        detail: `Oh My Pi does not support ${operation} for ${String(threadId)}.`,
      }),
    );

  // Close every session and wait for each to finish releasing, then end the
  // event stream so subscribers do not outlive the adapter.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      adapterClosed = true;
    }).pipe(
      Effect.andThen(closeAll("adapter-close")),
      Effect.andThen(Queue.end(events)),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
      mcpSessionInjection: true,
    },
    startSession,
    sendTurn,
    interruptTurn: (threadId, turnId) =>
      locally(
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (turnId && ctx.turnId && ctx.turnId !== turnId) {
            return yield* validation("interruptTurn", "No matching active Oh My Pi turn.");
          }
          // Native abort only interrupts the foreground run. Like Claude,
          // Stop closes the session so detached jobs cannot wake it again.
          yield* closeSession(ctx, "user-stop");
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
      Effect.sync(() => [...sessions.values()].filter(isOpen).map((ctx) => ({ ...ctx.session }))),
    // A start still waiting to register its session counts: a stop routed on
    // this answer must reach it.
    hasSession: (threadId) =>
      Effect.sync(() => isOpen(sessions.get(threadId)) || hasPendingStart(threadId)),
    stopAll: () => closeAll("stop-all"),
    streamEvents: Stream.fromQueue(events).pipe(Stream.map(delivered)),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;

  function respondToQuestion(
    ctx: LiveSessionContext,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) {
    const id = String(requestId);
    const pending = ctx.handles.runtime.lookupQuestion(id);
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
    return ctx.handles.client.extensionUiResponse(response).pipe(
      Effect.tap(() => Effect.sync(() => ctx.handles.runtime.removeQuestion(id))),
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
      Effect.mapError((cause) => commandFailed(ctx, "extension_ui_response", cause)),
    );
  }
});
