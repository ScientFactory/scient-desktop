import "../../index.css";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { useState } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { SidebarRowWindow } from "./SidebarRowWindow";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  document.documentElement.style.fontSize = "";
});

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

async function mount({ count = 1560, active = -1, fontSize = 16 } = {}) {
  document.documentElement.style.fontSize = `${fontSize}px`;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
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
  await expect.poll(() => host!.querySelectorAll("[data-full-row]").length).toBeGreaterThan(0);
  return {
    viewport: host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!,
    row: (index: number) => host!.querySelector<HTMLElement>(`[data-row-index="${index}"]`)!,
    mounted: () => host!.querySelectorAll("[data-full-row]").length,
  };
}

it.each([16, 20])(
  "bounds bodies in a 1560-row list and preserves scaled geometry at %ipx",
  async (fontSize) => {
    const fixture = await mount({ active: 1559, fontSize });
    expect(host!.querySelectorAll("li")).toHaveLength(1560);
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
    expect(host!.textContent).toContain("Thread 1400");
  },
);

it("moves placeholder focus to the full trigger and retains an offscreen focused row", async () => {
  const fixture = await mount();
  fixture.row(800).querySelector<HTMLElement>("button")!.focus({ preventScroll: true });
  await expect.poll(() => document.activeElement?.textContent).toBe("Full thread 800");
  expect(fixture.row(800).dataset.sidebarRowBody).toBe("mounted");
  expect(fixture.viewport.scrollTop).toBe(0);
  await userEvent.click(page.getByRole("button", { name: "Outside list", exact: true }));
  await expect.poll(() => fixture.row(800).dataset.sidebarRowBody).toBe("placeholder");
});

it("retains an open portal control while scrolling and releases it after closing", async () => {
  const fixture = await mount();
  await userEvent.click(page.getByRole("button", { name: "Menu 0", exact: true }));
  await userEvent.hover(page.getByRole("button", { name: "Outside list", exact: true }));
  fixture.row(800).scrollIntoView({ block: "center" });
  await expect.poll(() => fixture.row(800).dataset.sidebarRowBody).toBe("mounted");
  expect(fixture.row(0).dataset.sidebarRowBody).toBe("mounted");
  await userEvent.click(page.getByRole("button", { name: "Close menu 0", exact: true }));
  await expect.poll(() => fixture.row(0).dataset.sidebarRowBody).toBe("placeholder");
});

it("releases a native drag retained row when the drag ends outside the list", async () => {
  const fixture = await mount();
  fixture.row(0).dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
  fixture.row(800).scrollIntoView({ block: "center" });
  await expect.poll(() => fixture.row(800).dataset.sidebarRowBody).toBe("mounted");
  expect(fixture.row(0).dataset.sidebarRowBody).toBe("mounted");
  window.dispatchEvent(new DragEvent("dragend"));
  await expect.poll(() => fixture.row(0).dataset.sidebarRowBody).toBe("placeholder");
});
