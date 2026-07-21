import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PRIVATE_DIRECTORY_MODE, PrivatePathPermissionError } from "./privatePathPermissions";
import {
  ensurePrivateScientDirectoriesSync,
  type ScientDataDirectoryPaths,
} from "@synara/shared/scientDataDirectories";

const temporaryRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scient-private-dirs-"));
  temporaryRoots.push(root);
  return root;
}

function makePaths(baseDir: string): ScientDataDirectoryPaths {
  const stateDir = path.join(baseDir, "userdata");
  const logsDir = path.join(stateDir, "logs");
  return {
    baseDir,
    stateDir,
    secretsDir: path.join(stateDir, "secrets"),
    worktreesDir: path.join(baseDir, "worktrees"),
    attachmentsDir: path.join(stateDir, "attachments"),
    logsDir,
    providerLogsDir: path.join(logsDir, "provider"),
    terminalLogsDir: path.join(logsDir, "terminals"),
  };
}

function permissionMode(targetPath: string): number {
  return fs.statSync(targetPath).mode & 0o777;
}

function orderedDirectoryPaths(paths: ScientDataDirectoryPaths): readonly string[] {
  return [
    paths.baseDir,
    paths.stateDir,
    paths.secretsDir,
    paths.attachmentsDir,
    paths.logsDir,
    paths.providerLogsDir,
    paths.terminalLogsDir,
    paths.worktreesDir,
  ];
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ensurePrivateScientDirectoriesSync", () => {
  it.runIf(process.platform !== "win32")(
    "creates every Scient-owned directory as owner-only under common umasks",
    () => {
      for (const umask of [0o000, 0o002, 0o022]) {
        const container = makeRoot();
        const paths = makePaths(path.join(container, `scient-home-${umask.toString(8)}`));
        const previousUmask = process.umask(umask);
        try {
          ensurePrivateScientDirectoriesSync(paths);
        } finally {
          process.umask(previousUmask);
        }

        for (const directoryPath of Object.values(paths)) {
          expect(permissionMode(directoryPath), directoryPath).toBe(PRIVATE_DIRECTORY_MODE);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "repairs an existing group-writable application-data tree and is idempotent",
    () => {
      for (const insecureMode of [0o755, 0o775, 0o777]) {
        const baseDir = path.join(makeRoot(), `scient-home-${insecureMode.toString(8)}`);
        const paths = makePaths(baseDir);
        for (const directoryPath of orderedDirectoryPaths(paths)) {
          fs.mkdirSync(directoryPath, { recursive: true });
          fs.chmodSync(directoryPath, insecureMode);
        }

        ensurePrivateScientDirectoriesSync(paths);
        ensurePrivateScientDirectoriesSync(paths);

        for (const directoryPath of Object.values(paths)) {
          expect(permissionMode(directoryPath), directoryPath).toBe(PRIVATE_DIRECTORY_MODE);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses symlinks at every managed boundary without repairing their targets",
    () => {
      for (let targetIndex = 0; targetIndex < 8; targetIndex += 1) {
        const container = makeRoot();
        const paths = makePaths(path.join(container, "scient-home"));
        const orderedPaths = orderedDirectoryPaths(paths);
        for (const precedingPath of orderedPaths.slice(0, targetIndex)) {
          fs.mkdirSync(precedingPath, { recursive: true });
          fs.chmodSync(precedingPath, PRIVATE_DIRECTORY_MODE);
        }
        const externalTarget = path.join(container, `target-${targetIndex}`);
        fs.mkdirSync(externalTarget);
        fs.chmodSync(externalTarget, 0o775);
        fs.symlinkSync(externalTarget, orderedPaths[targetIndex]!, "dir");

        expect(() => ensurePrivateScientDirectoriesSync(paths)).toThrow(PrivatePathPermissionError);
        expect(permissionMode(externalTarget)).toBe(0o775);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports a regular file at every expected directory boundary",
    () => {
      for (let targetIndex = 0; targetIndex < 8; targetIndex += 1) {
        const container = makeRoot();
        const paths = makePaths(path.join(container, "scient-home"));
        const orderedPaths = orderedDirectoryPaths(paths);
        for (const precedingPath of orderedPaths.slice(0, targetIndex)) {
          fs.mkdirSync(precedingPath, { recursive: true });
          fs.chmodSync(precedingPath, PRIVATE_DIRECTORY_MODE);
        }
        fs.writeFileSync(orderedPaths[targetIndex]!, "not-a-directory");

        expect(() => ensurePrivateScientDirectoriesSync(paths)).toThrow(PrivatePathPermissionError);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "never changes a user project outside Scient application data",
    () => {
      const container = makeRoot();
      const projectDir = path.join(container, "project");
      fs.mkdirSync(projectDir, { mode: 0o775 });
      fs.chmodSync(projectDir, 0o775);

      ensurePrivateScientDirectoriesSync(makePaths(path.join(container, "scient-home")));

      expect(permissionMode(projectDir)).toBe(0o775);
    },
  );

  it("creates directories without applying POSIX chmod semantics on Windows", () => {
    const baseDir = path.join(makeRoot(), "scient-home");
    const paths = makePaths(baseDir);
    fs.mkdirSync(baseDir, { mode: 0o755 });
    const originalMode = permissionMode(baseDir);

    ensurePrivateScientDirectoriesSync(paths, "win32");

    for (const directoryPath of Object.values(paths)) {
      expect(fs.statSync(directoryPath).isDirectory()).toBe(true);
    }
    if (process.platform !== "win32") expect(permissionMode(baseDir)).toBe(originalMode);
  });
});
