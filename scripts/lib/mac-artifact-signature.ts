// FILE: mac-artifact-signature.ts
// Purpose: Verifies macOS app signatures in unpacked bundles and final DMG release artifacts.
// Layer: Release/build helper
// Depends on: macOS codesign and hdiutil.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const require = createRequire(import.meta.url);
const {
  SCIENT_APPSNAP_HELPER_BUNDLE_PATH,
  SCIENT_APPSNAP_HELPER_IDENTIFIER,
  SCIENT_ELECTRON_HELPERS,
  SCIENT_MAC_BUNDLE_IDENTIFIER,
} = require("./mac-signing-policy.cjs") as {
  readonly SCIENT_APPSNAP_HELPER_BUNDLE_PATH: string;
  readonly SCIENT_APPSNAP_HELPER_IDENTIFIER: string;
  readonly SCIENT_ELECTRON_HELPERS: ReadonlyArray<{
    readonly bundlePath: string;
    readonly identifier: string;
  }>;
  readonly SCIENT_MAC_BUNDLE_IDENTIFIER: string;
};
const FORBIDDEN_APPSNAP_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.device.audio-input",
] as const;

function signatureField(details: string, field: string): string | null {
  return details.match(new RegExp(`^${field}=(.+)$`, "m"))?.[1]?.trim() ?? null;
}

function hasEnabledEntitlement(entitlements: string, entitlement: string): boolean {
  const keyIndex = entitlements.indexOf(`<key>${entitlement}</key>`);
  if (keyIndex < 0) return false;
  return /<true\s*\/>/.test(entitlements.slice(keyIndex, keyIndex + 256));
}

function assertDeveloperIdentity(
  details: string,
  expectedIdentifier: string,
  expectedTeamIdentifier: string | null,
  label: string,
): string {
  const identifier = signatureField(details, "Identifier");
  const teamIdentifier = signatureField(details, "TeamIdentifier");
  if (
    identifier !== expectedIdentifier ||
    !details.includes("Authority=Developer ID Application:") ||
    !details.includes("Timestamp=") ||
    !details.includes("runtime") ||
    !teamIdentifier ||
    teamIdentifier === "not set" ||
    (expectedTeamIdentifier && teamIdentifier !== expectedTeamIdentifier)
  ) {
    throw new Error(`${label} does not have Scient's stable hardened Developer ID identity.`);
  }
  return teamIdentifier;
}

