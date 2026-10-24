// Restored fix cases from the upstream-deleted RightPanelTabs.keyboard.browser.test.tsx.
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import { RightPanelTabs } from "./RightPanelTabs";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));

const noop = () => undefined;

async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

async function renderPanel(
  overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {},
  platform = "MacIntel",
) {
  await using stack = new AsyncDisposableStack();
  stack.use(fakeTimers());
  stack.use(
    stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    ),
  );
  // Menus wait for exit animations to finish, which never happens under fake timers.
  stack.use(vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]));
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue(platform));
  const addFiles = vi.fn();
  const panel = (props: Partial<ComponentProps<typeof RightPanelTabs>>) => (
    <RightPanelTabs
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[]}
      environmentId={null}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={addFiles}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddAgents={noop}
      agentsAvailable={false}
      onAddSources={noop}
      onAddCompute={noop}
      sourcesAvailable={false}
      computeAvailable={false}
      onAddDevice={noop}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
      {...props}
    >
      content
    </RightPanelTabs>
  );
  // Nothing here navigates, and the test router would load on the fake clock too.
  const screen = stack.use(await render(panel(overrides), { router: false }));
  await settle();
  const environment = stack.move();
  return {
    container: screen.container,
    addFiles,
    rerender: async (props: Partial<ComponentProps<typeof RightPanelTabs>>) => {
      await screen.rerender(panel(props));
      await settle();
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await settle();
  return event;
}

describe("right panel new-tab shortcut", () => {
  // regression: b3a1334950 fix(web): right-panel launcher letters work while a closed menu stays mounted (#18132)
  it("opens Files while a closed popup remains mounted", async () => {
    await using screen = await renderPanel();
    const popup = document.createElement("div");
    popup.dataset.slot = "menu-popup";
    popup.dataset.closed = "";
    screen.container.append(popup);

    expect((await press("f")).defaultPrevented).toBe(true);
    expect(screen.addFiles).toHaveBeenCalledOnce();
  });

  // regression: b3a1334950 fix(web): right-panel launcher letters work while a closed menu stays mounted (#18132)
  it("opens the add-surface menu while a closed popup remains mounted", async () => {
    await using screen = await renderPanel();
    const popup = document.createElement("div");
    popup.dataset.slot = "menu-popup";
    popup.dataset.closed = "";
    screen.container.append(popup);

    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]:not([data-closed])')).not.toBeNull();
  });

  // regression: a8dec0e76f fix(web): Mod+T opens the tab menu while a pull request tab is open (#19065)
  it("blocks panel shortcuts until a mounted popup finishes closing", async () => {
    await using screen = await renderPanel();
    const popover = document.createElement("div");
    popover.dataset.slot = "popover-popup";
    popover.dataset.open = "";
    screen.container.append(popover);

    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect((await press("f")).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(screen.addFiles).not.toHaveBeenCalled();

    delete popover.dataset.open;
    popover.dataset.closed = "";
    popover.dataset.endingStyle = "";
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect((await press("f")).defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(screen.addFiles).not.toHaveBeenCalled();

    delete popover.dataset.endingStyle;
    popover.hidden = true;
    expect((await press("f")).defaultPrevented).toBe(true);
    expect(screen.addFiles).toHaveBeenCalledOnce();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Files");
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
  });
});

describe("right panel tab middle click", () => {
  // regression: 3c4df2857b fix(web): middle-click closing a panel tab no longer pastes the primary selection (#18860)
  it("cancels middle-button defaults and closes once while preserving other buttons", async () => {
    const onActivate = vi.fn();
    const onCloseSurface = vi.fn();
    const files = { id: "files" as const, kind: "files" as const };
    await using screen = await renderPanel({
      surfaces: [files],
      activeSurfaceId: files.id,
      onActivate,
      onCloseSurface,
    });
    const tabLabel = screen.container.querySelector("[data-active-tab] span.truncate")!;
    const mouse = async (type: string, button: number) => {
      const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
      await act(() => tabLabel.dispatchEvent(event));
      return event;
    };

    expect((await mouse("mousedown", 0)).defaultPrevented).toBe(false);
    expect((await mouse("mouseup", 0)).defaultPrevented).toBe(false);
    expect((await mouse("click", 0)).defaultPrevented).toBe(false);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(files);
    expect((await mouse("mousedown", 2)).defaultPrevented).toBe(false);
    expect((await mouse("mouseup", 2)).defaultPrevented).toBe(false);
    expect((await mouse("auxclick", 2)).defaultPrevented).toBe(false);
    expect(onCloseSurface).not.toHaveBeenCalled();

    expect((await mouse("mousedown", 1)).defaultPrevented).toBe(true);
    expect((await mouse("mouseup", 1)).defaultPrevented).toBe(true);
    expect(onCloseSurface).not.toHaveBeenCalled();
    expect((await mouse("auxclick", 1)).defaultPrevented).toBe(true);
    expect(onCloseSurface).toHaveBeenCalledExactlyOnceWith(files);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
