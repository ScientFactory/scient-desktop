// @effect-diagnostics nodeBuiltinImport:off -- The store under test is plain node:fs; the fixture follows it.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  enqueueScientThreadQueueItem,
  listScientThreadQueue,
  removeScientThreadQueueItem,
  reorderScientThreadQueue,
  scientThreadQueueStoreInternals,
  updateScientThreadQueueItem,
} from "./Store.ts";

const threadId = ThreadId.make("thread-queue-test");
const otherThreadId = ThreadId.make("thread-queue-other");

const stateDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-thread-queue-"));
  stateDirs.push(stateDir);
  return stateDir;
}

afterEach(async () => {
  await Promise.all(
    stateDirs.splice(0).map((stateDir) => NodeFSP.rm(stateDir, { recursive: true, force: true })),
  );
});

describe("scient thread queue store", () => {
  it("returns an empty queue for a thread that never queued", async () => {
    const stateDir = await makeStateDir();
    const snapshot = await listScientThreadQueue({ stateDir, threadId });
    expect(snapshot).toEqual({ threadId, items: [] });
  });

  it("enqueues items in order and persists them across reads", async () => {
    const stateDir = await makeStateDir();
    await enqueueScientThreadQueueItem({ stateDir, threadId, text: "first", attachments: [] });
    const snapshot = await enqueueScientThreadQueueItem({
      stateDir,
      threadId,
      text: "second",
      attachments: [],
    });
    expect(snapshot.items.map((item) => item.text)).toEqual(["first", "second"]);
    expect(snapshot.items[0]?.queueItemId).toMatch(/^qitem_/u);
    expect(snapshot.items[0]?.createdAt).toBeTruthy();

    const reread = await listScientThreadQueue({ stateDir, threadId });
    expect(reread).toEqual(snapshot);
  });

  it("keeps queues of different threads independent", async () => {
    const stateDir = await makeStateDir();
    await enqueueScientThreadQueueItem({ stateDir, threadId, text: "mine", attachments: [] });
    const other = await listScientThreadQueue({ stateDir, threadId: otherThreadId });
    expect(other.items).toEqual([]);
  });

  it("hashes thread IDs so arbitrary IDs cannot escape the queue directory", async () => {
    const stateDir = await makeStateDir();
    const unsafeLookingId = ThreadId.make("../escape");
    await enqueueScientThreadQueueItem({
      stateDir,
      threadId: unsafeLookingId,
      text: "still isolated",
      attachments: [],
    });
    const filePath = scientThreadQueueStoreInternals.queueFilePath(stateDir, unsafeLookingId);
    expect(NodePath.dirname(filePath)).toBe(NodePath.join(stateDir, "scient", "thread-queue"));
    expect(NodePath.basename(filePath)).toMatch(/^[a-f0-9]{64}\.json$/u);
  });

  it("migrates a queue written by the previous safe-filename format", async () => {
    const stateDir = await makeStateDir();
    const queueDir = NodePath.join(stateDir, "scient", "thread-queue");
    const legacyPath = NodePath.join(queueDir, `${threadId}.json`);
    const item = {
      queueItemId: "qitem_legacy",
      text: "legacy item",
      attachments: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await NodeFSP.mkdir(queueDir, { recursive: true });
    await NodeFSP.writeFile(
      legacyPath,
      JSON.stringify({ formatVersion: 1, threadId, items: [item] }),
      "utf8",
    );

    const migrated = await listScientThreadQueue({ stateDir, threadId });
    expect(migrated.items[0]?.text).toBe("legacy item");
    await expect(NodeFSP.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      NodeFSP.access(scientThreadQueueStoreInternals.queueFilePath(stateDir, threadId)),
    ).resolves.toBeUndefined();
  });

  it("enforces the per-thread item cap", async () => {
    const stateDir = await makeStateDir();
    for (let index = 0; index < 20; index += 1) {
      await enqueueScientThreadQueueItem({
        stateDir,
        threadId,
        text: `message ${index}`,
        attachments: [],
      });
    }
    await expect(
      enqueueScientThreadQueueItem({ stateDir, threadId, text: "one too many", attachments: [] }),
    ).rejects.toThrow("queue already holds");
  });

  it("removes an item and deletes the file when the queue drains", async () => {
    const stateDir = await makeStateDir();
    const enqueued = await enqueueScientThreadQueueItem({
      stateDir,
      threadId,
      text: "only",
      attachments: [],
    });
    const queueItemId = enqueued.items[0]!.queueItemId;
    const filePath = scientThreadQueueStoreInternals.queueFilePath(stateDir, threadId);
    await expect(NodeFSP.access(filePath)).resolves.toBeUndefined();

    const drained = await removeScientThreadQueueItem({ stateDir, threadId, queueItemId });
    expect(drained.items).toEqual([]);
    await expect(NodeFSP.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });

    // Removing an unknown item is a no-op that reports the untouched queue.
    const enqueuedAgain = await enqueueScientThreadQueueItem({
      stateDir,
      threadId,
      text: "again",
      attachments: [],
    });
    const unchanged = await removeScientThreadQueueItem({
      stateDir,
      threadId,
      queueItemId: enqueued.items[0]!.queueItemId,
    });
    expect(unchanged).toEqual(enqueuedAgain);
  });

  it("updates an item in place without changing its position or identity", async () => {
    const stateDir = await makeStateDir();
    await enqueueScientThreadQueueItem({ stateDir, threadId, text: "first", attachments: [] });
    const second = await enqueueScientThreadQueueItem({
      stateDir,
      threadId,
      text: "second",
      attachments: [],
    });
    const item = second.items[1]!;
    const updated = await updateScientThreadQueueItem({
      stateDir,
      threadId,
      queueItemId: item.queueItemId,
      text: "edited second",
      attachments: [],
    });

    expect(updated.items.map((entry) => entry.text)).toEqual(["first", "edited second"]);
    expect(updated.items[1]?.queueItemId).toBe(item.queueItemId);
    expect(updated.items[1]?.createdAt).toBe(item.createdAt);
    expect(updated.items[1]?.updatedAt).not.toBe(item.updatedAt);
    await expect(
      updateScientThreadQueueItem({
        stateDir,
        threadId,
        queueItemId: "qitem_missing",
        text: "missing",
        attachments: [],
      }),
    ).rejects.toThrow("no longer exists");
  });

  it("reorders items by full permutation and rejects stale orders", async () => {
    const stateDir = await makeStateDir();
    await enqueueScientThreadQueueItem({ stateDir, threadId, text: "a", attachments: [] });
    await enqueueScientThreadQueueItem({ stateDir, threadId, text: "b", attachments: [] });
    const enqueued = await enqueueScientThreadQueueItem({
      stateDir,
      threadId,
      text: "c",
      attachments: [],
    });
    const [a, b, c] = enqueued.items.map((item) => item.queueItemId) as [string, string, string];

    const reordered = await reorderScientThreadQueue({
      stateDir,
      threadId,
      queueItemIds: [c, a, b],
    });
    expect(reordered.items.map((item) => item.text)).toEqual(["c", "a", "b"]);

    await expect(
      reorderScientThreadQueue({ stateDir, threadId, queueItemIds: [a, b] }),
    ).rejects.toThrow("does not match");
    await expect(
      reorderScientThreadQueue({ stateDir, threadId, queueItemIds: [a, a, b] }),
    ).rejects.toThrow("does not match");
    await expect(
      reorderScientThreadQueue({
        stateDir,
        threadId,
        queueItemIds: [a, b, "qitem_00000000-0000-0000-0000-000000000000"],
      }),
    ).rejects.toThrow("does not match");
  });

  it("serializes concurrent enqueues so none are lost", async () => {
    const stateDir = await makeStateDir();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        enqueueScientThreadQueueItem({
          stateDir,
          threadId,
          text: `concurrent ${index}`,
          attachments: [],
        }),
      ),
    );
    const snapshot = await listScientThreadQueue({ stateDir, threadId });
    expect(snapshot.items).toHaveLength(8);
  });

  it("quarantines an unreadable queue file instead of looping on it", async () => {
    const stateDir = await makeStateDir();
    await enqueueScientThreadQueueItem({ stateDir, threadId, text: "kept", attachments: [] });
    const filePath = scientThreadQueueStoreInternals.queueFilePath(stateDir, threadId);
    await NodeFSP.writeFile(filePath, "{ not json", "utf8");

    await expect(listScientThreadQueue({ stateDir, threadId })).rejects.toThrow("unreadable");
    await expect(NodeFSP.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantined = await NodeFSP.readdir(NodePath.dirname(filePath));
    expect(quarantined.some((name) => name.includes(".corrupt-"))).toBe(true);

    // The next interaction starts clean.
    const recovered = await listScientThreadQueue({ stateDir, threadId });
    expect(recovered.items).toEqual([]);
  });
});
