// @effect-diagnostics nodeBuiltinImport:off -- The queue store persists plain JSON files.
// @effect-diagnostics globalDate:off -- Queue timestamps are interoperable ISO strings.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD,
  ScientThreadQueueItem,
  type ScientThreadQueueItemId,
  type ScientThreadQueueSnapshot,
  type ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Scient thread queue store.
 *
 * One JSON document per thread under `<stateDir>/scient/thread-queue/`. The
 * queue is a holding area, not an orchestration concept: items become real
 * messages only when the client dispatches them through `thread.turn.start`.
 * Writes are atomic (temp file + rename) and serialized per thread so a
 * double-click or racing devices cannot interleave partial updates.
 *
 * This module is Scient-owned end to end. See
 * `docs/internals/scient-thread-queue.md`.
 */

const PersistedThreadQueue = Schema.Struct({
  formatVersion: Schema.Literal(1),
  threadId: Schema.String,
  items: Schema.Array(ScientThreadQueueItem),
});
const decodePersistedThreadQueue = Schema.decodeUnknownSync(PersistedThreadQueue);

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function queueFilePath(stateDir: string, threadId: ThreadId): string {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new Error("The thread ID is not safe to address a thread queue.");
  }
  return NodePath.join(stateDir, "scient", "thread-queue", `${threadId}.json`);
}

async function writeQueueAtomic(filePath: string, snapshot: ScientThreadQueueSnapshot) {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporaryPath, JSON.stringify({ formatVersion: 1, ...snapshot }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await NodeFSP.rename(temporaryPath, filePath);
}

async function readQueueFromPath(
  filePath: string,
  threadId: ThreadId,
): Promise<ScientThreadQueueSnapshot> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { threadId, items: [] };
    }
    throw error;
  }
  try {
    const decoded = decodePersistedThreadQueue(JSON.parse(raw));
    if (decoded.threadId !== threadId) {
      throw new Error("The stored queue belongs to another thread.");
    }
    return { threadId, items: decoded.items };
  } catch (error) {
    // Never trap the user behind an undecodable file: move it aside once and
    // start from an empty queue. The quarantined copy keeps the evidence.
    const quarantinePath = `${filePath}.corrupt-${NodeCrypto.randomUUID()}`;
    await NodeFSP.rename(filePath, quarantinePath).catch(() => undefined);
    throw error instanceof Error
      ? new Error(`The stored thread queue is unreadable and was moved aside: ${error.message}`)
      : error;
  }
}

// Per-file promise lanes serialize mutations without blocking unrelated
// threads. The lane map stays bounded because entries are removed as soon as
// the tail settles.
const queueLanes = new Map<string, Promise<unknown>>();

async function withQueueLane<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = queueLanes.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  queueLanes.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
    if (queueLanes.get(key) === tail) queueLanes.delete(key);
  }
}

function withLane<A>(
  stateDir: string,
  threadId: ThreadId,
  run: (filePath: string) => Promise<A>,
): Promise<A> {
  const filePath = queueFilePath(stateDir, threadId);
  return withQueueLane(filePath, () => run(filePath));
}

export async function listScientThreadQueue(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
}): Promise<ScientThreadQueueSnapshot> {
  return withLane(input.stateDir, input.threadId, (filePath) =>
    readQueueFromPath(filePath, input.threadId),
  );
}

export async function enqueueScientThreadQueueItem(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
}): Promise<ScientThreadQueueSnapshot> {
  return withLane(input.stateDir, input.threadId, async (filePath) => {
    const current = await readQueueFromPath(filePath, input.threadId);
    if (current.items.length >= SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD) {
      throw new Error(
        `The queue already holds ${SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD} messages. Send or delete one before queueing more.`,
      );
    }
    const now = new Date().toISOString();
    const next: ScientThreadQueueSnapshot = {
      threadId: input.threadId,
      items: [
        ...current.items,
        {
          queueItemId: `qitem_${NodeCrypto.randomUUID()}`,
          text: input.text,
          attachments: [...input.attachments],
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    await writeQueueAtomic(filePath, next);
    return next;
  });
}

export async function removeScientThreadQueueItem(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly queueItemId: ScientThreadQueueItemId;
}): Promise<ScientThreadQueueSnapshot> {
  return withLane(input.stateDir, input.threadId, async (filePath) => {
    const current = await readQueueFromPath(filePath, input.threadId);
    const next: ScientThreadQueueSnapshot = {
      threadId: input.threadId,
      items: current.items.filter((item) => item.queueItemId !== input.queueItemId),
    };
    if (next.items.length === current.items.length) {
      return current;
    }
    if (next.items.length === 0) {
      await NodeFSP.rm(filePath, { force: true });
      return next;
    }
    await writeQueueAtomic(filePath, next);
    return next;
  });
}

export async function reorderScientThreadQueue(input: {
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly queueItemIds: ReadonlyArray<ScientThreadQueueItemId>;
}): Promise<ScientThreadQueueSnapshot> {
  return withLane(input.stateDir, input.threadId, async (filePath) => {
    const current = await readQueueFromPath(filePath, input.threadId);
    const rank = new Map(input.queueItemIds.map((id, index) => [id, index] as const));
    if (
      rank.size !== input.queueItemIds.length ||
      rank.size !== current.items.length ||
      current.items.some((item) => !rank.has(item.queueItemId))
    ) {
      throw new Error("The queue order does not match the current queue. Refresh and try again.");
    }
    const next: ScientThreadQueueSnapshot = {
      threadId: input.threadId,
      items: [...current.items].sort(
        (left, right) => rank.get(left.queueItemId)! - rank.get(right.queueItemId)!,
      ),
    };
    await writeQueueAtomic(filePath, next);
    return next;
  });
}

/** Test-only introspection: the store keeps no other module state. */
export const scientThreadQueueStoreInternals = {
  queueFilePath,
  lanes: queueLanes,
};
