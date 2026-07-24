import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RotatingFileSink } from "@synara/shared/logging";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-rotating-log-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RotatingFileSink", () => {
  it("repairs the active log and rotated backups to private file modes", () => {
    if (process.platform === "win32") return;

    const filePath = path.join(makeTempDir(), "private.log");
    fs.writeFileSync(filePath, "active");
    fs.writeFileSync(`${filePath}.1`, "backup");
    fs.chmodSync(filePath, 0o644);
    fs.chmodSync(`${filePath}.1`, 0o664);

    const sink = new RotatingFileSink({ filePath, maxBytes: 1024, maxFiles: 2 });
    sink.write(" next");

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${filePath}.1`).mode & 0o777).toBe(0o600);
  });

  it("rotates when writes exceed max bytes", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "desktop-main.log");
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 10,
      maxFiles: 3,
    });

    sink.write("12345");
    sink.write("67890");
    sink.write("abc");

    expect(fs.readFileSync(path.join(dir, "desktop-main.log"), "utf8")).toBe("abc");
    expect(fs.readFileSync(path.join(dir, "desktop-main.log.1"), "utf8")).toBe("1234567890");
  });

  it("retains only maxFiles backups", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "server-child.log");
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 4,
      maxFiles: 2,
    });

    sink.write("aaaa");
    sink.write("bbbb");
    sink.write("cccc");
    sink.write("dddd");

    expect(fs.existsSync(path.join(dir, "server-child.log.1"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "server-child.log.2"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "server-child.log.3"))).toBe(false);
  });

  it("prunes stale backups above maxFiles on startup", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "desktop-main.log");
    fs.writeFileSync(path.join(dir, "desktop-main.log.1"), "first");
    fs.writeFileSync(path.join(dir, "desktop-main.log.4"), "stale");

    const sink = new RotatingFileSink({
      filePath: logPath,
      maxBytes: 16,
      maxFiles: 2,
    });
    sink.write("hello");

    expect(fs.existsSync(path.join(dir, "desktop-main.log.4"))).toBe(false);
  });
});
