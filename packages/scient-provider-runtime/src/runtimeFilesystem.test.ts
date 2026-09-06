// @effect-diagnostics nodeBuiltinImport:off -- Deterministic tests of the private filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeRuntimeFilesystem } from "./runtimeFilesystem.ts";

const error = (code: string) => Object.assign(new Error(code), { code });
function fixture(platform: NodeJS.Platform = "win32") {
  let now = 0;
  const pause = vi.fn(async (ms: number) => {
    now += ms;
  });
  const rename = vi.fn<typeof NodeFSP.rename>().mockResolvedValue(undefined);
  const rm = vi.fn<typeof NodeFSP.rm>().mockResolvedValue(undefined);
  const lstat = vi.fn<typeof NodeFSP.lstat>().mockRejectedValue(error("ENOENT"));
  return {
    rename,
    rm,
    lstat,
    pause,
    fs: makeRuntimeFilesystem({ platform, now: () => now, sleep: pause, rename, rm, lstat }),
  };
}

describe("Windows runtime filesystem recovery", () => {
  it("does not delay successful operations", async () => {
    const f = fixture();
    await f.fs.rename("stage", "active");
    await f.fs.remove("stage");
    expect(f.pause).not.toHaveBeenCalled();
  });
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "retries a temporary %s move without replacing a destination",
    async (code) => {
      const f = fixture();
      f.rename.mockRejectedValueOnce(error(code)).mockRejectedValueOnce(error(code));
      await f.fs.rename("stage", "active");
      expect(f.rename).toHaveBeenCalledTimes(3);
      expect(f.lstat).toHaveBeenCalledTimes(2);
      expect(f.pause.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    },
  );
  it("fails with the original error after the bounded budget", async () => {
    const f = fixture();
    const locked = error("EPERM");
    f.rename.mockRejectedValue(locked);
    await expect(f.fs.rename("stage", "active")).rejects.toBe(locked);
    expect(f.pause.mock.calls.reduce((total, [ms]) => total + (ms ?? 0), 0)).toBe(15_000);
  });
  it("does not retry a permanent error or a non-Windows failure", async () => {
    for (const [platform, code] of [
      ["linux", "EPERM"],
      ["win32", "EXDEV"],
      ["win32", "ENOTEMPTY"],
    ] as const) {
      const f = fixture(platform);
      f.rename.mockRejectedValue(error(code));
      await expect(f.fs.rename("stage", "active")).rejects.toThrow(code);
      expect(f.pause).not.toHaveBeenCalled();
    }
  });
  it("does not overwrite a destination that appeared while waiting, including a symlink", async () => {
    const f = fixture();
    f.rename.mockRejectedValueOnce(error("EPERM"));
    f.lstat.mockResolvedValue({ isSymbolicLink: () => true } as Awaited<
      ReturnType<typeof NodeFSP.lstat>
    >);
    await expect(f.fs.rename("stage", "active")).rejects.toThrow("EPERM");
    expect(f.rename).toHaveBeenCalledTimes(1);
  });
  it("does not retry when destination inspection fails", async () => {
    const f = fixture();
    f.rename.mockRejectedValueOnce(error("EPERM"));
    f.lstat.mockRejectedValue(error("EACCES"));
    await expect(f.fs.rename("stage", "active")).rejects.toThrow("EPERM");
    expect(f.rename).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation before and during backoff", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.rename.mockRejectedValue(error("EPERM"));
    f.pause.mockImplementation(async () => {
      controller.abort();
    });
    await expect(
      f.fs.rename("stage", "active", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.rename).toHaveBeenCalledTimes(1);
    await expect(
      f.fs.rename("stage", "active", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.rename).toHaveBeenCalledTimes(1);
  });
  it.each(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"])(
    "retries %s cleanup independently of move rules",
    async (code) => {
      const f = fixture();
      f.rm.mockRejectedValueOnce(error(code));
      await f.fs.remove("stage");
      expect(f.rm).toHaveBeenCalledTimes(2);
      expect(f.lstat).not.toHaveBeenCalled();
    },
  );
});
