import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensurePrivateFileSync,
  PrivatePathPermissionError,
  repairPrivateFileSync,
} from "./privatePathPermissions";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scient-private-file-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ensurePrivateFileSync", () => {
  it("creates an owner-only file even under a permissive umask", () => {
    if (process.platform === "win32") return;
    const filePath = path.join(makeTemporaryRoot(), "private.log");
    const previousUmask = process.umask(0o000);
    try {
      ensurePrivateFileSync(filePath);
    } finally {
      process.umask(previousUmask);
    }

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("repairs an existing regular file without changing its contents", () => {
    if (process.platform === "win32") return;
    const filePath = path.join(makeTemporaryRoot(), "state.sqlite");
    fs.writeFileSync(filePath, "existing data", { mode: 0o664 });

    ensurePrivateFileSync(filePath);

    expect(fs.readFileSync(filePath, "utf8")).toBe("existing data");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlink without repairing or changing its target", () => {
    if (process.platform === "win32") return;
    const root = makeTemporaryRoot();
    const targetPath = path.join(root, "outside.log");
    const linkedPath = path.join(root, "server.log");
    fs.writeFileSync(targetPath, "outside", { mode: 0o664 });
    fs.chmodSync(targetPath, 0o664);
    fs.symlinkSync(targetPath, linkedPath, "file");

    expect(() => ensurePrivateFileSync(linkedPath)).toThrow(PrivatePathPermissionError);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("outside");
    expect(fs.statSync(targetPath).mode & 0o777).toBe(0o664);
  });

  it("rejects FIFOs instead of blocking while opening them", () => {
    if (process.platform === "win32") return;
    const root = makeTemporaryRoot();
    const ensurePath = path.join(root, "ensure.fifo");
    const repairPath = path.join(root, "repair.fifo");
    execFileSync("mkfifo", [ensurePath]);
    execFileSync("mkfifo", [repairPath]);

    expect(() => ensurePrivateFileSync(ensurePath)).toThrow(PrivatePathPermissionError);
    expect(() => repairPrivateFileSync(repairPath)).toThrow(PrivatePathPermissionError);
  });
});
