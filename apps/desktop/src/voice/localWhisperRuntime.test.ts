// FILE: localWhisperRuntime.test.ts
// Purpose: Verifies private loopback runtime paths and non-shell process arguments.
// Layer: Desktop voice runtime tests

import { describe, expect, it } from "vitest";
import { buildWhisperServerArguments, resolveWhisperRuntimePaths } from "./localWhisperRuntime";

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
      "--no-context",
    ]);
  });
});
