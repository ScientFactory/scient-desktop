import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertMacWhisperSignatureDetails,
  assertPinnedWhisperServerSource,
  resolvePrebuiltArtifact,
  tarExtractionArguments,
  WHISPER_CPP_COMMIT,
  verifyPackagedWhisperRuntime,
  WINDOWS_EXPAND_ARCHIVE_SCRIPT,
  WHISPER_CPP_PREBUILT,
  WHISPER_CPP_SOURCE,
  WHISPER_CPP_VERSION,
  whisperRuntimeFileVerification,
  windowsZipExtractionPlan,
} from "./stage-whisper-runtime.ts";

const temporaryDirectories: string[] = [];

function developerIdSignatureDetails(team: string): string {
  return [
    "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=3+7 location=embedded",
    "Authority=Developer ID Application: ScientFactory Inc. (TEAM123456)",
    "Timestamp=Jul 24, 2026 at 12:00:00",
    `TeamIdentifier=${team}`,
  ].join("\n");
}

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

  it("forces Windows drive-letter archives to remain local tar inputs", () => {
    expect(
      tarExtractionArguments(
        "C:\\Users\\runner\\source.tar.gz",
        "C:\\Users\\runner\\workspace",
        true,
        "win32",
      ),
    ).toEqual([
      "--force-local",
      "-xzf",
      "C:\\Users\\runner\\source.tar.gz",
      "-C",
      "C:\\Users\\runner\\workspace",
    ]);
    expect(tarExtractionArguments("/tmp/source.tar.gz", "/tmp/workspace", true, "linux")).toEqual([
      "-xzf",
      "/tmp/source.tar.gz",
      "-C",
      "/tmp/workspace",
    ]);
  });

  it("extracts Windows ZIP prebuilts through literal PowerShell file arguments", () => {
    expect(WINDOWS_EXPAND_ARCHIVE_SCRIPT).toContain(
      "Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force",
    );
    expect(
      windowsZipExtractionPlan(
        "D:\\temp\\expand-archive.ps1",
        "D:\\temp\\whisper-bin-x64.zip",
        "D:\\temp\\prebuilt",
        { SystemRoot: "D:\\Windows" },
      ),
    ).toEqual({
      command: "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "D:\\temp\\expand-archive.ps1",
        "-ArchivePath",
        "D:\\temp\\whisper-bin-x64.zip",
        "-DestinationPath",
        "D:\\temp\\prebuilt",
      ],
    });
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
    expect(buildSource).toContain('macSignatureMode: options.signed ? "developer-id" : "adhoc"');
  });

  it("allows code-signature verification only for the exact macOS executable", () => {
    expect(whisperRuntimeFileVerification("mac", "whisper-server")).toBe("mac-code-signature");
    expect(whisperRuntimeFileVerification("mac", "LICENSE.whisper.cpp")).toBe("sha256");
    expect(whisperRuntimeFileVerification("linux", "whisper-server")).toBe("sha256");
    expect(whisperRuntimeFileVerification("win", "whisper-server.exe")).toBe("sha256");
  });

  it("requires matching timestamped Developer ID teams and hardened runtime", () => {
    expect(() =>
      assertMacWhisperSignatureDetails({
        appDetails: developerIdSignatureDetails("TEAM123456"),
        executableDetails: developerIdSignatureDetails("TEAM123456"),
        mode: "developer-id",
      }),
    ).not.toThrow();
    expect(() =>
      assertMacWhisperSignatureDetails({
        appDetails: developerIdSignatureDetails("TEAM123456"),
        executableDetails: developerIdSignatureDetails("OTHERTEAM1"),
        mode: "developer-id",
      }),
    ).toThrow(/does not match app team/);
    expect(() =>
      assertMacWhisperSignatureDetails({
        appDetails: developerIdSignatureDetails("TEAM123456").replace(
          "Timestamp=Jul 24, 2026 at 12:00:00\n",
          "",
        ),
        executableDetails: developerIdSignatureDetails("TEAM123456"),
        mode: "developer-id",
      }),
    ).toThrow(/timestamp/);
    expect(() =>
      assertMacWhisperSignatureDetails({
        appDetails: developerIdSignatureDetails("TEAM123456"),
        executableDetails: developerIdSignatureDetails("TEAM123456").replace(
          "flags=0x10000(runtime)",
          "flags=0x0(none) Identifier=whisper-runtime",
        ),
        mode: "developer-id",
      }),
    ).toThrow(/hardened-runtime signing flags/);
  });

  it("keeps ad-hoc and Developer ID signature modes mutually exclusive", () => {
    const adhoc = ["Signature=adhoc", "TeamIdentifier=not set"].join("\n");
    expect(() =>
      assertMacWhisperSignatureDetails({
        appDetails: adhoc,
        executableDetails: adhoc,
        mode: "adhoc",
      }),
    ).not.toThrow();
    expect(() =>
      assertMacWhisperSignatureDetails({
        appDetails: adhoc,
        executableDetails: adhoc,
        mode: "developer-id",
      }),
    ).toThrow(/Developer ID Application/);
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
        schemaVersion: 2,
        component: "whisper.cpp",
        version: WHISPER_CPP_VERSION,
        platform: "linux",
        files: files.map((file) => ({
          file: file.file,
          size: file.bytes.byteLength,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          verification: "sha256",
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
    await writeFile(join(runtimeDirectory, "unexpected.dylib"), "unexpected");
    await expect(verifyPackagedWhisperRuntime({ distDir, platform: "linux" })).rejects.toThrow(
      /file set does not match provenance/,
    );
  });

  it("requires an explicit signature mode only for macOS verification", async () => {
    const distDir = await mkdtemp(join(tmpdir(), "scient-whisper-mode-test-"));
    temporaryDirectories.push(distDir);
    await expect(verifyPackagedWhisperRuntime({ distDir, platform: "mac" })).rejects.toThrow(
      /requires an explicit signature mode/,
    );
    await expect(
      verifyPackagedWhisperRuntime({
        distDir,
        macSignatureMode: "developer-id",
        platform: "linux",
      }),
    ).rejects.toThrow(/cannot be used for a non-macOS runtime/);
  });

  it("rejects receipt attempts to relabel hashed files as code-signed", async () => {
    const distDir = await mkdtemp(join(tmpdir(), "scient-whisper-policy-test-"));
    temporaryDirectories.push(distDir);
    const runtimeDirectory = join(distDir, "linux-unpacked", "resources", "whisper-runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const server = Buffer.from("server");
    const library = Buffer.from("library");
    await writeFile(join(runtimeDirectory, "whisper-server"), server);
    await writeFile(join(runtimeDirectory, "libwhisper.so"), library);
    await chmod(join(runtimeDirectory, "whisper-server"), 0o755);
    await writeFile(
      join(runtimeDirectory, "provenance.json"),
      JSON.stringify({
        schemaVersion: 2,
        component: "whisper.cpp",
        version: WHISPER_CPP_VERSION,
        platform: "linux",
        files: [
          {
            file: "whisper-server",
            size: server.byteLength,
            sha256: createHash("sha256").update(server).digest("hex"),
            verification: "sha256",
          },
          {
            file: "libwhisper.so",
            size: library.byteLength,
            sha256: createHash("sha256").update(library).digest("hex"),
            verification: "mac-code-signature",
          },
        ],
      }),
    );

    await expect(verifyPackagedWhisperRuntime({ distDir, platform: "linux" })).rejects.toThrow(
      /verification policy.*expected sha256/,
    );
  });
});
