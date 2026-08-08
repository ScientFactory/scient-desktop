// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - pure Node core, no Effect runtime.
// Owns a private loopback whisper.cpp `whisper-server` process and serializes
// inference requests through it.
//
// Lifted from the old app's `localWhisperRuntime.ts`. Design preserved:
//   - a loopback (127.0.0.1) HTTP server on a randomly reserved port,
//   - a per-process secret request-path so nothing else on the host can call it,
//   - a single-flight queue (one inference at a time),
//   - an idle shutdown timer, a per-clip inference timeout, and kill-on-abort,
//   - lowered OS process priority, and LD_LIBRARY_PATH wiring on Linux.
//
// `spawnImpl` and `fetchImpl` are injectable so the lifecycle is unit-testable
// without the real whisper binary.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { NormalizedVoiceClip } from "./errors.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_INFERENCE_TIMEOUT_MS = 45_000;
const MAX_INFERENCE_TIMEOUT_MS = 6 * 60_000;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const MAX_THREADS = 4;
const MINIMUM_VOICE_DARWIN_MAJOR = 21; // macOS 12 Monterey

/** Low-level result of a single inference (no engine tag; the engine adds that). */
export interface WhisperInferenceResult {
  readonly text: string;
}

export interface WhisperTranscribeOptions {
  readonly signal: AbortSignal;
  readonly language?: string;
}

export interface WhisperSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly windowsHide: boolean;
}

export type WhisperSpawn = (
  command: string,
  args: readonly string[],
  options: WhisperSpawnOptions,
) => NodeChildProcess.ChildProcessWithoutNullStreams;

export interface LocalWhisperRuntimeOptions {
  readonly runtimeDirectory: string;
  readonly fetchImpl?: typeof fetch;
  readonly spawnImpl?: WhisperSpawn;
  readonly idleTimeoutMs?: number;
  readonly threads?: number;
  readonly inferenceTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly osRelease?: () => string;
}

export interface WhisperRuntimePaths {
  readonly runtimeDirectory: string;
  readonly executablePath: string;
}

export class WhisperRuntimeError extends Error {
  readonly kind: "timeout" | "busy" | "disposed";

  constructor(kind: "timeout" | "busy" | "disposed", message: string) {
    super(message);
    this.name = "WhisperRuntimeError";
    this.kind = kind;
  }
}

const defaultWhisperSpawn: WhisperSpawn = (command, args, options) =>
  NodeChildProcess.spawn(command, [...args], options);

export function resolveWhisperInferenceTimeoutMs(
  clipDurationMs: number,
  configuredFloorMs = DEFAULT_INFERENCE_TIMEOUT_MS,
): number {
  return Math.min(
    MAX_INFERENCE_TIMEOUT_MS,
    Math.max(configuredFloorMs, Math.max(1, clipDurationMs) * 3),
  );
}

export function resolveWhisperRuntimePaths(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly desktopRuntimeDirectory: string;
  readonly platform?: NodeJS.Platform;
}): WhisperRuntimePaths {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- non-Effect path helper; platform is injectable.
  const platform = input.platform ?? NodeOS.platform();
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const runtimeDirectory = input.isPackaged
    ? pathApi.join(input.resourcesPath, "whisper-runtime")
    : pathApi.join(input.desktopRuntimeDirectory, "whisper-runtime");
  return {
    runtimeDirectory,
    executablePath: pathApi.join(
      runtimeDirectory,
      platform === "win32" ? "whisper-server.exe" : "whisper-server",
    ),
  };
}

export function buildWhisperServerArguments(input: {
  readonly modelPath: string;
  readonly port: number;
  readonly requestPath: string;
  readonly threads: number;
}): string[] {
  return [
    "--model",
    input.modelPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(input.port),
    "--request-path",
    input.requestPath,
    "--inference-path",
    "/inference",
    "--threads",
    String(input.threads),
    "--language",
    "auto",
    "--no-timestamps",
  ];
}

/**
 * Build the child-process environment. On Linux the runtime directory is
 * prepended to `LD_LIBRARY_PATH` so the bundled shared libraries resolve.
 */
export function buildRuntimeEnvironment(
  runtimeDirectory: string,
  platform: NodeJS.Platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Do not forward provider tokens, cloud credentials, or unrelated app
  // configuration into a third-party native helper. Keep only OS process
  // essentials; whisper.cpp needs no application secrets.
  const allowedKeys = [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "USERNAME",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = baseEnv[key];
    if (value !== undefined) environment[key] = value;
  }
  if (platform === "linux") {
    environment.LD_LIBRARY_PATH = [runtimeDirectory, baseEnv.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":");
  }
  return environment;
}

