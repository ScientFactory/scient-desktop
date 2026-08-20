// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the sidebar component with its width contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1200)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("uses a stored width in the initial render", () => {
    expect(resolveInitialThreadSidebarWidth(360, 1200)).toBe(360);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120, 1200)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("leaves enough room for the main content on a smaller window", () => {
    const viewportWidth = 1000;

    expect(resolveInitialThreadSidebarWidth(900, viewportWidth)).toBe(
      viewportWidth - THREAD_MAIN_CONTENT_MIN_WIDTH,
    );
  });

  it("keeps the sidebar minimum when the whole layout is narrower than its minimums", () => {
    expect(resolveInitialThreadSidebarWidth(900, 700)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("shows the desktop wordmark across the sidebar's full legal width range", () => {
    const sidebarSource = NodeFS.readFileSync(
      new URL("./sidebar/SidebarChrome.tsx", import.meta.url),
      "utf8",
    );
    const stylesheetSource = NodeFS.readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(sidebarSource).toContain(
      "sidebar-brand relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink items-center gap-1.5",
    );
    expect(stylesheetSource).toContain("@media (min-width: 48rem)");
    expect(stylesheetSource).toContain(".sidebar-brand {\n      display: flex;");
    expect(THREAD_SIDEBAR_MIN_WIDTH).toBe(13.5 * 16);
  });

  // Regression: the brand used to be shrink-0 at a 13rem minimum, so the
  // wordmark overflowed the sidebar's right edge at the narrowest width.
  it("leaves room for the header inset and the wordmark at the narrowest width", () => {
    // --workspace-titlebar-content-left on macOS: traffic lights (90px) plus
    // the sidebar toggle (1.75rem) plus the control gap (0.75rem).
    const headerContentLeft = 90 + 1.75 * 16 + 0.75 * 16;
    // Scient symbol (size-4) plus gap-1.5 plus the "Scient" wordmark.
    const brandWidth = 16 + 6 + 56;

    expect(THREAD_SIDEBAR_MIN_WIDTH).toBeGreaterThanOrEqual(headerContentLeft + brandWidth);
    // The estimate above lands exactly on the old 13rem minimum, so pin the
    // minimum strictly above the width that shipped the overflow.
    expect(THREAD_SIDEBAR_MIN_WIDTH).toBeGreaterThan(13 * 16);
  });

  it("keeps the brand shrinkable so it truncates instead of overflowing", () => {
    const sidebarSource = NodeFS.readFileSync(
      new URL("./sidebar/SidebarChrome.tsx", import.meta.url),
      "utf8",
    );

    expect(sidebarSource).not.toContain("w-fit min-w-0 shrink-0 items-center gap-1.5");
    expect(sidebarSource).toContain("truncate text-base font-semibold tracking-tight");
  });
});
