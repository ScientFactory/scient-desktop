import { describe, expect, it, vi } from "vitest";

import {
  isLinuxSetuidSandboxConfigured,
  isLinuxUserNamespaceSandboxAvailable,
  LinuxSandboxConfigurationError,
  resolveLinuxSandboxArgs,
} from "./electron-launcher.mjs";

const ELECTRON_PATH = "/repo/node_modules/electron/dist/electron";
const SANDBOX_PATH = "/repo/node_modules/electron/dist/chrome-sandbox";

describe("Linux Electron sandbox launch policy", () => {
  it("leaves non-Linux launches unchanged without inspecting chrome-sandbox", () => {
    const lstat = vi.fn();
    const runUnshare = vi.fn();

    expect(
      resolveLinuxSandboxArgs(ELECTRON_PATH, { platform: "darwin", lstat, runUnshare }),
    ).toEqual([]);
    expect(lstat).not.toHaveBeenCalled();
    expect(runUnshare).not.toHaveBeenCalled();
  });

  it("keeps Chromium's sandbox when chrome-sandbox is root-owned setuid 4755", () => {
    const lstat = vi.fn(() => ({ isFile: () => true, mode: 0o104755, uid: 0 }));
    const runUnshare = vi.fn();

    expect(isLinuxSetuidSandboxConfigured(ELECTRON_PATH, { platform: "linux", lstat })).toBe(true);
    expect(
      resolveLinuxSandboxArgs(ELECTRON_PATH, { platform: "linux", lstat, runUnshare }),
    ).toEqual([]);
    expect(lstat).toHaveBeenCalledWith(SANDBOX_PATH);
    expect(runUnshare).not.toHaveBeenCalled();
  });

  it("keeps Chromium's sandbox when unprivileged user namespaces work without a helper", () => {
    const runUnshare = vi.fn(() => ({ status: 0 }));

    expect(
      resolveLinuxSandboxArgs(ELECTRON_PATH, {
        platform: "linux",
        lstat: () => {
          throw new Error("ENOENT");
        },
        runUnshare,
      }),
    ).toEqual([]);
    expect(runUnshare).toHaveBeenCalledWith("unshare", ["-Ur", "true"], {
      shell: false,
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    expect(isLinuxUserNamespaceSandboxAvailable({ platform: "linux", runUnshare })).toBe(true);
  });

  it.each([
    ["is not root-owned", { isFile: () => true, mode: 0o104755, uid: 1000 }],
    ["is not setuid", { isFile: () => true, mode: 0o100755, uid: 0 }],
    ["is group-writable", { isFile: () => true, mode: 0o104775, uid: 0 }],
    ["has extra special bits", { isFile: () => true, mode: 0o106755, uid: 0 }],
    ["is not a regular file", { isFile: () => false, mode: 0o104755, uid: 0 }],
  ])("fails closed when chrome-sandbox %s", (_reason, metadata) => {
    expect(() =>
      resolveLinuxSandboxArgs(ELECTRON_PATH, {
        platform: "linux",
        lstat: () => metadata,
        runUnshare: () => ({ status: 1 }),
      }),
    ).toThrow(LinuxSandboxConfigurationError);
  });

  it("fails closed when both chrome-sandbox and unprivileged user namespaces are unavailable", () => {
    expect(() =>
      resolveLinuxSandboxArgs(ELECTRON_PATH, {
        platform: "linux",
        lstat: () => {
          throw new Error("ENOENT");
        },
        runUnshare: () => ({ status: 1 }),
      }),
    ).toThrow(expect.objectContaining({ sandboxPath: SANDBOX_PATH }));
  });

  it("allows --no-sandbox only through an explicit local-development override", () => {
    const warn = vi.fn();

    expect(
      resolveLinuxSandboxArgs(ELECTRON_PATH, {
        platform: "linux",
        lstat: () => ({ isFile: () => false, mode: 0, uid: 1000 }),
        runUnshare: () => ({ status: 1 }),
        development: true,
        env: { SCIENT_DEV_ALLOW_NO_SANDBOX: "1" },
        warn,
      }),
    ).toEqual(["--no-sandbox"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unsafe development override"));
  });

  it("refuses the unsafe override outside development", () => {
    expect(() =>
      resolveLinuxSandboxArgs(ELECTRON_PATH, {
        platform: "linux",
        lstat: () => ({ isFile: () => false, mode: 0, uid: 1000 }),
        runUnshare: () => ({ status: 1 }),
        development: false,
        env: { SCIENT_DEV_ALLOW_NO_SANDBOX: "1" },
      }),
    ).toThrow(LinuxSandboxConfigurationError);
  });
});
