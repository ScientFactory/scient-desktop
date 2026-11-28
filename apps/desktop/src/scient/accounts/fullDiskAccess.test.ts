import { expect, it } from "vite-plus/test";
import { appBundleOf, FULL_DISK_ACCESS_URL } from "./fullDiskAccess.ts";

it("finds the app bundle to drag into Full Disk Access, from any process inside it", () => {
  expect(appBundleOf("/Applications/Scient.app/Contents/MacOS/Scient")).toBe(
    "/Applications/Scient.app",
  );
  // The server runs as a helper inside the app: the outer app is the one macOS lists.
  expect(
    appBundleOf(
      "/Applications/Scient.app/Contents/Frameworks/Scient Helper.app/Contents/MacOS/Scient Helper",
    ),
  ).toBe("/Applications/Scient.app");
  expect(appBundleOf("/usr/local/bin/node")).toBeUndefined();
  expect(FULL_DISK_ACCESS_URL).toBe(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  );
});
