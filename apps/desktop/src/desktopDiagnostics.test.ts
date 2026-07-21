// FILE: desktopDiagnostics.test.ts
// Purpose: Verifies native log-folder opening and actionable OS errors.
// Layer: Desktop diagnostics tests

import { describe, expect, it, vi } from "vitest";

import { openDesktopLogsDirectory } from "./desktopDiagnostics";

describe("openDesktopLogsDirectory", () => {
  it("opens the exact Scient logs directory", async () => {
    const openPath = vi.fn(async () => "");
    await expect(openDesktopLogsDirectory("/tmp/scient/logs", openPath)).resolves.toBeUndefined();
    expect(openPath).toHaveBeenCalledWith("/tmp/scient/logs");
  });

  it("surfaces the native shell error", async () => {
    await expect(
      openDesktopLogsDirectory("/tmp/scient/logs", async () => "No application is registered"),
    ).rejects.toThrow("No application is registered");
  });
});
