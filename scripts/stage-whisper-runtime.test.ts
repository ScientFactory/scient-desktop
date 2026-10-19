// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem I/O.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assertPinnedWhisperServerSource,
  assertWindowsRuntimeSelfContained,
  developmentRuntimeCacheEntry,
  findUnshippedWindowsImports,
  isStagedWhisperRuntime,
  parseArguments,
  PE_MACHINE_X64,
  readPortableExecutable,
  resolveDevelopmentRuntimeCache,
  syncDevelopmentRuntimeCache,
  resolveArchiveExtractionPlan,
  resolvePrebuiltArtifact,
  runtimeExecutableName,
  WHISPER_CPP_COMMIT,
  WHISPER_CPP_SOURCE,
  WHISPER_CPP_VERSION,
  WHISPER_MACOS_DEPLOYMENT_TARGET,
  WHISPER_RUNTIME_BUILD,
  WHISPER_WINDOWS_CPU_VARIANTS,
  WHISPER_WINDOWS_RUNTIME_FILES,
  windowsCMakeConfigureArguments,
} from "./stage-whisper-runtime.ts";

/** A minimal x64 PE file: one section holding import and delay-load descriptors and their names. */
function portableExecutable(
  input: {
    readonly machine?: number;
    readonly imports?: readonly string[];
    readonly delayed?: readonly string[];
    readonly delayAttributes?: number;
  } = {},
): Buffer {
  const bytes = Buffer.alloc(0x1400);
  const header = 0x80;
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(header, 0x3c);
  bytes.writeUInt32LE(0x4550, header);
  bytes.writeUInt16LE(input.machine ?? PE_MACHINE_X64, header + 4);
  bytes.writeUInt16LE(1, header + 6);
  bytes.writeUInt16LE(240, header + 20);
  const optional = header + 24;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(16, optional + 108);
  const directories = optional + 112;
  const section = optional + 240;
  bytes.writeUInt32LE(0x1000, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x1000, section + 16);
  bytes.writeUInt32LE(0x400, section + 20);
  const rva = (offset: number) => offset - 0x400 + 0x1000;
  let names = 0x600;
  const writeName = (name: string) => {
    const at = names;
    bytes.write(`${name}\0`, at, "latin1");
    names += name.length + 1;
    return rva(at);
  };
  for (const [index, name] of (input.imports ?? []).entries())
    bytes.writeUInt32LE(writeName(name), 0x400 + index * 20 + 12);
  if (input.imports?.length) bytes.writeUInt32LE(rva(0x400), directories + 8);
  for (const [index, name] of (input.delayed ?? []).entries()) {
    bytes.writeUInt32LE(input.delayAttributes ?? 1, 0x500 + index * 32);
    bytes.writeUInt32LE(writeName(name), 0x500 + index * 32 + 4);
  }
  if (input.delayed?.length) bytes.writeUInt32LE(rva(0x500), directories + 13 * 8);
  return bytes;
}

