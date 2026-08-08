// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises the real runtime driver.
import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { NormalizedVoiceClip } from "./errors.ts";
import {
  buildRuntimeEnvironment,
  buildWhisperServerArguments,
  LocalWhisperRuntime,
  isWhisperRuntimePlatformSupported,
  lowerWhisperProcessPriority,
  resolveWhisperInferenceTimeoutMs,
  resolveWhisperRuntimePaths,
  WhisperRuntimeError,
  type WhisperSpawn,
  type WhisperSpawnOptions,
} from "./whisperRuntime.ts";

describe("pure runtime helpers", () => {
  it("builds whisper-server arguments in the expected order", () => {
    expect(
      buildWhisperServerArguments({
        modelPath: "/m.bin",
        port: 51234,
        requestPath: "/scient-abc",
        threads: 3,
      }),
    ).toEqual([
      "--model",
      "/m.bin",
      "--host",
      "127.0.0.1",
      "--port",
      "51234",
      "--request-path",
      "/scient-abc",
      "--inference-path",
      "/inference",
      "--threads",
      "3",
      "--language",
      "auto",
      "--no-timestamps",
    ]);
  });

  it("scales the inference timeout by 3x with a floor and a hard cap", () => {
    expect(resolveWhisperInferenceTimeoutMs(1_000)).toBe(45_000); // floor
    expect(resolveWhisperInferenceTimeoutMs(60_000)).toBe(180_000); // 3x
    expect(resolveWhisperInferenceTimeoutMs(10_000_000)).toBe(360_000); // cap
    expect(resolveWhisperInferenceTimeoutMs(1_000, 1_000)).toBe(3_000); // custom floor, 3x wins
  });

  it("resolves runtime paths for packaged/dev and windows/posix", () => {
    const packaged = resolveWhisperRuntimePaths({
      isPackaged: true,
      resourcesPath: "/res",
      desktopRuntimeDirectory: "/dev",
      platform: "linux",
    });
    expect(packaged.runtimeDirectory).toBe("/res/whisper-runtime");
    expect(packaged.executablePath).toBe("/res/whisper-runtime/whisper-server");

    const dev = resolveWhisperRuntimePaths({
      isPackaged: false,
      resourcesPath: "/res",
      desktopRuntimeDirectory: "/dev",
      platform: "linux",
    });
    expect(dev.runtimeDirectory).toBe("/dev/whisper-runtime");

    const win = resolveWhisperRuntimePaths({
      isPackaged: true,
      resourcesPath: "C:\\res",
      desktopRuntimeDirectory: "C:\\dev",
      platform: "win32",
    });
    expect(win.executablePath.endsWith("whisper-server.exe")).toBe(true);
  });

  it("prepends the runtime dir to LD_LIBRARY_PATH only on linux", () => {
    expect(
      buildRuntimeEnvironment("/rt", "linux", { LD_LIBRARY_PATH: "/existing" }).LD_LIBRARY_PATH,
    ).toBe("/rt:/existing");
    expect(buildRuntimeEnvironment("/rt", "linux", {}).LD_LIBRARY_PATH).toBe("/rt");
    expect(buildRuntimeEnvironment("/rt", "darwin", {}).LD_LIBRARY_PATH).toBeUndefined();
  });

  it("does not forward application credentials to the native helper", () => {
    const environment = buildRuntimeEnvironment("/rt", "linux", {
      PATH: "/bin",
      HOME: "/home/test",
      OPENAI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(environment.PATH).toBe("/bin");
    expect(environment.HOME).toBe("/home/test");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("lowers process priority defensively", () => {
    const calls: Array<[number, number]> = [];
    expect(lowerWhisperProcessPriority(123, (pid, prio) => calls.push([pid, prio]))).toBe(true);
    expect(calls).toEqual([[123, 10]]);
    expect(lowerWhisperProcessPriority(undefined, () => undefined)).toBe(false);
    expect(
      lowerWhisperProcessPriority(123, () => {
        throw new Error("EPERM");
      }),
    ).toBe(false);
  });

  it("fails closed below the native helper's macOS deployment target", () => {
    expect(isWhisperRuntimePlatformSupported("darwin", "20.6.0")).toBe(false);
    expect(isWhisperRuntimePlatformSupported("darwin", "21.0.0")).toBe(true);
    expect(isWhisperRuntimePlatformSupported("darwin", "not-a-version")).toBe(false);
    expect(isWhisperRuntimePlatformSupported("linux", "not-a-version")).toBe(true);
  });
});

class FakeChild extends NodeEvents.EventEmitter {
  pid = 999_999; // improbable pid; NodeOS.setPriority will safely no-op
  exitCode: number | null = null;
  killed = false;
  readonly stdout = { on: (): undefined => undefined };
  readonly stderr = { on: (): undefined => undefined };

  kill(): boolean {
    if (this.exitCode === null) {
      this.killed = true;
      this.exitCode = 0;
      this.emit("exit", 0, null);
    }
    return true;
  }
}

class ControlledExitChild extends FakeChild {
  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (signal === "SIGKILL") this.finishExit();
    return true;
  }

  finishExit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

interface Harness {
  readonly runtime: LocalWhisperRuntime;
  readonly spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: WhisperSpawnOptions;
  }>;
  readonly posts: Array<{ url: string; method: string }>;
  maxConcurrent: number;
  readonly cleanup: () => Promise<void>;
}

async function makeHarness(child: FakeChild = new FakeChild()): Promise<Harness> {
  const runtimeDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-voice-rt-"),
  );
  await NodeFSP.writeFile(NodePath.join(runtimeDirectory, "whisper-server"), "#!/bin/sh\n");

  const spawnCalls: Harness["spawnCalls"] = [];
  const spawnImpl: WhisperSpawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
  };

  const posts: Harness["posts"] = [];
  const harness: Partial<Harness> = { maxConcurrent: 0 };
  let active = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (method === "OPTIONS") {
      return new Response(null, { status: 200 });
    }
    posts.push({ url: target, method });
    active += 1;
    harness.maxConcurrent = Math.max(harness.maxConcurrent ?? 0, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(JSON.stringify({ text: "hello world" }), { status: 200 });
  }) as unknown as typeof fetch;

  const runtime = new LocalWhisperRuntime({
    runtimeDirectory,
    platform: "linux",
    idleTimeoutMs: 60_000,
    fetchImpl,
    spawnImpl,
  });

  return Object.assign(harness, {
    runtime,
    spawnCalls,
    posts,
    cleanup: async () => {
      await runtime.dispose();
      await NodeFSP.rm(runtimeDirectory, { recursive: true, force: true });
    },
  }) as Harness;
}

