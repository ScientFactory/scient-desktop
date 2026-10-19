#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off -- standalone verified build tool.
/* oxlint-disable t3code/no-global-process-runtime -- standalone CLI runtime detection; injected through exported pure helpers in tests. */
// Stages a pinned, verified whisper.cpp runtime for development or packaging.
// No native executable is committed: every input has a fixed revision and
// checksum, required server behavior is asserted from source, and the output
// carries its license plus a per-file provenance receipt.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const WHISPER_CPP_VERSION = "v1.9.1";
export const WHISPER_CPP_COMMIT = "f049fff95a089aa9969deb009cdd4892b3e74916";
export const WHISPER_MACOS_DEPLOYMENT_TARGET = "12.0";

export interface VerifiedArtifact {
  readonly fileName: string;
  readonly sha256: string;
  readonly url: string;
}

export const WHISPER_CPP_SOURCE = {
  commit: WHISPER_CPP_COMMIT,
  fileName: `whisper.cpp-${WHISPER_CPP_COMMIT}.tar.gz`,
  sha256: "279af4ce60dbf397362868f3bacc75b56a4332ac2541cae155070093f6aaf0e3",
  url: `https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_CPP_COMMIT}.tar.gz`,
} as const satisfies VerifiedArtifact & { readonly commit: string };

export const WHISPER_CPP_PREBUILT = {
  "linux-arm64": {
    fileName: "whisper-bin-ubuntu-arm64.tar.gz",
    sha256: "e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-ubuntu-arm64.tar.gz",
  },
  "linux-x64": {
    fileName: "whisper-bin-ubuntu-x64.tar.gz",
    sha256: "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-ubuntu-x64.tar.gz",
  },
} as const satisfies Record<string, VerifiedArtifact>;

export type WhisperRuntimePlatform = "linux" | "mac" | "win";
export type WhisperRuntimeArch = "arm64" | "x64" | "universal";

/**
 * Raised when a platform's runtime is built differently from the same pinned
 * source, so a receipt or development cache entry of the earlier build is not
 * taken for this one. Windows 2 is built here from source; Windows 1 was the
 * upstream archive, which needed the Visual C++ Redistributable.
 */
export const WHISPER_RUNTIME_BUILD: Readonly<Record<WhisperRuntimePlatform, number>> = {
  linux: 1,
  mac: 1,
  win: 2,
};

/** The CPU backends ggml builds with MSVC for x64; whisper-server loads the best one the CPU supports. */
export const WHISPER_WINDOWS_CPU_VARIANTS = [
  "x64",
  "sse42",
  "sandybridge",
  "haswell",
  "skylakex",
  "cannonlake",
  "cascadelake",
  "icelake",
  "alderlake",
] as const;

export const WHISPER_WINDOWS_RUNTIME_FILES = [
  "whisper-server.exe",
  "whisper.dll",
  "ggml.dll",
  "ggml-base.dll",
  ...WHISPER_WINDOWS_CPU_VARIANTS.map((variant) => `ggml-cpu-${variant}.dll`),
] as const;

interface StageOptions {
  readonly arch: WhisperRuntimeArch;
  readonly output: string;
  readonly platform: WhisperRuntimePlatform;
  readonly verbose: boolean;
}

