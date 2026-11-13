// @effect-diagnostics nodeBuiltinImport:off -- Windows permission checks against a faked disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as HostProcess from "./HostProcess.ts";
import {
  NATIVE_CHECK_DEADLINE_MS,
  NativeCheckDeadlineError,
  publicationDigest,
  validatePublicationArtifact,
} from "./scientPublicationArtifact.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, lstat: vi.fn(), readFile: vi.fn(), access: vi.fn() };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, execFile: vi.fn() };
});

// A Windows x64 executable as far as the format check reads it.
const bytes = Buffer.alloc(128);
bytes.write("MZ", 0);
bytes.writeUInt32LE(64, 60);
bytes.write("PE\0\0", 64, "latin1");
bytes.writeUInt16LE(0x8664, 68);
const receipt = JSON.stringify({
  protocol: 1,
  platform: "win32",
  arch: "x64",
  probe: false,
  executable: "scient-file-publication.exe",
  sha256: publicationDigest(bytes),
});
const helper = "/install/file-exchange/scient-file-publication.exe";

const fakeProcess = () => Object.assign(new NodeEvents.EventEmitter(), { kill: vi.fn() });

const USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
const PRIVATE = `O:${USER}G:${USER}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;

/** The helper's version on disk: a new one is a replaced file. */
let version = 0;
let checks = 0;
/** The descriptor PowerShell prints for each path it is given. */
let descriptor = (_path: string) => PRIVATE;
/** What happens to the disk while PowerShell looks at it. */
let duringCheck = () => {};
let lastPaths: string[] = [];

beforeEach(() => {
  version = 0;
  checks = 0;
  descriptor = () => PRIVATE;
  duringCheck = () => {};
  vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("win32");
  vi.spyOn(HostProcess.Architecture, "defaultValue").mockReturnValue("x64");
  vi.mocked(NodeFSP.lstat).mockImplementation((async (path: string, options?: object) => {
    const file = path === helper || path.endsWith(".json");
    const stamp = BigInt(version);
    if (options) return { ino: stamp, size: 1n, mtimeNs: stamp, ctimeNs: stamp };
    return { isSymbolicLink: () => false, isFile: () => file, isDirectory: () => !file };
  }) as never);
  vi.mocked(NodeFSP.readFile).mockImplementation((async (path: string) =>
    path === helper ? bytes : receipt) as never);
  vi.mocked(NodeFSP.access).mockResolvedValue(undefined);
  vi.mocked(NodeChildProcess.execFile).mockImplementation(((
    file: string,
    _args: string[],
    options: { env: Record<string, string> },
    done: (error: null, stdout: string) => void,
  ) => {
    let stdout = `"host\\user","${USER}"\r\n`;
    if (file.endsWith("powershell.exe")) {
      checks += 1;
      duringCheck();
      lastPaths = options.env.SCIENT_PUBLICATION_ACL_PATHS!.split("\n");
      stdout = lastPaths.map((path) => `${descriptor(path)}\r\n`).join("");
    }
    // The program exits, then closes, as a real launch does: later, never at once.
    const child = fakeProcess();
    setImmediate(() => {
      child.emit("exit", 0, null);
      done(null, stdout);
    });
    return child;
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("the Windows helper permission check", () => {
  it("reads the helper, its folder, its receipt and every folder above", async () => {
    // Others may add to a folder above, never to the helper's own.
    descriptor = (path) => (path === "/install" ? `${PRIVATE}(A;;0x6;;;WD)` : PRIVATE);
    await validatePublicationArtifact(helper);
    expect(lastPaths).toEqual([
      helper,
      "/install/file-exchange",
      "/install/file-exchange/publication-artifact.json",
      "/install",
      "/",
    ]);
  });

  it("refuses a folder above that another principal can delete from, or an untrusted owner", async () => {
    descriptor = (path) =>
      path === "/install/file-exchange" ? `${PRIVATE}(A;;0x6;;;WD)` : PRIVATE;
    await expect(validatePublicationArtifact(helper)).rejects.toThrow(
      "writable by another principal. (/install/file-exchange)",
    );
    descriptor = (path) => (path === "/install" ? `${PRIVATE}(A;;DT;;;WD)` : PRIVATE);
    await expect(validatePublicationArtifact(helper)).rejects.toThrow(
      "writable by another principal. (/install)",
    );
    descriptor = (path) =>
      path === helper ? PRIVATE.replace(`O:${USER}`, "O:S-1-5-21-1-2-3-1002") : PRIVATE;
    await expect(validatePublicationArtifact(helper)).rejects.toThrow(
      "Unexpected native resource owner",
    );
  });

  it("checks again each time, so a folder above that changed is seen", async () => {
    version = 10;
    await validatePublicationArtifact(helper);
    descriptor = (path) => (path === "/" ? `${PRIVATE}(A;;GA;;;BU)` : PRIVATE);
    await expect(validatePublicationArtifact(helper)).rejects.toThrow(
      "writable by another principal",
    );
    expect(checks).toBe(2);
  });

  it("refuses output that does not describe every path", async () => {
    descriptor = (path) => (path === "/" ? "" : PRIVATE);
    await expect(validatePublicationArtifact(helper)).rejects.toThrow("not read for every folder");
  });

  it("checks a helper replaced while PowerShell looked at it again", async () => {
    version = 30;
    duringCheck = () => {
      version = 31;
      duringCheck = () => {};
    };
    await validatePublicationArtifact(helper);
    expect(checks).toBe(2);
  });

  it("refuses a helper that keeps changing while it is checked", async () => {
    version = 40;
    duringCheck = () => {
      version += 1;
    };
    await expect(validatePublicationArtifact(helper)).rejects.toThrow("kept changing");
    expect(checks).toBe(3);
  });

  it("ends a check at its deadline only once PowerShell has closed, and records no pass", async () => {
    version = 60;
    const passing = vi.mocked(NodeChildProcess.execFile).getMockImplementation() as (
      ...args: unknown[]
    ) => unknown;
    let close = () => {};
    vi.mocked(NodeChildProcess.execFile).mockImplementation(((...args: unknown[]) => {
      if (!String(args[0]).endsWith("powershell.exe")) return passing(...args);
      vi.mocked(NodeChildProcess.execFile).mockImplementation(passing as never);
      checks += 1;
      const child = fakeProcess();
      // Stopped, it exits and closes later, as a real process does.
      child.kill.mockImplementation(() => {
        close = () => {
          child.emit("exit", null, "SIGTERM");
          (args.at(-1) as (error: Error) => void)(new Error("Command failed"));
        };
        return true;
      });
      return child;
    }) as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const outcome = validatePublicationArtifact(helper)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await expect.poll(() => vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(NATIVE_CHECK_DEADLINE_MS);
      // Stopped but not yet closed: the check is still running.
      expect(settled).toBe(false);
      close();
      expect(await outcome).toBeInstanceOf(NativeCheckDeadlineError);
    } finally {
      vi.useRealTimers();
    }
    await validatePublicationArtifact(helper);
    expect(checks).toBe(2);
  });

  it("shares one check among questions asked while it runs", async () => {
    version = 50;
    await Promise.all([validatePublicationArtifact(helper), validatePublicationArtifact(helper)]);
    expect(checks).toBe(1);
  });
});
