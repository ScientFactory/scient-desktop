// @effect-diagnostics nodeBuiltinImport:off -- The test reads uploaded bodies back with Node's zlib.
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import { CloudConversation, type MovedThreadsResponse } from "@scientfactory/scient-cloud/api";
import { DEFAULT_CLOUD_LIMITS } from "@scientfactory/scient-cloud/limits";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { capturedSnapshot } from "../conversationFile/scic.test-fixtures.ts";
import { CloudApi, CloudApiError, type CloudApiShape } from "./CloudApi.ts";
import {
  CloudSyncSource,
  STORAGE_FULL_RECHECK_MS,
  SYNC_MIN_INTERVAL_MS,
  SYNC_QUIET_MS,
  type SyncThreadFacts,
  make,
} from "./CloudSync.ts";
import {
  CloudLeaseGuard,
  CloudSyncState,
  emptyCloudSyncState,
  layerInMemory,
} from "./CloudSyncState.ts";

const THREAD = ThreadId.make("thread-1");
const decodeDocument = Schema.decodeUnknownSync(Schema.fromJsonString(CloudConversation));
const OTHER = EnvironmentId.make("env-b");

const apiError = (
  code: CloudApiError["code"],
  extra: { retryAfterMs?: number; movedTo?: string } = {},
) =>
  new CloudApiError({
    code,
    status: null,
    message: code,
    movedTo: extra.movedTo ?? null,
    retryAfterMs: extra.retryAfterMs ?? null,
  });

const facts = (overrides: Partial<SyncThreadFacts> = {}): SyncThreadFacts => ({
  threadId: THREAD,
  title: "Export design",
  updatedAt: "2026-11-10T10:00:00.000Z",
  archived: false,
  settled: true,
  listed: true,
  projectKey: "github.com/acme/lab",
  projectLabel: "lab",
  ...overrides,
});

const harness = Effect.gen(function* () {
  const threads = new Map<ThreadId, SyncThreadFacts>([[THREAD, facts()]]);
  const digests = new Map<ThreadId, string>([[THREAD, `sha256:${"1".repeat(64)}`]]);
  const puts: Array<{ threadId: ThreadId; generation: number; digest: string; gzip: Uint8Array }> =
    [];
  /** Local attachment files of THREAD by localId, with their sizes on disk. */
  const files = new Map<string, { path: string; size: number }>([
    ["thread-1-aaaa", { path: "/lab/figure.png", size: 8 }],
    ["thread-1-bbbb", { path: "/lab/paper.pdf", size: 9 }],
  ]);
  const reads: string[] = [];
  const blobChecks: string[] = [];
  let onBlobCheck = () => {};
  const deletes: ThreadId[] = [];
  const putFailures: CloudApiError[] = [];
  let moved: MovedThreadsResponse["threads"] = [];
  let enabled = true;

  const api: CloudApiShape = {
    cloudUrl: "https://cloud.test",
    environmentId: Effect.succeed(EnvironmentId.make("env-a")),
    label: Effect.succeed("Lab Mac"),
    publicJwk: Effect.die("unused"),
    enrollmentProof: () => Effect.die("unused"),
    limits: () => Effect.succeed({ ...DEFAULT_CLOUD_LIMITS, usedBytes: 0 }),
    putThread: ({ threadId, meta, gzip }) => {
      const failure = putFailures.shift();
      if (failure !== undefined) return Effect.fail(failure);
      puts.push({ threadId, generation: meta.generation, digest: meta.contentDigest, gzip });
      return Effect.succeed({ status: "stored" as const });
    },
    deleteThread: (_userId, threadId) => Effect.sync(() => void deletes.push(threadId)),
    hasBlob: (_userId, sha256) =>
      Effect.sync(() => {
        blobChecks.push(sha256);
        onBlobCheck();
        return true;
      }),
    putBlob: () => Effect.void,
    moved: () => Effect.sync(() => ({ threads: moved })),
    getThread: () => Effect.die("unused"),
    getBlob: () => Effect.die("unused"),
  };

  const source = CloudSyncSource.of({
    listThreads: Effect.sync(() => [...threads.values()]),
    thread: (threadId) => Effect.sync(() => threads.get(threadId) ?? null),
    capture: (threadId) =>
      Effect.sync(() => {
        const digest = digests.get(threadId);
        return digest === undefined
          ? null
          : {
              snapshot: { ...capturedSnapshot, contentDigest: digest },
              attachmentFiles: new Map(
                threadId === THREAD
                  ? [...files].map(([localId, file]) => [localId, file.path] as const)
                  : [],
              ),
            };
      }),
    fileSize: (path) =>
      Effect.sync(() => [...files.values()].find((file) => file.path === path)?.size ?? null),
    readFile: (path, maxBytes) =>
      Effect.sync(() => {
        reads.push(path);
        const size = [...files.values()].find((file) => file.path === path)?.size;
        return size === undefined || size > maxBytes ? null : new Uint8Array(size).fill(7);
      }),
    extras: () => Effect.succeed({ sidecar: {} }),
    touched: Stream.empty,
    enabled: Effect.sync(() => enabled),
    enabledChanges: Stream.empty,
  });

  const context = yield* Effect.context<CloudSyncState | CloudLeaseGuard>();
  const store = yield* CloudSyncState;
  const guard = yield* CloudLeaseGuard;
  const { service, markTouched } = yield* make.pipe(
    Effect.provideService(CloudApi, api),
    Effect.provideService(CloudSyncSource, source),
    Effect.provide(context),
  );
  return {
    sync: service,
    store,
    guard,
    threads,
    digests,
    puts,
    deletes,
    putFailures,
    files,
    reads,
    blobChecks,
    onBlobCheck: (run: () => void) => (onBlobCheck = run),
    touch: markTouched,
    setMoved: (value: MovedThreadsResponse["threads"]) => (moved = value),
    setEnabled: (value: boolean) => (enabled = value),
  };
}).pipe(Effect.provide(layerInMemory({ ...emptyCloudSyncState, userId: "user_1" })));

