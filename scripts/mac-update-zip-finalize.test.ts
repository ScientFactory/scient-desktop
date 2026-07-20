import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { verifyMacAppSignature } from "./lib/mac-artifact-signature.ts";

const runOnMac = process.platform === "darwin" ? it : it.skip;

describe("verifyMacAppSignature", () => {
  runOnMac("rejects malformed unsigned bundles and accepts complete ad-hoc signatures", () => {
    const root = mkdtempSync(join(tmpdir(), "scient-adhoc-signature-test-"));
    const appPath = join(root, "Scient.app");
    const contentsPath = join(appPath, "Contents");
    const executablePath = join(contentsPath, "MacOS", "Scient");

    try {
      mkdirSync(join(contentsPath, "MacOS"), { recursive: true });
      copyFileSync("/usr/bin/true", executablePath);
      chmodSync(executablePath, 0o755);
      writeFileSync(
        join(contentsPath, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Scient</string>
<key>CFBundleIdentifier</key><string>com.scientfactory.scient</string>
<key>CFBundleName</key><string>Scient</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
      );

      assert.throws(() => verifyMacAppSignature(appPath, false));

      execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
      assert.doesNotThrow(() => verifyMacAppSignature(appPath, false));
      assert.throws(
        () => verifyMacAppSignature(appPath, true),
        /Developer ID Application identity/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
