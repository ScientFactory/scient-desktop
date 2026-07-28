import { ProjectId, ThreadId, type ThreadBrowserState } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  BROWSER_PIP_DEFAULT_SIZE,
  BROWSER_PIP_MIN_SIZE,
  browserPictureInPictureIdentityMatches,
  browserPictureInPictureOwnerPaneIdToClose,
  clampBrowserPictureInPicturePosition,
  clampBrowserPictureInPictureSize,
  closeBrowserPictureInPicture,
  commitBrowserPictureInPictureLayout,
  openBrowserPictureInPicture,
  reconcileBrowserPictureInPicture,
  resolveBrowserPictureInPictureKeyboardLayout,
} from "./browserPictureInPicture";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-2");

function browserState(input: {
  version: number;
  activeTabId?: string | null;
  tabIds?: readonly string[];
  lastErrorByTabId?: Readonly<Record<string, string | null>>;
}): ThreadBrowserState {
  const tabIds = input.tabIds ?? ["tab-1"];
  return {
    threadId: THREAD_ID,
    version: input.version,
    open: true,
    activeTabId: input.activeTabId === undefined ? (tabIds[0] ?? null) : input.activeTabId,
    tabs: tabIds.map((id) => ({
      id,
      kind: "web",
      url: `https://${id}.example/`,
      displayUrl: null,
      title: id,
      status: "live",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      lastCommittedUrl: `https://${id}.example/`,
      lastError: input.lastErrorByTabId?.[id] ?? null,
    })),
    lastError: null,
  };
}

function openState() {
  return openBrowserPictureInPicture({
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    paneId: "browser-pane",
    tabId: "tab-1",
    browserVersion: 4,
    generation: 8,
  });
}

function reconcile(
  state: ReturnType<typeof openState> | null,
  nextBrowserState: ThreadBrowserState | null | undefined,
  overrides: Partial<{
    threadId: typeof THREAD_ID;
    projectId: typeof PROJECT_ID;
    browserPaneId: string | null;
  }> = {},
) {
  return reconcileBrowserPictureInPicture(state, {
    threadId: overrides.threadId ?? THREAD_ID,
    projectId: overrides.projectId ?? PROJECT_ID,
    browserPaneId: overrides.browserPaneId === undefined ? "browser-pane" : overrides.browserPaneId,
    browserState: nextBrowserState,
  });
}

