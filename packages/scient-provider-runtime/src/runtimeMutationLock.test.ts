// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalRandom:off -- Tests exercise the package's private filesystem boundary.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Hooks into every filesystem call the lock makes. `jitter` delays each call
 * by a random 0-2ms, so concurrent contenders interleave in orders a quiet
 * machine rarely shows; `before` runs ahead of each call.
 */
const fsHooks = vi.hoisted(() => ({
  jitter: false,
  before: undefined as ((call: string, args: ReadonlyArray<unknown>) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const hooked =
    <Args extends unknown[], Result>(name: string, call: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      if (fsHooks.jitter) await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
      await fsHooks.before?.(name, args);
      return call(...args);
    };
  return {
    ...original,
    link: hooked("link", original.link),
    open: hooked("open", original.open),
    readFile: hooked("readFile", original.readFile),
    rename: hooked("rename", original.rename),
    rm: hooked("rm", original.rm),
    unlink: hooked("unlink", original.unlink),
    writeFile: hooked("writeFile", original.writeFile),
  };
});

import {
  ManagedRuntimeMutationLockLostError,
  tryAcquireManagedRuntimeMutationLock,
  type ManagedRuntimeMutationLock,
} from "./runtimeMutationLock.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  fsHooks.jitter = false;
  fsHooks.before = undefined;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function lockPath(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-mutation-lock-"));
  temporaryRoots.push(root);
  return NodePath.join(root, "mutation.lock");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mtimeAge(path: string): Promise<number> {
  return Date.now() - (await NodeFSP.stat(path)).mtimeMs;
}

async function backdate(path: string, ageMs: number): Promise<void> {
  const then = new Date(Date.now() - ageMs);
  await NodeFSP.utimes(path, then, then);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await sleep(10);
  }
}

/**
 * A lock left by another process whose pid now belongs to an unrelated live
 * process: the parent of this test runner is alive and is not us.
 */
function reusedPidLock(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, processId: "earlier", token: "reused", ...extra })}\n`;
}

describe("managed runtime mutation lock heartbeat", () => {
  it("reclaims a lock whose pid was reused by a live process once its heartbeat is overdue", async () => {
    const path = await lockPath();
    await NodeFSP.writeFile(path, reusedPidLock({ heartbeatIntervalMs: 15_000 }));
    await backdate(path, 2 * 60_000);

    const lock = await tryAcquireManagedRuntimeMutationLock(path);

    expect(lock).toBeDefined();
    expect(JSON.parse(await NodeFSP.readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
    await lock?.release();
    await expect(NodeFSP.access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a recently refreshed lock whose pid is live", async () => {
    const path = await lockPath();
    const raw = reusedPidLock({ heartbeatIntervalMs: 15_000 });
    await NodeFSP.writeFile(path, raw);
    await backdate(path, 30_000);

    expect(await tryAcquireManagedRuntimeMutationLock(path)).toBeUndefined();
    expect(await NodeFSP.readFile(path, "utf8")).toBe(raw);
  });

  it("falls back to the file age for a live-pid lock written before heartbeats existed", async () => {
    const path = await lockPath();
    const raw = reusedPidLock();
    await NodeFSP.writeFile(path, raw);

    // A legacy owner never refreshes, so a young legacy lock is still honored.
    expect(await tryAcquireManagedRuntimeMutationLock(path)).toBeUndefined();
    expect(await NodeFSP.readFile(path, "utf8")).toBe(raw);

    await backdate(path, 2 * 60 * 60_000);
    const lock = await tryAcquireManagedRuntimeMutationLock(path);
    expect(lock).toBeDefined();
    await lock?.release();
  });

  it("never lets a live owner that keeps refreshing be reclaimed, even past the stale bound", async () => {
    const path = await lockPath();
    const heartbeatIntervalMs = 100;
    const owner = await tryAcquireManagedRuntimeMutationLock(path, { heartbeatIntervalMs });
    expect(owner).toBeDefined();
    const ownerRecord = await NodeFSP.readFile(path, "utf8");
    const publishedAt = (await NodeFSP.stat(path)).mtimeMs;

    // Well past the 4x-interval stale bound.
    await sleep(heartbeatIntervalMs * 10);

    expect((await NodeFSP.stat(path)).mtimeMs).toBeGreaterThan(publishedAt);
    expect(await mtimeAge(path)).toBeLessThan(heartbeatIntervalMs * 4);
    expect(await tryAcquireManagedRuntimeMutationLock(path)).toBeUndefined();
    expect(await NodeFSP.readFile(path, "utf8")).toBe(ownerRecord);
    await owner?.release();
  });

  it("stops refreshing once released and never re-creates or touches a later owner's lock", async () => {
    const path = await lockPath();
    const heartbeatIntervalMs = 30;
    const first = await tryAcquireManagedRuntimeMutationLock(path, { heartbeatIntervalMs });
    expect(first).toBeDefined();
    // Prove the heartbeat is running before release.
    await backdate(path, 60_000);
    await waitFor(async () => (await mtimeAge(path)) < 5_000);

    await first?.release();
    await expect(NodeFSP.access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await sleep(heartbeatIntervalMs * 5);
    await expect(NodeFSP.access(path)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await tryAcquireManagedRuntimeMutationLock(path, {
      heartbeatIntervalMs: 60_000,
    });
    expect(second).toBeDefined();
    const secondRecord = await NodeFSP.readFile(path, "utf8");
    await backdate(path, 30_000);
    await sleep(heartbeatIntervalMs * 5);

    expect(await mtimeAge(path)).toBeGreaterThan(25_000);
    expect(await NodeFSP.readFile(path, "utf8")).toBe(secondRecord);
    await second?.release();
  });

  it("stops refreshing a lock that another owner has taken over", async () => {
    const path = await lockPath();
    const heartbeatIntervalMs = 30;
    const owner = await tryAcquireManagedRuntimeMutationLock(path, { heartbeatIntervalMs });
    expect(owner).toBeDefined();
    await backdate(path, 60_000);
    await waitFor(async () => (await mtimeAge(path)) < 5_000);

    const replacement = reusedPidLock({ heartbeatIntervalMs: 60_000 });
    await NodeFSP.rm(path);
    await NodeFSP.writeFile(path, replacement);
    await backdate(path, 30_000);
    await sleep(heartbeatIntervalMs * 5);

    expect(await mtimeAge(path)).toBeGreaterThan(25_000);
    await owner?.release();
    expect(await NodeFSP.readFile(path, "utf8")).toBe(replacement);
  });
});

/** A lock left by a process that no longer exists. */
function deadOwnerLock(token: string): string {
  // Above every platform's pid ceiling, so `kill(pid, 0)` reports ESRCH.
  return `${JSON.stringify({ schemaVersion: 1, pid: 2 ** 30 - 1, processId: "gone", token })}\n`;
}

describe("managed runtime mutation lock ownership", () => {
  it("never reclaims a lock this process still holds, however old its heartbeat looks", async () => {
    const path = await lockPath();
    const owner = await tryAcquireManagedRuntimeMutationLock(path, { heartbeatIntervalMs: 60_000 });
    expect(owner).toBeDefined();
    const ownerRecord = await NodeFSP.readFile(path, "utf8");
    // After a system sleep the wall-clock mtime lags far behind the heartbeat timer.
    await backdate(path, 2 * 60 * 60_000);

    expect(await tryAcquireManagedRuntimeMutationLock(path)).toBeUndefined();
    expect(await NodeFSP.readFile(path, "utf8")).toBe(ownerRecord);
    expect(owner?.signal.aborted).toBe(false);
    await owner?.release();
  });

  it("reclaims a lock this process left behind once it no longer holds it", async () => {
    const path = await lockPath();
    const owner = await tryAcquireManagedRuntimeMutationLock(path, { heartbeatIntervalMs: 60_000 });
    const leaked = await NodeFSP.readFile(path, "utf8");
    await owner?.release();
    // As if the release had failed to remove the file.
    await NodeFSP.writeFile(path, leaked);

    const next = await tryAcquireManagedRuntimeMutationLock(path);
    expect(next).toBeDefined();
    await next?.release();
  });

  it("aborts the owner's signal once another owner has taken the lock over", async () => {
    const path = await lockPath();
    const owner = await tryAcquireManagedRuntimeMutationLock(path, { heartbeatIntervalMs: 20 });
    expect(owner?.signal.aborted).toBe(false);

    await NodeFSP.rm(path);
    await NodeFSP.writeFile(path, reusedPidLock({ heartbeatIntervalMs: 60_000 }));

    await expect.poll(() => owner?.signal.aborted, { timeout: 2_000 }).toBe(true);
    expect(owner?.signal.reason).toBeInstanceOf(ManagedRuntimeMutationLockLostError);
    await owner?.release();
  });

  it("resolves release even when the lock can no longer be removed", async () => {
    const path = await lockPath();
    const owner = await tryAcquireManagedRuntimeMutationLock(path, { heartbeatIntervalMs: 60_000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await NodeFSP.chmod(NodePath.dirname(path), 0o500);
    try {
      await expect(owner!.release()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      await NodeFSP.chmod(NodePath.dirname(path), 0o700);
      warn.mockRestore();
    }
  });

  it("never lets a contender that acts late on a stale lock displace its replacement", async () => {
    const path = await lockPath();
    await NodeFSP.writeFile(path, deadOwnerLock("stale"));
    const late = new NodeAsyncHooks.AsyncLocalStorage<true>();
    const owners: ManagedRuntimeMutationLock[] = [];
    let observed = false;
    // Once the late contender has read the stale lock, a rival completes a
    // whole acquisition before each of its later filesystem steps.
    fsHooks.before = async (call, args) => {
      if (!late.getStore()) return;
      if (!observed) {
        observed = call === "open" && args[0] === path && args[1] === "r";
        return;
      }
      const rival = await late.exit(() => tryAcquireManagedRuntimeMutationLock(path));
      if (rival) owners.push(rival);
    };

    const lateOwner = await late.run(true, () => tryAcquireManagedRuntimeMutationLock(path));
    if (lateOwner) owners.push(lateOwner);
    fsHooks.before = undefined;

    expect(observed).toBe(true);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.signal.aborted).toBe(false);
    await Promise.all(owners.map((lock) => lock.release()));
    await expect(NodeFSP.access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never lets three concurrent contenders for a stale lock both become its owner", async () => {
    const path = await lockPath();
    fsHooks.jitter = true;
    for (let iteration = 0; iteration < 150; iteration += 1) {
      await NodeFSP.writeFile(path, deadOwnerLock(`stale-${iteration}`));

      const contenders = await Promise.all(
        Array.from({ length: 3 }, () => tryAcquireManagedRuntimeMutationLock(path)),
      );
      const owners = contenders.filter((lock) => lock !== undefined);

      expect(owners, `iteration ${iteration}`).toHaveLength(1);
      expect(owners[0]!.signal.aborted).toBe(false);
      expect(JSON.parse(await NodeFSP.readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
      await Promise.all(owners.map((lock) => lock.release()));
      await expect(NodeFSP.access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