describe("Windows runtime dependencies", () => {
  it("reads the machine and the libraries a file loads, including delay-loaded ones", () => {
    expect(
      readPortableExecutable(
        portableExecutable({ imports: ["KERNEL32.dll", "whisper.dll"], delayed: ["SHELL32.dll"] }),
      ),
    ).toEqual({ machine: PE_MACHINE_X64, imports: ["KERNEL32.dll", "whisper.dll", "SHELL32.dll"] });
    expect(readPortableExecutable(portableExecutable()).imports).toEqual([]);
  });

  it("refuses what it cannot read", () => {
    expect(() => readPortableExecutable(Buffer.from("not a program"))).toThrow(/Not a readable/u);
    const truncated = portableExecutable({ imports: ["KERNEL32.dll"] }).subarray(0, 0x300);
    expect(() => readPortableExecutable(truncated)).toThrow(/Not a readable/u);
    expect(() =>
      readPortableExecutable(portableExecutable({ delayed: ["x.dll"], delayAttributes: 0 })),
    ).toThrow(/old-style/u);
  });

  it("accepts Windows itself and the runtime's own files, and names everything else", () => {
    const files = new Map([
      [
        "whisper-server.exe",
        {
          machine: PE_MACHINE_X64,
          imports: ["whisper.dll", "GGML.dll", "KERNEL32.dll", "WS2_32.dll"],
        },
      ],
      ["whisper.dll", { machine: PE_MACHINE_X64, imports: ["api-ms-win-crt-heap-l1-1-0.dll"] }],
      ["ggml.dll", { machine: PE_MACHINE_X64, imports: ["VCRUNTIME140.dll", "MSVCP140.dll"] }],
      ["ggml-cpu-x64.dll", { machine: PE_MACHINE_X64, imports: ["VCOMP140.DLL", "libomp.dll"] }],
    ]);
    expect(findUnshippedWindowsImports(files)).toEqual([
      "ggml.dll needs VCRUNTIME140.dll",
      "ggml.dll needs MSVCP140.dll",
      "ggml-cpu-x64.dll needs VCOMP140.DLL",
      "ggml-cpu-x64.dll needs libomp.dll",
    ]);
  });

  it("checks a staged folder: every binary x64 and needing only Windows and its neighbours", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-voice-pe-"));
    try {
      const write = (file: string, bytes: Buffer) =>
        NodeFSP.writeFile(NodePath.join(directory, file), bytes);
      await write("whisper-server.exe", portableExecutable({ imports: ["whisper.dll"] }));
      await write("whisper.dll", portableExecutable({ imports: ["KERNEL32.dll"] }));
      await NodeFSP.writeFile(NodePath.join(directory, "LICENSE.whisper.cpp"), "license");
      await expect(assertWindowsRuntimeSelfContained(directory)).resolves.toBeUndefined();

      await write("ggml-base.dll", portableExecutable({ imports: ["VCOMP140.DLL"] }));
      await expect(assertWindowsRuntimeSelfContained(directory)).rejects.toThrow(
        /ggml-base\.dll needs VCOMP140\.DLL/u,
      );
      await write("ggml-base.dll", portableExecutable({ machine: 0xaa64 }));
      await expect(assertWindowsRuntimeSelfContained(directory)).rejects.toThrow(/not an x64/u);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("stage-whisper-runtime", () => {
  it("pins source by immutable commit and checksum", () => {
    expect(WHISPER_CPP_VERSION).toBe("v1.9.1");
    expect(WHISPER_CPP_COMMIT).toMatch(/^[a-f0-9]{40}$/u);
    expect(WHISPER_CPP_SOURCE.url).toContain(WHISPER_CPP_COMMIT);
    expect(WHISPER_CPP_SOURCE.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("builds mac and Windows from source and uses verified prebuilts on Linux", () => {
    expect(WHISPER_MACOS_DEPLOYMENT_TARGET).toBe("12.0");
    expect(resolvePrebuiltArtifact("mac", "universal")).toBeNull();
    expect(resolvePrebuiltArtifact("win", "x64")).toBeNull();
    expect(resolvePrebuiltArtifact("linux", "arm64")?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolvePrebuiltArtifact("linux", "x64")?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => resolvePrebuiltArtifact("win", "arm64")).toThrow(/no verified/u);
  });

  it("builds Windows without OpenMP and with the C and C++ runtime linked in", () => {
    const args = windowsCMakeConfigureArguments("C:/src", "C:/src/build");
    expect(args).toEqual(
      expect.arrayContaining([
        "-DGGML_OPENMP=OFF",
        "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
        "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
        "-DBUILD_SHARED_LIBS=ON",
        "-DGGML_BACKEND_DL=ON",
        "-DGGML_CPU_ALL_VARIANTS=ON",
        "-DGGML_NATIVE=OFF",
        "-DWHISPER_SDL2=OFF",
      ]),
    );
    expect(WHISPER_WINDOWS_RUNTIME_FILES).toEqual([
      "whisper-server.exe",
      "whisper.dll",
      "ggml.dll",
      "ggml-base.dll",
      ...WHISPER_WINDOWS_CPU_VARIANTS.map((variant) => `ggml-cpu-${variant}.dll`),
    ]);
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
    expect(WHISPER_RUNTIME_BUILD.win).toBe(2);
    expect(NodePath.basename(developmentRuntimeCacheEntry(root, "win", "x64"))).toBe(
      `${WHISPER_CPP_VERSION}-${WHISPER_CPP_COMMIT.slice(0, 12)}-win-x64-build2`,
    );
  });

  it("does not take the upstream Windows archive for the Windows build", async () => {
    const { checkout } = await workspace();
    const directory = checkout("windows");
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "whisper-server.exe"), "helper");
    const receipt = (build?: number) =>
      JSON.stringify({
        component: "whisper.cpp",
        version: WHISPER_CPP_VERSION,
        platform: "win",
        arch: "x64",
        ...(build === undefined ? {} : { build }),
        source: { commit: WHISPER_CPP_COMMIT },
        files: [{ file: "whisper-server.exe", sha256: sha256("helper"), size: 6 }],
      });
    const receiptPath = NodePath.join(directory, "provenance.json");
    await NodeFSP.writeFile(receiptPath, receipt());
    expect(await isStagedWhisperRuntime(directory, "win", "x64")).toBe(false);
    await NodeFSP.writeFile(receiptPath, receipt(1));
    expect(await isStagedWhisperRuntime(directory, "win", "x64")).toBe(false);
    await NodeFSP.writeFile(receiptPath, receipt(2));
    expect(await isStagedWhisperRuntime(directory, "win", "x64")).toBe(true);

    // Release signing changes the helper's bytes but not the list of files.
    await NodeFSP.writeFile(NodePath.join(directory, "whisper-server.exe"), "signed helper");
    expect(await isStagedWhisperRuntime(directory, "win", "x64")).toBe(false);
    expect(await isStagedWhisperRuntime(directory, "win", "x64", "names")).toBe(true);
    await NodeFSP.writeFile(NodePath.join(directory, "parakeet.dll"), "leftover");
    expect(await isStagedWhisperRuntime(directory, "win", "x64", "names")).toBe(false);
    await NodeFSP.writeFile(receiptPath, receipt(1));
    await NodeFSP.rm(NodePath.join(directory, "parakeet.dll"));
    expect(await isStagedWhisperRuntime(directory, "win", "x64", "names")).toBe(false);
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
    // The damaged folder is gone, and nothing else is left beside the entry.
    expect(await NodeFSP.readdir(cacheRoot)).toEqual([NodePath.basename(entry)]);
  });

  it("keeps the entry another checkout published first", async () => {
    const { cacheRoot, checkout } = await workspace();
    const entry = developmentRuntimeCacheEntry(cacheRoot, "mac", "arm64");
    await stage(entry);
    const published = await NodeFSP.stat(NodePath.join(entry, "whisper-server"));
    // A checkout that publishes while the entry is already valid leaves it untouched.
    await stage(checkout("late"));
    expect(await sync(cacheRoot, checkout("late"))).toBe("current");
    const after = await NodeFSP.stat(NodePath.join(entry, "whisper-server"));
    expect(after.ino).toBe(published.ino);
  });

  it("does not accept a runtime whose helper is a link to a file elsewhere", async () => {
    const { cacheRoot, checkout } = await workspace();
    await stage(checkout("first"));
    const helper = NodePath.join(checkout("first"), "whisper-server");
    const elsewhere = NodePath.join(NodePath.dirname(cacheRoot), "elsewhere");
    await NodeFSP.rename(helper, elsewhere);
    await NodeFSP.symlink(elsewhere, helper);
    // The bytes match the receipt, but a copy of it would depend on `elsewhere`.
    expect(await isStagedWhisperRuntime(checkout("first"), "mac", "arm64")).toBe(false);
    expect(await sync(cacheRoot, checkout("first"))).toBe("missing");
    await expect(NodeFSP.stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets several checkouts publish and restore at the same moment", async () => {
    const { cacheRoot, checkout } = await workspace();
    const publishers = ["a", "b", "c", "d"].map((name) => checkout(name));
    await Promise.all(publishers.map((directory) => stage(directory)));
    const published = await Promise.all(publishers.map((directory) => sync(cacheRoot, directory)));
    // Each either shared its copy or found another checkout's identical one in place.
    for (const outcome of published) expect(["cached", "current"]).toContain(outcome);
    const entry = developmentRuntimeCacheEntry(cacheRoot, "mac", "arm64");
    expect(await isStagedWhisperRuntime(entry, "mac", "arm64")).toBe(true);
    expect(await NodeFSP.readdir(cacheRoot)).toEqual([NodePath.basename(entry)]);

    const takers = ["e", "f", "g", "h"].map((name) => checkout(name));
    expect(await Promise.all(takers.map((directory) => sync(cacheRoot, directory)))).toEqual([
      "restored",
      "restored",
      "restored",
      "restored",
    ]);
    for (const directory of takers)
      expect(await isStagedWhisperRuntime(directory, "mac", "arm64")).toBe(true);
    expect(await NodeFSP.readdir(cacheRoot)).toEqual([NodePath.basename(entry)]);
  });

  it("never gives a checkout a copy that does not verify", async () => {
    const { cacheRoot, checkout } = await workspace();
    const entry = developmentRuntimeCacheEntry(cacheRoot, "mac", "arm64");
    await stage(entry);
    // A checkout with a stale, incomplete runtime of its own takes the cached one whole.
    await NodeFSP.mkdir(checkout("second"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(checkout("second"), "whisper-server"), "stale");
    expect(await sync(cacheRoot, checkout("second"))).toBe("restored");
    expect(
      await NodeFSP.readFile(NodePath.join(checkout("second"), "whisper-server"), "utf8"),
    ).toBe("helper");
    expect(await NodeFSP.readdir(NodePath.dirname(checkout("second")))).toEqual([
      "whisper-runtime",
    ]);
  });

  it("uses the cache only when asked: packaging stages from pinned sources", () => {
    expect(parseArguments(["--platform", "mac", "--arch", "arm64"]).developmentCache).toBe("off");
    expect(parseArguments(["--verbose", "--dev-cache"]).developmentCache).toBe("use");
    expect(parseArguments(["--dev-cache-only"]).developmentCache).toBe("only");
    expect(parseArguments(["--dev-cache", "--output", "/tmp/out"]).output).toBe("/tmp/out");
  });
});
