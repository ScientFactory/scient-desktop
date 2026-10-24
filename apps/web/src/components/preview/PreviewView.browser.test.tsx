import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({
  // SCIENT-FORK:START
  pdfOwner: "desktop" as "desktop" | "server" | null,
  exportDisabled: null as boolean | null,
  runtime: undefined as "server" | undefined,
  sourceUrl: "http://example.com/",
  controller: "none" as "human" | "agent" | "none",
  // SCIENT-FORK:END
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  toast: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  nativeServerTab: false,
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        // SCIENT-FORK:START
        controller: mocks.controller,
        // SCIENT-FORK:END
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            // SCIENT-FORK:START — PDF export cases choose the tab runtime and source URL.
            runtime: mocks.nativeServerTab ? "server" : (mocks.runtime ?? "desktop"),
            navStatus: { _tag: "Success", url: mocks.sourceUrl, title: "Example" },
            // SCIENT-FORK:END
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "WSL" })) as never,
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: mocks.toast } };
});
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));
// SCIENT-FORK:START — server tabs render Scient's server browser surface.
vi.mock(import("~/browser/ServerBrowserSurface"), () => ({
  ServerBrowserSurface: () => <></>,
}));
// SCIENT-FORK:END

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });

import { useComposerDraftStore } from "~/composerDraftStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
// SCIENT-FORK:START
import { useRightPanelStore } from "~/rightPanelStore";
// SCIENT-FORK:END
import { PreviewView } from "./PreviewView";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

function view(onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"]) {
  return (
    <PreviewView
      threadRef={TEST_THREAD_REF}
      tabId="tab-1"
      visible
      {...(onSendAnnotation ? { onSendAnnotation } : {})}
    />
  );
}

function annotation(id: string, screenshot: unknown = null) {
  return {
    id,
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    comment: "Tighten this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  vi.clearAllMocks();
  mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
  mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
  mocks.pickElement.mockReset();
  mocks.pdfOwner = "desktop";
  mocks.controller = "none";
  mocks.exportDisabled = null;
  mocks.runtime = undefined;
  mocks.sourceUrl = "http://example.com/";
  mocks.pictureInPicture = false;
  mocks.showEmptyState = false;
  mocks.loading = false;
  mocks.nativeServerTab = false;
  mocks.serverEpoch = null;
  mocks.servers = [];
  mocks.recordingTabIds = new Set();
  mocks.recordingRuntimeTabId = null;
  useComposerDraftStore.setState({
    addPreviewAnnotation: mocks.addPreviewAnnotation,
    addImage: mocks.addImage,
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useBrowserPointerStore.setState({ byTabId: {} });
}

describe("PreviewView", () => {
  // SCIENT-FORK:START
  it("enables the PDF control for a remote server owner and disables it when no renderer owns export", async () => {
    setup();
    mocks.pdfOwner = "server";
    await using screen = await render(<PreviewView threadRef={TEST_THREAD_REF} visible />);
    expect(mocks.exportDisabled).toBe(false);
    mocks.pdfOwner = null;
    await screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} visible />);
    expect(mocks.exportDisabled).toBe(true);
  });
  it("disables HTML export while a remote server tab embeds an existing PDF", async () => {
    setup();
    mocks.pdfOwner = "server";
    mocks.runtime = "server";
    mocks.sourceUrl = "http://localhost/api/assets/synthetic-token/paper.PDF";
    await using screen = await render(<PreviewView threadRef={TEST_THREAD_REF} visible />);
    expect(mocks.exportDisabled).toBe(true);
    mocks.sourceUrl = "https://example.com/document.html";
    await screen.rerender(<PreviewView threadRef={TEST_THREAD_REF} visible />);
    expect(mocks.exportDisabled).toBe(false);
  });
  it("only shows control status while the agent is controlling the browser", async () => {
    setup();
    mocks.controller = "human";
    await using screen = await render(view());
    expect(document.body.textContent).not.toContain("Human control");
    expect(document.body.textContent).not.toContain("Agent controlling browser");
    mocks.controller = "agent";
    await screen.rerender(view());
    expect(document.body.textContent).toContain("Agent controlling browser");
  });
  it("opens the active browser in its thread, closes the panel, and closes the floating preview on repeat", async () => {
    setup();
    const player = usePreviewMiniPlayerStore.getState();
    const open = vi.spyOn(player, "open");
    const close = vi.spyOn(player, "close");
    const closePanel = vi.spyOn(useRightPanelStore.getState(), "close");
    try {
      await using _screen = await render(view());
      await expect
        .element(page.getByRole("button", { name: "Float preview over chat" }))
        .toHaveAttribute("aria-pressed", "false");
      await userEvent.click(page.getByRole("button", { name: "Float preview over chat" }));
      expect(open).toHaveBeenCalledWith(TEST_THREAD_REF, { kind: "browser", tabId: "tab-1" });
      expect(closePanel).toHaveBeenCalledWith(TEST_THREAD_REF);
      const closeButton = page.getByRole("button", { name: "Close floating preview" });
      await expect.element(closeButton).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(closeButton);
      expect(close).toHaveBeenCalledWith(TEST_THREAD_REF);
    } finally {
      open.mockRestore();
      close.mockRestore();
      closePanel.mockRestore();
    }
  });
  // SCIENT-FORK:END

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    setup();
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await using screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await screen.rerender(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await screen.rerender(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    setup();
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await using _screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });
});

// SCIENT-FORK:START
vi.mock(import("~/scient/documentExport/browserPdfExportOwner"), async (original) => ({
  ...(await original()),
  useBrowserPdfExportOwner: () => mocks.pdfOwner,
}));
vi.mock(import("~/scient/pdf/ScientPreviewExportActions"), () => ({
  ScientPreviewExportActions: (props: { disabled: boolean }) => {
    mocks.exportDisabled = props.disabled;
    return <span data-export-actions-mock />;
  },
}));
// SCIENT-FORK:END