export function lowerWhisperProcessPriority(
  pid: number | undefined,
  setPriority: (pid: number, priority: number) => void = NodeOS.setPriority,
): boolean {
  if (!pid) return false;
  try {
    setPriority(pid, 10);
    return true;
  } catch {
    return false;
  }
}

export function isWhisperRuntimePlatformSupported(
  platform: NodeJS.Platform,
  osRelease: string,
): boolean {
  if (platform !== "darwin") return true;
  const darwinMajor = Number.parseInt(osRelease.split(".", 1)[0] ?? "", 10);
  return Number.isFinite(darwinMajor) && darwinMajor >= MINIMUM_VOICE_DARWIN_MAJOR;
}

export class LocalWhisperRuntime {
  private readonly runtimeDirectory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: WhisperSpawn;
  private readonly platform: NodeJS.Platform;
  private readonly idleTimeoutMs: number;
  private readonly threads: number;
  private readonly inferenceTimeoutMs: number;
  private readonly osRelease: () => string;
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private endpoint: string | null = null;
  private activeModelPath: string | null = null;
  private starting: Promise<string> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private activeRequests = 0;
  private disposed = false;
  private readonly lifecycleController = new AbortController();

  constructor(options: LocalWhisperRuntimeOptions) {
    this.runtimeDirectory = options.runtimeDirectory;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.spawnImpl = options.spawnImpl ?? defaultWhisperSpawn;
    // oxlint-disable-next-line t3code/no-global-process-runtime -- non-Effect runtime owner; platform is injectable.
    this.platform = options.platform ?? NodeOS.platform();
    this.osRelease = options.osRelease ?? NodeOS.release;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.threads = Math.max(1, Math.min(MAX_THREADS, options.threads ?? MAX_THREADS));
    this.inferenceTimeoutMs = Math.max(
      1_000,
      options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS,
    );
  }

  isBusy(): boolean {
    return this.activeRequests > 0;
  }

