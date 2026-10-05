import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";
import { hasValidDevelopmentCodeIdentity } from "./electron-launcher.mjs";

const expectedId = "com.scientfactory.scient.next.dev.controlledidentity";

function codesign(...args) {
  return NodeChildProcess.spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
}

function writeBundle(bundle, identifier) {
  const contents = NodePath.join(bundle, "Contents");
  NodeFS.mkdirSync(NodePath.join(contents, "MacOS"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(contents, "Resources"), { recursive: true });
  NodeFS.copyFileSync("/usr/bin/true", NodePath.join(contents, "MacOS", "ControlledIdentity"));
  NodeFS.writeFileSync(NodePath.join(contents, "Resources", "sealed.txt"), "Owned fixture bytes\n");
  NodeFS.writeFileSync(
    NodePath.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>ControlledIdentity</string>
<key>CFBundleName</key><string>Controlled Identity</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
}

function withSignedBundle(identifier, test) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-code-identity-"));
  try {
    const bundle = NodePath.join(root, "Controlled Identity.app");
    const helper = NodePath.join(bundle, "Contents", "Helpers", "Controlled Helper.app");
    writeBundle(bundle, identifier);
    writeBundle(helper, `${identifier}.helper`);
    for (const path of [helper, bundle]) {
      const signed = codesign("--force", "--sign", "-", "--timestamp=none", path);
      assert.equal(signed.status, 0, signed.stderr);
    }
    const verified = codesign("--verify", "--deep", "--strict", bundle);
    assert.equal(verified.status, 0, verified.stderr);
    test(bundle, helper);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!NodeFS.existsSync("/usr/bin/codesign"))("native development code identity", () => {
  it("accepts an actual ad hoc signed candidate with an independently identified nested helper", () => {
    withSignedBundle(expectedId, (bundle) => {
      const requirement = codesign("--display", "--requirements", "-", bundle);
      assert.equal(requirement.status, 0, requirement.stderr);
      assert.include(
        requirement.stdout,
        "cdhash",
        "Exercise the actual ad hoc designated requirement",
      );
      assert.notInclude(requirement.stdout, `identifier "${expectedId}"`);
      assert.isTrue(hasValidDevelopmentCodeIdentity(bundle, { bundleId: expectedId }));
    });
  });

  it("refuses a fully valid signed candidate belonging to a different bundle identifier", () => {
    withSignedBundle(`${expectedId}.foreign`, (bundle) => {
      assert.isTrue(hasValidDevelopmentCodeIdentity(bundle, { bundleId: `${expectedId}.foreign` }));
      assert.isFalse(hasValidDevelopmentCodeIdentity(bundle, { bundleId: expectedId }));
    });
  });

  it("refuses an expected-identity candidate after a sealed resource is corrupted", () => {
    withSignedBundle(expectedId, (bundle) => {
      assert.isTrue(hasValidDevelopmentCodeIdentity(bundle, { bundleId: expectedId }));
      NodeFS.appendFileSync(
        NodePath.join(bundle, "Contents", "Resources", "sealed.txt"),
        "Corrupted\n",
      );
      assert.isFalse(hasValidDevelopmentCodeIdentity(bundle, { bundleId: expectedId }));
    });
  });

  it("retains deep validation when an independently signed nested helper is corrupted", () => {
    withSignedBundle(expectedId, (bundle, helper) => {
      assert.isTrue(hasValidDevelopmentCodeIdentity(bundle, { bundleId: expectedId }));
      NodeFS.appendFileSync(
        NodePath.join(helper, "Contents", "Resources", "sealed.txt"),
        "Corrupted\n",
      );
      assert.isFalse(hasValidDevelopmentCodeIdentity(bundle, { bundleId: expectedId }));
    });
  });
});
