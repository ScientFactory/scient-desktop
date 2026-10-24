import { beforeAll, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in test/scientCpuThrottle.ts. Applies SCIENT_TEST_CPU_THROTTLE to this page. */
    applyCpuThrottle: () => Promise<number>;
  }
}

// A no-op unless SCIENT_TEST_CPU_THROTTLE is set. Runs before every test file because a
// file may land on a page the pool opened after the previous file finished.
beforeAll(async () => {
  await commands.applyCpuThrottle();
});

// vi.waitFor gives up after 1 s unless a call says otherwise, and has no config option.
// GitHub's runners do layout-heavy work 4-7x slower than a developer Mac, so a wait that
// needs 0.3 s locally can need 2 s there. Calls that name their own timeout keep it;
// expect.poll gets the same default from vite.config.ts (test.expect.poll.timeout).
const BROWSER_WAIT_TIMEOUT_MS = 5_000;

const waitForWithFixedDefault = vi.waitFor;
vi.waitFor = ((callback, options) =>
  waitForWithFixedDefault(
    callback,
    typeof options === "number" || options?.timeout !== undefined
      ? options
      : { ...options, timeout: BROWSER_WAIT_TIMEOUT_MS },
  )) as typeof vi.waitFor;
