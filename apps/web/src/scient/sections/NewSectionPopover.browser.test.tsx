import "../../index.css";

import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { NewSectionPopover, type SectionCreateAnchor } from "./NewSectionPopover";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));

function renderForm(submit: (name: string) => Promise<boolean>, native = false) {
  function Probe() {
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<SectionCreateAnchor | null>(null);
    return (
      <>
        <button
          style={{ position: "absolute", left: 32, top: 80, width: 100, height: 32 }}
          onClick={(event) => {
            setAnchor(native ? { x: 132, y: 80 } : event.currentTarget);
            setOpen(true);
          }}
        >
          New section
        </button>
        <button style={{ position: "absolute", left: 32, top: 260 }} data-testid="outside">
          Outside
        </button>
        <NewSectionPopover
          open={open}
          anchor={anchor}
          requestKey={1}
          threadCount={1}
          onOpenChange={setOpen}
          onSubmit={submit}
        />
      </>
    );
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<Probe />);
}

it.each([false, true])(
  "opens a compact nonmodal form beside its element or native-menu origin (%s)",
  async (native) => {
    const submit = vi.fn(async () => true);
    renderForm(submit, native);
    await nextFrame();
    await userEvent.click(document.querySelector("button")!);
    await nextFrame();
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Section name"]')!;
    const rect = popup.getBoundingClientRect();
    expect(rect.width).toBeLessThanOrEqual(260);
    expect(rect.height).toBeLessThan(180);
    expect(rect.left).toBeGreaterThanOrEqual(130);
    expect(Math.abs(rect.top - 80)).toBeLessThan(5);
    expect(document.querySelector('[data-slot="dialog-backdrop"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("research");
    await userEvent.keyboard("{Enter}");
    await nextFrame();
    expect(submit).toHaveBeenCalledExactlyOnceWith("Research");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull(),
    );
  },
);

it("dismisses by outside click without submitting", async () => {
  const submit = vi.fn(async () => true);
  renderForm(submit);
  await nextFrame();
  await userEvent.click(document.querySelector("button")!);
  await nextFrame();
  await userEvent.keyboard("draft");
  await userEvent.click(document.querySelector('[data-testid="outside"]')!);
  await nextFrame();
  expect(submit).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull());
});

it("keeps a failed name for retry and closes with Escape", async () => {
  const submit = vi.fn(async () => false);
  renderForm(submit);
  await nextFrame();
  await userEvent.click(document.querySelector("button")!);
  await nextFrame();
  await userEvent.keyboard("design");
  await userEvent.keyboard("{Enter}");
  await nextFrame();
  expect(document.querySelector("input")?.value).toBe("Design");
  expect(document.body.textContent).toContain("could not be saved");
  await userEvent.keyboard("{Escape}");
  await nextFrame();
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull());
});
