import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  backendProcessContainmentOptions,
  forceTerminateBackendProcessTree,
} from "./backendProcessTree";

describe("forceTerminateBackendProcessTree", () => {
  it("always reserves an IPC channel and isolates POSIX process groups", () => {
    expect(backendProcessContainmentOptions(true, "linux")).toEqual({
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    expect(backendProcessContainmentOptions(false, "darwin")).toEqual({
      detached: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    expect(backendProcessContainmentOptions(false, "win32")).toEqual({
      detached: false,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
  });

  it("kills the detached POSIX process group", async () => {
    const killProcessGroup = vi.fn();

    await forceTerminateBackendProcessTree({ pid: 4321 }, { platform: "linux", killProcessGroup });

    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGKILL");
  });

  it("ignores a POSIX process group that already exited", async () => {
    await expect(
      forceTerminateBackendProcessTree(
        { pid: 4321 },
        {
          platform: "darwin",
          killProcessGroup: () => {
            const error = new Error("missing") as NodeJS.ErrnoException;
            error.code = "ESRCH";
            throw error;
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the Windows taskkill executable without a shell", async () => {
    const process = new EventEmitter();
    const spawnProcess = vi.fn(() => process);

    const terminating = forceTerminateBackendProcessTree(
      { pid: 4321 },
      {
        platform: "win32",
        env: { SystemRoot: "D:\\Windows" },
        spawnProcess: spawnProcess as never,
      },
    );
    process.emit("exit", 0, null);
    await terminating;

    expect(spawnProcess).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      {
        env: { SystemRoot: "D:\\Windows" },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
  });

  it("does not treat a missing Windows root as successful descendant cleanup", async () => {
    const process = new EventEmitter();
    const spawnProcess = vi.fn(() => process);
    const terminating = forceTerminateBackendProcessTree(
      { pid: 4321 },
      { platform: "win32", spawnProcess: spawnProcess as never },
    );

    process.emit("exit", 128, null);

    await expect(terminating).rejects.toThrow("taskkill exited with status 128");
  });
});
