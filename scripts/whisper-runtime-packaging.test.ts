import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertPinnedWhisperServerSource,
  resolvePrebuiltArtifact,
  WHISPER_CPP_COMMIT,
  verifyPackagedWhisperRuntime,
  WHISPER_CPP_PREBUILT,
  WHISPER_CPP_SOURCE,
  WHISPER_CPP_VERSION,
} from "./stage-whisper-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("whisper.cpp runtime packaging", () => {
  it("pins immutable, checksum-verified v1.9.1 inputs", () => {
    expect(WHISPER_CPP_VERSION).toBe("v1.9.1");
    expect(WHISPER_CPP_COMMIT).toBe("f049fff95a089aa9969deb009cdd4892b3e74916");
    expect(WHISPER_CPP_SOURCE.url).toBe(
      `https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_CPP_COMMIT}.tar.gz`,
    );
    expect(WHISPER_CPP_SOURCE.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(WHISPER_CPP_PREBUILT)).toEqual(["linux-arm64", "linux-x64", "win-x64"]);
    for (const artifact of Object.values(WHISPER_CPP_PREBUILT)) {
      expect(artifact.url).toContain("/releases/download/v1.9.1/");
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("stages the TypeScript runtime script with the pinned Bun runner", async () => {
    const buildSource = await readFile(
      new URL("./build-desktop-artifact.ts", import.meta.url),
      "utf8",
    );
    expect(buildSource).toContain('WHISPER_RUNTIME_STAGE_RUNNER = "bun"');
    expect(buildSource).toContain(
      "`${WHISPER_RUNTIME_STAGE_RUNNER} ${stageScript} --platform ${platform}",
    );
  });

  it("builds the static universal macOS helper with embedded Metal acceleration", async () => {
    const source = await readFile(new URL("./stage-whisper-runtime.ts", import.meta.url), "utf8");
    expect(source).toContain('"-DBUILD_SHARED_LIBS=OFF"');
    expect(source).toContain('"-DGGML_METAL=ON"');
    expect(source).toContain('"-DGGML_METAL_EMBED_LIBRARY=ON"');
    expect(source).toContain('arch === "universal" ? "arm64;x86_64"');
  });

  it("selects verified official prebuilts and rejects unsupported targets", () => {
    expect(resolvePrebuiltArtifact("linux", "x64")).toBe(WHISPER_CPP_PREBUILT["linux-x64"]);
    expect(resolvePrebuiltArtifact("linux", "arm64")).toBe(WHISPER_CPP_PREBUILT["linux-arm64"]);
    expect(resolvePrebuiltArtifact("win", "x64")).toBe(WHISPER_CPP_PREBUILT["win-x64"]);
    expect(resolvePrebuiltArtifact("mac", "universal")).toBeNull();
    expect(() => resolvePrebuiltArtifact("win", "arm64")).toThrow(
      /no verified win\/arm64 desktop runtime/,
    );
  });

  it("requires request-path parsing and the exact OPTIONS readiness route", () => {
    const source = [
      'else if (arg == "--request-path") { sparams.request_path = argv[++i]; }',
      "svr->Options(sparams.request_path + sparams.inference_path, handler);",
    ].join("\n");

    expect(() => assertPinnedWhisperServerSource(source)).not.toThrow();
    expect(() =>
      assertPinnedWhisperServerSource(
        'else if (arg == "--request-path") { sparams.request_path = argv[++i]; }',
      ),
    ).toThrow(/Options/);
  });

  it("rehashes the runtime in the final unpacked app and checks executable mode", async () => {
    const distDir = await mkdtemp(join(tmpdir(), "scient-whisper-package-test-"));
    temporaryDirectories.push(distDir);
    const runtimeDirectory = join(distDir, "linux-unpacked", "resources", "whisper-runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const files = [
      { file: "whisper-server", bytes: Buffer.from("server") },
      { file: "libwhisper.so", bytes: Buffer.from("library") },
    ];
    for (const file of files) await writeFile(join(runtimeDirectory, file.file), file.bytes);
    await chmod(join(runtimeDirectory, "whisper-server"), 0o755);
    await writeFile(
      join(runtimeDirectory, "provenance.json"),
      JSON.stringify({
        component: "whisper.cpp",
        version: WHISPER_CPP_VERSION,
        files: files.map((file) => ({
          file: file.file,
          size: file.bytes.byteLength,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        })),
      }),
    );

    await expect(verifyPackagedWhisperRuntime({ distDir, platform: "linux" })).resolves.toEqual([
      runtimeDirectory,
    ]);
    await writeFile(join(runtimeDirectory, "libwhisper.so"), "tampered");
    await expect(verifyPackagedWhisperRuntime({ distDir, platform: "linux" })).rejects.toThrow(
      /verification failed/,
    );
  });
});
