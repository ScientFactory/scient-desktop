// FILE: mac-artifact-signature.ts
// Purpose: Verifies macOS app signatures in unpacked bundles and final DMG release artifacts.
// Layer: Release/build helper
// Depends on: macOS codesign and hdiutil.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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
