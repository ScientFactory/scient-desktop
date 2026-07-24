// FILE: WhatsNewSurface.browser.tsx
// Purpose: Verify the one-time sidebar release card, dialog, focus, and geometry.

import "../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WhatsNewProvider, useWhatsNewContext } from "../whatsNew/WhatsNewProvider";
import { WhatsNewSidebarCard } from "../whatsNew/WhatsNewSidebarCard";
import type { WhatsNewEntry } from "../whatsNew/logic";
import WhatsNewDialog from "./WhatsNewDialog";
import { SidebarFooterControls } from "./SidebarFooterControls";
import { Sidebar, SidebarMenuButton, SidebarProvider, SidebarTrigger } from "./ui/sidebar";

const STORAGE_KEY = "scient:whats-new:v1";
const RELEASE: WhatsNewEntry = {
  version: "1.2.3",
  date: "July 24, 2026",
  headline: "A calmer, clearer way to keep work moving",
  features: [
    {
      id: "clearer-workspace",
      title: "Find your work faster",
      description: "Scient now keeps the things you need easier to reach.",
    },
    {
      id: "calmer-updates",
      title: "Understand each update",
      description: "See a short, friendly summary of what became better for you.",
    },
    {
      id: "quieter-notices",
      title: "Stay in control",
      description: "The note appears once and waits for you to choose when to read it.",
    },
  ],
};

function DialogSurface() {
  const state = useWhatsNewContext();
  if (!state.currentEntry) return null;
  return (
    <WhatsNewDialog
      open={state.isDialogOpen}
      onOpenChange={state.onDialogOpenChange}
      currentEntry={state.currentEntry}
      allEntries={state.allEntries}
      currentVersion={state.currentVersion}
      dialogHandle={state.dialogHandle}
    />
  );
}

function Harness({ offscreen = false }: { readonly offscreen?: boolean }) {
  return (
    <WhatsNewProvider entries={[RELEASE]} currentVersion={RELEASE.version}>
      <div
        data-testid="sidebar-footer"
        className="flex w-64 flex-col gap-1 p-2"
        style={offscreen ? { transform: "translateX(-500px)" } : undefined}
      >
        <WhatsNewSidebarCard />
        <button type="button" data-activity-center-trigger>
          Activity
        </button>
        <button type="button">Settings</button>
      </div>
      <DialogSurface />
    </WhatsNewProvider>
  );
}

function IntegratedFooter() {
  return (
    <SidebarFooterControls
      settingsAndUpdate={
        <div className="flex items-center gap-2">
          <SidebarMenuButton size="sm" className="flex-1">
            Settings
          </SidebarMenuButton>
          <button type="button" aria-label="Install update" className="size-7">
            Update
          </button>
        </div>
      }
    />
  );
}

function IntegratedSidebarSurface({ mobile }: { readonly mobile: boolean }) {
  return (
    <WhatsNewProvider entries={[RELEASE]} currentVersion={RELEASE.version}>
      <SidebarProvider style={{ "--sidebar-width": "208px" } as React.CSSProperties}>
        {mobile ? <SidebarTrigger /> : null}
        <Sidebar collapsible={mobile ? "offcanvas" : "none"}>
          <div className="min-h-0 flex-1" />
          <IntegratedFooter />
        </Sidebar>
      </SidebarProvider>
      <DialogSurface />
    </WhatsNewProvider>
  );
}

async function renderIntegratedSidebar(mobile: boolean) {
  const rootRoute = createRootRoute({
    component: () => <IntegratedSidebarSurface mobile={mobile} />,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  return render(<RouterProvider router={router} />);
}

async function emulateReducedMotion(value: "reduce" | "no-preference") {
  const session = cdp() as unknown as {
    send(method: string, params: unknown): Promise<unknown>;
  };
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });
}

function seedUpgrade() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ lastSeenVersion: "1.2.2" }));
}

