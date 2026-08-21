#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off -- standalone verified build tool.
/* oxlint-disable t3code/no-global-process-runtime -- standalone CLI runtime detection; pure helpers are exported for tests. */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const SYNCTEX_COMMIT = "82f46b64283b299b045a0295a09aadc11c644e1f";
export const SYNCTEX_CLI_VERSION = "1.7";
export const SYNCTEX_PARSER_VERSION = "1.31";
export const ZLIB_COMMIT = "da607da739fa6047df13e66a2af6b8bec7c2a498";
export const ZLIB_VERSION = "1.3.2";
export const SYNCTEX_MACOS_DEPLOYMENT_TARGET = "12.0";

interface VerifiedSource {
  readonly commit: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly url: string;
}

export const SYNCTEX_SOURCE = {
  commit: SYNCTEX_COMMIT,
  fileName: `synctex-${SYNCTEX_COMMIT}.tar.gz`,
  sha256: "d09ba3a19a4837d0ca3efe9c392c4a5888b1b47b14ec2910c88257947a5ad061",
  url: `https://github.com/jlaurens/synctex/archive/${SYNCTEX_COMMIT}.tar.gz`,
} as const satisfies VerifiedSource;

export const ZLIB_SOURCE = {
  commit: ZLIB_COMMIT,
  fileName: `zlib-${ZLIB_COMMIT}.tar.gz`,
  sha256: "b9258cf6254e7f7c37f1cd61dba943a1c5ea3cff5718c789834dac359094f5f7",
  url: `https://github.com/madler/zlib/archive/${ZLIB_COMMIT}.tar.gz`,
} as const satisfies VerifiedSource;

export type SyncTexRuntimePlatform = "linux" | "mac" | "win";
export type SyncTexRuntimeArch = "arm64" | "x64" | "universal";

interface StageOptions {
  readonly arch: SyncTexRuntimeArch;
  readonly output: string;
  readonly platform: SyncTexRuntimePlatform;
  readonly verbose: boolean;
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly verbose?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: false,
      stdio: options.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    if (!options.verbose && child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`})${stderr.trim().length > 0 ? `: ${stderr.trim()}` : "."}`,
          ),
        );
    });
  });
}

function capture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
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
        ? resolve(output)
        : reject(new Error(`${command} exited ${String(code)}: ${output.trim()}`)),
    );
  });
}

async function sha256File(filePath: string): Promise<string> {
  return NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(filePath))
    .digest("hex");
}

async function downloadVerified(source: VerifiedSource, destination: string): Promise<void> {
  const response = await fetch(source.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${source.url}: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== source.sha256) {
    throw new Error(
      `Checksum mismatch for ${source.fileName}: expected ${source.sha256}, received ${digest}.`,
    );
  }
  await NodeFSP.writeFile(destination, bytes, { flag: "wx" });
}

export function runtimeExecutableName(platform: SyncTexRuntimePlatform): string {
  return platform === "win" ? "synctex.exe" : "synctex";
}

export function runtimePlatformKey(
  platform: SyncTexRuntimePlatform,
  arch: SyncTexRuntimeArch,
): string {
  const processPlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `${processPlatform}-${arch}`;
}

export function cmakeArchitecture(
  platform: SyncTexRuntimePlatform,
  arch: SyncTexRuntimeArch,
): string | null {
  if (platform !== "mac") return null;
  if (arch === "universal") return "arm64;x86_64";
  return arch === "x64" ? "x86_64" : "arm64";
}

export function assertPinnedSyncTexSource(versionHeader: string, mainSource: string): void {
  for (const fragment of [
    `SYNCTEX_CLI_VERSION_STRING "${SYNCTEX_CLI_VERSION}"`,
    `SYNCTEX_VERSION_STRING "${SYNCTEX_PARSER_VERSION}"`,
  ]) {
    if (!versionHeader.includes(fragment)) {
      throw new Error(`Pinned SyncTeX source is missing the expected version: ${fragment}`);
    }
  }
  if (!mainSource.includes("SYNCTEX_STANDALONE")) {
    throw new Error("Pinned SyncTeX source no longer exposes its standalone build contract.");
  }
}

