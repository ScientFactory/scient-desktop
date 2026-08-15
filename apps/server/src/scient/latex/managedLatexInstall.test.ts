// @effect-diagnostics nodeBuiltinImport:off -- Both path flavours are driven
// directly, so the containment rule is proven under Windows semantics whatever
// host runs the suite.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  MANAGED_LATEX_STATE_FILE,
  isManagedInstallRootContained,
  managedLatexInstallRoot,
  managedLatexPaths,
} from "./managedLatexInstall.ts";

const WINDOWS_MANAGED_ROOT = "C:\\Users\\ada\\AppData\\Roaming\\Scient\\latex\\managed";
const POSIX_MANAGED_ROOT = "/home/ada/.scient/latex/managed";

describe("managedLatexPaths", () => {
  it("keeps the state file and the staging area inside the managed root", () => {
    const paths = managedLatexPaths({
      latexDir: "/state/latex",
      join: NodePath.posix.join,
    });

    expect(paths.managedRoot).toBe("/state/latex/managed");
    expect(paths.statePath).toBe(`/state/latex/managed/${MANAGED_LATEX_STATE_FILE}`);
    // Dot-prefixed, so a half-finished install is never mistaken for an
    // installed version directory beside it.
    expect(paths.stagingRoot).toBe("/state/latex/managed/.staging");
  });
});

describe("managedLatexInstallRoot", () => {
  it("gives every install a directory of its own", () => {
    const first = managedLatexInstallRoot({
      managedRoot: POSIX_MANAGED_ROOT,
      version: "2026.08",
      unique: "0a1b2c3d",
      join: NodePath.posix.join,
    });
    const second = managedLatexInstallRoot({
      managedRoot: POSIX_MANAGED_ROOT,
      version: "2026.08",
      unique: "4e5f6a7b",
      join: NodePath.posix.join,
    });

    expect(first).toBe(`${POSIX_MANAGED_ROOT}/tinytex-2026.08-0a1b2c3d`);
    // Two installs of the same version must never contend for one path: the
    // second would have to remove a tree the first's engine may be running.
    expect(second).not.toBe(first);
    expect(
      isManagedInstallRootContained({
        root: first,
        managedRoot: POSIX_MANAGED_ROOT,
        resolve: NodePath.posix.resolve,
      }),
    ).toBe(true);
  });
});

describe("isManagedInstallRootContained", () => {
  it("accepts an install directory the installer would really write", () => {
    expect(
      isManagedInstallRootContained({
        root: `${WINDOWS_MANAGED_ROOT}\\tinytex-2026.08-0a1b2c3d`,
        managedRoot: WINDOWS_MANAGED_ROOT,
        resolve: NodePath.win32.resolve,
      }),
    ).toBe(true);
    expect(
      isManagedInstallRootContained({
        root: `${POSIX_MANAGED_ROOT}/tinytex-2026.08-0a1b2c3d`,
        managedRoot: POSIX_MANAGED_ROOT,
        resolve: NodePath.posix.resolve,
      }),
    ).toBe(true);
  });

  it("refuses a root that walks back out of the managed directory", () => {
    // A tampered state file's escape: every segment is inside the managed root
    // as a string, and none of it is once the walk is resolved.
    expect(
      isManagedInstallRootContained({
        root: `${WINDOWS_MANAGED_ROOT}\\..\\..\\..`,
        managedRoot: WINDOWS_MANAGED_ROOT,
        resolve: NodePath.win32.resolve,
      }),
    ).toBe(false);
    expect(
      isManagedInstallRootContained({
        root: `${WINDOWS_MANAGED_ROOT}\\..\\..\\..\\Windows\\System32\\cmd.exe`,
        managedRoot: WINDOWS_MANAGED_ROOT,
        resolve: NodePath.win32.resolve,
      }),
    ).toBe(false);
    expect(
      isManagedInstallRootContained({
        root: `${POSIX_MANAGED_ROOT}/../../../usr/bin`,
        managedRoot: POSIX_MANAGED_ROOT,
        resolve: NodePath.posix.resolve,
      }),
    ).toBe(false);
  });

  it("refuses the managed root itself and a directory merely named like it", () => {
    expect(
      isManagedInstallRootContained({
        root: WINDOWS_MANAGED_ROOT,
        managedRoot: WINDOWS_MANAGED_ROOT,
        resolve: NodePath.win32.resolve,
      }),
    ).toBe(false);
    expect(
      isManagedInstallRootContained({
        root: `${WINDOWS_MANAGED_ROOT}-elsewhere\\tinytex-2026.08-0a1b2c3d`,
        managedRoot: WINDOWS_MANAGED_ROOT,
        resolve: NodePath.win32.resolve,
      }),
    ).toBe(false);
  });
});