interface CliOptions extends StageOptions {
  /**
   * How a development checkout uses the runtimes other checkouts on this
   * machine have staged: not at all, before building, or without ever building.
   * Packaging never uses it.
   */
  readonly developmentCache: "off" | "use" | "only";
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function run(command: string, args: readonly string[], options: RunOptions = {}) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`),
        );
    });
  });
}

function capture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(new Error(`${command} exited ${String(code)}: ${output.trim()}`)),
    );
  });
}

async function sha256File(filePath: string): Promise<string> {
  return NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(filePath))
    .digest("hex");
}

export async function downloadVerified(
  artifact: VerifiedArtifact,
  destination: string,
): Promise<void> {
  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${artifact.url}: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(
      `Checksum mismatch for ${artifact.fileName}: expected ${artifact.sha256}, received ${digest}.`,
    );
  }
  await NodeFSP.writeFile(destination, bytes, { flag: "wx" });
}

export function assertPinnedWhisperServerSource(serverSource: string): void {
  for (const fragment of [
    'arg == "--request-path"',
    "sparams.request_path = argv[++i]",
    "svr->Options(sparams.request_path + sparams.inference_path",
  ]) {
    if (!serverSource.includes(fragment)) {
      throw new Error(`Pinned whisper-server source is missing required behavior: ${fragment}`);
    }
  }
}

export function resolvePrebuiltArtifact(
  platform: WhisperRuntimePlatform,
  arch: WhisperRuntimeArch,
): VerifiedArtifact | null {
  // macOS and Windows x64 are built here from the pinned source.
  if (platform === "mac" || (platform === "win" && arch === "x64")) return null;
  const artifact = WHISPER_CPP_PREBUILT[`${platform}-${arch}` as keyof typeof WHISPER_CPP_PREBUILT];
  if (!artifact) {
    throw new Error(
      `whisper.cpp ${WHISPER_CPP_VERSION} has no verified ${platform}/${arch} runtime.`,
    );
  }
  return artifact;
}

export function runtimeExecutableName(platform: WhisperRuntimePlatform): string {
  return platform === "win" ? "whisper-server.exe" : "whisper-server";
}

type ArchiveFormat = "tar.gz" | "zip";
type ArchiveHostPlatform = "win32" | "darwin" | "linux";

interface ArchiveExtractionPlan {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
}

function archiveFormat(fileName: string): ArchiveFormat {
  if (fileName.endsWith(".tar.gz")) return "tar.gz";
  if (fileName.endsWith(".zip")) return "zip";
  throw new Error(`Unsupported whisper runtime archive: ${fileName}`);
}

export function resolveArchiveExtractionPlan(
  archive: string,
  destination: string,
  hostPlatform: ArchiveHostPlatform,
): ArchiveExtractionPlan {
  const format = archiveFormat(archive);
  if (format === "zip" && hostPlatform === "win32") {
    return {
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:SCIENT_WHISPER_ARCHIVE -DestinationPath $env:SCIENT_WHISPER_DESTINATION -Force",
      ],
      command: "powershell.exe",
      env: {
        SCIENT_WHISPER_ARCHIVE: archive,
        SCIENT_WHISPER_DESTINATION: destination,
      },
    };
  }

  return {
    args: [
      ...(hostPlatform === "win32" ? ["--force-local"] : []),
      ...(format === "tar.gz" ? ["-xzf"] : ["-xf"]),
      archive,
      "-C",
      destination,
    ],
    command: "tar",
  };
}

async function extractArchive(
  archive: string,
  destination: string,
  hostPlatform: ArchiveHostPlatform = process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux",
): Promise<void> {
  const plan = resolveArchiveExtractionPlan(archive, destination, hostPlatform);
  if (plan.env) {
    await run(plan.command, plan.args, { env: { ...process.env, ...plan.env } });
    return;
  }
  await run(plan.command, plan.args);
}

async function extractSource(archive: string, workspace: string): Promise<string> {
  await extractArchive(archive, workspace);
  const sourceDirectory = NodePath.join(workspace, `whisper.cpp-${WHISPER_CPP_COMMIT}`);
  const serverSource = await NodeFSP.readFile(
    NodePath.join(sourceDirectory, "examples/server/server.cpp"),
    "utf8",
  );
  assertPinnedWhisperServerSource(serverSource);
  return sourceDirectory;
}

async function buildMacRuntime(
  sourceDirectory: string,
  output: string,
  arch: WhisperRuntimeArch,
): Promise<void> {
  const buildDirectory = NodePath.join(sourceDirectory, "build-scient");
  const cmakeArchitecture =
    arch === "universal" ? "arm64;x86_64" : arch === "x64" ? "x86_64" : "arm64";
  await run("cmake", [
    "-S",
    sourceDirectory,
    "-B",
    buildDirectory,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_OSX_ARCHITECTURES=${cmakeArchitecture}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${WHISPER_MACOS_DEPLOYMENT_TARGET}`,
    "-DBUILD_SHARED_LIBS=OFF",
    "-DGGML_ACCELERATE=ON",
    "-DGGML_BLAS=OFF",
    "-DGGML_NATIVE=OFF",
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_BUILD_SERVER=ON",
  ]);
  await run("cmake", [
    "--build",
    buildDirectory,
    "--config",
    "Release",
    "--target",
    "whisper-server",
  ]);
  await NodeFSP.copyFile(
    NodePath.join(buildDirectory, "bin", "whisper-server"),
    NodePath.join(output, "whisper-server"),
  );
}

