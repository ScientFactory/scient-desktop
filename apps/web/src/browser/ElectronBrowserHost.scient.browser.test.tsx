import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as never,
}));

// Web Locks coordinate app windows only inside the desktop shell, which a browser test lacks.
vi.mock(import("../scient/multiWindow/previewTabPresence"), async (original) => ({
  ...(await original()),
  previewWindowLocks: () => navigator.locks,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { acquireBrowserSurface } from "./browserSurfaceStore";
import { withDesktopTab } from "./desktopTabLifetime";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { createPreviewHostClaim } from "../scient/multiWindow/previewHostOwnership";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-other-window"),
  ThreadId.make("thread-other-window"),
);
const PLACEHOLDER = "This browser tab is open in another window.";

/** A same-origin frame is its own Web Locks client, like another app window. */
function openOtherWindow(stack: DisposableStack): LockManager {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  stack.defer(() => frame.remove());
  return frame.contentWindow!.navigator.locks;
}

function openTab(tabId: string) {
  reconcilePreviewServerSessions(threadRef, {
    sessions: [
      {
        threadId: threadRef.threadId,
        tabId,
        navStatus: { _tag: "Success", url: "https://example.com/", title: "Example" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    serverEpoch: "server-a",
    revision: 1,
  });
  return previewRuntimeTabId(threadRef, "server-a", tabId);
}

async function showTab(stack: DisposableStack, runtimeTabId: string) {
  const surface = acquireBrowserSurface(runtimeTabId);
  stack.defer(surface.release);
  await act(() => {
    surface.present({ x: 0, y: 0, width: 480, height: 320 }, true);
  });
}

function setup(): Disposable {
  __resetClientSettingsPersistenceForTests();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  return {
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

async function renderHost() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>,
    ),
  );
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(() => ensureClientSettingsHydrated());
  const environment = stack.move();
  return { container: screen.container, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

describe("ElectronBrowserHost with several app windows", () => {
  it("shows where another window hosts the tab, and moves the tab here on request", async () => {
    using _state = setup();
    using otherWindow = new DisposableStack();
    const runtimeTabId = openTab("tab_1");
    const other = createPreviewHostClaim(runtimeTabId, openOtherWindow(otherWindow));
    otherWindow.defer(other.start());
    await other.setDisplayed(true);
    await vi.waitFor(() => expect(other.role()).toBe("host"));

    await using screen = await renderHost();
    using surfaces = new DisposableStack();
    await showTab(surfaces, runtimeTabId);

    await expect.element(page.getByText(PLACEHOLDER)).toBeVisible();
    expect(screen.container.querySelector("webview")).toBeNull();

    await page.getByRole("button", { name: "Show here" }).click();

    await vi.waitFor(() => expect(screen.container.querySelector("webview")).not.toBeNull());
    await vi.waitFor(() => expect(other.role()).toBe("elsewhere"));
    expect(page.getByText(PLACEHOLDER).query()).toBeNull();
  });

  it("keeps the desktop tab open after another window takes it from this one", async () => {
    using _state = setup();
    using otherWindow = new DisposableStack();
    const runtimeTabId = openTab("tab_2");
    await using screen = await renderHost();
    using surfaces = new DisposableStack();
    await showTab(surfaces, runtimeTabId);
    await vi.waitFor(() => expect(screen.container.querySelector("webview")).not.toBeNull());
    otherWindow.use(fakeTimers());

    const other = createPreviewHostClaim(runtimeTabId, openOtherWindow(otherWindow));
    otherWindow.defer(other.start());
    other.showHere();

    await expect.element(page.getByText(PLACEHOLDER)).toBeVisible();
    expect(screen.container.querySelector("webview")).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => withDesktopTab(runtimeTabId, async () => resolve()));
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });
});
