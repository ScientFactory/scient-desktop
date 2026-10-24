// Scient-owned: upstream deleted RightPanelTabs.browser.test.tsx; its pure rows live in
// RightPanelTabs.test.tsx (upstream) and RightPanelTabs.scient.test.tsx.
import type { ComponentProps } from "react";
import type { DesktopPreviewFavicon, PreviewSessionSnapshot } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

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

import { RightPanelTabs } from "./RightPanelTabs";

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