  async isInstalled(): Promise<boolean> {
    if (!isWhisperRuntimePlatformSupported(this.platform, this.osRelease())) return false;
    const { executablePath } = this.paths();
    try {
      const stats = await NodeFSP.stat(executablePath);
      return stats.isFile();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async transcribe(
    modelPath: string,
    clip: NormalizedVoiceClip,
    options: WhisperTranscribeOptions,
  ): Promise<WhisperInferenceResult> {
    if (this.disposed) {
      throw new WhisperRuntimeError("disposed", "Offline voice runtime is shutting down.");
    }
    this.activeRequests += 1;
    const previous = this.queueTail;
    let releaseQueue!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    try {
      if (this.disposed) {
        throw new WhisperRuntimeError("disposed", "Offline voice runtime is shutting down.");
      }
      const runtimeSignal = AbortSignal.any([options.signal, this.lifecycleController.signal]);
      runtimeSignal.throwIfAborted();
      return await this.transcribeNow(modelPath, clip, runtimeSignal, options.language);
    } finally {
      releaseQueue();
      this.activeRequests -= 1;
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!this.disposed) {
      this.disposed = true;
      this.lifecycleController.abort(
        new WhisperRuntimeError("disposed", "Offline voice runtime is shutting down."),
      );
      this.clearIdleTimer();
      this.stopProcess();
    }
    await this.queueTail;
    await stopAndWaitForChild(child);
  }

  async stopIdle(): Promise<void> {
    if (this.activeRequests > 0) {
      throw new WhisperRuntimeError("busy", "Offline voice transcription is active.");
    }
    await stopAndWaitForChild(this.stopProcess());
  }

  private async transcribeNow(
    modelPath: string,
    clip: NormalizedVoiceClip,
    signal: AbortSignal,
    language: string | undefined,
  ): Promise<WhisperInferenceResult> {
    const endpoint = await this.ensureStarted(modelPath, signal);
    signal.throwIfAborted();
    this.clearIdleTimer();

    const abortRuntime = () => this.stopProcess();
    signal.addEventListener("abort", abortRuntime, { once: true });
    const inferenceController = new AbortController();
    const forwardAbort = () => inferenceController.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(
      () => {
        inferenceController.abort(
          new WhisperRuntimeError("timeout", "Offline voice transcription timed out."),
        );
        this.stopProcess();
      },
      resolveWhisperInferenceTimeoutMs(clip.durationMs, this.inferenceTimeoutMs),
    );
    timeout.unref();
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([Buffer.from(clip.audioBytes)], { type: clip.mimeType }),
        "voice.wav",
      );
      form.append("response_format", "json");
      form.append("language", language ?? "auto");
      form.append("temperature", "0.0");
      form.append("temperature_inc", "0.2");
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        body: form,
        signal: inferenceController.signal,
      });
      if (!response.ok) {
        throw new Error(`Offline transcription failed with status ${response.status}.`);
      }
      const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
      if (typeof payload?.text !== "string") {
        throw new Error("Offline transcription returned an invalid response.");
      }
      const text = payload.text.trim();
      return { text };
    } catch (error) {
      if (inferenceController.signal.reason instanceof WhisperRuntimeError) {
        throw inferenceController.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortRuntime);
      signal.removeEventListener("abort", forwardAbort);
      if (!this.disposed) this.armIdleTimer();
    }
  }

  private async ensureStarted(modelPath: string, signal: AbortSignal): Promise<string> {
    if (this.endpoint && this.child && this.activeModelPath === modelPath) {
      return this.endpoint;
    }
    if (this.activeModelPath !== modelPath) {
      this.stopProcess();
    }
    if (this.starting) return this.starting;

    const starting = this.startProcess(modelPath, signal).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async startProcess(modelPath: string, signal: AbortSignal): Promise<string> {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Offline transcription is unavailable in this runtime.");
    }
    const paths = this.paths();
    if (!(await this.isInstalled())) {
      throw new Error("The bundled offline transcription runtime is missing.");
    }
    signal.throwIfAborted();

    const port = await reserveLoopbackPort();
    signal.throwIfAborted();
    const requestPath = `/scient-${NodeCrypto.randomBytes(24).toString("hex")}`;
    const endpoint = `http://127.0.0.1:${port}${requestPath}/inference`;
    const child = this.spawnImpl(
      paths.executablePath,
      buildWhisperServerArguments({ modelPath, port, requestPath, threads: this.threads }),
      {
        cwd: paths.runtimeDirectory,
        env: buildRuntimeEnvironment(paths.runtimeDirectory, this.platform),
        shell: false,
        windowsHide: true,
      },
    );
    this.child = child;
    this.activeModelPath = modelPath;
    lowerWhisperProcessPriority(child.pid);
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.endpoint = null;
        this.activeModelPath = null;
      }
    });
    let rejectSpawn: ((error: Error) => void) | null = null;
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      rejectSpawn = reject;
    });
    const onSpawnError = (error: Error) => rejectSpawn?.(error);
    child.once("error", onSpawnError);
    child.on("error", () => {
      if (this.child === child) this.stopProcess();
    });

    try {
      await Promise.race([
        waitForServer({
          child,
          endpoint,
          fetchImpl: this.fetchImpl,
          signal,
          timeoutMs: STARTUP_TIMEOUT_MS,
        }),
        spawnFailure,
      ]);
      this.endpoint = endpoint;
      this.armIdleTimer();
      return endpoint;
    } catch (error) {
      this.stopProcess();
      throw error;
    } finally {
      child.removeListener("error", onSpawnError);
    }
  }

  private paths(): WhisperRuntimePaths {
    const executableName = this.platform === "win32" ? "whisper-server.exe" : "whisper-server";
    return {
      runtimeDirectory: this.runtimeDirectory,
      executablePath: NodePath.join(this.runtimeDirectory, executableName),
    };
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.stopProcess(), this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private stopProcess(): NodeChildProcess.ChildProcessWithoutNullStreams | null {
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.activeModelPath = null;
    if (child && child.exitCode === null && !child.killed) child.kill();
    return child;
  }
}

async function stopAndWaitForChild(
  child: NodeChildProcess.ChildProcessWithoutNullStreams | null,
): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (!child.killed) child.kill();
  if (await waitForChildExit(child, STOP_TIMEOUT_MS)) return;
  if (child.exitCode === null) child.kill("SIGKILL");
  if (!(await waitForChildExit(child, FORCE_STOP_TIMEOUT_MS))) {
    throw new Error("Offline voice helper did not stop.");
  }
}

async function waitForChildExit(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port <= 0) reject(new Error("Could not reserve an offline transcription port."));
        else resolve(port);
      });
    });
  });
}

async function waitForServer(input: {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly endpoint: string;
  readonly fetchImpl: typeof fetch;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    input.signal.throwIfAborted();
    if (input.child.exitCode !== null) {
      throw new Error(`Offline transcription runtime exited with code ${input.child.exitCode}.`);
    }
    try {
      const response = await input.fetchImpl(input.endpoint, {
        method: "OPTIONS",
        signal: input.signal,
      });
      if (response.ok) return;
    } catch (error) {
      if (input.signal.aborted) throw error;
    }
    await delay(100, input.signal);
  }
  throw new Error("Timed out while starting offline transcription.");
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timeout.unref();
  });
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
