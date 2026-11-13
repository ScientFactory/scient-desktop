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

const fakePowerShell = () => Object.assign(new NodeEvents.EventEmitter(), { kill: vi.fn() });

/** The helper's version on disk: a new one is a replaced file. */
let version = 0;
let now = 0;
let checks = 0;
/** What happens to the disk while PowerShell looks at it. */
let duringCheck = () => {};

beforeEach(() => {
  version = 0;
  now = 0;
  checks = 0;
  duringCheck = () => {};
  vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("win32");
  vi.spyOn(HostProcess.Architecture, "defaultValue").mockReturnValue("x64");
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(NodeFSP.lstat).mockImplementation((async (path: string, options?: object) => {
    const file = path === helper || path.endsWith(".json");
    const stamp = BigInt(version);
    if (options) return { ino: stamp, size: 1n, mtimeNs: stamp, ctimeNs: stamp };
    return { isSymbolicLink: () => false, isFile: () => file, isDirectory: () => !file };
  }) as never);
  vi.mocked(NodeFSP.readFile).mockImplementation((async (path: string) =>
    path === helper ? bytes : receipt) as never);
  vi.mocked(NodeFSP.access).mockResolvedValue(undefined);
  vi.mocked(NodeChildProcess.execFile).mockImplementation(((...args: unknown[]) => {
    checks += 1;
    duringCheck();
    // PowerShell passes, exits, then closes, as a real launch does: later, never at once.
    const child = fakePowerShell();
    setImmediate(() => {
      child.emit("exit", 0, null);
      (args.at(-1) as (error: null) => void)(null);
    });
    return child;
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

// Each case uses its own version numbers, so passes cached by an earlier case never match.
describe("the Windows helper permission check", () => {
  it("is not repeated for an unchanged helper, however long ago it passed", async () => {
    version = 10;
    await validatePublicationArtifact(helper);
    await validatePublicationArtifact(helper);
    now += 24 * 60 * 60_000;
    await validatePublicationArtifact(helper);
    expect(checks).toBe(1);
  });

  it("is not run for a helper installed with the server, whose receipt still counts", async () => {
    version = 70;
    await validatePublicationArtifact(helper, { installedWithServer: true });
    expect(checks).toBe(0);
    const intact = vi.mocked(NodeFSP.readFile).getMockImplementation()!;
    vi.mocked(NodeFSP.readFile).mockImplementation((async (path: string) =>
      path === helper ? Buffer.alloc(128) : intact(path)) as never);
    await expect(
      validatePublicationArtifact(helper, { installedWithServer: true }),
    ).rejects.toThrow("hash differs");
  });

  it("checks a replaced helper again", async () => {
    version = 20;
    await validatePublicationArtifact(helper);
    version = 21;
    await validatePublicationArtifact(helper);
    expect(checks).toBe(2);
  });

  it("never records a pass for a helper other than the one PowerShell looked at", async () => {
    version = 30;
    // The helper is replaced while it is checked, then put back.
    duringCheck = () => {
      version = 31;
      duringCheck = () => {};
    };
    await validatePublicationArtifact(helper);
    expect(checks).toBe(2);
    version = 30;
    await validatePublicationArtifact(helper);
    expect(checks).toBe(3);
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
    const passing = vi.mocked(NodeChildProcess.execFile).getMockImplementation()!;
    let close = () => {};
    vi.mocked(NodeChildProcess.execFile).mockImplementationOnce(((...args: unknown[]) => {
      checks += 1;
      const child = fakePowerShell();
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
    vi.mocked(NodeChildProcess.execFile).mockImplementation(passing);
    await validatePublicationArtifact(helper);
    expect(checks).toBe(2);
  });

  it("shares one check among questions asked while it runs", async () => {
    version = 50;
    await Promise.all([validatePublicationArtifact(helper), validatePublicationArtifact(helper)]);
    expect(checks).toBe(1);
  });
});
