import "../../index.css";

import { render as _fixtureRender, type Screen, act, stubGlobal } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { DockCommandItem as MenuItem, DockMenu, DockOverflowRow } from "./dockChrome";

describe("DockOverflowRow", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    while (_fixture.root0.length > 0) {
      const root = _fixture.root0.pop();
      if (root) await act(async () => await root.unmount());
    }
    _clearOwnedDOM(_fixture);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }

  it("hides labels before overflowing groups and restores them when widened", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const host = document.createElement("div");
    nativeDockLayout(_fixture, host, 200, 100, 30, 30);
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    await act(
      async () =>
        await root.rerender(
          <DockOverflowRow
            label="Writing tools"
            fixed
            compactLabels
            expanded
            onExpandedChange={vi.fn()}
            groups={["text", "math", "insert"].map((id, index) => ({
              id,
              priority: 100 - index,
              estimatedWidth: 100,
              bar: <button type="button">{id}</button>,
              overflow: <MenuItem>{id}</MenuItem>,
            }))}
            overflowItems={<MenuItem>Help</MenuItem>}
          />,
        ),
    );
    const toolbar = host.querySelector('[role="toolbar"]')!;
    await expect.poll(() => toolbar.hasAttribute("data-dock-compact-labels")).toBe(true);
    expect(toolbar.querySelectorAll("[data-dock-group]")).toHaveLength(3);
    const padding = getComputedStyle(toolbar);
    host.style.width = `${105 + parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight)}px`;
    expect(toolbar.hasAttribute("data-dock-compact-labels")).toBe(true);
    await expect.poll(() => toolbar.querySelectorAll("[data-dock-group]").length).toBe(2);
    host.style.width = "500px";
    await expect.poll(() => toolbar.hasAttribute("data-dock-compact-labels")).toBe(false);
    expect(toolbar.querySelectorAll("[data-dock-group]")).toHaveLength(3);
  });

  it("does not remeasure layout when only command state rerenders", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const host = document.createElement("div");
    nativeDockLayout(_fixture, host, 500, 60, 60, 30);
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);

    // Native resize delivery is independent of command state; width changes are tested above.
    using _resize = stubGlobal("ResizeObserver", undefined);
    using offsetWidth = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get");
    const renderRow = async (pressed: boolean, groupId = "format") => {
      await act(
        async () =>
          await root.rerender(
            <DockOverflowRow
              label="Document actions"
              expanded
              onExpandedChange={vi.fn()}
              groups={[
                {
                  id: groupId,
                  priority: 100,
                  estimatedWidth: 60,
                  pinned: true,
                  bar: (
                    <button type="button" aria-pressed={pressed}>
                      Bold
                    </button>
                  ),
                },
              ]}
            />,
          ),
      );
    };

    await renderRow(false);
    await vi.waitFor(() => expect(offsetWidth.mock.calls.length).toBeGreaterThan(0));
    const initialMeasurements = offsetWidth.mock.calls.length;
    expect(initialMeasurements).toBeGreaterThan(0);

    await renderRow(true);
    expect(offsetWidth).toHaveBeenCalledTimes(initialMeasurements);

    await renderRow(true, "style");
    expect(offsetWidth.mock.calls.length).toBeGreaterThan(initialMeasurements);
  });

  it("opens grouped actions after narrow-width overflow without losing menu context", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const host = document.createElement("div");
    nativeDockLayout(_fixture, host, 120, 80, 80, 50);
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    const actions = {
      undo: vi.fn(),
      heading: vi.fn(),
      table: vi.fn(),
    };

    await act(
      async () =>
        await root.rerender(
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
    await expect
      .poll(() =>
        Array.from(document.body.querySelectorAll("[data-slot='menu-label']"), (node) =>
          node.textContent?.trim(),
        ),
      )
      .toEqual([]);
  });

  it("keeps one complete contextual group in the unified menu while its compact controls fit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    const tableAction = vi.fn();

    await act(
      async () =>
        await root.rerender(
          <DockOverflowRow
            label="Document actions"
            expanded
            onExpandedChange={vi.fn()}
            groups={[
              {
                id: "table",
                priority: 60,
                estimatedWidth: 80,
                alwaysInOverflow: true,
                bar: <button type="button">Add row</button>,
                overflowLabel: "Table",
                overflow: <MenuItem onClick={tableAction}>Select whole table</MenuItem>,
              },
            ]}
          />,
        ),
    );

    expect(host.querySelectorAll("[aria-label='More actions']")).toHaveLength(1);
    expect(host.querySelector("[aria-label='More table actions']")).toBeNull();
    await act(() => host.querySelector<HTMLButtonElement>("[aria-label='More actions']")!.click());
    expect(document.body.querySelector("[data-slot='menu-label']")?.textContent).toBe("Table");
    const item = Array.from(
      document.body.querySelectorAll<HTMLElement>("[data-slot='menu-item']"),
    ).find((candidate) => candidate.textContent === "Select whole table");
    await act(() => item!.click());
    expect(tableAction).toHaveBeenCalledOnce();
  });

  it("runs a closed menu command even when animation frames are suspended", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const host = document.createElement("div");
    const destination = document.createElement("input");
    document.body.append(_ownDOM(_fixture, host), _ownDOM(_fixture, destination));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    const command = vi.fn(() => destination.focus());
    await act(
      async () =>
        await root.rerender(
          <DockMenu label="Insert" icon={<span>+</span>}>
            <MenuItem onClick={command}>Open editor</MenuItem>
          </DockMenu>,
        ),
    );
    await act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    await act(() => document.body.querySelector<HTMLElement>("[role='menuitem']")!.click());
    expect(command).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(destination);
    frame.mockRestore();
  });

  it.each(["click", "Enter"])(
    "lets the command choose its focus destination after %s activation",
    async (activation) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const host = document.createElement("div");
      const destination = document.createElement("input");
      destination.setAttribute("aria-label", "Nested editor or link picker");
      document.body.append(_ownDOM(_fixture, host), _ownDOM(_fixture, destination));
      const root = _fixture.stack.use(
        await _fixtureRender(null, { container: host, router: false }),
      );
      _fixture.root0.push(root);
      const command = vi.fn(() => {
        destination.focus();
      });
      await act(
        async () =>
          await root.rerender(
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}

function nativeDockLayout(
  _fixture: _Fixture,
  host: HTMLElement,
  width: number,
  expanded: number,
  compact: number,
  reserved: number,
) {
  host.dataset.nativeDockFixture = "true";
  host.style.width = width + "px";
  host.style.setProperty("--native-dock-expanded", expanded + "px");
  host.style.setProperty("--native-dock-compact", compact + "px");
  host.style.setProperty("--native-dock-reserved", reserved + "px");
  const scope = "[data-native-dock-fixture]";
  const style = document.createElement("style");
  style.textContent =
    scope +
    " [data-dock-group]{width:var(--native-dock-expanded);flex-shrink:0}" +
    scope +
    " [data-dock-compact-labels] [data-dock-group]{width:var(--native-dock-compact)}" +
    scope +
    " [data-dock-reserved]{width:var(--native-dock-reserved);flex-shrink:0}";
  document.body.append(_ownDOM(_fixture, style));
}
