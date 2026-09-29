import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  assertForegroundSigning,
  DevelopmentAppBundleError,
  makeDevelopmentStartCommandStub,
  readDevelopmentAppFailure,
  replaceAppBundleAtomically,
  resolveBundleMetadataPath,
  resolveBundleStartCommandPath,
  signInForeground,
} from "./dev-app-bundle.mjs";

const roots = [];

function tempDir() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-dev-bundle-"));
  roots.push(directory);
  return directory;
}

function writeBundle(appBundlePath, marker) {
  NodeFS.mkdirSync(NodePath.join(appBundlePath, "Contents"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(appBundlePath, "Contents", "marker"), marker);
}

function readMarker(appBundlePath) {
  return NodeFS.readFileSync(NodePath.join(appBundlePath, "Contents", "marker"), "utf8");
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("development app bundle", () => {
  it("gives every bundle its own build record", () => {
    // A production smoke build in the same checkout must not invalidate the dev app.
    assert.notEqual(
      resolveBundleMetadataPath("/runtime", "Scient.app"),
      resolveBundleMetadataPath("/runtime", "Scient (Dev) · fork.app"),
    );
    assert.equal(
      resolveBundleStartCommandPath("/runtime", "Scient (Dev).app"),
      "/runtime/Scient (Dev).app.start.command",
    );
  });

  it("signs a start command that only defers to the script beside the bundle", () => {
    const stub = makeDevelopmentStartCommandStub("/runtime/Scient (Dev).app.start.command");

    assert.include(stub, `exec /bin/sh '/runtime/Scient (Dev).app.start.command' "$@"`);
    assert.include(stub, "exit 78");
    assert.notInclude(stub, "pnpm.cjs");
  });

  it("refuses to sign from the background service and records the next step", () => {
    const failurePath = NodePath.join(tempDir(), "last-failure.json");
    const environment = {
      SCIENT_DEV_APP_BACKGROUND_SERVICE: "1",
      SCIENT_DEV_APP_FAILURE_FILE: failurePath,
    };
    let signed = false;

    assert.throws(
      () => signInForeground("/runtime/Scient (Dev).app", () => (signed = true), environment),
      DevelopmentAppBundleError,
    );
    assert.isFalse(signed);
    assert.match(readDevelopmentAppFailure(failurePath), /Run pnpm dev:app:start again/u);
    assert.doesNotThrow(() => assertForegroundSigning("/runtime/Scient (Dev).app", {}));
  });

  it("reports the signer's own reason when signing fails", () => {
    const failurePath = NodePath.join(tempDir(), "last-failure.json");

    assert.throws(
      () =>
        signInForeground(
          "/runtime/Scient (Dev).app",
          () => {
            throw new Error(
              "Failed to run codesign:\n/runtime/Scient (Dev).app/x/locale.pak: Operation not permitted\n",
            );
          },
          { SCIENT_DEV_APP_FAILURE_FILE: failurePath },
        ),
      /Signing Scient \(Dev\)\.app failed: .*Operation not permitted/u,
    );
    assert.match(readDevelopmentAppFailure(failurePath), /Run pnpm dev:app from a terminal/u);
  });

  it("swaps in a rebuilt bundle only after it is complete", () => {
    const runtimeDir = tempDir();
    const target = NodePath.join(runtimeDir, "Scient (Dev).app");
    writeBundle(target, "old");

    replaceAppBundleAtomically(target, (staged) => {
      assert.equal(NodePath.basename(staged), "Scient (Dev).app");
      assert.equal(readMarker(target), "old");
      writeBundle(staged, "new");
    });

    assert.equal(readMarker(target), "new");
    assert.deepEqual(NodeFS.readdirSync(runtimeDir), ["Scient (Dev).app"]);
  });

  it("keeps the previous bundle when a rebuild fails", () => {
    const runtimeDir = tempDir();
    const target = NodePath.join(runtimeDir, "Scient (Dev).app");
    writeBundle(target, "old");

    assert.throws(
      () =>
        replaceAppBundleAtomically(target, (staged) => {
          writeBundle(staged, "half-built");
          throw new Error("Operation not permitted");
        }),
      /Operation not permitted/u,
    );

    assert.equal(readMarker(target), "old");
    assert.deepEqual(NodeFS.readdirSync(runtimeDir), ["Scient (Dev).app"]);
  });

  it("recovers from a build killed mid-way before building again", () => {
    const runtimeDir = tempDir();
    const target = NodePath.join(runtimeDir, "Scient (Dev).app");
    // Killed between the two renames: the live bundle survives only as `.previous`.
    const midSwap = NodePath.join(runtimeDir, ".staging-midswap");
    writeBundle(NodePath.join(midSwap, "Scient (Dev).app.previous"), "old");
    // Killed while signing long ago: a full abandoned copy.
    const abandoned = NodePath.join(runtimeDir, ".staging-abandoned");
    writeBundle(NodePath.join(abandoned, "Scient (Dev).app"), "half-built");
    const later = Date.now() + 11 * 60 * 1000;

    let sawRestored = false;
    replaceAppBundleAtomically(
      target,
      (staged) => {
        sawRestored = readMarker(target) === "old";
        writeBundle(staged, "new");
      },
      { now: later },
    );

    assert.isTrue(sawRestored);
    assert.equal(readMarker(target), "new");
    assert.deepEqual(NodeFS.readdirSync(runtimeDir), ["Scient (Dev).app"]);
  });

  it("leaves a concurrent build's recent staging directory alone", () => {
    const runtimeDir = tempDir();
    const target = NodePath.join(runtimeDir, "Scient (Dev).app");
    const live = NodePath.join(runtimeDir, ".staging-live");
    writeBundle(NodePath.join(live, "Scient (Dev).app"), "in progress");

    replaceAppBundleAtomically(target, (staged) => writeBundle(staged, "new"));

    assert.isTrue(NodeFS.existsSync(live));
  });

  it("restores the previous bundle if the swap itself fails", () => {
    const runtimeDir = tempDir();
    const target = NodePath.join(runtimeDir, "Scient (Dev).app");
    writeBundle(target, "old");
    const fs = {
      ...NodeFS,
      renameSync: (from, to) => {
        if (to === target && from.includes(".staging-") && !from.endsWith(".previous")) {
          throw new Error("rename refused");
        }
        NodeFS.renameSync(from, to);
      },
    };

    assert.throws(
      () => replaceAppBundleAtomically(target, (staged) => writeBundle(staged, "new"), { fs }),
      /rename refused/u,
    );

    assert.equal(readMarker(target), "old");
  });
});
