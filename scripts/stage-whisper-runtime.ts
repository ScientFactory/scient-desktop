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
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsSystemRoot } from "@synara/shared/windowsProcess";

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
  readonly verification: WhisperRuntimeFileVerification;
}

interface WhisperRuntimeReceipt {
  readonly schemaVersion: 2;
  readonly component: "whisper.cpp";
  readonly version: string;
  readonly platform: WhisperRuntimePlatform;
  readonly files: ReadonlyArray<StagedFileReceipt>;
}

export type MacWhisperSignatureMode = "adhoc" | "developer-id";
export type WindowsWhisperSignatureMode = "authenticode" | "unsigned";
export type WhisperRuntimeFileVerification =
  | "mac-code-signature"
  | "sha256"
  | "windows-authenticode-or-sha256";

export interface WindowsAuthenticodeSignatureDetails {
  readonly signerSubject: string | null;
  readonly signerThumbprint: string | null;
  readonly status: string;
  readonly statusMessage: string;
  readonly timestampSubject: string | null;
}

export interface WindowsAuthenticodeVerificationDetails {
  readonly app: WindowsAuthenticodeSignatureDetails;
  readonly executable: WindowsAuthenticodeSignatureDetails;
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
  await run("tar", tarExtractionArguments(sourceArchive, workspace, true));
  const sourceDir = join(workspace, `whisper.cpp-${WHISPER_CPP_COMMIT}`);
  const serverSource = await readFile(join(sourceDir, "examples/server/server.cpp"), "utf8");
  assertPinnedWhisperServerSource(serverSource);
  return sourceDir;
}

export function tarExtractionArguments(
  archive: string,
  destination: string,
  gzip: boolean,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  // Git for Windows provides GNU tar. Without --force-local, its archive parser treats the
  // drive prefix in C:\path\archive as a remote host and fails with "Cannot connect to C".
  return [
    ...(platform === "win32" ? ["--force-local"] : []),
    gzip ? "-xzf" : "-xf",
    archive,
    "-C",
    destination,
  ];
}

export const WINDOWS_EXPAND_ARCHIVE_SCRIPT = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$ArchivePath,",
  "  [Parameter(Mandatory = $true)][string]$DestinationPath",
  ")",
  "Set-StrictMode -Version Latest",
  "$ErrorActionPreference = 'Stop'",
  "Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force",
  "",
].join("\r\n");

export const WINDOWS_AUTHENTICODE_VERIFY_SCRIPT = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$AppPath,",
  "  [Parameter(Mandatory = $true)][string]$ExecutablePath",
  ")",
  "Set-StrictMode -Version Latest",
  "$ErrorActionPreference = 'Stop'",
  "function Read-AuthenticodeSignature([string]$Path) {",
  "  $Signature = Get-AuthenticodeSignature -LiteralPath $Path",
  "  [pscustomobject]@{",
  "    status = [string]$Signature.Status",
  "    statusMessage = [string]$Signature.StatusMessage",
  "    signerSubject = if ($null -eq $Signature.SignerCertificate) { $null } else { [string]$Signature.SignerCertificate.Subject }",
  "    signerThumbprint = if ($null -eq $Signature.SignerCertificate) { $null } else { [string]$Signature.SignerCertificate.Thumbprint }",
  "    timestampSubject = if ($null -eq $Signature.TimeStamperCertificate) { $null } else { [string]$Signature.TimeStamperCertificate.Subject }",
  "  }",
  "}",
  "[pscustomobject]@{",
  "  app = Read-AuthenticodeSignature $AppPath",
  "  executable = Read-AuthenticodeSignature $ExecutablePath",
  "} | ConvertTo-Json -Compress -Depth 4",
  "",
].join("\r\n");

export function windowsZipExtractionPlan(
  scriptPath: string,
  archive: string,
  destination: string,
  env: NodeJS.ProcessEnv = process.env,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return {
    command: win32.join(
      resolveWindowsSystemRoot(env),
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ArchivePath",
      archive,
      "-DestinationPath",
      destination,
    ],
  };
}