export function assertStaticLinuxProgramHeaders(programHeaders: string): void {
  if (/\bINTERP\b/u.test(programHeaders)) {
    throw new Error("Staged Linux SyncTeX runtime is dynamically linked.");
  }
}

function replaceRequiredOnce(
  source: string,
  expected: string,
  replacement: string,
  label: string,
): string {
  const first = source.indexOf(expected);
  if (first < 0 || first !== source.lastIndexOf(expected)) {
    throw new Error(`Pinned SyncTeX source has an unexpected ${label} contract.`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

/**
 * The official standalone CLI uses a POSIX-only interactive loop even though
 * its one-shot view/edit paths support Windows. Scient never enables that
 * interactive mode, so the Windows asset fails it explicitly and keeps the
 * official parser and one-shot CLI behavior unchanged.
 */
export function adaptSyncTexMainForWindows(mainSource: string): string {
  const withPortableIncludes = replaceRequiredOnce(
    mainSource,
    "#   include <poll.h>\n#   include <unistd.h>",
    `#   if defined(WIN32)
#       include <direct.h>
#       define getcwd _getcwd
#   else
#       include <poll.h>
#       include <unistd.h>
#   endif`,
    "POSIX include",
  );
  const withExplicitWindowsFailure = replaceRequiredOnce(
    withPortableIncludes,
    "    if (!status && g_interactive) {",
    `#if defined(WIN32)
    if (!status && g_interactive) {
        fputs("SyncTeX ERROR: interactive mode is unavailable on Windows.\\n", stderr);
        status = 1;
    }
#else
    if (!status && g_interactive) {`,
    "interactive entry",
  );
  return replaceRequiredOnce(
    withExplicitWindowsFailure,
    `    }
    synctex_scanner_free(g_scanner);
    g_scanner = NULL;
    return status;
}

static void synctex_usage`,
    `    }
#endif
    synctex_scanner_free(g_scanner);
    g_scanner = NULL;
    return status;
}

static void synctex_usage`,
    "interactive exit",
  );
}

export function adaptSyncTexConfigForWindows(configHeader: string): string {
  return replaceRequiredOnce(
    configHeader,
    "#define HAVE_STRLCAT\n#define HAVE_STRLCPY\n",
    "",
    "standalone feature header",
  );
}

export function renderCMakeProject(input: {
  readonly syncTexDirectory: string;
  readonly zlibDirectory: string;
}): string {
  const syncTex = input.syncTexDirectory.replaceAll("\\", "/");
  const zlib = input.zlibDirectory.replaceAll("\\", "/");
  return `cmake_minimum_required(VERSION 3.20)
cmake_policy(SET CMP0091 NEW)
project(scient_synctex C)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ZLIB_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZLIB_BUILD_TESTING OFF CACHE BOOL "" FORCE)
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>" CACHE STRING "" FORCE)
endif()
add_subdirectory("${zlib}" zlib-build EXCLUDE_FROM_ALL)
add_executable(synctex
  "${syncTex}/synctex_main.c"
  "${syncTex}/synctex_parser.c"
  "${syncTex}/synctex_parser_utils.c"
)
set_source_files_properties("${syncTex}/synctex_main.c" PROPERTIES COMPILE_DEFINITIONS SYNCTEX_STANDALONE)
target_include_directories(synctex PRIVATE "${syncTex}" "${zlib}" "\${CMAKE_CURRENT_BINARY_DIR}/zlib-build")
target_link_libraries(synctex PRIVATE zlibstatic)
if(WIN32)
  target_compile_definitions(synctex PRIVATE WIN32)
  target_link_libraries(synctex PRIVATE Shlwapi)
  target_compile_options(synctex PRIVATE /W3 /guard:cf)
  target_link_options(synctex PRIVATE /guard:cf /DYNAMICBASE /NXCOMPAT)
else()
  target_compile_options(synctex PRIVATE -Wall -Wextra -fstack-protector-strong)
  target_link_options(synctex PRIVATE -fstack-protector-strong)
  if(UNIX AND NOT APPLE)
    target_compile_definitions(synctex PRIVATE _FORTIFY_SOURCE=2)
    target_link_options(synctex PRIVATE -static -Wl,-z,relro,-z,now)
  endif()
endif()
`;
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

async function extractSource(source: VerifiedSource, workspace: string): Promise<string> {
  const archive = NodePath.join(workspace, source.fileName);
  await downloadVerified(source, archive);
  await run("tar", ["-xzf", archive, "-C", workspace]);
  return NodePath.join(workspace, `${source.fileName.replace(/\.tar\.gz$/u, "")}`);
}

async function locateBuiltExecutable(buildDirectory: string, platform: SyncTexRuntimePlatform) {
  const executable = runtimeExecutableName(platform);
  for (const candidate of [
    NodePath.join(buildDirectory, executable),
    NodePath.join(buildDirectory, "Release", executable),
  ]) {
    try {
      const stat = await NodeFSP.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next generator layout.
    }
  }
  throw new Error(`CMake did not produce ${executable}.`);
}

export async function stageSyncTexRuntime(options: StageOptions): Promise<void> {
  const output = NodePath.resolve(options.output);
  const workspace = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-synctex-"));
  const temporaryOutput = `${output}.partial-${process.pid}`;
  try {
    await NodeFSP.rm(temporaryOutput, { recursive: true, force: true });
    await NodeFSP.mkdir(temporaryOutput, { recursive: true });
    if (options.verbose) console.log(`[synctex-runtime] Downloading ${SYNCTEX_SOURCE.url}`);
    const syncTexDirectory = await extractSource(SYNCTEX_SOURCE, workspace);
    if (options.verbose) console.log(`[synctex-runtime] Downloading ${ZLIB_SOURCE.url}`);
    const zlibDirectory = await extractSource(ZLIB_SOURCE, workspace);

    const [versionHeader, mainSource, configHeader] = await Promise.all([
      NodeFSP.readFile(NodePath.join(syncTexDirectory, "synctex_version.h"), "utf8"),
      NodeFSP.readFile(NodePath.join(syncTexDirectory, "synctex_main.c"), "utf8"),
      NodeFSP.readFile(NodePath.join(syncTexDirectory, "synctex_parser_c-auto.h"), "utf8"),
    ]);
    assertPinnedSyncTexSource(versionHeader, mainSource);
    if (options.platform === "win") {
      await Promise.all([
        NodeFSP.writeFile(
          NodePath.join(syncTexDirectory, "synctex_main.c"),
          adaptSyncTexMainForWindows(mainSource),
        ),
        NodeFSP.writeFile(
          NodePath.join(syncTexDirectory, "synctex_parser_c-auto.h"),
          adaptSyncTexConfigForWindows(configHeader),
        ),
      ]);
    }

    const projectDirectory = NodePath.join(workspace, "scient-build");
    const buildDirectory = NodePath.join(workspace, "build");
    await NodeFSP.mkdir(projectDirectory);
    await NodeFSP.writeFile(
      NodePath.join(projectDirectory, "CMakeLists.txt"),
      renderCMakeProject({ syncTexDirectory, zlibDirectory }),
    );
    const architecture = cmakeArchitecture(options.platform, options.arch);
    await run(
      "cmake",
      [
        "-S",
        projectDirectory,
        "-B",
        buildDirectory,
        "-DCMAKE_BUILD_TYPE=Release",
        ...(architecture === null ? [] : [`-DCMAKE_OSX_ARCHITECTURES=${architecture}`]),
        ...(options.platform === "mac"
          ? [`-DCMAKE_OSX_DEPLOYMENT_TARGET=${SYNCTEX_MACOS_DEPLOYMENT_TARGET}`]
          : []),
      ],
      { verbose: options.verbose },
    );
    await run("cmake", ["--build", buildDirectory, "--config", "Release", "--parallel"], {
      verbose: options.verbose,
    });

    const builtExecutable = await locateBuiltExecutable(buildDirectory, options.platform);
    const executable = NodePath.join(temporaryOutput, runtimeExecutableName(options.platform));
    await NodeFSP.copyFile(builtExecutable, executable);
    if (options.platform !== "win") {
      await NodeFSP.chmod(executable, 0o755);
      await run("strip", [executable]);
    }
    if (options.platform === "linux") {
      assertStaticLinuxProgramHeaders(await capture("readelf", ["-l", executable]));
    }
    await Promise.all([
      NodeFSP.copyFile(
        NodePath.join(syncTexDirectory, "LICENSE"),
        NodePath.join(temporaryOutput, "LICENSE.synctex"),
      ),
      NodeFSP.copyFile(
        NodePath.join(zlibDirectory, "LICENSE"),
        NodePath.join(temporaryOutput, "LICENSE.zlib"),
      ),
    ]);

    const help = await capture(executable, ["help"]);
    if (
      !help.includes(`command line utility, version ${SYNCTEX_CLI_VERSION}`) ||
      !help.includes(`command-line client, version ${SYNCTEX_PARSER_VERSION}`)
    ) {
      throw new Error("Staged SyncTeX runtime reported unexpected CLI or parser versions.");
    }
    const files = await collectFiles(temporaryOutput);
    const receipt = {
      schemaVersion: 1,
      component: "synctex",
      cliVersion: SYNCTEX_CLI_VERSION,
      parserVersion: SYNCTEX_PARSER_VERSION,
      platform: options.platform,
      arch: options.arch,
      platformKey: runtimePlatformKey(options.platform, options.arch),
      source: SYNCTEX_SOURCE,
      zlib: { version: ZLIB_VERSION, source: ZLIB_SOURCE, linkage: "static" },
      build: {
        cmake: (await capture("cmake", ["--version"])).split("\n", 1)[0]?.trim() ?? "unknown",
        linuxExecutableLinkage: options.platform === "linux" ? "static" : null,
        macosDeploymentTarget: options.platform === "mac" ? SYNCTEX_MACOS_DEPLOYMENT_TARGET : null,
      },
      smoke: { cliVersion: SYNCTEX_CLI_VERSION, parserVersion: SYNCTEX_PARSER_VERSION },
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
      `[synctex-runtime] Staged ${SYNCTEX_CLI_VERSION} ${options.platform}/${options.arch} at ${output}`,
    );
  } finally {
    await NodeFSP.rm(workspace, { recursive: true, force: true });
    await NodeFSP.rm(temporaryOutput, { recursive: true, force: true });
  }
}

function hostPlatform(): SyncTexRuntimePlatform {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function parseArguments(args: readonly string[]): StageOptions {
  const values = new Map<string, string>();
  let verbose = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    const value = args[index + 1];
    if (!argument?.startsWith("--") || !value)
      throw new Error(`Invalid argument ${argument ?? ""}.`);
    values.set(argument, value);
    index += 1;
  }
  const platform = (values.get("--platform") ?? hostPlatform()) as SyncTexRuntimePlatform;
  const arch = (values.get("--arch") ?? process.arch) as SyncTexRuntimeArch;
  const platformKey = runtimePlatformKey(platform, arch);
  const output =
    values.get("--output") ??
    NodeURL.fileURLToPath(new URL(`../native/synctex-runtime/${platformKey}`, import.meta.url));
  if (!["linux", "mac", "win"].includes(platform)) throw new Error("Invalid platform.");
  if (!["arm64", "x64", "universal"].includes(arch)) throw new Error("Invalid architecture.");
  if (arch === "universal" && platform !== "mac") {
    throw new Error("Universal SyncTeX runtimes are supported only on macOS.");
  }
  return { arch, output, platform, verbose };
}

const isEntrypoint =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isEntrypoint) {
  stageSyncTexRuntime(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