const WINDOWS_BUILD_TOOLS_REQUIRED =
  "Building the Windows voice helper needs Visual Studio 2022 or later with the C++ desktop workload (Build Tools are enough), which packaging runners have. A machine without them can use a runtime another checkout on it staged (see docs/internals/scient-voice.md).";

/**
 * The upstream Windows archive needs the Visual C++ Redistributable, including
 * its OpenMP library, which many Windows machines lack. This build needs only
 * Windows: ggml's own thread pool replaces OpenMP, and every file carries the
 * C and C++ runtime it uses. The CPU backends stay separate files so that each
 * machine gets the fastest one its processor supports.
 */
export function windowsCMakeConfigureArguments(
  sourceDirectory: string,
  buildDirectory: string,
): string[] {
  return [
    "-S",
    sourceDirectory,
    "-B",
    buildDirectory,
    "-A",
    "x64",
    "-DBUILD_SHARED_LIBS=ON",
    "-DGGML_BACKEND_DL=ON",
    "-DGGML_CPU_ALL_VARIANTS=ON",
    "-DGGML_NATIVE=OFF",
    "-DGGML_OPENMP=OFF",
    // whisper.cpp declares CMake 3.5, so the runtime choice needs this policy.
    "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
    "-DWHISPER_SDL2=OFF",
    "-DWHISPER_CURL=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_BUILD_SERVER=ON",
  ];
}

/** CMake on the PATH, or the copy that ships with a Visual Studio that has the C++ tools. */
async function resolveWindowsCMake(): Promise<string> {
  if (
    await capture("cmake", ["--version"]).then(
      () => true,
      () => false,
    )
  )
    return "cmake";
  const programFiles = process.env["ProgramFiles(x86)"] ?? String.raw`C:\Program Files (x86)`;
  const vswhere = NodePath.join(
    programFiles,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const installation = await capture(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]).then(
    (output) => output.trim().split(/\r?\n/u)[0] ?? "",
    () => "",
  );
  if (installation) {
    const bundled = NodePath.join(
      installation,
      "Common7",
      "IDE",
      "CommonExtensions",
      "Microsoft",
      "CMake",
      "CMake",
      "bin",
      "cmake.exe",
    );
    if (
      await NodeFSP.stat(bundled).then(
        (entry) => entry.isFile(),
        () => false,
      )
    )
      return bundled;
  }
  throw new Error(WINDOWS_BUILD_TOOLS_REQUIRED);
}

async function buildWindowsRuntime(sourceDirectory: string, output: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The Windows voice helper is built on Windows.");
  }
  const cmake = await resolveWindowsCMake();
  const buildDirectory = NodePath.join(sourceDirectory, "build-scient");
  // The Visual Studio generator is the one this configuration is written for.
  const env = { ...process.env };
  delete env.CMAKE_GENERATOR;
  delete env.CMAKE_GENERATOR_PLATFORM;
  delete env.CMAKE_GENERATOR_TOOLSET;
  try {
    await run(cmake, windowsCMakeConfigureArguments(sourceDirectory, buildDirectory), { env });
  } catch (error) {
    throw new Error(`${String(error)} ${WINDOWS_BUILD_TOOLS_REQUIRED}`, { cause: error });
  }
  await run(
    cmake,
    ["--build", buildDirectory, "--config", "Release", "--target", "whisper-server", "--parallel"],
    { env },
  );
  const releaseDirectory = NodePath.join(buildDirectory, "bin", "Release");
  for (const file of WHISPER_WINDOWS_RUNTIME_FILES) {
    await NodeFSP.copyFile(NodePath.join(releaseDirectory, file), NodePath.join(output, file));
  }
}

/** Libraries every supported Windows (10 and later) provides; anything else must ship with the runtime. */
const WINDOWS_SYSTEM_LIBRARIES = new Set([
  "advapi32.dll",
  "bcrypt.dll",
  "crypt32.dll",
  "dbghelp.dll",
  "gdi32.dll",
  "iphlpapi.dll",
  "kernel32.dll",
  "mswsock.dll",
  "ntdll.dll",
  "ole32.dll",
  "oleaut32.dll",
  "psapi.dll",
  "rpcrt4.dll",
  "secur32.dll",
  "shell32.dll",
  "shlwapi.dll",
  "user32.dll",
  "userenv.dll",
  "version.dll",
  "winmm.dll",
  "ws2_32.dll",
]);

