// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DockCommandItem as MenuItem, DockMenu, DockOverflowRow } from "./dockChrome";

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

  it("keeps the formatting handle at the leading edge in both states", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    function Harness() {
      const [expanded, setExpanded] = useState(false);
      return (
        <DockOverflowRow
          label="Document actions"
          expanded={expanded}
          onExpandedChange={setExpanded}
          groups={[
            {
              id: "format",
              priority: 100,
              estimatedWidth: 40,
              pinned: true,
              bar: <button type="button">Bold</button>,
            },
          ]}
        />
      );
    }

    await act(() => root.render(<Harness />));
    const toolbar = host.querySelector<HTMLElement>("[aria-label='Document actions']")!;
    const leadingCluster = toolbar.querySelector<HTMLElement>("[data-dock-toggle-cluster]")!;
    expect(toolbar.firstElementChild).toBe(leadingCluster);
    expect(leadingCluster.querySelector("[aria-label='Show formatting tools']")).not.toBeNull();
    expect(leadingCluster.querySelector(".scient-markdown-command-divider")).toBeNull();

    await act(() =>
      leadingCluster
        .querySelector<HTMLButtonElement>("[aria-label='Show formatting tools']")!
        .click(),
    );
    expect(toolbar.firstElementChild).toBe(leadingCluster);
    expect(leadingCluster.querySelector("[aria-label='Hide formatting tools']")).not.toBeNull();
    expect(leadingCluster.querySelector(".scient-markdown-command-divider")).not.toBeNull();
    expect(toolbar.children[1]?.textContent).toBe("Bold");
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

  it.each(["click", "Enter"])(
    "lets the command choose its focus destination after %s activation",
    async (activation) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const host = document.createElement("div");
      const destination = document.createElement("input");
      destination.setAttribute("aria-label", "Nested editor or link picker");
      document.body.append(host, destination);
      const root = createRoot(host);
      roots.push(root);
      const command = vi.fn(() => {
        destination.focus();
      });
      await act(() =>
        root.render(
          <DockMenu label="Insert" icon={<span>+</span>}>
            <MenuItem onClick={command}>Open editor</MenuItem>
          </DockMenu>,
        ),
      );
      await act(() => host.querySelector<HTMLButtonElement>("button")!.click());
      const item = document.body.querySelector<HTMLElement>("[role='menuitem']")!;
      await act(() => {
        item.focus();
        if (activation === "click") item.click();
        else {
          item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          item.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        }
      });
      await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(document.body.querySelector("[role='menu']")).toBeNull());
      expect(document.activeElement).toBe(destination);
    },
  );
});
