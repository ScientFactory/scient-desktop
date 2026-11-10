// @effect-diagnostics nodeBuiltinImport:off -- Snapshot gzip uses Node's zlib.
import * as NodeZlib from "node:zlib";

import {
  CloudConversation,
  type CloudLimits,
  type SnapshotSidecar,
  type ThreadMeta,
} from "@scientfactory/scient-cloud/api";
import { DEFAULT_CLOUD_LIMITS } from "@scientfactory/scient-cloud/limits";
import type {
  ConversationSnapshotV1,
  EnvironmentId,
  ScientCloudPauseReason,
  ScientCloudSyncState,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { CloudApi, type CloudApiError } from "./CloudApi.ts";
import { markAttachments, sha256Hex, withContentDigest } from "./cloudAttachments.ts";
import { CloudSyncState, type CloudSyncStateDocument } from "./CloudSyncState.ts";
import type { ConversationExtrasResult } from "./ConversationExtras.ts";

export const SYNC_QUIET_MS = 20_000;
export const SYNC_MIN_INTERVAL_MS = 120_000;
const SYNC_TICK_MS = 5_000;
const SYNC_BATCH = 20;
const MOVED_POLL_MS = 60_000;
export const STORAGE_FULL_RECHECK_MS = 10 * 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/** What sync needs to know about one local thread. */
export interface SyncThreadFacts {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  /** No run is preparing, starting, running or waiting. */
  readonly settled: boolean;
  /** Shown in thread lists: not a subagent or side chat. */
  readonly listed: boolean;
  readonly projectKey: string;
  readonly projectLabel: string;
  readonly relativePath?: string | undefined;
  readonly repoWebUrl?: string | undefined;
  readonly branch?: string | undefined;
}

export interface SyncCapture {
  readonly snapshot: ConversationSnapshotV1;
  readonly attachmentFiles: ReadonlyMap<string, string>;
}

/** The local side of sync; the live one reads projections, the tests a fixture. */
export interface CloudSyncSourceShape {
  readonly listThreads: Effect.Effect<ReadonlyArray<SyncThreadFacts>>;
  /** Null when the thread is deleted or gone. */
  readonly thread: (threadId: ThreadId) => Effect.Effect<SyncThreadFacts | null>;
  /** Null when the thread is too large to capture or disappeared meanwhile. */
  readonly capture: (
    threadId: ThreadId,
    selection: { readonly workLog: boolean; readonly reasoning: boolean },
  ) => Effect.Effect<SyncCapture | null>;
  /** Null when the file is missing; read without loading its bytes. */
  readonly fileSize: (path: string) => Effect.Effect<number | null>;
  /** Null when the file is missing or holds more than `maxBytes`, which it never reads past. */
  readonly readFile: (path: string, maxBytes: number) => Effect.Effect<Uint8Array | null>;
  /** Per-answer provider/model and the repository commit for the sidecar and meta. */
  readonly extras: (
    threadId: ThreadId,
    snapshot: ConversationSnapshotV1,
  ) => Effect.Effect<ConversationExtrasResult>;
  /** Threads touched by domain events. */
  readonly touched: Stream.Stream<ThreadId>;
  /** Whether the cloud copy setting is on, and its changes. */
  readonly enabled: Effect.Effect<boolean>;
  readonly enabledChanges: Stream.Stream<boolean>;
}

export class CloudSyncSource extends Context.Service<CloudSyncSource, CloudSyncSourceShape>()(
  "t3/scient/cloud/CloudSync/CloudSyncSource",
) {}

export interface CloudSyncRuntimeStatus {
  readonly state: ScientCloudSyncState;
  readonly paused: { readonly reason: ScientCloudPauseReason; readonly message: string } | null;
  readonly pendingThreads: number;
  readonly usedBytes: number | null;
  readonly freeBytes: number | null;
}

export class CloudSync extends Context.Service<
  CloudSync,
  {
    readonly status: Effect.Effect<CloudSyncRuntimeStatus>;
    /** Clear a pause and reconcile again, after enrollment or the switch turning on. */
    readonly wake: Effect.Effect<void>;
    /** Runs one scheduling step now; the worker calls it every few seconds. */
    readonly tick: Effect.Effect<void>;
    /** Deletes every copy this computer uploaded and forgets them. */
    readonly deleteCopies: Effect.Effect<void, CloudApiError>;
  }
>()("t3/scient/cloud/CloudSync") {}

/** `stopped`: the switch went off or the enrollment changed mid-upload. */
type UploadOutcome = "copied" | "unchanged" | "skipped" | "gone" | "busy" | "stopped";

const encodeConversation = Schema.encodeEffect(Schema.fromJsonString(CloudConversation));

const textOf = (value: string, max: number, fallback: string) => {
  const trimmed = value.trim().slice(0, max).trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const gzip = (bytes: Uint8Array) =>
  Effect.promise(
    () =>
      new Promise<Uint8Array>((resolve, reject) =>
        NodeZlib.gzip(bytes, (error, result) => (error ? reject(error) : resolve(result))),
      ),
  );

const backoffDelayMs = (failures: number, jitter: number, retryAfterMs: number | null) => {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
  return Math.max(Math.round(base * (0.5 + jitter / 2)), retryAfterMs ?? 0);
};

export const make = Effect.gen(function* () {
  const api = yield* CloudApi;
  const store = yield* CloudSyncState;
  const source = yield* CloudSyncSource;
  const lock = yield* Semaphore.make(1);

  const dirty = new Map<ThreadId, number>();
  const lastUpload = new Map<ThreadId, number>();
  let reconciled = false;
  let failures = 0;
  let nextAttemptAt = 0;
  let lastMovedPoll = Number.NEGATIVE_INFINITY;
  let copying = false;
  let paused: { reason: ScientCloudPauseReason; message: string; until: number } | null = null;
  let limits: CloudLimits | null = null;

  const active = Effect.gen(function* () {
    const state = yield* store.get;
    if (state.userId === null) return null;
    return (yield* source.enabled) ? state.userId : null;
  });
  /** Rechecked before every request, so turning the switch off stops a batch promptly. */
  const stillActive = (userId: string) => active.pipe(Effect.map((current) => current === userId));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const recordMoved = (threadId: ThreadId, movedTo: EnvironmentId, movedAt: string) =>
    store.update((state) => ({
      ...state,
      moved: { ...state.moved, [threadId]: { movedTo, movedAt } },
    }));

  const forget = (threadId: ThreadId) =>
    store.update((state) => {
      if (!(threadId in state.threads) && !(threadId in state.skipped)) return state;
      const { [threadId]: _copied, ...threads } = state.threads;
      const { [threadId]: _skipped, ...skipped } = state.skipped;
      return { ...state, threads, skipped };
    });

  const uploadBlobs = Effect.fn("CloudSync.uploadBlobs")(function* (
    userId: string,
    threadId: ThreadId,
    files: ReadonlyMap<string, string>,
    maxBlobBytes: number,
  ) {
    const attachments: Array<NonNullable<SnapshotSidecar["attachments"]>[number]> = [];
    for (const [localId, path] of files) {
      if (!(yield* stillActive(userId))) return null;
      const bytes = yield* source.readFile(path, maxBlobBytes);
      if (bytes === null) continue;
      const sha256 = sha256Hex(bytes);
      if (!(yield* api.hasBlob(userId, sha256, threadId))) {
        // Turning Cloud copy off while the check ran stops the file before it leaves.
        if (!(yield* stillActive(userId))) return null;
        yield* api.putBlob(userId, sha256, bytes, threadId);
      }
      attachments.push({ localId, sha256, bytes: bytes.byteLength });
    }
    return attachments;
  });

  const upload = Effect.fn("CloudSync.upload")(function* (userId: string, threadId: ThreadId) {
    const facts = yield* source.thread(threadId);
    const state = yield* store.get;
    if (facts === null) {
      if (threadId in state.threads) {
        yield* api.deleteThread(userId, threadId);
        yield* forget(threadId);
      }
      return "gone" satisfies UploadOutcome;
    }
    if (!facts.listed || threadId in state.moved) return "skipped" satisfies UploadOutcome;
    if (!facts.settled) return "busy" satisfies UploadOutcome;
    const max = limits ?? DEFAULT_CLOUD_LIMITS;
    const prior = state.threads[threadId];
    let lastDigest: string | null = null;
    // The full record first; a record over the limit goes again without work log and reasoning.
    for (const full of [true, false]) {
      const capture = yield* source.capture(threadId, { workLog: full, reasoning: full });
      if (capture === null) continue;
      // Files over the per-file limit stay home, and the copy says so.
      const files = new Map<string, string>();
      for (const [localId, path] of capture.attachmentFiles) {
        const size = yield* source.fileSize(path);
        if (size !== null && size <= max.maxBlobBytes) files.set(localId, path);
      }
      const marked = markAttachments(capture.snapshot, (localId) => files.has(localId));
      const snapshot = marked === capture.snapshot ? capture.snapshot : withContentDigest(marked);
      const digest = snapshot.contentDigest;
      lastDigest = digest;
      if (state.skipped[threadId] === digest) return "skipped" satisfies UploadOutcome;
      if (
        full &&
        prior !== undefined &&
        prior.contentDigest === digest &&
        prior.archived === facts.archived &&
        prior.title === facts.title
      ) {
        yield* store.update((current) => ({
          ...current,
          threads: {
            ...current.threads,
            [threadId]: { ...prior, sourceUpdatedAt: facts.updatedAt },
          },
        }));
        return "unchanged" satisfies UploadOutcome;
      }
      const attachments = yield* uploadBlobs(userId, threadId, files, max.maxBlobBytes);
      if (attachments === null) return "stopped" satisfies UploadOutcome;
      const extras = yield* source.extras(threadId, snapshot);
      const sidecar = { ...extras.sidecar, ...(attachments.length === 0 ? {} : { attachments }) };
      const document: CloudConversation = {
        snapshot,
        ...(Object.keys(sidecar).length === 0 ? {} : { sidecar }),
      };
      const body = yield* gzip(new TextEncoder().encode(yield* encodeConversation(document)));
      if (body.byteLength > max.maxSnapshotBytes) continue;
      const continuedFrom = state.continuedFrom[threadId];
      const meta: ThreadMeta = {
        title: textOf(facts.title, 500, "Untitled conversation"),
        projectKey: textOf(facts.projectKey, 1000, "unknown"),
        projectLabel: textOf(facts.projectLabel, 200, "Project"),
        ...(facts.relativePath ? { relativePath: textOf(facts.relativePath, 1000, ".") } : {}),
        ...(facts.repoWebUrl ? { repoWebUrl: textOf(facts.repoWebUrl, 1000, "") } : {}),
        ...(facts.branch ? { branch: textOf(facts.branch, 500, "") } : {}),
        ...(extras.headCommit === undefined ? {} : { headCommit: extras.headCommit }),
        updatedAt: facts.updatedAt,
        archived: facts.archived,
        contentDigest: digest,
        generation: 0,
        ...(continuedFrom
          ? { continuedFrom: { env: continuedFrom.env, thread: continuedFrom.thread } }
          : {}),
      };
      if (!(yield* stillActive(userId))) return "stopped" satisfies UploadOutcome;
      const stored = yield* api.putThread({ userId, threadId, meta, gzip: body }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.code === "too_large",
          () => Effect.succeed(false),
        ),
      );
      if (!stored) continue;
      const uploadedAt = yield* nowIso;
      yield* store.update((current) => {
        const { [threadId]: _skipped, ...skipped } = current.skipped;
        return {
          ...current,
          skipped,
          threads: {
            ...current.threads,
            [threadId]: {
              contentDigest: digest,
              title: facts.title,
              archived: facts.archived,
              uploadedAt,
              bytes: body.byteLength,
              sourceUpdatedAt: facts.updatedAt,
            },
          },
        };
      });
      return "copied" satisfies UploadOutcome;
    }
    if (lastDigest !== null) {
      const skippedDigest = lastDigest;
      yield* store.update((current) => ({
        ...current,
        skipped: { ...current.skipped, [threadId]: skippedDigest },
      }));
    }
    yield* Effect.logInfo("Cloud copy skipped a conversation over the size limit.", { threadId });
    return "skipped" satisfies UploadOutcome;
  });

  const reconcile = Effect.fn("CloudSync.reconcile")(function* (userId: string) {
    limits = yield* api.limits(userId);
    const state = yield* store.get;
    const threads = yield* source.listThreads;
    const present = new Set<ThreadId>();
    for (const facts of threads) {
      present.add(facts.threadId);
      if (!facts.listed || facts.threadId in state.moved) continue;
      if (state.threads[facts.threadId]?.sourceUpdatedAt !== facts.updatedAt) {
        if (!dirty.has(facts.threadId)) dirty.set(facts.threadId, Number.NEGATIVE_INFINITY);
      }
    }
    for (const threadId of Object.keys(state.threads) as ThreadId[]) {
      if (!present.has(threadId)) dirty.set(threadId, Number.NEGATIVE_INFINITY);
    }
    reconciled = true;
  });

  const pollMoved = Effect.fn("CloudSync.pollMoved")(function* (userId: string) {
    const state = yield* store.get;
    const { threads } = yield* api.moved(userId, state.movedCursor ?? undefined);
    let cursor = state.movedCursor;
    for (const moved of threads) {
      yield* recordMoved(moved.threadId, moved.movedTo, moved.movedAt);
      dirty.delete(moved.threadId);
      if (cursor === null || moved.movedAt > cursor) cursor = moved.movedAt;
    }
    if (cursor !== state.movedCursor)
      yield* store.update((current) => ({ ...current, movedCursor: cursor }));
  });

  const handleFailure = Effect.fn("CloudSync.handleFailure")(function* (
    error: CloudApiError,
    threadId: ThreadId | null,
    now: number,
  ) {
    switch (error.code) {
      case "lease_lost":
        if (threadId !== null) {
          dirty.delete(threadId);
          if (error.movedTo !== null)
            yield* recordMoved(threadId, error.movedTo as EnvironmentId, yield* nowIso);
        }
        failures = 0;
        return;
      case "quota_exceeded":
        paused = {
          reason: "storage-full",
          message: "Cloud copy paused: your cloud storage is full.",
          until: now + STORAGE_FULL_RECHECK_MS,
        };
        return;
      case "unauthorized":
      case "forbidden":
        paused = {
          reason: "not-enrolled",
          message: "Cloud copy paused: this computer is no longer linked to your account.",
          until: Number.POSITIVE_INFINITY,
        };
        return;
      case "invalid_request":
      case "not_found":
      case "too_large":
        // The cloud refused this one conversation; others keep going.
        if (threadId !== null) dirty.delete(threadId);
        yield* Effect.logWarning("Cloud copy refused a conversation.", {
          threadId,
          code: error.code,
        });
        return;
      default: {
        failures += 1;
        const jitter = yield* Random.next;
        nextAttemptAt = now + backoffDelayMs(failures, jitter, error.retryAfterMs);
      }
    }
  });

  const step = Effect.fn("CloudSync.step")(function* () {
    const userId = yield* active;
    if (userId === null) {
      reconciled = false;
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    if (paused !== null) {
      if (now < paused.until) return;
      paused = null;
    }
    if (now < nextAttemptAt) return;
    let current: ThreadId | null = null;
    const attempt = Effect.gen(function* () {
      if (!reconciled) yield* reconcile(userId);
      if (now - lastMovedPoll >= MOVED_POLL_MS) {
        lastMovedPoll = now;
        yield* pollMoved(userId);
      }
      // One upload at a time, a bounded batch per step so a first copy does not take hours.
      for (let batch = 0; batch < SYNC_BATCH; batch++) {
        let pick: ThreadId | null = null;
        let pickTouched = Number.POSITIVE_INFINITY;
        for (const [threadId, touched] of dirty) {
          if (now - touched < SYNC_QUIET_MS) continue;
          if (now - (lastUpload.get(threadId) ?? Number.NEGATIVE_INFINITY) < SYNC_MIN_INTERVAL_MS)
            continue;
          if (touched < pickTouched) {
            pick = threadId;
            pickTouched = touched;
          }
        }
        if (pick === null || !(yield* stillActive(userId))) return;
        current = pick;
        copying = true;
        const outcome = yield* upload(userId, pick).pipe(
          Effect.ensuring(Effect.sync(() => (copying = false))),
        );
        if (outcome === "stopped") return;
        if (outcome === "busy") {
          dirty.set(pick, now);
          continue;
        }
        if (dirty.get(pick) === pickTouched) dirty.delete(pick);
        lastUpload.set(pick, now);
        failures = 0;
      }
    });
    yield* attempt.pipe(
      Effect.tap(() => Effect.sync(() => (failures = 0))),
      Effect.catchTags({ CloudApiError: (error) => handleFailure(error, current, now) }),
    );
  });

  const tick = lock.withPermits(1)(
    step().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Cloud copy step failed.", { cause })),
    ),
  );

  const status = Effect.gen(function* () {
    const state: CloudSyncStateDocument = yield* store.get;
    const enabled = yield* source.enabled;
    const syncState: ScientCloudSyncState = !enabled
      ? "off"
      : state.userId === null
        ? "not-enrolled"
        : paused !== null
          ? "paused"
          : copying
            ? "copying"
            : failures > 0
              ? "retrying"
              : "idle";
    return {
      state: syncState,
      paused: paused === null ? null : { reason: paused.reason, message: paused.message },
      pendingThreads: dirty.size,
      usedBytes: limits?.usedBytes ?? null,
      freeBytes: limits?.freeBytes ?? null,
    } satisfies CloudSyncRuntimeStatus;
  });

  const wake = Effect.sync(() => {
    paused = null;
    reconciled = false;
    failures = 0;
    nextAttemptAt = 0;
    lastMovedPoll = Number.NEGATIVE_INFINITY;
  });

  const deleteCopies = lock.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* store.get;
      if (state.userId === null) return;
      for (const threadId of Object.keys(state.threads) as ThreadId[]) {
        yield* api.deleteThread(state.userId, threadId);
        yield* forget(threadId);
      }
      dirty.clear();
    }),
  );

  const markTouched = (threadId: ThreadId) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => void dirty.set(threadId, now)));

  return { service: CloudSync.of({ status, wake, tick, deleteCopies }), markTouched };
});

/** The worker: marks touched threads, follows the switch, and runs a step every few seconds. */
export const layer = Layer.effect(
  CloudSync,
  Effect.gen(function* () {
    const { service, markTouched } = yield* make;
    const source = yield* CloudSyncSource;
    yield* Effect.forkScoped(Stream.runForEach(source.touched, markTouched));
    yield* Effect.forkScoped(
      Stream.runForEach(source.enabledChanges, (enabled) => (enabled ? service.wake : Effect.void)),
    );
    yield* Effect.forkScoped(
      Effect.forever(service.tick.pipe(Effect.andThen(Effect.sleep(SYNC_TICK_MS)))),
    );
    return service;
  }),
);
