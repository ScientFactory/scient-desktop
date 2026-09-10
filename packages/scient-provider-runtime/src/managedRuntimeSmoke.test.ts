// @effect-diagnostics nodeBuiltinImport:off -- Tests control the package's owned subprocess boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveReviewedCursorArtifact } from "./cursorManifest.ts";
import { ManagedCursorRuntime } from "./managedCursorRuntime.ts";
import { smokeManagedRuntimeExecutable } from "./managedProviderRuntime.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function makeChild() {
  return Object.assign(new NodeEvents.EventEmitter(), {
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kill: vi.fn(() => true),
  });
}

let child: ReturnType<typeof makeChild>;

beforeEach(() => {
  vi.useFakeTimers();
  child = makeChild();
  vi.mocked(NodeChildProcess.spawn).mockReturnValue(
    child as unknown as ReturnType<typeof NodeChildProcess.spawn>,
  );
});

afterEach(() => {
  child.stdout.destroy();
  child.stderr.destroy();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function startProbe(signal?: AbortSignal) {
  const settled = vi.fn();
  const result = smokeManagedRuntimeExecutable("cursor", ["--version"], "Cursor", {}, { signal });
  void result.then(() => settled("success"), settled);
  return { result, settled };
}

describe("managed runtime smoke process lifetime", () => {
  it("does not release the payload on exit before the process streams close", async () => {
    const { result, settled } = startProbe();
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();

    child.emit("close", 0, null);
    await expect(result).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for closure on a nonzero exit too", async () => {
    const { result, settled } = startProbe();
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", 1, null);
    await expect(result).rejects.toThrow("smoke test failed with code 1");
  });

  it("preserves the spawn error and settles once after close", async () => {
    const { result, settled } = startProbe();
    const cause = new Error("spawn ENOENT");
    child.emit("error", cause);
    child.emit("close", -2, null);
    await expect(result).rejects.toMatchObject({ cause });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills an overproducing probe but waits for closure before cleanup can proceed", async () => {
    const { result, settled } = startProbe();
    child.stdout.emit("data", Buffer.alloc(65 * 1024));
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null, "SIGKILL");
    await expect(result).rejects.toThrow("excessive output");
  });

  it("force-stops a timed-out probe without releasing staging early", async () => {
    const { result, settled } = startProbe();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null, "SIGKILL");
    await expect(result).rejects.toThrow("timed out");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for closure after cancellation and removes its abort listener", async () => {
    const controller = new AbortController();
    const { result, settled } = startProbe(controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null, "SIGKILL");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not spawn an already-cancelled probe or kill a completed one", async () => {
    await expect(startProbe(AbortSignal.abort()).result).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(NodeChildProcess.spawn).not.toHaveBeenCalled();

    const controller = new AbortController();
    const { result } = startProbe(controller.signal);
    child.emit("close", 0, null);
    await result;
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("keeps the actual runtime activation behind probe closure", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cursor-smoke-"));
    const spawned = Promise.withResolvers<void>();
    vi.mocked(NodeChildProcess.spawn).mockImplementation(() => {
      spawned.resolve();
      return child as unknown as ReturnType<typeof NodeChildProcess.spawn>;
    });
    const artifact = resolveReviewedCursorArtifact({ platform: "win32", arch: "x64" })!;
    const stages: string[] = [];
    const runtime = new ManagedCursorRuntime(root, {
      download: async ({ destination }) => {
        await NodeFSP.writeFile(destination, "fixture");
      },
      verify: async () => {},
      materialize: async ({ destination, executablePath }) => {
        await NodeFSP.mkdir(NodePath.join(destination, "dist-package"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(destination, "dist-package/node.exe"), "fixture");
        const executable = NodePath.join(destination, executablePath);
        await NodeFSP.writeFile(executable, "fixture");
        return executable;
      },
    });
    const installing = runtime.install({
      artifact,
      signal: new AbortController().signal,
      onProgress: ({ stage }) => stages.push(stage),
    });
    try {
      await spawned.promise;
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(stages).not.toContain("activating");
      expect(await runtime.readState()).toBeUndefined();

      child.emit("close", 0, null);
      await expect(installing).resolves.toMatchObject({
        installed: true,
        activeVersion: artifact.version,
      });
      expect(stages.at(-1)).toBe("activating");
    } finally {
      child.emit("close", 0, null);
      await installing.catch(() => undefined);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
