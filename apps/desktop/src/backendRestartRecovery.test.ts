import { describe, expect, it } from "vitest";

import {
  buildBackendRestartRecoveryDialog,
  resolveBackendRestartRecoveryAction,
} from "./backendRestartRecovery";

describe("backend restart recovery", () => {
  it("offers retry and logs while keeping cancellation non-destructive", () => {
    const options = buildBackendRestartRecoveryDialog({
      appName: "Scient",
      failures: 5,
      windowMs: 60_000,
      logFilePath: "/tmp/scient/server-child.log",
    });

    expect(options.buttons).toEqual(["Try again", "Open logs", "Keep Scient open"]);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(2);
    expect(options.detail).toContain("5 failures in 60 seconds");
    expect(options.detail).toContain("/tmp/scient/server-child.log");
  });

  it("maps only explicit actionable buttons to native effects", () => {
    expect(resolveBackendRestartRecoveryAction(0)).toBe("retry");
    expect(resolveBackendRestartRecoveryAction(1)).toBe("open-logs");
    expect(resolveBackendRestartRecoveryAction(2)).toBe("dismiss");
    expect(resolveBackendRestartRecoveryAction(-1)).toBe("dismiss");
  });
});
