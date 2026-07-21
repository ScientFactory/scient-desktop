import { describe, expect, it, vi } from "vitest";

import { isLinuxSetuidSandboxConfigured, resolveLinuxSandboxArgs } from "./electron-launcher.mjs";

const ELECTRON_PATH = "/repo/node_modules/electron/dist/electron";
const SANDBOX_PATH = "/repo/node_modules/electron/dist/chrome-sandbox";

describe("Linux Electron sandbox launch policy", () => {
  it("leaves non-Linux launches unchanged without inspecting chrome-sandbox", () => {
    const stat = vi.fn();

    expect(resolveLinuxSandboxArgs(ELECTRON_PATH, { platform: "darwin", stat })).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });

  it("keeps Chromium's sandbox when chrome-sandbox is root-owned setuid 4755", () => {
    const stat = vi.fn(() => ({ mode: 0o104755, uid: 0 }));

    expect(isLinuxSetuidSandboxConfigured(ELECTRON_PATH, { platform: "linux", stat })).toBe(true);
    expect(resolveLinuxSandboxArgs(ELECTRON_PATH, { platform: "linux", stat })).toEqual([]);
    expect(stat).toHaveBeenCalledWith(SANDBOX_PATH);
  });

  it.each([
    ["is not root-owned", { mode: 0o104755, uid: 1000 }],
    ["is not setuid", { mode: 0o100755, uid: 0 }],
    ["is group-writable", { mode: 0o104775, uid: 0 }],
  ])("uses the local-development fallback when chrome-sandbox %s", (_reason, metadata) => {
    const warn = vi.fn();

    expect(
      resolveLinuxSandboxArgs(ELECTRON_PATH, {
        platform: "linux",
        stat: () => metadata,
        warn,
      }),
    ).toEqual(["--no-sandbox"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("uses the local-development fallback when chrome-sandbox is missing", () => {
    const warn = vi.fn();

    expect(
      resolveLinuxSandboxArgs(ELECTRON_PATH, {
        platform: "linux",
        stat: () => {
          throw new Error("ENOENT");
        },
        warn,
      }),
    ).toEqual(["--no-sandbox"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("launching local Electron"));
  });
});