export interface PortableExecutableSummary {
  readonly machine: number;
  /** Libraries loaded at start and on first use (delay-loaded), as named in the file. */
  readonly imports: readonly string[];
}

export const PE_MACHINE_X64 = 0x8664;

/** Reads the machine type and imported library names of a Windows executable or DLL. */
export function readPortableExecutable(bytes: Uint8Array): PortableExecutableSummary {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (reason: string): never => {
    throw new Error(`Not a readable Windows executable: ${reason}.`);
  };
  const u16 = (offset: number) =>
    offset >= 0 && offset + 2 <= view.length ? view.readUInt16LE(offset) : fail("truncated");
  const u32 = (offset: number) =>
    offset >= 0 && offset + 4 <= view.length ? view.readUInt32LE(offset) : fail("truncated");
  if (u16(0) !== 0x5a4d) fail("no MZ header");
  const header = u32(0x3c);
  if (u32(header) !== 0x4550) fail("no PE signature");
  const machine = u16(header + 4);
  const sectionCount = u16(header + 6);
  const optional = header + 24;
  const sections = optional + u16(header + 20);
  const magic = u16(optional);
  if (magic !== 0x20b && magic !== 0x10b) fail("unknown optional header");
  const wide = magic === 0x20b;
  const directoryCount = u32(optional + (wide ? 108 : 92));
  const directories = optional + (wide ? 112 : 96);
  const offsetOf = (rva: number): number => {
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sections + index * 40;
      const virtualSize = u32(section + 8);
      const address = u32(section + 12);
      const rawSize = u32(section + 16);
      if (rva >= address && rva < address + Math.max(virtualSize, rawSize)) {
        return rva - address + u32(section + 20);
      }
    }
    return fail(`address ${rva} is outside every section`);
  };
  const nameAt = (rva: number) => {
    const start = offsetOf(rva);
    const end = view.indexOf(0, start);
    return end === -1 ? fail("unterminated library name") : view.toString("latin1", start, end);
  };
  const imports: string[] = [];
  // Import descriptors are 20 bytes with the name at 12; delay-load ones are
  // 32 bytes with attributes at 0 (bit 0: addresses are relative) and the name at 4.
  for (const { index, size, name, delayed } of [
    { index: 1, size: 20, name: 12, delayed: false },
    { index: 13, size: 32, name: 4, delayed: true },
  ]) {
    if (directoryCount <= index) continue;
    const rva = u32(directories + index * 8);
    if (rva === 0) continue;
    for (let entry = offsetOf(rva); ; entry += size) {
      const nameRva = u32(entry + name);
      if (nameRva === 0) break;
      if (delayed && (u32(entry) & 1) === 0) fail("old-style delay-load descriptor");
      imports.push(nameAt(nameRva));
      if (imports.length > 4096) fail("too many imports");
    }
  }
  return { machine, imports };
}

/**
 * Lists every library a runtime file needs that is neither one of the
 * runtime's own files nor part of Windows. The Universal C Runtime (the
 * api-ms-win-crt-* names) is part of Windows 10 and later; the Visual C++
 * runtime (vcruntime140.dll, msvcp140.dll, vcomp140.dll) is not.
 */
export function findUnshippedWindowsImports(
  files: ReadonlyMap<string, PortableExecutableSummary>,
): string[] {
  const shipped = new Set([...files.keys()].map((file) => file.toLowerCase()));
  const missing: string[] = [];
  for (const [file, summary] of files) {
    for (const library of summary.imports) {
      const name = library.toLowerCase();
      if (shipped.has(name) || WINDOWS_SYSTEM_LIBRARIES.has(name)) continue;
      if (name.startsWith("api-ms-win-")) continue;
      missing.push(`${file} needs ${library}`);
    }
  }
  return missing;
}

/** Fails unless every executable and DLL in `directory` is x64 and needs only Windows and its neighbours. */
export async function assertWindowsRuntimeSelfContained(directory: string): Promise<void> {
  const files = new Map<string, PortableExecutableSummary>();
  for (const file of (await NodeFSP.readdir(directory)).toSorted()) {
    if (!/\.(?:exe|dll)$/iu.test(file)) continue;
    const summary = readPortableExecutable(await NodeFSP.readFile(NodePath.join(directory, file)));
    if (summary.machine !== PE_MACHINE_X64) throw new Error(`${file} is not an x64 binary.`);
    files.set(file, summary);
  }
  const missing = findUnshippedWindowsImports(files);
  if (missing.length > 0) {
    throw new Error(
      `The Windows voice runtime needs libraries that Windows does not provide: ${missing.join("; ")}.`,
    );
  }
}

