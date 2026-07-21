// FILE: desktop-signing-environment.ts
// Purpose: Isolate desktop signing credentials from non-signing build subprocesses.
// Layer: Release/build helper
// Depends on: Platform-specific signing environment variable names.

import {
  WINDOWS_AZURE_SIGNING_ENV_NAMES,
  WINDOWS_CERTIFICATE_SIGNING_ENV_NAMES,
} from "./windows-signing.ts";

export const APPLE_SIGNING_ENV_NAMES = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

export const WINDOWS_SIGNING_ENV_NAMES = [
  ...WINDOWS_CERTIFICATE_SIGNING_ENV_NAMES,
  ...WINDOWS_AZURE_SIGNING_ENV_NAMES,
  "AZURE_TRUSTED_SIGNING_FILE_DIGEST",
  "AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST",
  "AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161",
] as const;

export const DESKTOP_SIGNING_ENV_NAMES = [
  ...APPLE_SIGNING_ENV_NAMES,
  ...WINDOWS_SIGNING_ENV_NAMES,
] as const;

type DesktopBuildPlatform = "linux" | "mac" | "win";
type MutableEnvironment = Record<string, string | undefined>;

function retainedSigningNames(
  platform: DesktopBuildPlatform,
  signed: boolean,
): ReadonlySet<string> {
  if (!signed) return new Set();
  if (platform === "mac") return new Set(APPLE_SIGNING_ENV_NAMES);
  if (platform === "win") return new Set(WINDOWS_SIGNING_ENV_NAMES);
  return new Set();
}

/**
 * Removes every desktop signing variable from the parent environment and returns
 * only the credentials required by the selected signed platform. Call this before
 * spawning build or staging subprocesses, then pass the returned environment only
 * to electron-builder.
 */
export function isolateDesktopSigningEnvironment(
  environment: MutableEnvironment,
  platform: DesktopBuildPlatform,
  signed: boolean,
): NodeJS.ProcessEnv {
  const retainedNames = retainedSigningNames(platform, signed);
  const signingEnvironment: NodeJS.ProcessEnv = {};

  for (const name of DESKTOP_SIGNING_ENV_NAMES) {
    const value = environment[name];
    delete environment[name];
    if (retainedNames.has(name) && value?.trim()) {
      signingEnvironment[name] = value;
    }
  }

  return signingEnvironment;
}
