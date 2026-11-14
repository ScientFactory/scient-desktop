import { describe, expect, it } from "@effect/vitest";

import { windowsPrivateRefusal } from "./OverleafRetentionVault.ts";

const helperFailure = (codeDomain: string, code: number) =>
  Object.assign(new Error("Native private retention provisioning refused."), {
    result: { codeDomain, code },
  });

describe("a Windows retention folder's failed check", () => {
  it.each([
    ["a write-protected disk", helperFailure("win32", 19), "read-only-parent"],
    ["a denied folder", helperFailure("win32", 5), "read-only-parent"],
    ["a disk that is not NTFS", helperFailure("win32", 0x20000006), "unsupported-filesystem"],
    ["a folder another user can open", new Error("unsafe-directory"), "unsafe-directory"],
    ["a cloud-managed folder", new Error("sync-managed-folder"), "sync-managed-folder"],
  ])("refuses %s as macOS and Linux do", (_case, error, reason) => {
    expect(windowsPrivateRefusal(error)?.reason).toBe(reason);
  });

  it("leaves a missing folder and any other failure to its caller", () => {
    const missing = Object.assign(new Error("unsafe-directory"), { code: "ENOENT" });
    expect(windowsPrivateRefusal(missing)).toBeNull();
    expect(windowsPrivateRefusal(helperFailure("win32", 87))).toBeNull();
    expect(windowsPrivateRefusal(new Error("helper crashed"))).toBeNull();
  });
});
