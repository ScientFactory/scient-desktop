// FILE: desktopCodexVoiceRuntime.ts
// Purpose: Resolves the same configured or managed Codex runtime context used by Scient sessions.
// Layer: Desktop voice runtime configuration

import * as FS from "node:fs/promises";
import { constants as FS_CONSTANTS, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import * as OS from "node:os";
import * as Path from "node:path";

import type { DesktopVoiceProcessContext } from "./chatGptVoiceTranscription";

interface CodexSettingsRecord {
  readonly providers?: {
    readonly codex?: {
      readonly enabled?: unknown;
      readonly binaryPath?: unknown;
      readonly homePath?: unknown;
    };
  };
}

export interface DesktopCodexVoiceRuntimeOptions {
  readonly stateDirectory: string;
  readonly scientHome: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function resolveDesktopCodexVoiceProcessContext(
  options: DesktopCodexVoiceRuntimeOptions,
): Promise<DesktopVoiceProcessContext> {
  const env = { ...(options.env ?? process.env) };
  const settings = await readCodexSettings(Path.join(options.stateDirectory, "settings.json"));
  if (settings.enabled === false) {
    throw new Error("Codex is disabled in Scient settings.");
  }

  const configuredBinary = settings.binaryPath || "codex";
  const binaryPath = await resolveCodexBinaryPath({
    configuredBinary,
    stateDirectory: options.stateDirectory,
    env,
  });
  const sourceHome =
    settings.homePath || env.CODEX_HOME?.trim() || Path.join(OS.homedir(), ".codex");
  const overlayHome = Path.join(options.scientHome, "codex-home-overlay");
  const effectiveHome = (await pathExists(Path.join(overlayHome, "auth.json")))
    ? overlayHome
    : sourceHome;

  return {
    binaryPath,
    env: {
      ...env,
      SCIENT_HOME: options.scientHome,
      CODEX_HOME: effectiveHome,
    },
  };
}

async function readCodexSettings(settingsPath: string): Promise<{
  readonly enabled?: boolean;
  readonly binaryPath: string;
  readonly homePath: string;
}> {
  try {
    const parsed = JSON.parse(await FS.readFile(settingsPath, "utf8")) as CodexSettingsRecord;
    const codex = parsed.providers?.codex;
    return {
      ...(typeof codex?.enabled === "boolean" ? { enabled: codex.enabled } : {}),
      binaryPath: boundedString(codex?.binaryPath),
      homePath: boundedString(codex?.homePath),
    };
  } catch {
    return { binaryPath: "", homePath: "" };
  }
}

async function resolveCodexBinaryPath(input: {
  readonly configuredBinary: string;
  readonly stateDirectory: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  if (input.configuredBinary !== "codex") return input.configuredBinary;
  if (await findExecutableOnPath("codex", input.env)) return "codex";

  const managedRoot = Path.join(input.stateDirectory, "provider-runtimes", "codex");
  const currentRecordPath = Path.join(managedRoot, "current.json");
  let rawRecord: string;
  try {
    rawRecord = await FS.readFile(currentRecordPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "codex";
    throw new Error("Scient could not verify the managed Codex runtime.", { cause: error });
  }

  try {
    const record = JSON.parse(rawRecord) as Record<string, unknown>;
    const releaseId = boundedString(record.releaseId);
    const executableRelativePath = boundedString(record.executableRelativePath);
    const executablePath = boundedString(record.executablePath);
    const executableDigest = boundedString(record.executableDigest);
    if (
      record.version !== 1 ||
      record.provider !== "codex" ||
      !releaseId ||
      !executableRelativePath ||
      !executablePath ||
      !/^[a-f0-9]{64}$/u.test(executableDigest)
    ) {
      throw new Error("The managed Codex runtime record is invalid.");
    }
    const releaseRoot = Path.resolve(managedRoot, "releases", releaseId);
    const expectedPath = Path.resolve(releaseRoot, executableRelativePath);
    if (expectedPath !== Path.resolve(executablePath)) {
      throw new Error("The managed Codex executable path is invalid.");
    }
    const relative = Path.relative(releaseRoot, expectedPath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${Path.sep}`) ||
      Path.isAbsolute(relative)
    ) {
      throw new Error("The managed Codex executable escapes its release directory.");
    }
    const stats = await FS.lstat(executablePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("The managed Codex executable is not a regular file.");
    }
    const [realRoot, realExecutable] = await Promise.all([
      FS.realpath(releaseRoot),
      FS.realpath(executablePath),
    ]);
    const realRelative = Path.relative(realRoot, realExecutable);
    if (
      !realRelative ||
      realRelative === ".." ||
      realRelative.startsWith(`..${Path.sep}`) ||
      Path.isAbsolute(realRelative)
    ) {
      throw new Error("The managed Codex executable resolves outside its release directory.");
    }
    if ((await hashExecutable(executablePath)) !== executableDigest) {
      throw new Error("The managed Codex executable checksum changed after installation.");
    }
    return executablePath;
  } catch (error) {
    throw new Error("Scient refused an unverified managed Codex runtime.", { cause: error });
  }
}

async function hashExecutable(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function findExecutableOnPath(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const directories = (env.PATH ?? "").split(Path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        await FS.access(Path.join(directory, `${command}${extension}`), FS_CONSTANTS.X_OK);
        return true;
      } catch {
        // Continue through the bounded PATH candidates.
      }
    }
  }
  return false;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await FS.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function boundedString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length <= 4_096 ? trimmed : "";
}
