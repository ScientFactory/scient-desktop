import { describe, expect, it } from "vite-plus/test";

import {
  assertPinnedWhisperServerSource,
  resolveArchiveExtractionPlan,
  resolvePrebuiltArtifact,
  runtimeExecutableName,
  WHISPER_CPP_COMMIT,
  WHISPER_CPP_SOURCE,
  WHISPER_CPP_VERSION,
  WHISPER_MACOS_DEPLOYMENT_TARGET,
} from "./stage-whisper-runtime.ts";

describe("stage-whisper-runtime", () => {
  it("pins source by immutable commit and checksum", () => {
    expect(WHISPER_CPP_VERSION).toBe("v1.9.1");
    expect(WHISPER_CPP_COMMIT).toMatch(/^[a-f0-9]{40}$/u);
    expect(WHISPER_CPP_SOURCE.url).toContain(WHISPER_CPP_COMMIT);
    expect(WHISPER_CPP_SOURCE.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses source builds on mac and verified prebuilts on supported targets", () => {
    expect(WHISPER_MACOS_DEPLOYMENT_TARGET).toBe("12.0");
    expect(resolvePrebuiltArtifact("mac", "universal")).toBeNull();
    expect(resolvePrebuiltArtifact("linux", "arm64")?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolvePrebuiltArtifact("linux", "x64")?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolvePrebuiltArtifact("win", "x64")?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => resolvePrebuiltArtifact("win", "arm64")).toThrow(/no verified/u);
  });

  it("requires the private request-path behavior from pinned source", () => {
    expect(() => assertPinnedWhisperServerSource("unrelated source")).toThrow(/required behavior/u);
    expect(() =>
      assertPinnedWhisperServerSource(
        [
          'arg == "--request-path"',
          "sparams.request_path = argv[++i]",
          "svr->Options(sparams.request_path + sparams.inference_path",
        ].join("\n"),
      ),
    ).not.toThrow();
  });

  it("uses the platform executable name", () => {
    expect(runtimeExecutableName("mac")).toBe("whisper-server");
    expect(runtimeExecutableName("linux")).toBe("whisper-server");
    expect(runtimeExecutableName("win")).toBe("whisper-server.exe");
  });

  it("uses Windows-safe extraction for local tarballs and zip prebuilts", () => {
    const sourcePlan = resolveArchiveExtractionPlan(
      String.raw`C:\\runner\\whisper.cpp.tar.gz`,
      String.raw`C:\\runner\\source`,
      "win32",
    );
    expect(sourcePlan.command).toBe("tar");
    expect(sourcePlan.args).toEqual([
      "--force-local",
      "-xzf",
      String.raw`C:\\runner\\whisper.cpp.tar.gz`,
      "-C",
      String.raw`C:\\runner\\source`,
    ]);

    const prebuiltPlan = resolveArchiveExtractionPlan(
      String.raw`C:\\runner\\whisper-bin-x64.zip`,
      String.raw`C:\\runner\\prebuilt`,
      "win32",
    );
    expect(prebuiltPlan.command).toBe("powershell.exe");
    expect(prebuiltPlan.args).toContain(
      "Expand-Archive -LiteralPath $env:SCIENT_WHISPER_ARCHIVE -DestinationPath $env:SCIENT_WHISPER_DESTINATION -Force",
    );
    expect(prebuiltPlan.env).toEqual({
      SCIENT_WHISPER_ARCHIVE: String.raw`C:\\runner\\whisper-bin-x64.zip`,
      SCIENT_WHISPER_DESTINATION: String.raw`C:\\runner\\prebuilt`,
    });
  });

  it("keeps POSIX archive extraction on tar", () => {
    const plan = resolveArchiveExtractionPlan(
      "/tmp/whisper-bin-x64.zip",
      "/tmp/prebuilt",
      "darwin",
    );
    expect(plan).toEqual({
      args: ["-xf", "/tmp/whisper-bin-x64.zip", "-C", "/tmp/prebuilt"],
      command: "tar",
    });
  });
});
