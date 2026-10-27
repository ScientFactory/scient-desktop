// Scient-owned: upstream deleted RightPanelTabs.browser.test.tsx; its pure rows live in
// RightPanelTabs.test.tsx (upstream) and RightPanelTabs.scient.test.tsx.
import type { ComponentProps } from "react";
import { userEvent } from "vite-plus/test/browser";
import type {
  ContextMenuItem,
  DesktopPreviewFavicon,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const setAudioMuted = vi.hoisted(() => vi.fn(async () => undefined));
const menu = vi.hoisted(() => ({
  profiles: [] as Array<{ id: string; name: string }>,
  show: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(async () => undefined),
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ contextMenu: { show: menu.show } }) as never,
}));

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "light", resolvedTheme: "light", themeHalves: null }) as never,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: menu.profiles }) as never,
}));
vi.mock(import("./preview/previewBridge"), () => ({
  previewBridge: { setAudioMuted } as never,
}));
import { surfaceShortcutActionForKey } from "./RightPanelTabs";
import { RightPanelTabs } from "./RightPanelTabs";

// A real 1x1 PNG, so the browser keeps it instead of falling back on a decode error.
const PIXEL_A =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PIXEL_B =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};
const secondSurface = {
  id: "browser:tab-2" as const,
  kind: "preview" as const,
  resourceId: "tab-2",
};
const sessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "tab-1": {
    threadId: "thread-1",
    tabId: "tab-1",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  "tab-2": {
    threadId: "thread-1",
    tabId: "tab-2",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/admin", title: "Admin" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
};

const favicon = (dataUrl: string, pageUrl: string): DesktopPreviewFavicon => ({
  dataUrl,
  pageUrl,
  capturedAt: 1,
});

function overlay(
  icon: DesktopPreviewFavicon | null,
  audio?: { audible?: boolean; audioMuted?: boolean },
) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    audioMuted: audio?.audioMuted ?? false,
    audible: audio?.audible ?? false,
    controller: "none" as const,
    favicon: icon,
  };
}

const noop = () => undefined;

function tabs(
  first: DesktopPreviewFavicon | null,
  second?: DesktopPreviewFavicon,
  audio?: { audible?: boolean; audioMuted?: boolean },
  previewRuntimeTabId: ((tabId: string) => string) | null = (tabId) => `runtime:${tabId}`,
  overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {},
) {
  return (
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
      surfaces={second ? [previewSurface, secondSurface] : [previewSurface]}
      environmentId={null}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={sessions}
      desktopByTabId={{
        "tab-1": overlay(first, audio),
        ...(second ? { "tab-2": overlay(second) } : {}),
      }}
      {...(previewRuntimeTabId ? { previewRuntimeTabId } : {})}
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
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddSources={() => {}}
      onAddCompute={() => {}}
      sourcesAvailable={false}
      computeAvailable={false}
      onAddAgents={noop}
      agentsAvailable={false}
      onAddDevice={noop}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
      {...overrides}
    >
      <div>content</div>
    </RightPanelTabs>
  );
}

function setup() {
  setAudioMuted.mockClear();
  menu.show.mockClear();
  menu.profiles = [];
}

function renderTabs(...args: Parameters<typeof tabs>) {
  return render(tabs(...args));
}

const imageSources = (container: HTMLElement) =>
  [...container.querySelectorAll("img")].map((image) => image.src);
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((element) => element.ariaLabel === name);

describe("preview tab favicon", () => {
  // regression: a75a6d7643 test(web): misc-b tests run in a real browser (#20869)
  it("prefers a live capture and never asks a public provider about a private hostname", async () => {
    setup();
    await using screen = await renderTabs(favicon(PIXEL_A, "http://24x.xf.local/"));
    expect(imageSources(screen.container)).toEqual([PIXEL_A]);

    await screen.rerender(tabs(null));
    expect(imageSources(screen.container)).toEqual([]);
  });

  // regression: 710fd0eeb3 feat(desktop): add favicons to the Browser panel (#5644)
  it("keeps route-specific captures isolated between live tabs on one origin", async () => {
    setup();
    await using screen = await renderTabs(
      favicon(PIXEL_A, "http://24x.xf.local/"),
      favicon(PIXEL_B, "http://24x.xf.local/admin"),
    );
    expect(imageSources(screen.container)).toEqual([PIXEL_A, PIXEL_B]);
  });

  // regression: 710fd0eeb3 feat(desktop): add favicons to the Browser panel (#5644)
  it("hides a capture while the server session still describes another origin", async () => {
    setup();
    await using screen = await renderTabs(favicon(PIXEL_A, "https://example.com/"));
    expect(imageSources(screen.container)).not.toContain(PIXEL_A);
  });
});