export function assertSignedMacIdentityDetails(input: {
  readonly appDetails: string;
  readonly appEntitlements?: string;
  readonly appSnapDetails: string;
  readonly appSnapEntitlements: string;
  readonly electronHelpers?: ReadonlyArray<{
    readonly details: string;
    readonly entitlements: string;
    readonly identifier: string;
  }>;
}): void {
  const appTeamIdentifier = assertDeveloperIdentity(
    input.appDetails,
    SCIENT_MAC_BUNDLE_IDENTIFIER,
    null,
    "Signed macOS app",
  );
  if (hasEnabledEntitlement(input.appEntitlements ?? "", "com.apple.security.get-task-allow")) {
    throw new Error("Signed macOS app enables the development-only get-task-allow entitlement.");
  }

  assertDeveloperIdentity(
    input.appSnapDetails,
    SCIENT_APPSNAP_HELPER_IDENTIFIER,
    appTeamIdentifier,
    "AppSnap helper",
  );

  const forbiddenEntitlement = FORBIDDEN_APPSNAP_ENTITLEMENTS.find((entitlement) =>
    input.appSnapEntitlements.includes(`<key>${entitlement}</key>`),
  );
  if (forbiddenEntitlement) {
    throw new Error(`AppSnap helper carries forbidden entitlement ${forbiddenEntitlement}.`);
  }

  for (const helper of input.electronHelpers ?? []) {
    assertDeveloperIdentity(
      helper.details,
      helper.identifier,
      appTeamIdentifier,
      `Electron helper ${helper.identifier}`,
    );
    if (hasEnabledEntitlement(helper.entitlements, "com.apple.security.get-task-allow")) {
      throw new Error(`Electron helper ${helper.identifier} enables get-task-allow.`);
    }
  }
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly verbose?: boolean } = {},
): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER_BYTES,
  });
  if (options.verbose && result.stdout) process.stdout.write(result.stdout);
  if (options.verbose && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

export function verifyMacAppSignature(
  appBundlePath: string,
  requireDeveloperSignature: boolean,
): void {
  runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath]);
  const details = runCommand("codesign", ["-dv", "--verbose=4", appBundlePath]);

  if (requireDeveloperSignature) {
    if (
      !details.includes("Authority=Developer ID Application:") ||
      details.includes("TeamIdentifier=not set")
    ) {
      throw new Error(
        `Signed macOS update bundle must use a Developer ID Application identity: ${appBundlePath}`,
      );
    }
    const appSnapHelperPath = join(appBundlePath, SCIENT_APPSNAP_HELPER_BUNDLE_PATH);
    if (!existsSync(appSnapHelperPath)) {
      throw new Error(`Signed macOS app is missing AppSnap helper: ${appSnapHelperPath}`);
    }
    runCommand("codesign", ["--verify", "--strict", "--verbose=4", appSnapHelperPath]);
    const appSnapDetails = runCommand("codesign", ["-dv", "--verbose=4", appSnapHelperPath]);
    const appSnapEntitlements = runCommand("codesign", [
      "-d",
      "--entitlements",
      ":-",
      appSnapHelperPath,
    ]);
    const appEntitlements = runCommand("codesign", ["-d", "--entitlements", ":-", appBundlePath]);
    const electronHelpers = SCIENT_ELECTRON_HELPERS.map((helper) => {
      const helperPath = join(appBundlePath, helper.bundlePath);
      if (!existsSync(helperPath)) {
        throw new Error(`Signed macOS app is missing Electron helper: ${helperPath}`);
      }
      runCommand("codesign", ["--verify", "--strict", "--verbose=4", helperPath]);
      return {
        identifier: helper.identifier,
        details: runCommand("codesign", ["-dv", "--verbose=4", helperPath]),
        entitlements: runCommand("codesign", ["-d", "--entitlements", ":-", helperPath]),
      };
    });
    assertSignedMacIdentityDetails({
      appDetails: details,
      appEntitlements,
      appSnapDetails,
      appSnapEntitlements,
      electronHelpers,
    });
    runCommand("xcrun", ["stapler", "validate", "--verbose", appBundlePath]);
    runCommand("spctl", ["--assess", "--type", "execute", "--verbose=4", appBundlePath]);
  } else if (!details.includes("Signature=adhoc") || !details.includes("TeamIdentifier=not set")) {
    throw new Error(
      `Unsigned macOS update bundle must have a complete ad-hoc signature: ${appBundlePath}`,
    );
  }
}

export function verifySingleMacDmgSignature(options: {
  readonly stageDistDir: string;
  readonly requireDeveloperSignature: boolean;
  readonly verbose?: boolean;
}): string {
  if (process.platform !== "darwin") {
    throw new Error("macOS DMG signature verification must run on macOS.");
  }

  const dmgNames = readdirSync(options.stageDistDir).filter((entry) => entry.endsWith(".dmg"));
  if (dmgNames.length !== 1 || !dmgNames[0]) {
    throw new Error(`Expected one macOS DMG in ${options.stageDistDir}, found ${dmgNames.length}.`);
  }

  const dmgPath = join(options.stageDistDir, dmgNames[0]);
  const mountPath = mkdtempSync(join(tmpdir(), "scient-dmg-signature-"));
  let attached = false;
  try {
    runCommand("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPath, dmgPath], {
      verbose: options.verbose === true,
    });
    attached = true;

    const appNames = readdirSync(mountPath).filter((entry) => entry.endsWith(".app"));
    if (appNames.length !== 1 || !appNames[0]) {
      throw new Error(`Expected one macOS app in ${dmgNames[0]}, found ${appNames.length}.`);
    }
    verifyMacAppSignature(join(mountPath, appNames[0]), options.requireDeveloperSignature);
    return dmgPath;
  } finally {
    if (attached) {
      runCommand("hdiutil", ["detach", mountPath]);
    }
    rmSync(mountPath, { recursive: true, force: true });
  }
}