const advance = (ms: number) => TestClock.adjust(ms);

describe("CloudSync", () => {
  it.effect("copies a settled thread, skips an unchanged digest and copies a new one", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);
      expect(h.puts[0]?.generation).toBe(0);

      // Touched again, but within the per-thread interval: nothing new goes up.
      yield* h.touch(THREAD);
      yield* advance(SYNC_QUIET_MS + 1);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);

      // After the interval the same digest is recognised and skipped.
      yield* advance(SYNC_MIN_INTERVAL_MS);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);

      h.digests.set(THREAD, `sha256:${"2".repeat(64)}`);
      yield* h.touch(THREAD);
      yield* advance(SYNC_MIN_INTERVAL_MS);
      yield* h.sync.tick;
      expect(h.puts.map((put) => put.digest)).toEqual([
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
      ]);
      expect((yield* h.store.get).threads[THREAD]?.contentDigest).toBe(`sha256:${"2".repeat(64)}`);
    }),
  );

  it.effect("waits for a running turn to settle and for the thread to go quiet", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.threads.set(THREAD, facts({ settled: false }));
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
      h.threads.set(THREAD, facts());
      yield* advance(SYNC_QUIET_MS - 1);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
      yield* advance(2);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);
    }),
  );

  it.effect("backs off after a network failure and honours Retry-After", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.putFailures.push(apiError("network", { retryAfterMs: 30_000 }));
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
      expect((yield* h.sync.status).state).toBe("retrying");
      yield* advance(20_000);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
      expect(h.putFailures).toHaveLength(0);
      yield* advance(10_001);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);
      expect((yield* h.sync.status).state).toBe("idle");
    }),
  );

  it.effect("pauses when cloud storage is full and tries again later", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.putFailures.push(apiError("quota_exceeded"));
      yield* h.sync.tick;
      const paused = yield* h.sync.status;
      expect(paused.state).toBe("paused");
      expect(paused.paused?.reason).toBe("storage-full");
      yield* advance(STORAGE_FULL_RECHECK_MS - 1);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
      yield* advance(2);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);
    }),
  );

  it.effect("records a lost lease, stops copying the thread, and the guard refuses it", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      expect(yield* h.guard.movedTo(THREAD)).toBeUndefined();
      h.putFailures.push(apiError("lease_lost", { movedTo: OTHER }));
      yield* h.sync.tick;
      expect((yield* h.guard.movedTo(THREAD))?.movedTo).toBe(OTHER);
      h.digests.set(THREAD, `sha256:${"3".repeat(64)}`);
      yield* h.touch(THREAD);
      yield* advance(SYNC_MIN_INTERVAL_MS + SYNC_QUIET_MS);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
    }),
  );

  it.effect("learns moved threads from the cloud's moved list", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.setMoved([
        { threadId: THREAD, movedTo: OTHER, generation: 1, movedAt: "2026-11-10T11:00:00.000Z" },
      ]);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
      const state = yield* h.store.get;
      expect(state.moved[THREAD]?.movedTo).toBe(OTHER);
      expect(state.movedCursor).toBe("2026-11-10T11:00:00.000Z");
    }),
  );

  it.effect("deletes the cloud copy of a deleted thread", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);
      h.threads.delete(THREAD);
      yield* h.touch(THREAD);
      yield* advance(SYNC_MIN_INTERVAL_MS + SYNC_QUIET_MS);
      yield* h.sync.tick;
      expect(h.deletes).toEqual([THREAD]);
      expect((yield* h.store.get).threads[THREAD]).toBeUndefined();
    }),
  );

  it.effect("does nothing while the switch is off", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.setEnabled(false);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(0);
      expect((yield* h.sync.status).state).toBe("off");
    }),
  );
  it.effect("leaves a file over the size limit unread and says so in the copy", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.files.set("thread-1-bbbb", {
        path: "/lab/paper.pdf",
        size: DEFAULT_CLOUD_LIMITS.maxBlobBytes + 1,
      });
      yield* h.sync.tick;
      expect(h.reads).toEqual(["/lab/figure.png"]);
      const { snapshot, sidecar } = decodeDocument(
        new TextDecoder().decode(NodeZlib.gunzipSync(h.puts[0]!.gzip)),
      );
      const available = Object.fromEntries(
        snapshot.messages[0]!.attachments.map((a) => [a.localId, a.available]),
      );
      expect(available).toEqual({
        "thread-1-aaaa": true,
        "thread-1-bbbb": false,
        "thread-1-cccc": false,
      });
      expect(sidecar?.attachments?.map((entry) => entry.localId)).toEqual(["thread-1-aaaa"]);
      expect(snapshot.contentDigest).toBe(h.puts[0]!.digest);
      expect(snapshot.contentDigest).not.toBe(capturedSnapshot.contentDigest);
    }),
  );

  it.effect("stops mid-upload when the switch turns off, and copies once it is back on", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.files.set("thread-1-bbbb", { path: "/lab/paper.pdf", size: 9 });
      h.onBlobCheck(() => h.setEnabled(false));
      yield* h.sync.tick;
      expect(h.blobChecks).toHaveLength(1);
      expect(h.puts).toHaveLength(0);
      expect((yield* h.store.get).threads[THREAD]).toBeUndefined();

      h.onBlobCheck(() => {});
      h.setEnabled(true);
      yield* h.sync.tick;
      expect(h.puts).toHaveLength(1);
    }),
  );
});