async function stagePrebuiltRuntime(
  artifact: VerifiedArtifact,
  archive: string,
  workspace: string,
  output: string,
): Promise<void> {
  const extracted = NodePath.join(workspace, "prebuilt");
  await NodeFSP.mkdir(extracted);
  await extractArchive(archive, extracted);
  const [root] = await NodeFSP.readdir(extracted);
  if (!root) throw new Error(`${artifact.fileName} was empty.`);
  const releaseDirectory = NodePath.join(extracted, root);
  for (const file of await NodeFSP.readdir(releaseDirectory)) {
    if (file === "whisper-server" || file.includes(".so")) {
      await NodeFSP.cp(NodePath.join(releaseDirectory, file), NodePath.join(output, file), {
        dereference: true,
      });
    }
  }
}

async function collectFiles(output: string) {
  const names = (await NodeFSP.readdir(output))
    .filter((name) => name !== "provenance.json")
    .toSorted();
  return Promise.all(
    names.map(async (file) => {
      const filePath = NodePath.join(output, file);
      const fileStat = await NodeFSP.stat(filePath);
      return { file, sha256: await sha256File(filePath), size: fileStat.size };
    }),
  );
}

export async function stageWhisperRuntime(options: StageOptions): Promise<void> {
  const output = NodePath.resolve(options.output);
  const prebuilt = resolvePrebuiltArtifact(options.platform, options.arch);
  const workspace = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-whisper-runtime-"),
  );
  const temporaryOutput = `${output}.partial-${process.pid}`;
  try {
    await NodeFSP.rm(temporaryOutput, { recursive: true, force: true });
    await NodeFSP.mkdir(temporaryOutput, { recursive: true });
    const sourceArchive = NodePath.join(workspace, WHISPER_CPP_SOURCE.fileName);
    if (options.verbose) console.log(`[voice-runtime] Downloading ${WHISPER_CPP_SOURCE.url}`);
    await downloadVerified(WHISPER_CPP_SOURCE, sourceArchive);
    const sourceDirectory = await extractSource(sourceArchive, workspace);
    await NodeFSP.copyFile(
      NodePath.join(sourceDirectory, "LICENSE"),
      NodePath.join(temporaryOutput, "LICENSE.whisper.cpp"),
    );

    if (prebuilt) {
      const archive = NodePath.join(workspace, prebuilt.fileName);
      if (options.verbose) console.log(`[voice-runtime] Downloading ${prebuilt.url}`);
      await downloadVerified(prebuilt, archive);
      await stagePrebuiltRuntime(prebuilt, archive, workspace, temporaryOutput);
    } else if (options.platform === "win") {
      await buildWindowsRuntime(sourceDirectory, temporaryOutput);
    } else {
      await buildMacRuntime(sourceDirectory, temporaryOutput, options.arch);
    }

    const executable = NodePath.join(temporaryOutput, runtimeExecutableName(options.platform));
    await NodeFSP.stat(executable);
    if (options.platform === "win") await assertWindowsRuntimeSelfContained(temporaryOutput);
    else await NodeFSP.chmod(executable, 0o755);
    const help = await capture(executable, ["--help"]);
    if (!help.includes("--request-path")) {
      throw new Error("Staged whisper-server does not advertise --request-path.");
    }
    const files = await collectFiles(temporaryOutput);
    if (!files.some((file) => file.file === runtimeExecutableName(options.platform))) {
      throw new Error("Staged whisper.cpp runtime is missing its executable.");
    }
    if (options.platform === "linux" && !files.some((file) => file.file.includes(".so"))) {
      throw new Error("Staged Linux whisper.cpp runtime is missing shared libraries.");
    }
    const receipt = {
      schemaVersion: 1,
      component: "whisper.cpp",
      version: WHISPER_CPP_VERSION,
      platform: options.platform,
      arch: options.arch,
      build: WHISPER_RUNTIME_BUILD[options.platform],
      source: WHISPER_CPP_SOURCE,
      binaryArtifact: prebuilt,
      sourceAssertions: { optionsReadinessRoute: true, requestPathArgument: true },
      macAcceleration:
        options.platform === "mac"
          ? {
              accelerate: true,
              deploymentTarget: WHISPER_MACOS_DEPLOYMENT_TARGET,
              metal: true,
              metalLibraryEmbedded: true,
            }
          : null,
      windowsBuild:
        options.platform === "win"
          ? {
              compiler: "MSVC",
              cpuVariants: WHISPER_WINDOWS_CPU_VARIANTS,
              openmp: false,
              staticRuntime: true,
            }
          : null,
      files,
    };
    await NodeFSP.writeFile(
      NodePath.join(temporaryOutput, "provenance.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await NodeFSP.rm(output, { recursive: true, force: true });
    await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
    await NodeFSP.rename(temporaryOutput, output);
    console.log(
      `[voice-runtime] Staged ${WHISPER_CPP_VERSION} ${options.platform}/${options.arch} at ${output}`,
    );
  } finally {
    await NodeFSP.rm(workspace, { recursive: true, force: true });
    await NodeFSP.rm(temporaryOutput, { recursive: true, force: true });
  }
}

/** Where development checkouts on one machine keep staged runtimes for each other. */
export function resolveDevelopmentRuntimeCache(homeDirectory = NodeOS.homedir()): string {
  return NodePath.join(homeDirectory, ".scient-next", "dev-shared", "voice", "whisper-runtime");
}

/** One entry for each pinned build, so a checkout never takes another version's helper. */
export function developmentRuntimeCacheEntry(
  cacheRoot: string,
  platform: WhisperRuntimePlatform,
  arch: WhisperRuntimeArch,
): string {
  const build = WHISPER_RUNTIME_BUILD[platform];
  return NodePath.join(
    cacheRoot,
    `${WHISPER_CPP_VERSION}-${WHISPER_CPP_COMMIT.slice(0, 12)}-${platform}-${arch}${build > 1 ? `-build${build}` : ""}`,
  );
}

/**
 * Whether a folder holds this exact pinned runtime, complete: its receipt
 * names this version, commit, platform, architecture and build, and the folder holds
 * exactly the recorded files, each an ordinary file of the recorded size and
 * checksum. A link, a folder, a partial copy, a damaged file and another
 * version all fail. It is not a defence against someone who can already write
 * to the user's files.
 */
export async function isStagedWhisperRuntime(
  directory: string,
  platform: WhisperRuntimePlatform,
  arch: WhisperRuntimeArch,
): Promise<boolean> {
  try {
    const receipt: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "provenance.json"), "utf8"),
    );
    if (typeof receipt !== "object" || receipt === null) return false;
    const { component, version, source, files } = receipt as Record<string, unknown>;
    const recorded = receipt as {
      readonly platform?: unknown;
      readonly arch?: unknown;
      readonly build?: unknown;
    };
    if (
      component !== "whisper.cpp" ||
      version !== WHISPER_CPP_VERSION ||
      recorded.platform !== platform ||
      recorded.arch !== arch ||
      // Receipts written before builds were numbered are build 1.
      (recorded.build ?? 1) !== WHISPER_RUNTIME_BUILD[platform] ||
      (source as { readonly commit?: unknown } | null)?.commit !== WHISPER_CPP_COMMIT ||
      !Array.isArray(files)
    )
      return false;
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    // A link would leave the copy depending on a file outside it.
    if (!entries.every((entry) => entry.isFile())) return false;
    const actual = await collectFiles(directory);
    return (
      actual.some((file) => file.file === runtimeExecutableName(platform)) &&
      actual.length === files.length &&
      actual.every((file, index) => {
        const expected = files[index] as Record<string, unknown> | null;
        return (
          expected?.file === file.file &&
          expected.sha256 === file.sha256 &&
          expected.size === file.size
        );
      })
    );
  } catch {
    return false;
  }
}