describe("preview tab audio toggle", () => {
  // regression: a75a6d7643 test(web): misc-b tests run in a real browser (#20869)
  it.each([
    { audible: false, audioMuted: false },
    { audible: false, audioMuted: true },
  ])("is absent for a silent tab (muted=$audioMuted)", async (audio) => {
    setup();
    await using screen = await renderTabs(null, undefined, audio);
    expect(button(screen.container, "Mute Local site")).toBeUndefined();
    expect(button(screen.container, "Unmute Local site")).toBeUndefined();
  });

  // regression: a75a6d7643 test(web): misc-b tests run in a real browser (#20869)
  it.each([
    { audioMuted: false, label: "Mute Local site", nextMuted: true },
    { audioMuted: true, label: "Unmute Local site", nextMuted: false },
  ])("$label addresses the desktop by runtime tab id", async ({ audioMuted, label, nextMuted }) => {
    setup();
    await using screen = await renderTabs(null, undefined, { audible: true, audioMuted });
    await act(() => button(screen.container, label)!.click());
    expect(setAudioMuted).toHaveBeenCalledExactlyOnceWith("runtime:tab-1", nextMuted);
  });

  // regression: 3a02c9cf1d feat(desktop): mute a browser tab (#7252)
  it("hides the toggle when no runtime tab id can be resolved", async () => {
    setup();
    await using screen = await renderTabs(null, undefined, { audible: true }, null);
    expect(button(screen.container, "Mute Local site")).toBeUndefined();
  });
});

function shortcutEvent(
  key: string,
  overrides: Partial<Parameters<typeof surfaceShortcutActionForKey>[1]> = {},
): Parameters<typeof surfaceShortcutActionForKey>[1] {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ...overrides,
  };
}

describe("surface shortcuts", () => {
  const actions = [
    { shortcut: "B", available: true, label: "Browser" },
    { shortcut: "D", available: false, label: "Diff" },
  ] as const;

  // regression: 3b8e7bbbe0 feat(web): add shortcuts to the surface dropdown (#7318)
  it("does not activate unavailable surfaces", async () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("d"))).toBeNull();
  });
});

it("applies automatic direction to the complete tab layout", async () => {
  setup();
  await using screen = await render(
    tabs(null, undefined, undefined, undefined, {
      previewSessions: {
        ...sessions,
        "tab-1": {
          ...sessions["tab-1"]!,
          navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "דוח תוצאות" },
        },
      },
    }),
  );
  const tab = screen.container.querySelector<HTMLElement>('[data-active-tab="true"]')!;
  expect(tab.dir).toBe("auto");
  expect(
    [...tab.querySelectorAll("span")].find((span) => span.textContent === "דוח תוצאות")?.dir,
  ).toBe("auto");
});

// regression: a495ed55e0 chore(upstream): merge t3 through 21da3061aa
it.each([
  { present: false, addressable: true, audioMuted: false, disabled: true },
  { present: true, addressable: false, audioMuted: false, disabled: true },
  { present: true, addressable: true, audioMuted: false, disabled: false },
  { present: true, addressable: true, audioMuted: true, disabled: false },
])(
  "derives the context menu from actual desktop ownership: %j",
  async ({ present, addressable, audioMuted, disabled }) => {
    setup();
    await using screen = await render(
      tabs(
        null,
        undefined,
        { audioMuted },
        addressable ? (id) => `runtime:${id}` : null,
        present ? {} : { desktopByTabId: {} },
      ),
    );
    const tab = screen.container.querySelector<HTMLElement>('[data-active-tab="true"]')!;
    await act(() => {
      tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const items = menu.show.mock.calls.at(-1)?.[0] as readonly ContextMenuItem[] | undefined;
    expect(items?.find((item) => item.id === "toggle-mute")).toMatchObject({
      label: audioMuted ? "Unmute tab" : "Mute tab",
      disabled,
    });
  },
);

// regression: a495ed55e0 chore(upstream): merge t3 through 21da3061aa
it.each(["touch", "mouse", undefined] as const)(
  "reserves touch for profile choices and opens the other defaults: %s",
  async (pointerType) => {
    setup();
    menu.profiles = [
      { id: "default", name: "Main" },
      { id: "work", name: "Work" },
    ];
    const openDefault = vi.fn();
    await using screen = await render(
      tabs(null, undefined, undefined, undefined, {
        onAddBrowser: openDefault,
      }),
    );
    await userEvent.click(screen.container.querySelector('[aria-label="Add panel surface"]')!);
    const trigger = await vi.waitFor(() => {
      const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-keyshortcuts="B"]');
      if (!item) throw new Error("Browser submenu is not open");
      return item;
    });
    await act(() => {
      trigger.dispatchEvent(
        pointerType === undefined
          ? new MouseEvent("click", { bubbles: true, cancelable: true })
          : new PointerEvent("click", { pointerType, bubbles: true, cancelable: true }),
      );
    });
    if (pointerType === "touch") {
      expect(openDefault).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Work"));
    } else expect(openDefault).toHaveBeenCalledOnce();
  },
);
