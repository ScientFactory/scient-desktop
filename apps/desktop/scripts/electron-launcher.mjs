// This file mostly exists because we want dev mode to use Scient's own app identity.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { scientBundleId } from "@synara/shared/desktopIdentity";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "Scient (Dev)" : "Scient";
const APP_BUNDLE_ID = scientBundleId(isDevelopment);
const LAUNCHER_VERSION = 2;
const MICROPHONE_USAGE_DESCRIPTION =
  "Scient needs microphone access so you can record voice notes and transcribe them into the chat composer.";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function patchMainBundleInfoPlist(appBundlePath, iconPath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  setPlistString(infoPlistPath, "NSMicrophoneUsageDescription", MICROPHONE_USAGE_DESCRIPTION);

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) {
    return;
  }

  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    if (!entry.name.startsWith("Electron Helper")) {
      continue;
    }

    const helperPlistPath = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(helperPlistPath)) {
      continue;
    }

    const suffix = entry.name.replace("Electron Helper", "").replace(".app", "").trim();
    const helperName = suffix
      ? `${APP_DISPLAY_NAME} Helper ${suffix}`
      : `${APP_DISPLAY_NAME} Helper`;
    const helperIdSuffix = suffix.replace(/[()]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
    const helperBundleId = helperIdSuffix
      ? `${APP_BUNDLE_ID}.helper.${helperIdSuffix}`
      : `${APP_BUNDLE_ID}.helper`;

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    setPlistString(helperPlistPath, "CFBundleName", helperName);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const iconPath = join(desktopDir, "resources", "icon.icns");
  const metadataPath = join(runtimeDir, "metadata.json");

  mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  cpSync(sourceAppBundlePath, targetAppBundlePath, { recursive: true });
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath);
  patchHelperBundleInfoPlists(targetAppBundlePath);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

export function resolveElectronPath() {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath);
}

export function isLinuxSetuidSandboxConfigured(
  electronBinaryPath,
  { platform = process.platform, lstat = lstatSync } = {},
) {
  if (platform !== "linux") {
    return true;
  }

  const sandboxPath = join(dirname(electronBinaryPath), "chrome-sandbox");
  try {
    const sandboxStat = lstat(sandboxPath);
    return sandboxStat.isFile() && sandboxStat.uid === 0 && (sandboxStat.mode & 0o7777) === 0o4755;
  } catch {
    return false;
  }
}

export class LinuxSandboxConfigurationError extends Error {
  constructor(sandboxPath) {
    super(
      `Electron sandbox helper ${sandboxPath} must be a regular file owned by root with exact mode 4755. ` +
        "Repair the helper before launching Scient. For an isolated local development session only, " +
        "set SCIENT_DEV_ALLOW_NO_SANDBOX=1 to accept the unsafe fallback explicitly.",
    );
    this.name = "LinuxSandboxConfigurationError";
    this.sandboxPath = sandboxPath;
  }
}

export function resolveLinuxSandboxArgs(
  electronBinaryPath,
  {
    platform = process.platform,
    lstat = lstatSync,
    development = isDevelopment,
    env = process.env,
    warn = console.warn,
  } = {},
) {
  if (isLinuxSetuidSandboxConfigured(electronBinaryPath, { platform, lstat })) {
    return [];
  }

  const sandboxPath = join(dirname(electronBinaryPath), "chrome-sandbox");
  if (development && env.SCIENT_DEV_ALLOW_NO_SANDBOX === "1") {
    warn(
      "[desktop-launcher] Unsafe development override accepted: launching local Electron with --no-sandbox.",
    );
    return ["--no-sandbox"];
  }

  throw new LinuxSandboxConfigurationError(sandboxPath);
}

export function resolveElectronLaunchCommand(args = [], options = {}) {
  const electronPath = resolveElectronPath();
  return {
    electronPath,
    args: [...resolveLinuxSandboxArgs(electronPath, options), ...args],
  };
}
