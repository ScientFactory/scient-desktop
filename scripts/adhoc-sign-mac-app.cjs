// FILE: adhoc-sign-mac-app.cjs
// Purpose: Gives unsigned early-access macOS bundles a complete ad-hoc signature before packaging.
// Layer: electron-builder afterPack hook
// Depends on: macOS codesign and the staged Electron application bundle.

const { execFileSync, spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const { SCIENT_MAC_BUNDLE_IDENTIFIER } = require("./lib/mac-signing-policy.cjs");

const EXPECTED_BUNDLE_IDENTIFIER = SCIENT_MAC_BUNDLE_IDENTIFIER;

module.exports = async function adhocSignMacApp(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${productFilename}.app`);
  const configuredEntitlements = context.packager.platformSpecificBuildOptions.entitlements;
  const args = ["--force", "--deep", "--sign", "-", "--options", "runtime"];

  if (typeof configuredEntitlements === "string" && configuredEntitlements.length > 0) {
    args.push("--entitlements", resolve(context.packager.projectDir, configuredEntitlements));
  }
  args.push(appPath);

  console.log(`Ad-hoc signing unsigned macOS bundle: ${appPath}`);
  execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });

  const detailResult = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  if (detailResult.status !== 0) {
    throw new Error(
      `Could not inspect ad-hoc signature: ${(detailResult.stderr || detailResult.stdout || "").trim()}`,
    );
  }
  const details = `${detailResult.stdout || ""}\n${detailResult.stderr || ""}`;
  if (!details.includes(`Identifier=${EXPECTED_BUNDLE_IDENTIFIER}`)) {
    throw new Error(
      `Ad-hoc signed bundle has the wrong identifier; expected ${EXPECTED_BUNDLE_IDENTIFIER}.`,
    );
  }
  if (!details.includes("Signature=adhoc") || !details.includes("TeamIdentifier=not set")) {
    throw new Error("Unsigned macOS bundle was not sealed with the expected ad-hoc identity.");
  }
};
