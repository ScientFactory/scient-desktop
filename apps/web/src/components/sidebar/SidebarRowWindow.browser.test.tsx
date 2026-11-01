import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { createPortal } from "react-dom";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { SidebarRowWindow } from "./SidebarRowWindow";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  document.documentElement.style.fontSize = "";
}

function Body({ index, retain }: { index: number; retain: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  function toggle(value: boolean) {
    retain(value);
    setOpen(value);
  }
  return (
    <div className="h-[5.125rem]" data-full-row>
      <button data-sidebar-row-trigger>Full thread {index}</button>
      <button onClick={() => toggle(true)} aria-label={`Menu ${index}`}>
        Menu
      </button>
      {open
        ? createPortal(
            <button onClick={() => toggle(false)}>Close menu {index}</button>,
            document.body,
          )
        : null}
    </div>
  );
}

async function mount(_fixture: _Fixture, { count = 1560, active = -1, fontSize = 16 } = {}) {
  document.documentElement.style.fontSize = `${fontSize}px`;
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <>
      <button>Outside list</button>
      <div data-slot="scroll-area-viewport" style={{ height: 360, width: 320, overflow: "auto" }}>
        <ul>
          {Array.from({ length: count }, (_, index) => (
            <SidebarRowWindow
              key={index}
              data-row-index={index}
              className="min-h-[5.125rem] list-none"
              alwaysRender={index === active}
              placeholder={
                <button className="h-[5.125rem]" aria-label={`Thread ${index}`}>
                  Thread {index}
                </button>
              }
            >
              {(retain) => <Body index={index} retain={retain} />}
            </SidebarRowWindow>
          ))}
        </ul>
      </div>
    </>,
  );
  await expect
    .poll(() => _fixture.host!.querySelectorAll("[data-full-row]").length)
    .toBeGreaterThan(0);
  return {
    viewport: _fixture.host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!,
    row: (index: number) =>
      _fixture.host!.querySelector<HTMLElement>(`[data-row-index="${index}"]`)!,
    mounted: () => _fixture.host!.querySelectorAll("[data-full-row]").length,
  };
}

// One enlarged font covers both bounding and rem-scaled row geometry.
it.each([20])(
  "bounds bodies in a 1560-row list and preserves scaled geometry at %ipx",
  async (fontSize) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const fixture = await mount(_fixture, { active: 1559, fontSize });
    expect(_fixture.host!.querySelectorAll("li")).toHaveLength(1560);
    await expect.poll(fixture.mounted).toBeLessThan(12);
    expect(fixture.row(1559).dataset.sidebarRowBody).toBe("mounted");
    const height = fixture.row(800).getBoundingClientRect().height;
    expect(height).toBeCloseTo(5.125 * fontSize);
    const totalHeight = fixture.viewport.scrollHeight;
    // A pointer left over the first rows by an earlier test would keep row 0
    // mounted; and a loaded CI runner can take more than a second to deliver
    // the scroll's visibility changes for a 1560-row list.
    await userEvent.hover(page.getByRole("button", { name: "Outside list", exact: true }));
    fixture.row(800).scrollIntoView({ block: "center" });
    await expect
      .poll(() => fixture.row(800).dataset.sidebarRowBody, { timeout: 5_000 })
      .toBe("mounted");
    await expect
      .poll(() => fixture.row(0).dataset.sidebarRowBody, { timeout: 5_000 })
      .toBe("placeholder");
    expect(fixture.row(800).getBoundingClientRect().height).toBeCloseTo(height);
    expect(fixture.viewport.scrollHeight).toBe(totalHeight);
    expect(fixture.mounted()).toBeLessThan(16);
    expect(_fixture.host!.textContent).toContain("Thread 1400");
  },
);

it("moves placeholder focus to the full trigger and retains an offscreen focused row", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture);
  fixture.row(800).querySelector<HTMLElement>("button")!.focus({ preventScroll: true });
  await expect.poll(() => document.activeElement?.textContent).toBe("Full thread 800");
  expect(fixture.row(800).dataset.sidebarRowBody).toBe("mounted");
  expect(fixture.viewport.scrollTop).toBe(0);
  await userEvent.click(page.getByRole("button", { name: "Outside list", exact: true }));
  await expect.poll(() => fixture.row(800).dataset.sidebarRowBody).toBe("placeholder");
});

it("retains an open portal control while scrolling and releases it after closing", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture);
  await userEvent.click(page.getByRole("button", { name: "Menu 0", exact: true }));
  await userEvent.hover(page.getByRole("button", { name: "Outside list", exact: true }));
  fixture.row(800).scrollIntoView({ block: "center" });
  await expect.poll(() => fixture.row(800).dataset.sidebarRowBody).toBe("mounted");
  expect(fixture.row(0).dataset.sidebarRowBody).toBe("mounted");
  await userEvent.click(page.getByRole("button", { name: "Close menu 0", exact: true }));
  await expect.poll(() => fixture.row(0).dataset.sidebarRowBody).toBe("placeholder");
});

it("releases a native drag retained row when the drag ends outside the list", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture);
  fixture.row(0).dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
  fixture.row(800).scrollIntoView({ block: "center" });
  await expect.poll(() => fixture.row(800).dataset.sidebarRowBody).toBe("mounted");
  expect(fixture.row(0).dataset.sidebarRowBody).toBe("mounted");
  window.dispatchEvent(new DragEvent("dragend"));
  await expect.poll(() => fixture.row(0).dataset.sidebarRowBody).toBe("placeholder");
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
