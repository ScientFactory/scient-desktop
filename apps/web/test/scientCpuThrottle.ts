// CI layout can be several times slower than a developer Mac. SCIENT_TEST_CPU_THROTTLE slows only
// the tested renderer through DevTools; transforms, Vitest, and Playwright stay unthrottled, so
// this probes page races rather than shard duration.

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
