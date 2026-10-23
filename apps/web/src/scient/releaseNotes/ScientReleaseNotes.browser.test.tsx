import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
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

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  document.documentElement.classList.remove("dark");
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

it.each(["light", "dark"])(
  "keeps the extended note readable and navigable in %s mode",
  async (theme) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    await page.viewport(390, 700);
    document.documentElement.classList.toggle("dark", theme === "dark");
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    await _fixture.root0.rerender(<ScientReleaseNotes />);

    await page
      .getByRole("button", {
        name: `Read what is new in Scient version ${SCIENT_RELEASE_NOTES[0].version}`,
      })
      .click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.poll(() => document.activeElement?.textContent).toBe("What’s new in Scient");
    await expect
      .poll(() => {
        const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
        return popup ? getComputedStyle(popup).opacity : null;
      })
      .toBe("1");
    await expect
      .poll(() => document.querySelectorAll('[role="dialog"] ol li').length)
      .toBe(SCIENT_RELEASE_NOTES[0].highlights.length);
    if (import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS) {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS}/extended-${theme}.png`,
      });
    }
    const rows = document.querySelectorAll('[role="dialog"] ol li');
    expect([...rows].map((row) => row.querySelector("p")?.textContent)).toEqual(
      SCIENT_RELEASE_NOTES[0].highlights.map(({ title }) => title),
    );
    for (const [index, row] of rows.entries()) {
      expect([...row.querySelectorAll("p")].slice(1).map((p) => p.textContent)).toEqual(
        SCIENT_RELEASE_NOTES[0].highlights[index]!.description.split("\n\n"),
      );
    }
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
      .getByRole("button", { name: "Read release notes for Scient 0.6.23", exact: true })
      .click();
    await expect.poll(() => document.querySelectorAll('[role="dialog"] ol li').length).toBe(9);
    await expect.element(dialog.getByText("Version 0.6.23 · October 2026")).toBeVisible();
    if (import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS) {
      await page.screenshot({
        path: `${import.meta.env.VITE_SCIENT_RELEASE_SCREENSHOTS}/previous-extended-${theme}.png`,
      });
    }
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

it("hides the release card in a collapsed sidebar and restores it when expanded", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  _fixture.host = document.createElement("div");
  _fixture.host.className = "group";
  _fixture.host.dataset.collapsible = "icon";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<ScientReleaseNotes />);

  const card = page.getByRole("button", {
    name: `Read what is new in Scient version ${SCIENT_RELEASE_NOTES[0].version}`,
    includeHidden: true,
  });
  await expect.element(card).not.toBeVisible();
  delete _fixture.host.dataset.collapsible;
  await expect.element(card).toBeVisible();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
