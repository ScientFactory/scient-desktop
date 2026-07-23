#!/usr/bin/env bun
// FILE: stage-whisper-runtime.ts
// Purpose: Stages a verified whisper.cpp server runtime for packaged desktop artifacts.
// Layer: Release/build script

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WHISPER_CPP_VERSION = "v1.9.1";

interface VerifiedArtifact {
  readonly fileName: string;
  readonly sha256: string;
  readonly url: string;
}

export const WHISPER_CPP_COMMIT = "f049fff95a089aa9969deb009cdd4892b3e74916";
export const WHISPER_CPP_SOURCE = {
  commit: WHISPER_CPP_COMMIT,
  fileName: `whisper.cpp-${WHISPER_CPP_COMMIT}.tar.gz`,
  sha256: "279af4ce60dbf397362868f3bacc75b56a4332ac2541cae155070093f6aaf0e3",
  url: `https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_CPP_COMMIT}.tar.gz`,
};

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

interface StagedFileReceipt {
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
}

interface WhisperRuntimeReceipt {
  readonly component: "whisper.cpp";
  readonly version: string;
  readonly files: ReadonlyArray<StagedFileReceipt>;
}

function run(command: string, args: ReadonlyArray<string>, options: { cwd?: string } = {}) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`),
      );
    });
  });
}

function capture(command: string, args: ReadonlyArray<string>) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} exited ${String(code)}: ${output.trim()}`));
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const bytes = await readFile(filePath);
  hash.update(bytes);
  return hash.digest("hex");
}

async function downloadVerified(artifact: VerifiedArtifact, destination: string): Promise<void> {
  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Could not download ${artifact.url}: HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(
      `Checksum mismatch for ${artifact.fileName}: expected ${artifact.sha256}, received ${actual}.`,
    );
  }
  await writeFile(destination, bytes, { flag: "wx" });
}

