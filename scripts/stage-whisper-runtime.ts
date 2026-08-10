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

interface VerifiedArtifact {
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
  "win-x64": {
    fileName: "whisper-bin-x64.zip",
    sha256: "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
  },
} as const satisfies Record<string, VerifiedArtifact>;

export type WhisperRuntimePlatform = "linux" | "mac" | "win";
export type WhisperRuntimeArch = "arm64" | "x64" | "universal";

interface StageOptions {
  readonly arch: WhisperRuntimeArch;
  readonly output: string;
  readonly platform: WhisperRuntimePlatform;
  readonly verbose: boolean;
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

async function downloadVerified(artifact: VerifiedArtifact, destination: string): Promise<void> {
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
  if (platform === "mac") return null;
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

async function stagePrebuiltRuntime(
  artifact: VerifiedArtifact,
  archive: string,
  workspace: string,
  output: string,
  platform: WhisperRuntimePlatform,
): Promise<void> {
  const extracted = NodePath.join(workspace, "prebuilt");
  await NodeFSP.mkdir(extracted);
  await extractArchive(archive, extracted);
  if (platform === "win") {
    const releaseDirectory = NodePath.join(extracted, "Release");
    for (const file of await NodeFSP.readdir(releaseDirectory)) {
      if (file === "whisper-server.exe" || file.endsWith(".dll")) {
        await NodeFSP.copyFile(NodePath.join(releaseDirectory, file), NodePath.join(output, file));
      }
    }
    return;
  }
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
      await stagePrebuiltRuntime(prebuilt, archive, workspace, temporaryOutput, options.platform);
    } else {
      await buildMacRuntime(sourceDirectory, temporaryOutput, options.arch);
    }

    const executable = NodePath.join(temporaryOutput, runtimeExecutableName(options.platform));
    await NodeFSP.stat(executable);
    if (options.platform !== "win") await NodeFSP.chmod(executable, 0o755);
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
    if (options.platform === "win" && !files.some((file) => file.file.endsWith(".dll"))) {
      throw new Error("Staged Windows whisper.cpp runtime is missing DLLs.");
    }
    const receipt = {
      schemaVersion: 1,
      component: "whisper.cpp",
      version: WHISPER_CPP_VERSION,
      platform: options.platform,
      arch: options.arch,
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

function hostPlatform(): WhisperRuntimePlatform {
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
  const platform = (values.get("--platform") ?? hostPlatform()) as WhisperRuntimePlatform;
  const arch = (values.get("--arch") ?? process.arch) as WhisperRuntimeArch;
  const defaultOutput = NodeURL.fileURLToPath(
    new URL("../native/whisper-runtime", import.meta.url),
  );
  const output = values.get("--output") ?? defaultOutput;
  if (!["linux", "mac", "win"].includes(platform)) throw new Error("Invalid platform.");
  if (!["arm64", "x64", "universal"].includes(arch)) throw new Error("Invalid architecture.");
  return { arch, output, platform, verbose };
}

const isEntrypoint =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isEntrypoint) {
  stageWhisperRuntime(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
