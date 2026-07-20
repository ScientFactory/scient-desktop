// FILE: ConnectionRecoveryNotifications.browser.tsx
// Purpose: Browser regressions for recovery-toast dismissal, visible timing, and copy errors.
// Layer: Browser UI test

import "../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ToastProvider, toastManager } from "./ui/toast";

function ToastHarness() {
  return <ToastProvider />;
}

async function mountToastHarness() {
  const host = document.createElement("div");
  document.body.append(host);
  const rootRoute = createRootRoute({ component: ToastHarness });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  const screen = await render(<RouterProvider router={router} />, { container: host });

  return async () => {
    toastManager.close();
    await screen.unmount();
    host.remove();
  };
}

describe("connection recovery toast integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("runs the manager close callback used by swipe and Escape dismissal", async () => {
    const cleanup = await mountToastHarness();
    const onClose = vi.fn();
    const toastId = toastManager.add({ onClose, title: "Reconnecting", timeout: 0 });

    toastManager.close(toastId);

    expect(onClose).toHaveBeenCalledOnce();
    await cleanup();
  });

  it("counts auto-dismiss time only while the window is visible and focused", async () => {
    const cleanup = await mountToastHarness();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    toastManager.add({
      title: "Reconnected",
      data: { allowCrossThreadVisibility: true, dismissAfterVisibleMs: 100 },
      timeout: 0,
    });

    await new Promise((resolve) => window.setTimeout(resolve, 200));
    expect(document.body.textContent).toContain("Reconnected");

    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new FocusEvent("focus"));
    await expect.poll(() => document.body.textContent).not.toContain("Reconnected");
    await cleanup();
  });

  it("shows a visible error when diagnostic copy fails", async () => {
    const cleanup = await mountToastHarness();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard denied"));
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    toastManager.add({
      title: "Scient is still reconnecting",
      data: {
        allowCrossThreadVisibility: true,
        copyLabel: "diagnostics",
        copyText: "Scient connection diagnostics",
      },
      timeout: 0,
    });

    await page.getByRole("button", { name: "Copy diagnostics" }).click();

    await expect.poll(() => document.body.textContent).toContain("Could not copy diagnostics");
    await cleanup();
  });
});