/**
 * Puts a verified copy of `source` at `destination`. The copy is checked
 * before it is given its name, so the destination is this runtime, complete,
 * or is left as it was. A destination that already holds this runtime is never
 * removed: when two checkouts publish at once the first one stays and the
 * second finds it there. Only a destination that fails verification is moved
 * aside to make room.
 */
async function publishVerifiedCopy(input: {
  readonly source: string;
  readonly destination: string;
  readonly platform: WhisperRuntimePlatform;
  readonly arch: WhisperRuntimeArch;
}): Promise<boolean> {
  const { source, destination, platform, arch } = input;
  const unique = `${process.pid}-${NodeCrypto.randomBytes(4).toString("hex")}`;
  const pending = `${destination}.partial-${unique}`;
  const replaced = `${destination}.replaced-${unique}`;
  const moveIntoPlace = () =>
    NodeFSP.rename(pending, destination).then(
      () => true,
      () => false,
    );
  try {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.cp(source, pending, { recursive: true, errorOnExist: true, dereference: true });
    if (!(await isStagedWhisperRuntime(pending, platform, arch))) return false;
    // Renaming onto a folder that has contents fails, so this never replaces anything.
    if (await moveIntoPlace()) return true;
    if (await isStagedWhisperRuntime(destination, platform, arch)) return true;
    await NodeFSP.rename(destination, replaced).catch(() => undefined);
    await moveIntoPlace();
    return await isStagedWhisperRuntime(destination, platform, arch);
  } catch {
    return false;
  } finally {
    await NodeFSP.rm(pending, { recursive: true, force: true }).catch(() => undefined);
    await NodeFSP.rm(replaced, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Makes a checkout's runtime and the development cache agree without building
 * anything: a checkout that lacks the runtime takes the cached one, and a
 * checkout that has it adds it to the cache. Returns what it did. The caller
 * must own the checkout's runtime: no app of that checkout may be running.
 */
export async function syncDevelopmentRuntimeCache(input: {
  readonly cacheRoot: string;
  readonly output: string;
  readonly platform: WhisperRuntimePlatform;
  readonly arch: WhisperRuntimeArch;
}): Promise<"restored" | "cached" | "current" | "missing"> {
  const { platform, arch } = input;
  const output = NodePath.resolve(input.output);
  const entry = developmentRuntimeCacheEntry(input.cacheRoot, platform, arch);
  const staged = await isStagedWhisperRuntime(output, platform, arch);
  const cached = await isStagedWhisperRuntime(entry, platform, arch);
  if (staged && cached) return "current";
  if (staged) {
    // Not shared this time is not a failure: the checkout already has its runtime.
    return (await publishVerifiedCopy({ source: output, destination: entry, platform, arch }))
      ? "cached"
      : "current";
  }
  if (!cached) return "missing";
  return (await publishVerifiedCopy({ source: entry, destination: output, platform, arch }))
    ? "restored"
    : "missing";
}

function hostPlatform(): WhisperRuntimePlatform {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

export function parseArguments(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let verbose = false;
  let developmentCache: CliOptions["developmentCache"] = "off";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    if (argument === "--dev-cache" || argument === "--dev-cache-only") {
      developmentCache = argument === "--dev-cache-only" ? "only" : "use";
      continue;
    }
    const value = args[index + 1];
    if (!argument?.startsWith("--") || !value)
      throw new Error(`Invalid argument ${argument ?? ""}.`);
    values.set(argument, value);
    index += 1;
  }
  const platform = (values.get("--platform") ?? hostPlatform()) as WhisperRuntimePlatform;
  const arch = (values.get("--arch") ?? process.arch) as WhisperRuntimeArch;
  const defaultOutput = NodeURL.fileURLToPath(
    new URL("../native/whisper-runtime", import.meta.url),
  );
  const output = values.get("--output") ?? defaultOutput;
  if (!["linux", "mac", "win"].includes(platform)) throw new Error("Invalid platform.");
  if (!["arm64", "x64", "universal"].includes(arch)) throw new Error("Invalid architecture.");
  return { arch, output, platform, verbose, developmentCache };
}

async function runCli(options: CliOptions): Promise<void> {
  if (options.developmentCache === "off") return stageWhisperRuntime(options);
  const cache = { ...options, cacheRoot: resolveDevelopmentRuntimeCache() };
  const before = await syncDevelopmentRuntimeCache(cache);
  if (before === "restored")
    console.log(`[voice-runtime] Copied ${WHISPER_CPP_VERSION} from this machine's dev cache.`);
  if (before !== "missing" || options.developmentCache === "only") return;
  await stageWhisperRuntime(options);
  // The runtime is staged either way; sharing it is a convenience.
  await syncDevelopmentRuntimeCache(cache).catch(() => undefined);
}

const isEntrypoint =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isEntrypoint) {
  runCli(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
