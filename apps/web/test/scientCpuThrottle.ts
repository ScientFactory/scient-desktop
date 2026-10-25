// Local "CI-like" slowness for browser tests.
//
// GitHub's ubuntu-24.04 runners execute layout-heavy browser tests several times slower
// than a developer Mac (LaTeX template tests: 3-7x; most small files: about 1x). Timing
// races that never show locally fail there. Set SCIENT_TEST_CPU_THROTTLE=<rate> (for
// example 4) to have Chromium slow every test page's renderer main thread by that factor
// through the DevTools Emulation.setCPUThrottlingRate call — the same control as the
// DevTools Performance panel's "CPU throttling". Unset, 0 or 1 leaves pages untouched.
//
// Only the page under test is slowed. Vite's transforms, the Vitest main process and
// Playwright still run at full speed, so this reproduces in-page timing races, not
// shard wall time.

import { defineBrowserCommand } from "vite-plus/test/browser-playwright";

function readCpuThrottleRate(value = process.env.SCIENT_TEST_CPU_THROTTLE): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 1 ? rate : 1;
}

// Emulation overrides belong to the DevTools session that set them and end when it
// detaches, so each page keeps its session for as long as the page lives.
const throttledPages = new WeakMap<object, Promise<number>>();

/** Applies the configured throttle once per page; returns the active rate. */
export const applyCpuThrottle = defineBrowserCommand<[]>(async ({ page }) => {
  const rate = readCpuThrottleRate();
  if (rate === 1) return 1;
  let pending = throttledPages.get(page);
  if (!pending) {
    pending = page
      .context()
      .newCDPSession(page)
      .then(async (session) => {
        await session.send("Emulation.setCPUThrottlingRate", { rate });
        return rate;
      });
    throttledPages.set(page, pending);
    pending.catch(() => throttledPages.delete(page));
  }
  return pending;
});
