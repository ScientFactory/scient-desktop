import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ openExternal: vi.fn(), openPath: vi.fn() }));
vi.mock("electron", () => ({ shell: mocks }));
import { openAccountStore } from "./openStore.ts";
it("opens only the fixed 1Password app target", async () => {
  mocks.openExternal.mockReset().mockResolvedValue(undefined);
  expect(await openAccountStore("onepassword://", "linux")).toBe(true);
  expect(mocks.openExternal).toHaveBeenCalledWith("onepassword://");
  expect(openAccountStore("onepassword://delete-item?i=synthetic", "darwin")).toBeUndefined();
  mocks.openExternal.mockRejectedValue(new Error("Synthetic missing app"));
  expect(await openAccountStore("onepassword://", "darwin")).toBe(false);
});
it("tries both fixed Keychain locations and Passwords, only on macOS", async () => {
  mocks.openPath
    .mockReset()
    .mockResolvedValueOnce("Missing")
    .mockResolvedValueOnce("Missing")
    .mockResolvedValueOnce("");
  expect(await openAccountStore("scient-accounts://keychain", "linux")).toBe(false);
  expect(mocks.openPath).not.toHaveBeenCalled();
  expect(await openAccountStore("scient-accounts://keychain", "darwin")).toBe(true);
  expect(mocks.openPath.mock.calls.map(([path]) => path)).toEqual([
    "/System/Library/CoreServices/Applications/Keychain Access.app",
    "/Applications/Utilities/Keychain Access.app",
    "/System/Applications/Passwords.app",
  ]);
  mocks.openPath.mockResolvedValue("Missing");
  expect(await openAccountStore("scient-accounts://keychain", "darwin")).toBe(false);
  expect(
    openAccountStore("scient-accounts://keychain?path=/tmp/other.app", "darwin"),
  ).toBeUndefined();
});