export function windowsAuthenticodeVerificationPlan(
  scriptPath: string,
  appPath: string,
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return {
    command: win32.join(
      resolveWindowsSystemRoot(env),
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-AppPath",
      appPath,
      "-ExecutablePath",
      executablePath,
    ],
  };
}

async function extractWindowsZip(
  archive: string,
  destination: string,
  workspace: string,
): Promise<void> {
  const scriptPath = join(workspace, "expand-archive.ps1");
  await writeFile(scriptPath, WINDOWS_EXPAND_ARCHIVE_SCRIPT, { encoding: "utf8", flag: "wx" });
  const plan = windowsZipExtractionPlan(scriptPath, archive, destination);
  await run(plan.command, plan.args);
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
  if (platform === "win" && process.platform === "win32") {
    await extractWindowsZip(archive, extracted, workspace);
  } else {
    await run("tar", tarExtractionArguments(archive, extracted, false));
  }

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

export function whisperRuntimeFileVerification(
  platform: WhisperRuntimePlatform,
  file: string,
): WhisperRuntimeFileVerification {
  if (platform === "mac" && file === "whisper-server") return "mac-code-signature";
  if (platform === "win" && file === "whisper-server.exe") {
    return "windows-authenticode-or-sha256";
  }
  return "sha256";
}

async function collectReceiptFiles(
  output: string,
  platform: WhisperRuntimePlatform,
): Promise<ReadonlyArray<StagedFileReceipt>> {
  const files = (await readdir(output)).filter((file) => file !== "provenance.json").toSorted();
  return Promise.all(
    files.map(async (file) => {
      const filePath = join(output, file);
      const fileStat = await stat(filePath);
      return {
        file,
        sha256: await sha256File(filePath),
        size: fileStat.size,
        verification: whisperRuntimeFileVerification(platform, file),
      };
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

function isStagedFileReceipt(value: unknown): value is StagedFileReceipt {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StagedFileReceipt>;
  return (
    typeof candidate.file === "string" &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.sha256) &&
    typeof candidate.size === "number" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    (candidate.verification === "mac-code-signature" ||
      candidate.verification === "sha256" ||
      candidate.verification === "windows-authenticode-or-sha256")
  );
}

function signatureDetailValue(details: string, key: string): string | undefined {
  const prefix = `${key}=`;
  return details
    .split(/\r?\n/u)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function assertDeveloperIdSignature(details: string, label: string): string {
  if (
    !details.split(/\r?\n/u).some((line) => line.startsWith("Authority=Developer ID Application:"))
  ) {
    throw new Error(`${label} is not signed by a Developer ID Application identity.`);
  }
  const timestamp = signatureDetailValue(details, "Timestamp");
  if (!timestamp || timestamp.toLowerCase() === "none") {
    throw new Error(`${label} is missing a trusted signing timestamp.`);
  }
  const codeDirectory = details.split(/\r?\n/u).find((line) => line.startsWith("CodeDirectory "));
  const signingFlags = codeDirectory?.match(/\bflags=(\S+)/u)?.[1];
  if (!signingFlags || !/(?:^|[,(])runtime(?:[,)]|$)/u.test(signingFlags)) {
    throw new Error(`${label} is missing hardened-runtime signing flags.`);
  }
  const teamIdentifier = signatureDetailValue(details, "TeamIdentifier");
  if (!teamIdentifier || teamIdentifier.toLowerCase() === "not set") {
    throw new Error(`${label} is missing a Developer ID team identifier.`);
  }
  return teamIdentifier;
}

function assertAdhocSignature(details: string, label: string): void {
  if (signatureDetailValue(details, "Signature") !== "adhoc") {
    throw new Error(`${label} is not ad-hoc signed.`);
  }
  if (signatureDetailValue(details, "TeamIdentifier") !== "not set") {
    throw new Error(`${label} has an unexpected team identifier for an ad-hoc signature.`);
  }
}

export function assertMacWhisperSignatureDetails(input: {
  readonly appDetails: string;
  readonly executableDetails: string;
  readonly mode: MacWhisperSignatureMode;
}): void {
  if (input.mode === "developer-id") {
    const appTeam = assertDeveloperIdSignature(input.appDetails, "Packaged app");
    const executableTeam = assertDeveloperIdSignature(
      input.executableDetails,
      "Packaged whisper-server",
    );
    if (appTeam !== executableTeam) {
      throw new Error(
        `Packaged whisper-server team identifier ${executableTeam} does not match app team ${appTeam}.`,
      );
    }
    return;
  }
  assertAdhocSignature(input.appDetails, "Packaged app");
  assertAdhocSignature(input.executableDetails, "Packaged whisper-server");
}

async function verifyMacWhisperSignature(input: {
  readonly appBundle: string;
  readonly executable: string;
  readonly mode: MacWhisperSignatureMode;
}): Promise<void> {
  const codesign = "/usr/bin/codesign";
  await capture(codesign, ["--verify", "--strict", "--verbose=4", input.executable]);
  await capture(codesign, ["--verify", "--deep", "--strict", "--verbose=4", input.appBundle]);
  const [appDetails, executableDetails] = await Promise.all([
    capture(codesign, ["--display", "--verbose=4", input.appBundle]),
    capture(codesign, ["--display", "--verbose=4", input.executable]),
  ]);
  assertMacWhisperSignatureDetails({ appDetails, executableDetails, mode: input.mode });
}

function isWindowsAuthenticodeSignatureDetails(
  value: unknown,
): value is WindowsAuthenticodeSignatureDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WindowsAuthenticodeSignatureDetails>;
  return (
    typeof candidate.status === "string" &&
    typeof candidate.statusMessage === "string" &&
    (typeof candidate.signerSubject === "string" || candidate.signerSubject === null) &&
    (typeof candidate.signerThumbprint === "string" || candidate.signerThumbprint === null) &&
    (typeof candidate.timestampSubject === "string" || candidate.timestampSubject === null)
  );
}

function nonEmptySignatureValue(value: string | null, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is missing.`);
  return normalized;
}

export function assertWindowsAuthenticodeSignatureDetails(
  input: WindowsAuthenticodeVerificationDetails,
): void {
  const signatures = [
    ["Packaged app", input.app],
    ["Packaged whisper-server.exe", input.executable],
  ] as const;
  for (const [label, signature] of signatures) {
    if (signature.status !== "Valid") {
      throw new Error(
        `${label} Authenticode signature is not valid (${signature.status}: ${signature.statusMessage}).`,
      );
    }
    nonEmptySignatureValue(signature.signerSubject, `${label} signer subject`);
    nonEmptySignatureValue(signature.signerThumbprint, `${label} signer thumbprint`);
    nonEmptySignatureValue(signature.timestampSubject, `${label} timestamp signer`);
  }
  const appPublisher = nonEmptySignatureValue(
    input.app.signerSubject,
    "Packaged app signer subject",
  );
  const executablePublisher = nonEmptySignatureValue(
    input.executable.signerSubject,
    "Packaged whisper-server.exe signer subject",
  );
  if (appPublisher !== executablePublisher) {
    throw new Error(
      `Packaged whisper-server.exe publisher ${executablePublisher} does not match app publisher ${appPublisher}.`,
    );
  }
}

async function verifyWindowsWhisperSignature(input: {
  readonly appExecutable: string;
  readonly executable: string;
}): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "scient-whisper-authenticode-"));
  try {
    const scriptPath = join(workspace, "verify-authenticode.ps1");
    await writeFile(scriptPath, WINDOWS_AUTHENTICODE_VERIFY_SCRIPT, {
      encoding: "utf8",
      flag: "wx",
    });
    const plan = windowsAuthenticodeVerificationPlan(
      scriptPath,
      input.appExecutable,
      input.executable,
    );
    const output = await capture(plan.command, plan.args);
    const parsed = JSON.parse(output.trim()) as Partial<WindowsAuthenticodeVerificationDetails>;
    if (
      !isWindowsAuthenticodeSignatureDetails(parsed.app) ||
      !isWindowsAuthenticodeSignatureDetails(parsed.executable)
    ) {
      throw new Error("Windows Authenticode verifier returned invalid signature details.");
    }
    assertWindowsAuthenticodeSignatureDetails({
      app: parsed.app,
      executable: parsed.executable,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function verifyPackagedWhisperRuntime(input: {
  readonly distDir: string;
  readonly macSignatureMode?: MacWhisperSignatureMode;
  readonly platform: WhisperRuntimePlatform;
  readonly windowsSignatureMode?: WindowsWhisperSignatureMode;
}): Promise<ReadonlyArray<string>> {
  if (input.platform === "mac" && !input.macSignatureMode) {
    throw new Error("macOS whisper.cpp verification requires an explicit signature mode.");
  }
  if (input.platform !== "mac" && input.macSignatureMode) {
    throw new Error("A macOS signature mode cannot be used for a non-macOS runtime.");
  }
  if (input.platform === "win" && !input.windowsSignatureMode) {
    throw new Error("Windows whisper.cpp verification requires an explicit signature mode.");
  }
  if (input.platform !== "win" && input.windowsSignatureMode) {
    throw new Error("A Windows signature mode cannot be used for a non-Windows runtime.");
  }
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
    const appBundle = join(unpacked, "Scient.app");
    const runtimeDirectory =
      input.platform === "mac"
        ? join(appBundle, "Contents", "Resources", "whisper-runtime")
        : join(unpacked, "resources", "whisper-runtime");
    const receipt = JSON.parse(
      await readFile(join(runtimeDirectory, "provenance.json"), "utf8"),
    ) as Partial<WhisperRuntimeReceipt>;
    if (
      receipt.schemaVersion !== 2 ||
      receipt.component !== "whisper.cpp" ||
      receipt.version !== WHISPER_CPP_VERSION ||
      receipt.platform !== input.platform ||
      !Array.isArray(receipt.files) ||
      !receipt.files.every(isStagedFileReceipt)
    ) {
      throw new Error(`Packaged whisper.cpp provenance is invalid at ${runtimeDirectory}.`);
    }
    const actualFiles = (await readdir(runtimeDirectory))
      .filter((file) => file !== "provenance.json")
      .toSorted();
    const receiptFiles = receipt.files.map((file) => file.file).toSorted();
    if (
      actualFiles.length !== receiptFiles.length ||
      actualFiles.some((file, index) => file !== receiptFiles[index])
    ) {
      throw new Error(
        `Packaged whisper.cpp file set does not match provenance at ${runtimeDirectory}.`,
      );
    }
    assertRuntimeFileSet(input.platform, receipt.files);
    for (const file of receipt.files) {
      if (file.file.includes("/") || file.file.includes("\\") || file.file === "..") {
        throw new Error(`Invalid packaged whisper.cpp receipt path: ${file.file}`);
      }
      const expectedVerification = whisperRuntimeFileVerification(input.platform, file.file);
      if (file.verification !== expectedVerification) {
        throw new Error(
          `Invalid packaged whisper.cpp verification policy for ${file.file}: expected ${expectedVerification}.`,
        );
      }
      const filePath = join(runtimeDirectory, file.file);
      const fileStat = await stat(filePath);
      const requiresSha256 =
        file.verification === "sha256" ||
        (file.verification === "windows-authenticode-or-sha256" &&
          input.windowsSignatureMode === "unsigned");
      if (
        requiresSha256 &&
        (fileStat.size !== file.size || (await sha256File(filePath)) !== file.sha256)
      ) {
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
    if (input.platform === "mac") {
      await verifyMacWhisperSignature({
        appBundle,
        executable,
        mode: input.macSignatureMode!,
      });
    }
    if (input.platform === "win" && input.windowsSignatureMode === "authenticode") {
      await verifyWindowsWhisperSignature({
        appExecutable: join(unpacked, "Scient.exe"),
        executable,
      });
    }
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

    const files = await collectReceiptFiles(temporaryOutput, options.platform);
    assertRuntimeFileSet(options.platform, files);
    const receipt = {
      schemaVersion: 2,
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
