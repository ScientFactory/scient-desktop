// FILE: WhatsNewSurface.browser.tsx
// Purpose: Verify the one-time sidebar release card, dialog, focus, and geometry.

import "../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WhatsNewProvider, useWhatsNewContext } from "../whatsNew/WhatsNewProvider";
import { WhatsNewSidebarCard } from "../whatsNew/WhatsNewSidebarCard";
import type { WhatsNewEntry } from "../whatsNew/logic";
import WhatsNewDialog from "./WhatsNewDialog";

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
    document.body.innerHTML = "";
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

    await page.getByRole("button", { name: "Read what improved in Scient v1.2.3" }).click();
    const dialog = page.getByRole("dialog", { name: /new in Scient/ });
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByText("Find your work faster", { exact: true })).toBeVisible();
    expect(document.activeElement?.textContent).toContain("new in Scient");

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(document.activeElement?.textContent).toBe("Activity");
  });

  it("keeps the card inline above Activity and Settings at minimum width [geometry:linux]", async () => {
    seedUpgrade();
    await page.viewport(208, 360);
    await render(<Harness />);
    const card = page.getByTestId("whats-new-sidebar-card").element();
    const activity = page.getByRole("button", { name: "Activity" }).element();
    const settings = page.getByRole("button", { name: "Settings" }).element();
    const footer = page.getByTestId("sidebar-footer").element();
    const [cardRect, activityRect, settingsRect, footerRect] = [
      card.getBoundingClientRect(),
      activity.getBoundingClientRect(),
      settings.getBoundingClientRect(),
      footer.getBoundingClientRect(),
    ];

    expect(cardRect.bottom).toBeLessThanOrEqual(activityRect.top);
    expect(activityRect.bottom).toBeLessThanOrEqual(settingsRect.top);
    expect(cardRect.left).toBeGreaterThanOrEqual(footerRect.left);
    expect(cardRect.right).toBeLessThanOrEqual(footerRect.right);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});
