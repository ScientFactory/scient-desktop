// @effect-diagnostics nodeBuiltinImport:off -- Synthetic v1 migration fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { discoverLegacyQueueThreads, legacyQueueFilePath, listScientThreadQueue } from "./Store.ts";
const directories: string[] = [];
const threadId = ThreadId.make("migration-thread");
async function fixture(owner = threadId) {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-queue-migration-"));
  directories.push(stateDir);
  const path = legacyQueueFilePath(stateDir, threadId);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const raw = JSON.stringify({
    formatVersion: 1,
    threadId: owner,
    items: [
      {
        queueItemId: "qitem_old",
        text: "old message",
        attachments: [],
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      },
    ],
  });
  await NodeFSP.writeFile(path, raw);
  return { stateDir, path, raw };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
describe("legacy queue migration reader", () => {
  it("discovers unopened queues and leaves the original bytes intact", async () => {
    const f = await fixture();
    expect(await discoverLegacyQueueThreads(f.stateDir)).toEqual([threadId]);
    expect((await listScientThreadQueue({ stateDir: f.stateDir, threadId })).items[0]?.text).toBe(
      "old message",
    );
    expect(await NodeFSP.readFile(f.path, "utf8")).toBe(f.raw);
  });
  it("reads older safe thread-name files", async () => {
    const f = await fixture();
    await NodeFSP.rename(f.path, NodePath.join(NodePath.dirname(f.path), `${threadId}.json`));
    expect((await listScientThreadQueue({ stateDir: f.stateDir, threadId })).items).toHaveLength(1);
  });
  it("refuses another thread's payload", async () => {
    const f = await fixture(ThreadId.make("wrong-owner"));
    await expect(listScientThreadQueue({ stateDir: f.stateDir, threadId })).rejects.toThrow(
      "another thread",
    );
  });
  it("keeps corrupt files recoverable and reports the read error", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(f.path, "broken json");
    await expect(listScientThreadQueue({ stateDir: f.stateDir, threadId })).rejects.toThrow();
    expect(await NodeFSP.readFile(f.path, "utf8")).toBe("broken json");
    expect(await discoverLegacyQueueThreads(f.stateDir)).toEqual([]);
  });
  it("never follows traversal-shaped legacy thread IDs", async () => {
    const f = await fixture();
    expect(
      (
        await listScientThreadQueue({
          stateDir: f.stateDir,
          threadId: ThreadId.make("../../secret"),
        })
      ).items,
    ).toEqual([]);
  });
});
