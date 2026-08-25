import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import { findInvalidDarwinRuntimeAliases } from "./ensure-electron-runtime.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeRuntimeFixture() {
  const electronDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-runtime-test-"));
  fixtures.push(electronDir);
  const frameworkRoot = NodePath.join(
    electronDir,
    "dist",
    "Electron.app",
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  const versionRoot = NodePath.join(frameworkRoot, "Versions", "A");
  for (const directory of ["Helpers", "Libraries", "Resources"]) {
    NodeFS.mkdirSync(NodePath.join(versionRoot, directory), { recursive: true });
  }
  NodeFS.writeFileSync(NodePath.join(versionRoot, "Electron Framework"), "runtime");
  NodeFS.symlinkSync("A", NodePath.join(frameworkRoot, "Versions", "Current"));
  for (const [name, target] of [
    ["Electron Framework", "Versions/Current/Electron Framework"],
    ["Helpers", "Versions/Current/Helpers"],
    ["Libraries", "Versions/Current/Libraries"],
    ["Resources", "Versions/Current/Resources"],
  ]) {
    NodeFS.symlinkSync(target, NodePath.join(frameworkRoot, name));
  }
  return { electronDir, frameworkRoot };
}

describe("Electron runtime repair", () => {
  it("accepts the framework alias layout from the official Electron archive", () => {
    const { electronDir } = makeRuntimeFixture();

    assert.deepEqual(findInvalidDarwinRuntimeAliases(electronDir), []);
  });

  it("rejects an extracted runtime whose framework aliases were flattened", () => {
    const { electronDir, frameworkRoot } = makeRuntimeFixture();
    const resourcesPath = NodePath.join(frameworkRoot, "Resources");
    NodeFS.rmSync(resourcesPath);
    NodeFS.mkdirSync(resourcesPath);

    assert.deepEqual(findInvalidDarwinRuntimeAliases(electronDir), [resourcesPath]);
  });
});
