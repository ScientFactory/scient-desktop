// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem I/O.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assertPinnedWhisperServerSource,
  developmentRuntimeCacheEntry,
  isStagedWhisperRuntime,
  parseArguments,
  resolveDevelopmentRuntimeCache,
  syncDevelopmentRuntimeCache,
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

describe("the development runtime cache", () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
    );
  });
  async function workspace() {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-voice-cache-"));
    temporary.push(root);
    return {
      cacheRoot: NodePath.join(root, "cache"),
      checkout: (name: string) => NodePath.join(root, name, "native", "whisper-runtime"),
    };
  }
  const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
  /** A staged runtime as the script writes it, with a stand-in for the helper. */
  async function stage(
    directory: string,
    overrides: { version?: string; commit?: string; arch?: string } = {},
  ) {
    await NodeFSP.mkdir(directory, { recursive: true });
    const files = { "LICENSE.whisper.cpp": "license", "whisper-server": "helper" };
    for (const [file, contents] of Object.entries(files))
      await NodeFSP.writeFile(NodePath.join(directory, file), contents);
    await NodeFSP.writeFile(
      NodePath.join(directory, "provenance.json"),
      JSON.stringify({
        component: "whisper.cpp",
        version: overrides.version ?? WHISPER_CPP_VERSION,
        platform: "mac",
        arch: overrides.arch ?? "arm64",
        source: { commit: overrides.commit ?? WHISPER_CPP_COMMIT },
        files: Object.entries(files).map(([file, contents]) => ({
          file,
          sha256: sha256(contents),
          size: contents.length,
        })),
      }),
    );
  }
  const sync = (cacheRoot: string, output: string) =>
    syncDevelopmentRuntimeCache({ cacheRoot, output, platform: "mac", arch: "arm64" });

  it("lives beside, not inside, any checkout, with one entry for each pinned build", () => {
    const root = resolveDevelopmentRuntimeCache("/Users/someone");
    expect(root).toBe("/Users/someone/.scient-next/dev-shared/voice/whisper-runtime");
    const entry = developmentRuntimeCacheEntry(root, "mac", "arm64");
    expect(NodePath.basename(entry)).toBe(
      `${WHISPER_CPP_VERSION}-${WHISPER_CPP_COMMIT.slice(0, 12)}-mac-arm64`,
    );
    expect(developmentRuntimeCacheEntry(root, "mac", "x64")).not.toBe(entry);
  });

  it("gives a checkout without the runtime the one another checkout staged", async () => {
    const { cacheRoot, checkout } = await workspace();
    await stage(checkout("first"));
    expect(await sync(cacheRoot, checkout("second"))).toBe("missing");
    expect(await sync(cacheRoot, checkout("first"))).toBe("cached");
    expect(await sync(cacheRoot, checkout("second"))).toBe("restored");
    expect(await isStagedWhisperRuntime(checkout("second"), "mac", "arm64")).toBe(true);
    expect((await NodeFSP.readdir(checkout("second"))).toSorted()).toEqual([
      "LICENSE.whisper.cpp",
      "provenance.json",
      "whisper-server",
    ]);
    expect(await sync(cacheRoot, checkout("second"))).toBe("current");
    // Nothing is left half-written beside either folder.
    expect(await NodeFSP.readdir(NodePath.dirname(checkout("second")))).toEqual([
      "whisper-runtime",
    ]);
    expect(await NodeFSP.readdir(cacheRoot)).toHaveLength(1);
  });

  it.each([
    ["another version", { version: "v0.0.0" }],
    ["another commit", { commit: "0".repeat(40) }],
    ["another architecture", { arch: "x64" }],
  ])("does not share or accept a runtime of %s", async (_name, overrides) => {
    const { cacheRoot, checkout } = await workspace();
    await stage(checkout("first"), overrides);
    expect(await isStagedWhisperRuntime(checkout("first"), "mac", "arm64")).toBe(false);
    expect(await sync(cacheRoot, checkout("first"))).toBe("missing");
    await expect(NodeFSP.stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not accept a cached runtime with a changed, missing or extra file", async () => {
    const { cacheRoot, checkout } = await workspace();
    const entry = developmentRuntimeCacheEntry(cacheRoot, "mac", "arm64");
    for (const damage of [
      () => NodeFSP.writeFile(NodePath.join(entry, "whisper-server"), "hacked"),
      () => NodeFSP.rm(NodePath.join(entry, "LICENSE.whisper.cpp")),
      () => NodeFSP.writeFile(NodePath.join(entry, "extra.dylib"), "extra"),
    ]) {
      await NodeFSP.rm(entry, { recursive: true, force: true });
      await stage(entry);
      expect(await isStagedWhisperRuntime(entry, "mac", "arm64")).toBe(true);
      await damage();
      expect(await isStagedWhisperRuntime(entry, "mac", "arm64")).toBe(false);
      expect(await sync(cacheRoot, checkout("second"))).toBe("missing");
      await expect(NodeFSP.stat(checkout("second"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // A checkout that has a good runtime replaces the damaged entry.
    await stage(checkout("first"));
    expect(await sync(cacheRoot, checkout("first"))).toBe("cached");
    expect(await isStagedWhisperRuntime(entry, "mac", "arm64")).toBe(true);
  });

  it("uses the cache only when asked: packaging stages from pinned sources", () => {
    expect(parseArguments(["--platform", "mac", "--arch", "arm64"]).developmentCache).toBe("off");
    expect(parseArguments(["--verbose", "--dev-cache"]).developmentCache).toBe("use");
    expect(parseArguments(["--dev-cache-only"]).developmentCache).toBe("only");
    expect(parseArguments(["--dev-cache", "--output", "/tmp/out"]).output).toBe("/tmp/out");
  });
});
