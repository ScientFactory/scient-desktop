import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const runnerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/run-browser-overlay-lifecycle.mjs",
);

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await delay(10);
  }
}

it.skipIf(process.platform === "win32")(
  "cleans temporary state when interrupted during earliest setup",
  async () => {
    const probeRoot = mkdtempSync(join(tmpdir(), "scient-browser-overlay-signal-test-"));
    const markerPath = join(probeRoot, "ready");
    const child = spawn(process.execPath, [runnerPath], {
      env: {
        ...process.env,
        SCIENT_BROWSER_OVERLAY_TEST_SETUP_SIGNAL_PROBE: markerPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitForFile(markerPath, 5_000);
      const harnessTempDir = readFileSync(markerPath, "utf8");
      const exit = once(child, "exit");
      expect(child.kill("SIGTERM")).toBe(true);
      const [code, signal] = await exit;

      // Bun reports a handled SIGTERM as the terminating signal while Node
      // reports the explicit 143 exit code used by the same handler.
      expect(code === 143 || signal === "SIGTERM").toBe(true);
      expect(stderr).toContain("interrupted by SIGTERM");
      expect(existsSync(harnessTempDir)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(probeRoot, { recursive: true, force: true });
    }
  },
  10_000,
);
