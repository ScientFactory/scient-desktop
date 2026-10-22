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

// SCIENT-FORK:START
import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import {
  buildTabContextMenuItems,
  resolvePullRequestTabLink,
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
} from "./RightPanelTabs";
// SCIENT-FORK:END
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
  it("prefers a live capture and never asks a public provider about a private hostname", async () => {
    setup();
    await using screen = await renderTabs(favicon(PIXEL_A, "http://24x.xf.local/"));
    expect(imageSources(screen.container)).toEqual([PIXEL_A]);

    await screen.rerender(tabs(null));
    expect(imageSources(screen.container)).toEqual([]);
  });

  it("keeps route-specific captures isolated between live tabs on one origin", async () => {
    setup();
    await using screen = await renderTabs(
      favicon(PIXEL_A, "http://24x.xf.local/"),
      favicon(PIXEL_B, "http://24x.xf.local/admin"),
    );
    expect(imageSources(screen.container)).toEqual([PIXEL_A, PIXEL_B]);
  });

  it("hides a capture while the server session still describes another origin", async () => {
    setup();
    await using screen = await renderTabs(favicon(PIXEL_A, "https://example.com/"));
    expect(imageSources(screen.container)).not.toContain(PIXEL_A);
  });
});

describe("preview tab audio toggle", () => {
  it.each([
    { audible: false, audioMuted: false },
    { audible: false, audioMuted: true },
  ])("is absent for a silent tab (muted=$audioMuted)", async (audio) => {
    setup();
    await using screen = await renderTabs(null, undefined, audio);
    expect(button(screen.container, "Mute Local site")).toBeUndefined();
    expect(button(screen.container, "Unmute Local site")).toBeUndefined();
  });

  it.each([
    { audioMuted: false, label: "Mute Local site", nextMuted: true },
    { audioMuted: true, label: "Unmute Local site", nextMuted: false },
  ])("$label addresses the desktop by runtime tab id", async ({ audioMuted, label, nextMuted }) => {
    setup();
    await using screen = await renderTabs(null, undefined, { audible: true, audioMuted });
    await act(() => button(screen.container, label)!.click());
    expect(setAudioMuted).toHaveBeenCalledExactlyOnceWith("runtime:tab-1", nextMuted);
  });

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

  it("matches available surface shortcuts case-insensitively", async () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("b"))).toBe(actions[0]);
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("B"))).toBe(actions[0]);
  });

  it("does not activate unavailable surfaces", async () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("d"))).toBeNull();
  });

  it("leaves modified, composing, and already-handled key events alone", async () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("b", { metaKey: true }))).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { isComposing: true })),
    ).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("b", { defaultPrevented: true })),
    ).toBeNull();
  });
});

describe("surface shortcut typing contexts", () => {
  const makeTarget = (matches: string | null) => ({
    closest(selectors: string) {
      if (matches === null || !selectors.includes(matches)) return null;
      return {};
    },
  });

  it("treats form fields and every editable region as typing contexts", async () => {
    expect(surfaceShortcutTargetsTypingContext(makeTarget("input"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("textarea"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("select"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("[contenteditable]"))).toBe(true);
  });

  it("claims letters when focus sits outside any editable region", async () => {
    expect(surfaceShortcutTargetsTypingContext(null)).toBe(false);
    expect(surfaceShortcutTargetsTypingContext(makeTarget(null))).toBe(false);
  });
});

describe("RightPanelTabs context menu", () => {
  it("offers explicit relative and full path actions for file tabs", async () => {
    expect(
      buildTabContextMenuItems({
        pathCopyFormats: ["relative", "full"],
        mute: null,
        surfaceIndex: 0,
        surfaceCount: 2,
      }).map(({ id, label }) => ({ id, label })),
    ).toEqual([
      { id: "copy-relative-path", label: "Copy relative path" },
      { id: "copy-full-path", label: "Copy full path" },
      { id: "close", label: "Close" },
      { id: "close-others", label: "Close others" },
      { id: "close-to-right", label: "Close to the right" },
      { id: "close-all", label: "Close all" },
    ]);
  });

  it("offers only a full path for host files outside the workspace", async () => {
    expect(
      buildTabContextMenuItems({
        pathCopyFormats: ["full"],
        mute: null,
        surfaceIndex: 0,
        surfaceCount: 1,
      }).map((item) => item.id),
    ).toEqual(["copy-full-path", "close", "close-others", "close-to-right", "close-all"]);
  });

  it("does not add path actions to non-file tabs", async () => {
    expect(
      buildTabContextMenuItems({
        pathCopyFormats: [],
        mute: null,
        surfaceIndex: 0,
        surfaceCount: 1,
      }).map((item) => item.id),
    ).toEqual(["close", "close-others", "close-to-right", "close-all"]);
  });

  it("preserves the preview mute action alongside the shared close actions", async () => {
    expect(
      buildTabContextMenuItems({
        pathCopyFormats: [],
        mute: { label: "Unmute tab", disabled: false },
        surfaceIndex: 0,
        surfaceCount: 1,
      }).map(({ id, label, disabled }) => ({ id, label, disabled: disabled ?? false })),
    ).toEqual([
      { id: "toggle-mute", label: "Unmute tab", disabled: false },
      { id: "close", label: "Close", disabled: false },
      { id: "close-others", label: "Close others", disabled: true },
      { id: "close-to-right", label: "Close to the right", disabled: true },
      { id: "close-all", label: "Close all", disabled: false },
    ]);
  });
});

describe("pull request tab snapshots", () => {
  const environmentId = EnvironmentId.make("local");
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/api",
    number: 7,
    url: "https://github.com/acme/api/pull/7",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unknown linked state authoritative and scopes matches to environment and host", async () => {
    const threads = [{ environmentId, pullRequests: [link] }];
    expect(resolvePullRequestTabLink(threads, environmentId, "github.com", link)).toBe(link);
    expect(
      resolvePullRequestTabLink(threads, EnvironmentId.make("remote"), "github.com", link),
    ).toBeUndefined();
    expect(
      resolvePullRequestTabLink(threads, environmentId, "github.enterprise.test", link),
    ).toBeUndefined();
  });
  it("uses the newest snapshot when several threads link the same PR", async () => {
    const snapshot = {
      state: "merged" as const,
      title: "API",
      headBranch: "api",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-02-01T00:00:00Z",
    };
    const newer = { ...link, snapshot };
    expect(
      resolvePullRequestTabLink(
        [{ environmentId, pullRequests: [link, newer] }],
        environmentId,
        "github.com",
        link,
      ),
    ).toBe(newer);
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

it.each(["touch", "mouse", undefined] as const)(
  "reserves touch for profile choices and opens the other defaults: %s",
  async (pointerType) => {
    setup();
    menu.profiles = [
      { id: "default", name: "Default" },
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