export function assertPinnedWhisperServerSource(serverSource: string): void {
  const requiredSourceFragments = [
    'arg == "--request-path"',
    "sparams.request_path = argv[++i]",
    "svr->Options(sparams.request_path + sparams.inference_path",
  ];
  for (const fragment of requiredSourceFragments) {
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
  const key = `${platform}-${arch}` as keyof typeof WHISPER_CPP_PREBUILT;
  const artifact = WHISPER_CPP_PREBUILT[key];
  if (!artifact) {
    throw new Error(
      `whisper.cpp ${WHISPER_CPP_VERSION} has no verified ${platform}/${arch} desktop runtime.`,
    );
  }
  return artifact;
}

async function extractSource(sourceArchive: string, workspace: string): Promise<string> {
  await run("tar", ["-xzf", sourceArchive, "-C", workspace]);
  const sourceDir = join(workspace, `whisper.cpp-${WHISPER_CPP_COMMIT}`);
  const serverSource = await readFile(join(sourceDir, "examples/server/server.cpp"), "utf8");
  assertPinnedWhisperServerSource(serverSource);
  return sourceDir;
}

async function buildMacRuntime(
  sourceDir: string,
  output: string,
  arch: WhisperRuntimeArch,
): Promise<void> {
  const buildDir = join(sourceDir, "build-scient");
  const cmakeArchitecture =
    arch === "universal" ? "arm64;x86_64" : arch === "x64" ? "x86_64" : "arm64";
  await run("cmake", [
    "-S",
    sourceDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_OSX_ARCHITECTURES=${cmakeArchitecture}`,
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0",
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
  await run("cmake", ["--build", buildDir, "--config", "Release", "--target", "whisper-server"]);
  const builtServer = join(buildDir, "bin", "whisper-server");
  await copyFile(builtServer, join(output, "whisper-server"));
}

async function stagePrebuiltRuntime(
  artifact: VerifiedArtifact,
  archive: string,
  workspace: string,
  output: string,
  platform: WhisperRuntimePlatform,
): Promise<void> {
  const extracted = join(workspace, "prebuilt");
  await mkdir(extracted);
  await run("tar", ["-xf", archive, "-C", extracted]);

  if (platform === "win") {
    const releaseDir = join(extracted, "Release");
    for (const file of await readdir(releaseDir)) {
      if (file === "whisper-server.exe" || file.endsWith(".dll")) {
        await copyFile(join(releaseDir, file), join(output, file));
      }
    }
    return;
  }

  const [root] = await readdir(extracted);
  if (!root) throw new Error(`The ${artifact.fileName} archive was empty.`);
  const releaseDir = join(extracted, root);
  for (const file of await readdir(releaseDir)) {
    if (file === "whisper-server" || file.includes(".so")) {
      await cp(join(releaseDir, file), join(output, file), { dereference: true });
    }
  }
}

async function collectReceiptFiles(output: string): Promise<ReadonlyArray<StagedFileReceipt>> {
  const files = (await readdir(output)).filter((file) => file !== "provenance.json").toSorted();
  return Promise.all(
    files.map(async (file) => {
      const filePath = join(output, file);
      const fileStat = await stat(filePath);
      return { file, sha256: await sha256File(filePath), size: fileStat.size };
    }),
  );
}

function assertRuntimeFileSet(
  platform: WhisperRuntimePlatform,
  files: ReadonlyArray<StagedFileReceipt>,
): void {
  const names = new Set(files.map((file) => file.file));
  const executable = platform === "win" ? "whisper-server.exe" : "whisper-server";
  if (!names.has(executable)) throw new Error(`Staged runtime is missing ${executable}.`);
  if (platform === "win" && !files.some((file) => file.file.endsWith(".dll"))) {
    throw new Error("Staged Windows runtime is missing required DLLs.");
  }
  if (platform === "linux" && !files.some((file) => file.file.includes(".so"))) {
    throw new Error("Staged Linux runtime is missing required shared libraries.");
  }
}

export async function verifyPackagedWhisperRuntime(input: {
  readonly distDir: string;
  readonly platform: WhisperRuntimePlatform;
}): Promise<ReadonlyArray<string>> {
  const distEntries = await readdir(input.distDir, { withFileTypes: true });
  const unpackedDirectories = distEntries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (input.platform === "mac"
          ? entry.name.startsWith("mac")
          : entry.name === `${input.platform === "win" ? "win" : "linux"}-unpacked`),
    )
    .map((entry) => join(input.distDir, entry.name));
  if (unpackedDirectories.length === 0) {
    throw new Error(`No unpacked ${input.platform} app was found in ${input.distDir}.`);
  }

  const verified: string[] = [];
  for (const unpacked of unpackedDirectories) {
    const runtimeDirectory =
      input.platform === "mac"
        ? join(unpacked, "Scient.app", "Contents", "Resources", "whisper-runtime")
        : join(unpacked, "resources", "whisper-runtime");
    const receipt = JSON.parse(
      await readFile(join(runtimeDirectory, "provenance.json"), "utf8"),
    ) as WhisperRuntimeReceipt;
    if (receipt.component !== "whisper.cpp" || receipt.version !== WHISPER_CPP_VERSION) {
      throw new Error(`Packaged whisper.cpp provenance is invalid at ${runtimeDirectory}.`);
    }
    assertRuntimeFileSet(input.platform, receipt.files);
    for (const file of receipt.files) {
      if (file.file.includes("/") || file.file.includes("\\") || file.file === "..") {
        throw new Error(`Invalid packaged whisper.cpp receipt path: ${file.file}`);
      }
      const filePath = join(runtimeDirectory, file.file);
      const fileStat = await stat(filePath);
      if (fileStat.size !== file.size || (await sha256File(filePath)) !== file.sha256) {
        throw new Error(`Packaged whisper.cpp file verification failed: ${filePath}`);
      }
    }
    const executable = join(
      runtimeDirectory,
      input.platform === "win" ? "whisper-server.exe" : "whisper-server",
    );
    if (input.platform !== "win" && ((await stat(executable)).mode & 0o111) === 0) {
      throw new Error(`Packaged whisper.cpp executable is not executable: ${executable}`);
    }
    if (input.platform === "mac") await capture("codesign", ["--verify", "--strict", executable]);
    verified.push(runtimeDirectory);
  }
  return verified;
}

export async function stageWhisperRuntime(options: StageOptions): Promise<void> {
  const output = resolve(options.output);
  const prebuilt = resolvePrebuiltArtifact(options.platform, options.arch);
  const workspace = await mkdtemp(join(tmpdir(), "scient-whisper-runtime-"));
  const temporaryOutput = `${output}.partial-${process.pid}`;
  try {
    await rm(temporaryOutput, { force: true, recursive: true });
    await mkdir(temporaryOutput, { recursive: true });

    const sourceArchive = join(workspace, WHISPER_CPP_SOURCE.fileName);
    if (options.verbose) console.log(`[whisper-runtime] Downloading ${WHISPER_CPP_SOURCE.url}`);
    await downloadVerified(WHISPER_CPP_SOURCE, sourceArchive);
    const sourceDir = await extractSource(sourceArchive, workspace);
    await copyFile(join(sourceDir, "LICENSE"), join(temporaryOutput, "LICENSE.whisper.cpp"));

    if (prebuilt) {
      const archive = join(workspace, prebuilt.fileName);
      if (options.verbose) console.log(`[whisper-runtime] Downloading ${prebuilt.url}`);
      await downloadVerified(prebuilt, archive);
      await stagePrebuiltRuntime(prebuilt, archive, workspace, temporaryOutput, options.platform);
    } else {
      await buildMacRuntime(sourceDir, temporaryOutput, options.arch);
    }

    const executableName = options.platform === "win" ? "whisper-server.exe" : "whisper-server";
    const executablePath = join(temporaryOutput, executableName);
    await stat(executablePath);
    if (options.platform !== "win") await chmod(executablePath, 0o755);

    const help = await capture(executablePath, ["--help"]);
    if (!help.includes("--request-path")) {
      throw new Error("Staged whisper-server does not advertise --request-path.");
    }

    const files = await collectReceiptFiles(temporaryOutput);
    assertRuntimeFileSet(options.platform, files);
    const receipt = {
      schemaVersion: 1,
      component: "whisper.cpp",
      version: WHISPER_CPP_VERSION,
      platform: options.platform,
      arch: options.arch,
      source: WHISPER_CPP_SOURCE,
      binaryArtifact: prebuilt,
      sourceAssertions: {
        optionsReadinessRoute: true,
        requestPathArgument: true,
      },
      macAcceleration:
        options.platform === "mac"
          ? { accelerate: true, metal: true, metalLibraryEmbedded: true }
          : null,
      files,
    };
    await writeFile(
      join(temporaryOutput, "provenance.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );

    await rm(output, { force: true, recursive: true });
    await mkdir(dirname(output), { recursive: true });
    await rename(temporaryOutput, output);
    console.log(
      `[whisper-runtime] Staged ${WHISPER_CPP_VERSION} ${options.platform}/${options.arch} at ${output}`,
    );
  } finally {
    await rm(workspace, { force: true, recursive: true });
    await rm(temporaryOutput, { force: true, recursive: true });
  }
}

function parseArguments(arguments_: ReadonlyArray<string>): StageOptions {
  const values = new Map<string, string>();
  let verbose = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!argument?.startsWith("--") || !value)
      throw new Error(`Invalid argument ${argument ?? ""}.`);
    values.set(argument, value);
    index += 1;
  }
  const platform = values.get("--platform") as WhisperRuntimePlatform | undefined;
  const arch = values.get("--arch") as WhisperRuntimeArch | undefined;
  const output = values.get("--output");
  if (!platform || !["linux", "mac", "win"].includes(platform)) {
    throw new Error("--platform must be linux, mac, or win.");
  }
  if (!arch || !["arm64", "x64", "universal"].includes(arch)) {
    throw new Error("--arch must be arm64, x64, or universal.");
  }
  if (!output) throw new Error("--output is required.");
  return { arch, output, platform, verbose };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  stageWhisperRuntime(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
