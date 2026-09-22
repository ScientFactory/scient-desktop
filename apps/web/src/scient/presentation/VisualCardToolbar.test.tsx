// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span className={className} data-test-movement-tooltip>
      {children}
    </span>
  ),
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));

import { VisualCardToolbar } from "./VisualCardToolbar";

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("visual-card toolbar", () => {
  it("suppresses the movement tooltip only while pointer dragging", async () => {
    const card = document.createElement("div");
    card.dataset.scientVisualCard = "true";
    const container = document.createElement("div");
    card.append(container);
    document.body.append(card);
    root = createRoot(container);
    await act(() =>
      root?.render(
        <VisualCardToolbar label="Figure actions" appearance="command-group" movement="direct">
          <span>Action</span>
        </VisualCardToolbar>,
      ),
    );

    const toolbar = container.querySelector<HTMLElement>("[aria-label='Figure actions']")!;
    const handle = toolbar.querySelector<HTMLButtonElement>("[data-scient-toolbar-move]")!;
    const tooltip = toolbar.querySelector<HTMLElement>("[data-test-movement-tooltip]")!;
    const captured = new Set<number>();
    handle.setPointerCapture = vi.fn((pointerId: number) => captured.add(pointerId));
    handle.hasPointerCapture = vi.fn((pointerId: number) => captured.has(pointerId));
    handle.releasePointerCapture = vi.fn((pointerId: number) => captured.delete(pointerId));
    const pointer = (type: string) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: 20,
          clientY: 20,
          isPrimary: true,
          pointerId: 7,
        }),
      );

    expect(tooltip.classList.contains("hidden")).toBe(false);
    await act(() => pointer("pointerdown"));
    expect(tooltip.classList.contains("hidden")).toBe(true);
    await act(() => pointer("pointerup"));
    expect(tooltip.classList.contains("hidden")).toBe(false);
  });
});
