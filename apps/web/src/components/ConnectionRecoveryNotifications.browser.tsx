// FILE: ConnectionRecoveryNotifications.browser.tsx
// Purpose: Browser integration coverage for connection-recovery notices and toast behavior.
// Layer: Browser UI test

import "../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type { DesktopBridge } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { emitWsTransportState } from "../wsTransportEvents";
import { ConnectionRecoveryNotifications } from "./ConnectionRecoveryNotifications";
import { ToastProvider, toastManager } from "./ui/toast";

let activeHarnessCleanup: (() => Promise<void>) | null = null;

function RecoveryHarness() {
  return (
    <ToastProvider>
      <button type="button">Focus before notifications</button>
      <ConnectionRecoveryNotifications />
    </ToastProvider>
  );
}

async function mountRecoveryHarness() {
  const host = document.createElement("div");
  document.body.append(host);
  const rootRoute = createRootRoute({ component: RecoveryHarness });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  const screen = await render(<RouterProvider router={router} />, { container: host });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    toastManager.close();
    host.remove();
    if (activeHarnessCleanup === cleanup) activeHarnessCleanup = null;
  };
  activeHarnessCleanup = cleanup;
  return cleanup;
}

describe("connection recovery toast integration", () => {
  beforeEach(() => {
    emitWsTransportState("open");
  });

  afterEach(async () => {
    emitWsTransportState("open");
    await activeHarnessCleanup?.();
    Reflect.deleteProperty(window, "desktopBridge");
    vi.restoreAllMocks();
    toastManager.close();
    document.body.innerHTML = "";
  });

  it("shows the real delayed recovery flow with accessible keyboard actions", async () => {
    const openLogsDirectory = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        diagnostics: { openLogsDirectory },
      } as unknown as DesktopBridge,
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const cleanup = await mountRecoveryHarness();

    await page.getByRole("button", { name: "Focus before notifications" }).click();
    emitWsTransportState("reconnecting");

    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(document.body.textContent).not.toContain("Reconnecting…");

    await expect
      .poll(() => document.body.textContent, { timeout: 3_000 })
      .toContain("Reconnecting…");
    expect(document.body.textContent).toContain(
      "Scient is restoring its local connection. Open chats remain on this computer.",
    );
    expect(document.body.textContent).not.toContain("Copy diagnostics");

    const notificationRegion = document.querySelector(
      '[role="region"][aria-label="Notifications"]',
    );
    expect(notificationRegion?.getAttribute("aria-live")).toBe("polite");
    expect(notificationRegion?.getAttribute("aria-relevant")).toContain("text");

    await expect
      .poll(() => document.body.textContent, { timeout: 11_000 })
      .toContain("Scient is still reconnecting");
    await expect
      .poll(() => document.body.textContent)
      .toContain("Copy the connection summary or open the logs for details.");

    const detailsDialog = page.getByRole("dialog", { name: "Scient is still reconnecting" });
    await expect.element(detailsDialog).toBeVisible();

    await page.getByRole("button", { name: "Focus before notifications" }).click();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Copy diagnostics");
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => writeText.mock.calls.length).toBe(1);
    const copiedDiagnostics = writeText.mock.calls[0]?.[0] ?? "";
    expect(copiedDiagnostics).toContain("Scient connection diagnostics");
    expect(copiedDiagnostics).toContain("Transport state: reconnecting");
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("Copied diagnostics");

    await userEvent.keyboard("{Tab}");
    expect(document.activeElement?.textContent).toContain("Open logs");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => openLogsDirectory.mock.calls.length).toBe(1);

    emitWsTransportState("open");
    await expect.poll(() => document.body.textContent).toContain("Reconnected");
    expect(notificationRegion?.textContent).toContain(
      "Scient is connected to its local service again.",
    );

    await cleanup();
  }, 20_000);

  it("runs the manager close callback used by swipe and Escape dismissal", async () => {
    const cleanup = await mountRecoveryHarness();
    const onClose = vi.fn();
    const toastId = toastManager.add({ onClose, title: "Reconnecting", timeout: 0 });

    toastManager.close(toastId);

    expect(onClose).toHaveBeenCalledOnce();
    await cleanup();
  });

  it("counts auto-dismiss time only while the window is visible and focused", async () => {
    const cleanup = await mountRecoveryHarness();
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
    const cleanup = await mountRecoveryHarness();
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
