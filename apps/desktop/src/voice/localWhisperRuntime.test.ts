// FILE: localWhisperRuntime.test.ts
// Purpose: Verifies private loopback runtime paths and non-shell process arguments.
// Layer: Desktop voice runtime tests

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedVoiceClip } from "@synara/shared/voiceTranscription";
import {
  buildWhisperServerArguments,
  LocalWhisperRuntime,
  lowerWhisperProcessPriority,
  resolveWhisperRuntimePaths,
  resolveWhisperInferenceTimeoutMs,
} from "./localWhisperRuntime";

describe("localWhisperRuntime", () => {
  it("resolves packaged Windows and development runtime binaries", () => {
    expect(
      resolveWhisperRuntimePaths({
        isPackaged: true,
        resourcesPath: "C:\\Scient\\resources",
        desktopRuntimeDirectory: "C:\\repo\\.electron-runtime",
        platform: "win32",
      }),
    ).toEqual({
      runtimeDirectory: "C:\\Scient\\resources\\whisper-runtime",
      executablePath: "C:\\Scient\\resources\\whisper-runtime\\whisper-server.exe",
    });
    expect(
      resolveWhisperRuntimePaths({
        isPackaged: false,
        resourcesPath: "/Applications/Scient.app/Contents/Resources",
        desktopRuntimeDirectory: "/repo/.electron-runtime",
        platform: "darwin",
      }),
    ).toEqual({
      runtimeDirectory: "/repo/.electron-runtime/whisper-runtime",
      executablePath: "/repo/.electron-runtime/whisper-runtime/whisper-server",
    });
  });

  it("builds explicit loopback-only arguments with multilingual auto-detection", () => {
    expect(
      buildWhisperServerArguments({
        modelPath: "/models/small q5.bin",
        port: 43_210,
        requestPath: "/scient-secret",
        threads: 4,
      }),
    ).toEqual([
      "--model",
      "/models/small q5.bin",
      "--host",
      "127.0.0.1",
      "--port",
      "43210",
      "--request-path",
      "/scient-secret",
      "--inference-path",
      "/inference",
      "--threads",
      "4",
      "--language",
      "auto",
      "--no-timestamps",
    ]);
  });

  it("best-effort lowers helper priority without making startup depend on it", () => {
    const calls: Array<[number, number]> = [];
    expect(lowerWhisperProcessPriority(42, (pid, priority) => calls.push([pid, priority]))).toBe(
      true,
    );
    expect(calls).toEqual([[42, 10]]);
    expect(
      lowerWhisperProcessPriority(42, () => {
        throw new Error("unsupported");
      }),
    ).toBe(false);
  });

  it("scales the hard inference deadline for long recordings with a release-safe cap", () => {
    expect(resolveWhisperInferenceTimeoutMs(5_000)).toBe(45_000);
    expect(resolveWhisperInferenceTimeoutMs(120_000)).toBe(360_000);
    expect(resolveWhisperInferenceTimeoutMs(999_000)).toBe(360_000);
  });

  it("makes disposal terminal so queued work cannot respawn the helper", async () => {
    const runtime = new LocalWhisperRuntime({ runtimeDirectory: "/missing" });
    let releaseQueue!: () => void;
    const queuedBehind = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    (runtime as unknown as { queueTail: Promise<void> }).queueTail = queuedBehind;
    const clip: NormalizedVoiceClip = {
      audioBytes: new Uint8Array([1]),
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1,
      cwd: "/workspace",
    };
    const queued = runtime.transcribe("/model.bin", clip, new AbortController().signal);
    const disposing = runtime.dispose();
    releaseQueue();

    await expect(queued).rejects.toMatchObject({ kind: "disposed" });
    await expect(disposing).resolves.toBeUndefined();
    await expect(
      runtime.transcribe("/model.bin", clip, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "disposed" });
  });

  it("cannot spawn a helper when disposal races in-flight startup", async () => {
    const runtime = new LocalWhisperRuntime({ runtimeDirectory: "/runtime" });
    let releaseInstallationCheck!: () => void;
    const installationCheck = new Promise<void>((resolve) => {
      releaseInstallationCheck = resolve;
    });
    const installed = vi.spyOn(runtime, "isInstalled").mockImplementation(async () => {
      await installationCheck;
      return true;
    });
    const clip: NormalizedVoiceClip = {
      audioBytes: new Uint8Array([1]),
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1,
      cwd: "/workspace",
    };

    const transcription = runtime.transcribe("/model.bin", clip, new AbortController().signal);
    await vi.waitFor(() => expect(installed).toHaveBeenCalledOnce());
    const disposing = runtime.dispose();
    releaseInstallationCheck();

    await expect(transcription).rejects.toMatchObject({ kind: "disposed" });
    await expect(disposing).resolves.toBeUndefined();
    expect((runtime as unknown as { child: unknown }).child).toBeNull();
  });

  it("stops and waits for an idle helper before model mutation", async () => {
    const runtime = new LocalWhisperRuntime({ runtimeDirectory: "/missing" });
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    });
    (runtime as unknown as { child: typeof child }).child = child;

    await expect(runtime.stopIdle()).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
