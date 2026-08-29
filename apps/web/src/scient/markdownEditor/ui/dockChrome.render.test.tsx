// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MenuItem } from "~/components/ui/menu";

import { DockOverflowRow } from "./dockChrome";

class TestResizeObserver {
  static callback: ResizeObserverCallback | null = null;

  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe("DockOverflowRow", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await act(() => root.unmount());
    }
    TestResizeObserver.callback = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens grouped actions after narrow-width overflow without losing menu context", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
    width.mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "toolbar" ? 120 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-dock-reserved") ? 50 : 80;
      },
    );

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const actions = {
      undo: vi.fn(),
      heading: vi.fn(),
      table: vi.fn(),
    };

    await act(() =>
      root.render(
        <DockOverflowRow
          label="Document actions"
          expanded
          onExpandedChange={vi.fn()}
          groups={[
            {
              id: "history",
              priority: 30,
              estimatedWidth: 80,
              bar: <button type="button">Undo</button>,
              overflowLabel: "History",
              overflow: <MenuItem onClick={actions.undo}>Undo</MenuItem>,
            },
            {
              id: "style",
              priority: 20,
              estimatedWidth: 80,
              bar: <button type="button">Heading</button>,
              overflowLabel: "Style",
              overflow: <MenuItem onClick={actions.heading}>Heading</MenuItem>,
            },
            {
              id: "insert",
              priority: 10,
              estimatedWidth: 80,
              bar: <button type="button">Table</button>,
              overflowLabel: "Insert",
              overflow: <MenuItem onClick={actions.table}>Table</MenuItem>,
            },
          ]}
        />,
      ),
    );

    for (const [label, action] of Object.entries(actions)) {
      const trigger = host.querySelector<HTMLButtonElement>("[aria-label='More actions']");
      expect(trigger).not.toBeNull();
      await act(() => trigger!.click());

      const groupLabels = Array.from(
        document.body.querySelectorAll("[data-slot='menu-label']"),
        (node) => node.textContent?.trim(),
      );
      expect(groupLabels).toHaveLength(3);
      expect(groupLabels).toEqual(expect.arrayContaining(["History", "Style", "Insert"]));
      const item = Array.from(
        document.body.querySelectorAll<HTMLElement>("[data-slot='menu-item']"),
      ).find((candidate) => candidate.textContent?.toLocaleLowerCase() === label);
      expect(item).not.toBeNull();
      await act(() => item!.click());
      expect(action).toHaveBeenCalledOnce();
    }
    expect(
      Array.from(document.body.querySelectorAll("[data-slot='menu-label']"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual([]);
  });
});
