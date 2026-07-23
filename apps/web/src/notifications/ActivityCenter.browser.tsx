// FILE: ActivityCenter.browser.tsx
// Purpose: Verifies the lower-left Activity entry, grouped panel, and review controls.
// Layer: Browser UI test

import "../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarProvider } from "../components/ui/sidebar";
import { ActivityCenter } from "./ActivityCenter";
import { activityManager, useActivityStore } from "./activityStore";

let activeCleanup: (() => Promise<void>) | null = null;

function ActivityHarness() {
  return (
    <SidebarProvider>
      <div className="w-72 p-3">
        <ActivityCenter />
      </div>
    </SidebarProvider>
  );
}

async function mountHarness() {
  const host = document.createElement("div");
  document.body.append(host);
  const rootRoute = createRootRoute({ component: ActivityHarness });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  const screen = await render(<RouterProvider router={router} />, { container: host });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await screen.unmount();
    host.remove();
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
}

describe("Activity Center", () => {
  beforeEach(() => useActivityStore.getState().reset());

  afterEach(async () => {
    await activeCleanup?.();
    useActivityStore.getState().reset();
    document.body.innerHTML = "";
  });

  it("groups important work and lets the user review the full retained list", async () => {
    activityManager.publish({
      dedupeKey: "provider:update",
      source: "provider",
      status: "needs_attention",
      tone: "warning",
      title: "Codex update available",
    });
    activityManager.publish({
      dedupeKey: "maintenance:running",
      source: "maintenance",
      status: "in_progress",
      tone: "info",
      title: "Checking old chats",
    });
    for (let index = 0; index < 13; index += 1) {
      activityManager.publish({
        dedupeKey: `thread:${index}:complete`,
        source: "thread",
        status: "recent",
        tone: "success",
        title: `Task ${index + 1} finished`,
      });
    }

    await mountHarness();
    await page.getByRole("button", { name: /Activity, 1 needs attention/ }).click();

    await expect.element(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
    await expect
      .element(page.getByText("Background work and items that need you", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Needs attention", { exact: true })).toBeVisible();
    await expect.element(page.getByText("In progress", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Recent", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Codex update available", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Checking old chats", { exact: true })).toBeVisible();
    expect(page.getByText("Task 1 finished", { exact: true }).elements()).toHaveLength(0);

    await page.getByRole("button", { name: "View all activity" }).click();
    await expect.element(page.getByText("Task 1 finished", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Mark all read" }).click();
    expect(useActivityStore.getState().items.every((item) => item.readAt)).toBe(true);
  });

  it("shows a clear empty state", async () => {
    await mountHarness();
    await page.getByRole("button", { name: /Activity, All caught up/ }).click();

    const dialog = page.getByRole("dialog", { name: "Activity" });
    await expect.element(dialog.getByText("All caught up", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Background activity will appear here.", { exact: true }))
      .toBeVisible();
  });

  it("keeps connection diagnostics actionable inside Activity", async () => {
    activityManager.publish({
      dedupeKey: "system:local-service-connection",
      source: "system",
      status: "needs_attention",
      tone: "warning",
      title: "Scient is still reconnecting",
      destination: {
        type: "connection_diagnostics",
        stateStartedAt: "2026-07-23T12:00:00.000Z",
      },
    });

    await mountHarness();
    await page.getByRole("button", { name: /Activity, 1 needs attention/ }).click();

    await expect.element(page.getByRole("button", { name: "Copy summary" })).toBeVisible();
  });
});
