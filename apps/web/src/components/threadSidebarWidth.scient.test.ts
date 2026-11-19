import { describe, expect, it } from "vite-plus/test";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
} from "./threadSidebarWidth";

// The minimum is the brand-less minimum width.
const THREAD_SIDEBAR_MIN_WIDTH = resolveThreadSidebarMinimumWidth(0);

// The viewport bounds the width as it renders, not when it is read at startup.
const renderedWidth = (storedWidth: number, viewportWidth: number) =>
  clampThreadSidebarWidth(
    resolveInitialThreadSidebarWidth(storedWidth),
    THREAD_SIDEBAR_MIN_WIDTH,
    resolveThreadSidebarMaximumWidth(viewportWidth, THREAD_SIDEBAR_MIN_WIDTH),
  );

// regression: 2c199aacac fix(desktop): preserve main window bounds (#3851)
describe("thread sidebar width", () => {
  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("leaves enough room for the main content on a smaller window", () => {
    const viewportWidth = 1000;

    expect(renderedWidth(900, viewportWidth)).toBe(viewportWidth - THREAD_MAIN_CONTENT_MIN_WIDTH);
  });
});
