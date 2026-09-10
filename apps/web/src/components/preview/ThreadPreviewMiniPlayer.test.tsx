// @vitest-environment happy-dom
import { EnvironmentId, ThreadId, FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";

const mocks = vi.hoisted(() => ({
  ready: false,
  openArtifact: vi.fn(),
  openBrowser: vi.fn(),
}));
vi.mock("~/previewStateStore", () => ({
  useThreadPreviewState: () => ({
    serverEpoch: 1,
    sessions: mocks.ready ? { browser: { viewport: FILL_PREVIEW_VIEWPORT } } : {},
    desktopByTabId: {},
  }),
}));
vi.mock("~/browser/browserSurfaceStore", () => ({ useBrowserSurfaceStore: () => null }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: () => <div data-browser-surface />,
}));
vi.mock("./StaticAssetImageSurface", () => ({
  StaticAssetImageSurface: () => <div data-artifact-surface />,
}));
vi.mock("./StaticImageActionButtons", () => ({
  StaticImageCopyButton: () => null,
  StaticImageDownloadButton: () => null,
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrlState: () => ({ _tag: "Pending" }) }));
vi.mock("./previewBridge", () => ({ previewBridge: null }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openScientArtifact: mocks.openArtifact, openBrowser: mocks.openBrowser }),
  },
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
}));

const threadRef = scopeThreadRef(EnvironmentId.make("fixture"), ThreadId.make("thread"));
const artifact: PreviewStaticImageSurfaceDescriptor = {
  surfaceId: "figure",
  label: "Figure",
  fileName: "figure.png",
  mediaType: "image/png",
  sourcePath: "figure.png",
  resource: { _tag: "workspace-file", cwd: "/fixture", relativePath: "figure.png" },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  mocks.ready = false;
  mocks.openArtifact.mockReset();
  mocks.openBrowser.mockReset();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = () =>
  act(() => root.render(<ThreadPreviewMiniPlayer threadRef={threadRef} bottomInset={200} />));
const player = () => document.querySelector<HTMLElement>('[aria-label="Floating preview"]')!;
async function key(target: Element, key: string) {
  await act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

it("measures and mounts a browser surface when its session arrives after the first render", async () => {
  usePreviewMiniPlayerStore.getState().open(threadRef, "browser");
  await render();
  expect(player()).toBeNull();
  mocks.ready = true;
  await render();
  expect(container.querySelector("[data-browser-surface]")).not.toBeNull();
  expect(parseFloat(player().style.top) + parseFloat(player().style.height)).toBeLessThanOrEqual(
    500,
  );
});

it("keeps artifact sizing independent and supports keyboard move, resize, and panel handoff", async () => {
  usePreviewMiniPlayerStore.getState().openArtifact(threadRef, artifact);
  await render();
  expect(container.querySelector("[data-artifact-surface]")).toBeNull();
  expect(document.querySelector("[data-artifact-surface]")).not.toBeNull();
  const originalX = parseFloat(player().style.left);
  const originalHeight = player().style.height;
  await key(document.querySelector('[role="toolbar"]')!, "ArrowRight");
  expect(parseFloat(player().style.left)).toBe(originalX + 8);
  await key(document.querySelector('[data-preview-mini-player-resize="east"]')!, "ArrowRight");
  expect(player().style.width).toBe("412px");
  expect(player().style.height).toBe(originalHeight);
  await act(() =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Open preview in right panel"]')!
      .click(),
  );
  expect(mocks.openArtifact).toHaveBeenCalledWith(threadRef, artifact);
  expect(mocks.openBrowser).not.toHaveBeenCalled();
  expect(player()).toBeNull();
});

it("closes the shared floating surface with Escape without leaving a portal behind", async () => {
  usePreviewMiniPlayerStore.getState().openArtifact(threadRef, artifact);
  await render();
  await key(document.querySelector('[role="toolbar"]')!, "Escape");
  expect(player()).toBeNull();
});