describe("browser picture-in-picture lifecycle", () => {
  it("opens an ephemeral session around one exact thread, pane, tab, and generation", () => {
    const state = openState();

    expect(state).toEqual({
      identity: {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        paneId: "browser-pane",
        tabId: "tab-1",
        generation: 8,
      },
      observedBrowserVersion: 4,
      position: null,
      size: BROWSER_PIP_DEFAULT_SIZE,
    });
  });

  it("cleans up on thread switch, project switch, or browser-pane removal", () => {
    const state = openState();

    expect(
      reconcile(state, browserState({ version: 4 }), { threadId: OTHER_THREAD_ID }),
    ).toBeNull();
    expect(
      reconcile(state, browserState({ version: 4 }), { projectId: OTHER_PROJECT_ID }),
    ).toBeNull();
    expect(reconcile(state, browserState({ version: 4 }), { browserPaneId: null })).toBeNull();
  });

  it("ignores a stale browser snapshot instead of rewinding the selected tab", () => {
    const state = openState();
    const stale = browserState({ version: 3, activeTabId: "tab-old", tabIds: ["tab-old"] });

    expect(reconcile(state, stale)).toBe(state);
  });

  it("tracks a newer active-tab replacement and invalidates an old close callback", () => {
    const state = openState();
    const replaced = reconcile(
      state,
      browserState({ version: 5, activeTabId: "tab-2", tabIds: ["tab-1", "tab-2"] }),
    );

    expect(replaced?.identity).toEqual({
      ...state.identity,
      tabId: "tab-2",
      generation: 9,
    });
    expect(closeBrowserPictureInPicture(replaced, state.identity)).toBe(replaced);
  });

  it("closes when the active tab is closed without a replacement", () => {
    expect(
      reconcile(openState(), browserState({ version: 5, activeTabId: null, tabIds: [] })),
    ).toBeNull();
  });

  it("keeps the surface through a tab crash and recovery without changing identity", () => {
    const state = openState();
    const crashed = reconcile(
      state,
      browserState({ version: 5, lastErrorByTabId: { "tab-1": "Renderer crashed" } }),
    );
    const recovered = reconcile(crashed, browserState({ version: 6 }));

    expect(crashed?.identity).toBe(state.identity);
    expect(recovered?.identity).toBe(state.identity);
    expect(recovered?.observedBrowserVersion).toBe(6);
  });

  it("allows only the current generation to commit layout or close the surface", () => {
    const state = openState();
    const settled = commitBrowserPictureInPictureLayout(state, state.identity, {
      position: { x: 20, y: 30 },
      size: { width: 520, height: 340 },
    });

    expect(settled?.position).toEqual({ x: 20, y: 30 });
    expect(settled?.size).toEqual({ width: 520, height: 340 });
    expect(browserPictureInPictureIdentityMatches(settled!, state.identity)).toBe(true);
    expect(closeBrowserPictureInPicture(settled, state.identity)).toBeNull();
  });

  it("separates floating-surface close from closing the owning browser pane", () => {
    const state = openState();
    const staleIdentity = { ...state.identity, generation: state.identity.generation - 1 };

    expect(browserPictureInPictureOwnerPaneIdToClose(state, staleIdentity)).toBeNull();
    expect(browserPictureInPictureOwnerPaneIdToClose(state, state.identity)).toBe("browser-pane");
    expect(closeBrowserPictureInPicture(state, state.identity)).toBeNull();
  });

  it("rejects a settled layout from a stale gesture identity", () => {
    const state = openState();
    const staleIdentity = { ...state.identity, tabId: "replaced-tab" };
    const layout = { position: { x: 44, y: 52 }, size: { width: 500, height: 320 } };

    expect(commitBrowserPictureInPictureLayout(state, staleIdentity, layout)).toBe(state);
    expect(commitBrowserPictureInPictureLayout(state, state.identity, layout)).toEqual({
      ...state,
      position: layout.position,
      size: layout.size,
    });
  });
});

describe("browser picture-in-picture layout", () => {
  it("enforces minimum size while staying within its container", () => {
    expect(
      clampBrowserPictureInPictureSize({ width: 20, height: 30 }, { width: 1_000, height: 800 }),
    ).toEqual(BROWSER_PIP_MIN_SIZE);
    expect(
      clampBrowserPictureInPictureSize(
        { width: 2_000, height: 2_000 },
        { width: 500, height: 300 },
      ),
    ).toEqual({ width: 476, height: 276 });
  });

  it("remains representable in a container smaller than the preferred minimum", () => {
    expect(
      clampBrowserPictureInPictureSize(
        { width: Number.POSITIVE_INFINITY, height: Number.NaN },
        { width: 180, height: 120 },
      ),
    ).toEqual({ width: 156, height: 96 });
  });

  it("clamps movement to the available bounds and sanitizes invalid coordinates", () => {
    const container = { width: 900, height: 700 };
    const player = { width: 440, height: 300 };

    expect(
      clampBrowserPictureInPicturePosition({ x: -30, y: Number.NaN }, container, player),
    ).toEqual({ x: 12, y: 12 });
    expect(clampBrowserPictureInPicturePosition({ x: 1_000, y: 1_000 }, container, player)).toEqual(
      { x: 460, y: 400 },
    );
  });

  it("maps keyboard arrows to bounded movement and Alt-arrows to resizing", () => {
    const common = {
      shiftKey: false,
      position: { x: 20, y: 30 },
      size: { width: 440, height: 300 },
      container: { width: 900, height: 700 },
    };

    expect(
      resolveBrowserPictureInPictureKeyboardLayout({
        ...common,
        key: "ArrowRight",
        altKey: false,
      }),
    ).toEqual({ position: { x: 28, y: 30 }, size: common.size });
    expect(
      resolveBrowserPictureInPictureKeyboardLayout({
        ...common,
        key: "ArrowDown",
        shiftKey: true,
        altKey: true,
      }),
    ).toEqual({ position: common.position, size: { width: 440, height: 332 } });
    expect(
      resolveBrowserPictureInPictureKeyboardLayout({
        ...common,
        key: "Enter",
        altKey: false,
      }),
    ).toBeNull();
  });
});
