import "../../index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

import { SCIENT_RELEASE_NOTES } from "./catalog";
import { ScientReleaseNotes } from "./ScientReleaseNotes";

// Exercise the real dialog with synthetic upgrade state, without a live profile.
vi.mock("./useScientReleaseNotes", async () => {
  const { useState } = await import("react");
  const { SCIENT_RELEASE_NOTES: notes } = await import("./catalog");
  return {
    useScientReleaseNotes: () => {
      const [open, setOpen] = useState(false);
      return {
        current: notes[0],
        history: notes,
        isCardVisible: true,
        isDialogOpen: open,
        openDialog: () => setOpen(true),
        dismissCard: () => {},
        setDialogOpen: setOpen,
      };
    },
  };
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  document.documentElement.classList.remove("dark");
  root = undefined;
  host = undefined;
});

it.each(["light", "dark"])(
  "keeps the extended note readable and navigable in %s mode",
  async (theme) => {
    await page.viewport(390, 700);
    document.documentElement.classList.toggle("dark", theme === "dark");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(<ScientReleaseNotes />);

    await page.getByRole("button", { name: "Read what is new in Scient version 0.6.22" }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect
      .poll(() => {
        const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
        return popup ? getComputedStyle(popup).opacity : null;
      })
      .toBe("1");
    await expect.poll(() => document.querySelectorAll('[role="dialog"] ol li').length).toBe(9);
    if (import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS) {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS}/extended-${theme}.png`,
      });
    }
    const rows = document.querySelectorAll('[role="dialog"] ol li');
    expect([...rows].map((row) => row.querySelector("p")?.textContent)).toEqual(
      SCIENT_RELEASE_NOTES[0].highlights.map(({ title }) => title),
    );
    expect([...rows[0]!.querySelectorAll("p")].slice(1).map((p) => p.textContent)).toEqual(
      SCIENT_RELEASE_NOTES[0].highlights[0].description.split("\n\n"),
    );
    const viewport = document.querySelector<HTMLElement>(
      '[role="dialog"] [data-slot="scroll-area-viewport"]',
    )!;
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    viewport.scrollTop = viewport.scrollHeight;
    await expect.poll(() => viewport.scrollTop).toBeGreaterThan(0);
    await expect.element(dialog.getByText(SCIENT_RELEASE_NOTES[0].alsoIncluded)).toBeVisible();
    const footer = document.querySelector<HTMLElement>(
      '[role="dialog"] [data-slot="dialog-footer"]',
    )!;
    const bounds = footer.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);

    await dialog.getByRole("button", { name: "Release history", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Read release notes for Scient 0.6.21", exact: true })
      .click();
    await expect.element(dialog.getByText("Chat without a project", { exact: true })).toBeVisible();
    if (import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS) {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS}/previous-${theme}.png`,
      });
    }
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
  },
);
