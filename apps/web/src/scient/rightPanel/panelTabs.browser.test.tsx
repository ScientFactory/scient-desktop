import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatShortcutCommands } from "~/components/chat/useChatShortcuts";
import type { RightPanelSurface } from "~/rightPanelStore";

import { render } from "../../../test/render";
import { AllTabsMenu } from "./AllTabsMenu";
import { useScientTabStrip } from "./tabStrip";
import { usePanelTabShortcuts } from "./usePanelTabShortcuts";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("panel-tabs"));
const terminal = (id: string) =>
  ({
    id: `terminal:${id}`,
    kind: "terminal",
    resourceId: id,
    terminalIds: [id],
    activeTerminalId: id,
  }) as const satisfies RightPanelSurface;
const [first, second, third] = [terminal("a"), terminal("b"), terminal("c")];
const run = (command: keyof ChatShortcutCommands, shortcuts: ChatShortcutCommands) =>
  shortcuts[command]!({ event: new KeyboardEvent("keydown"), terminalFocusOwner: null });

async function shortcutsFor(options: {
  readonly panelOpen: boolean;
  readonly activeSurface: RightPanelSurface | null;
}) {
  const calls = { activate: vi.fn(), addNewTab: vi.fn(), addTerminal: vi.fn() };
  let shortcuts: ChatShortcutCommands = {};
  function Probe() {
    const result = usePanelTabShortcuts({
      threadRef: ref,
      panelOpen: options.panelOpen,
      surfaces: [first, second, third],
      activeSurface: options.activeSurface,
      activate: calls.activate,
      addNewTab: calls.addNewTab,
      canOperatePreview: true,
      browserAvailable: true,
      runAfterPendingFileSave: (_target, proceed) => proceed(),
      openPreview: vi.fn() as never,
      previewSessions: {},
      addTerminal: calls.addTerminal,
    });
    useLayoutEffect(() => {
      shortcuts = result.shortcuts;
    });
    return null;
  }
  const screen = await render(<Probe />, { router: false });
  return { screen, calls, shortcuts: () => shortcuts };
}

describe("usePanelTabShortcuts", () => {
  it("moves between tabs and copies the open one while the panel is open", async () => {
    const probe = await shortcutsFor({ panelOpen: true, activeSurface: second });
    await using _screen = probe.screen;
    run("rightPanel.nextTab", probe.shortcuts());
    run("rightPanel.previousTab", probe.shortcuts());
    expect(probe.calls.activate.mock.calls).toEqual([[third], [first]]);
    // A terminal tab's copy is a new terminal.
    run("rightPanel.duplicateTab", probe.shortcuts());
    expect(probe.calls.addTerminal).toHaveBeenCalledOnce();
    // An open panel's own tab bar handles a new tab.
    expect(run("rightPanel.new", probe.shortcuts())).toBe(false);
    expect(probe.calls.addNewTab).not.toHaveBeenCalled();
  });

  it("leaves tab keys alone while the panel is closed, and opens it with a new tab", async () => {
    const probe = await shortcutsFor({ panelOpen: false, activeSurface: second });
    await using _screen = probe.screen;
    for (const command of [
      "rightPanel.nextTab",
      "rightPanel.previousTab",
      "rightPanel.duplicateTab",
      "rightPanel.toggleFiles",
    ] as const) {
      expect(run(command, probe.shortcuts())).toBe(false);
    }
    expect(probe.calls.activate).not.toHaveBeenCalled();
    run("rightPanel.new", probe.shortcuts());
    expect(probe.calls.addNewTab).toHaveBeenCalledOnce();
  });
});

describe("useScientTabStrip", () => {
  it("gives an open, empty panel one New tab, and a closed one none", async () => {
    const onAddNewTab = vi.fn();
    function Probe(props: { readonly open: boolean }) {
      useScientTabStrip({ surfaces: [], activeSurfaceId: null, open: props.open, onAddNewTab });
      return null;
    }
    await using screen = await render(<Probe open={false} />, { router: false });
    expect(onAddNewTab).not.toHaveBeenCalled();
    await screen.rerender(<Probe open />);
    expect(onAddNewTab.mock.calls).toEqual([[{ whenEmpty: true }]]);
  });
});

describe("AllTabsMenu", () => {
  it("lists every tab, marks the open one, and opens or closes the one picked", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    await using screen = await render(
      <AllTabsMenu
        tabs={[first, second]}
        activeId={second.id}
        titleOf={(tab) => `Terminal ${tab.resourceId}`}
        onSelect={onSelect}
        onClose={onClose}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "All tabs" }));
    await userEvent.click(screen.getByRole("button", { name: "Close Terminal a" }));
    expect(onClose).toHaveBeenCalledWith(first);
    await userEvent.click(screen.getByText("Terminal b"));
    expect(onSelect).toHaveBeenCalledWith(second);
  });
});