describe("Scient release-note surface", () => {
  beforeEach(async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    localStorage.clear();
    await page.viewport(900, 700);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows only after an upgrade, persists genuine presentation, and suppresses a remount", async () => {
    seedUpgrade();
    const screen = await render(<Harness />);

    await expect.element(page.getByTestId("whats-new-sidebar-card")).toBeVisible();
    await expect
      .poll(() => localStorage.getItem(STORAGE_KEY))
      .toContain('"lastPresentedVersion":"1.2.3"');

    await screen.unmount();
    await render(<Harness />);
    expect(page.getByTestId("whats-new-sidebar-card").elements()).toHaveLength(0);
  });

  it("does not consume presentation while offscreen", async () => {
    seedUpgrade();
    const screen = await render(<Harness offscreen />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain("lastPresentedVersion");

    await screen.rerender(<Harness />);
    await expect.element(page.getByTestId("whats-new-sidebar-card")).toBeVisible();
    await expect
      .poll(() => localStorage.getItem(STORAGE_KEY))
      .toContain('"lastPresentedVersion":"1.2.3"');
  });

  it("opens the full note without auto-opening and returns focus to Activity", async () => {
    seedUpgrade();
    await render(<Harness />);
    expect(page.getByRole("dialog").elements()).toHaveLength(0);

    await page.getByRole("button", { name: /Read what improved in Scient v1.2.3/ }).click();
    const dialog = page.getByRole("dialog", { name: /new in Scient/ });
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByText("Find your work faster", { exact: true })).toBeVisible();
    expect(document.activeElement?.textContent).toContain("new in Scient");

    await page.getByRole("button", { name: "Release history" }).click();
    await expect.poll(() => document.activeElement?.textContent).toContain("Release history");
    await page.getByRole("button", { name: "Back to What's new" }).click();
    await expect.poll(() => document.activeElement?.textContent).toContain("new in Scient");

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(document.activeElement?.textContent).toBe("Activity");
  });

  it("honors reduced motion for the release-note dialog", async () => {
    await emulateReducedMotion("reduce");
    try {
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      seedUpgrade();
      await render(<Harness />);
      await page.getByRole("button", { name: /Read what improved in Scient v1.2.3/ }).click();
      const popup = document.querySelector<HTMLElement>("[data-slot=dialog-popup]");
      const backdrop = document.querySelector<HTMLElement>("[data-slot=dialog-backdrop]");
      expect(popup).not.toBeNull();
      expect(backdrop).not.toBeNull();
      expect(getComputedStyle(popup!).transitionDuration).toBe("0s");
      expect(getComputedStyle(backdrop!).transitionDuration).toBe("0s");
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await emulateReducedMotion("no-preference");
    }
  });

  it("opens and dismisses the note coherently inside the real mobile sidebar", async () => {
    seedUpgrade();
    await page.viewport(390, 844);
    const screen = await renderIntegratedSidebar(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain("lastPresentedVersion");

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect.element(page.getByTestId("whats-new-sidebar-card")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Activity/ })).toBeVisible();
    await expect
      .poll(() => localStorage.getItem(STORAGE_KEY))
      .toContain('"lastPresentedVersion":"1.2.3"');

    await page.getByRole("button", { name: /Read what improved in Scient v1.2.3/ }).click();
    const dialog = page.getByRole("dialog", { name: /new in Scient/ });
    await expect.element(dialog).toBeVisible();
    expect(document.activeElement?.textContent).toContain("new in Scient");
    const dialogPopup = document.querySelector<HTMLElement>("[data-slot=dialog-popup]")!;
    await expect
      .poll(() => dialogPopup.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(innerHeight);
    const dialogRect = dialogPopup.getBoundingClientRect();
    expect(
      dialogPopup.contains(
        document.elementFromPoint(dialogRect.left + dialogRect.width / 2, dialogRect.top + 24),
      ),
    ).toBe(true);

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(document.activeElement?.textContent).toContain("Activity");

    await screen.unmount();
    localStorage.clear();
    seedUpgrade();
    await renderIntegratedSidebar(true);
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("button", { name: /Read what improved in Scient v1.2.3/ }).click();
    await page.getByRole("button", { name: "Done" }).click();
    await expect
      .element(page.getByRole("dialog", { name: /new in Scient/ }))
      .not.toBeInTheDocument();
    expect(document.activeElement?.textContent).toContain("Activity");
  });

  it("keeps the card inline in the real 208px sidebar footer [geometry:linux]", async () => {
    seedUpgrade();
    await page.viewport(900, 360);
    await renderIntegratedSidebar(false);
    const card = page.getByTestId("whats-new-sidebar-card").element();
    const activity = page.getByRole("button", { name: /Activity/ }).element();
    const settings = page.getByRole("button", { name: "Settings" }).element();
    const update = page.getByRole("button", { name: "Install update" }).element();
    const footer = document.querySelector<HTMLElement>("[data-slot=sidebar-footer]")!;
    const [cardRect, activityRect, settingsRect, updateRect, footerRect] = [
      card.getBoundingClientRect(),
      activity.getBoundingClientRect(),
      settings.getBoundingClientRect(),
      update.getBoundingClientRect(),
      footer.getBoundingClientRect(),
    ];

    expect(footerRect.width).toBe(208);
    expect(cardRect.bottom).toBeLessThanOrEqual(activityRect.top);
    expect(activityRect.bottom).toBeLessThanOrEqual(settingsRect.top);
    expect(settingsRect.top).toBe(updateRect.top);
    expect(settingsRect.bottom).toBe(updateRect.bottom);
    expect(cardRect.left).toBeGreaterThanOrEqual(footerRect.left);
    expect(cardRect.right).toBeLessThanOrEqual(footerRect.right);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  });

  it("keeps a standard release dialog usable in a short-height viewport [geometry:linux]", async () => {
    seedUpgrade();
    await page.viewport(900, 360);
    await renderIntegratedSidebar(false);
    await page.getByRole("button", { name: /Read what improved in Scient v1.2.3/ }).click();

    const dialog = page.getByRole("dialog", { name: /new in Scient/ });
    await expect.element(dialog).toBeVisible();
    const popup = document.querySelector<HTMLElement>("[data-slot=dialog-popup]")!;
    const header = popup.querySelector<HTMLElement>("[data-slot=dialog-header]")!;
    const footer = popup.querySelector<HTMLElement>("[data-slot=dialog-footer]")!;
    const viewport = popup.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    const [popupRect, headerRect, footerRect] = [
      popup.getBoundingClientRect(),
      header.getBoundingClientRect(),
      footer.getBoundingClientRect(),
    ];

    expect(popupRect.top).toBeGreaterThanOrEqual(0);
    expect(popupRect.bottom).toBeLessThanOrEqual(innerHeight);
    expect(headerRect.top).toBeGreaterThanOrEqual(popupRect.top);
    expect(footerRect.bottom).toBeLessThanOrEqual(popupRect.bottom);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    viewport.scrollTop = viewport.scrollHeight;
    await expect.poll(() => viewport.scrollTop).toBeGreaterThan(0);
    await expect.element(page.getByRole("button", { name: "Done" })).toBeVisible();
  });
});