const CLIP: NormalizedVoiceClip = {
  audioBytes: new Uint8Array([1, 2, 3, 4]),
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 500,
};

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.cleanup()));
});

async function harness(child?: FakeChild): Promise<Harness> {
  const h = await makeHarness(child);
  harnesses.push(h);
  return h;
}

describe("LocalWhisperRuntime lifecycle", () => {
  it("starts the server, posts to the secret inference endpoint, and returns text", async () => {
    const h = await harness();
    const result = await h.runtime.transcribe("/model.bin", CLIP, {
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("hello world");
    expect(h.spawnCalls).toHaveLength(1);
    const call = h.spawnCalls[0];
    expect(call?.command.endsWith("whisper-server")).toBe(true);
    expect(call?.args).toContain("--model");
    expect(call?.args).toContain("/model.bin");
    expect(call?.args).toContain("--inference-path");
    // Linux env wiring is applied.
    expect(call?.options.env.LD_LIBRARY_PATH).toBeDefined();

    const endpoint = h.posts[0]?.url ?? "";
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/scient-[0-9a-f]{48}\/inference$/u);
  });

  it("accepts an empty transcript as valid no-speech output", async () => {
    const runtimeDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-voice-empty-"),
    );
    await NodeFSP.writeFile(NodePath.join(runtimeDirectory, "whisper-server"), "#!/bin/sh\n");
    const child = new FakeChild();
    const runtime = new LocalWhisperRuntime({
      runtimeDirectory,
      platform: "linux",
      spawnImpl: (() =>
        child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams) as WhisperSpawn,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) =>
        (init?.method ?? "GET") === "OPTIONS"
          ? new Response(null, { status: 200 })
          : new Response(JSON.stringify({ text: "" }), { status: 200 })) as typeof fetch,
    });
    await expect(
      runtime.transcribe("/model.bin", CLIP, { signal: new AbortController().signal }),
    ).resolves.toEqual({ text: "" });
    await runtime.dispose();
    await NodeFSP.rm(runtimeDirectory, { recursive: true, force: true });
  });

  it("reuses one process and serializes concurrent requests (single-flight)", async () => {
    const h = await harness();
    const [a, b] = await Promise.all([
      h.runtime.transcribe("/model.bin", CLIP, { signal: new AbortController().signal }),
      h.runtime.transcribe("/model.bin", CLIP, { signal: new AbortController().signal }),
    ]);
    expect(a.text).toBe("hello world");
    expect(b.text).toBe("hello world");
    expect(h.spawnCalls).toHaveLength(1); // process reused
    expect(h.maxConcurrent).toBe(1); // never two inferences at once
  });

  it("does not spawn when the signal is already aborted", async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort(new Error("nope"));
    await expect(
      h.runtime.transcribe("/model.bin", CLIP, { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("throws a disposed error after dispose()", async () => {
    const h = await harness();
    await h.runtime.dispose();
    await expect(
      h.runtime.transcribe("/model.bin", CLIP, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(WhisperRuntimeError);
  });

  it("stopIdle kills the running process when not busy", async () => {
    const h = await harness();
    await h.runtime.transcribe("/model.bin", CLIP, { signal: new AbortController().signal });
    await expect(h.runtime.stopIdle()).resolves.toBeUndefined();
    expect(h.spawnCalls).toHaveLength(1);
  });

  it("waits for the helper process to exit during disposal", async () => {
    const child = new ControlledExitChild();
    const h = await harness(child);
    await h.runtime.transcribe("/model.bin", CLIP, {
      signal: new AbortController().signal,
    });

    let disposed = false;
    const disposal = h.runtime.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(child.killed).toBe(true);
    expect(disposed).toBe(false);

    child.finishExit();
    await disposal;
    expect(disposed).toBe(true);
  });

  it("fails installation checks when the executable is missing", async () => {
    const runtime = new LocalWhisperRuntime({
      runtimeDirectory: NodePath.join(NodeOS.tmpdir(), "scient-voice-missing-runtime"),
      platform: "linux",
      fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      spawnImpl: (() => {
        throw new Error("should not spawn");
      }) as unknown as WhisperSpawn,
    });
    expect(await runtime.isInstalled()).toBe(false);
    await expect(
      runtime.transcribe("/model.bin", CLIP, { signal: new AbortController().signal }),
    ).rejects.toThrow(/runtime is missing/u);
    await runtime.dispose();
  });
});
