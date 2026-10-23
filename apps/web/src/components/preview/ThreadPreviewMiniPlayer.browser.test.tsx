import { RegistryContext } from "@effect/atom-react";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  applyPreviewServerEvent,
  previewStateAtom,
  readThreadPreviewState,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import "../../index.css";
import { page } from "vitest/browser";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, ThreadId, PreviewTabId, FILL_PREVIEW_VIEWPORT } from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";

const mocks = vi.hoisted(() => ({
  openArtifact: vi.fn(),
  openBrowser: vi.fn(),
}));
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

const threadRef = scopeThreadRef(EnvironmentId.make("fixture"), ThreadId.make("thread"));
const artifact: PreviewStaticImageSurfaceDescriptor = {
  surfaceId: "figure",
  label: "Figure",
  fileName: "figure.png",
  mediaType: "image/png",
  sourcePath: "figure.png",
  resource: { _tag: "workspace-file", cwd: "/fixture", relativePath: "figure.png" },
};

async function _setupFixture0(_fixture: _Fixture) {
  const previousViewport = { width: innerWidth, height: innerHeight };
  _fixture.stack.defer(() => page.viewport(previousViewport.width, previousViewport.height));
  await page.viewport(1000, 700);
  const previousPreview = readThreadPreviewState(threadRef);
  _fixture.stack.defer(() =>
    appAtomRegistry.set(previewStateAtom(scopedThreadKey(threadRef)), previousPreview),
  );
  const previousMiniPlayer = usePreviewMiniPlayerStore.getState();
  _fixture.stack.defer(() => usePreviewMiniPlayerStore.setState(previousMiniPlayer, true));
  _fixture.stack.use(
    vi
      .spyOn(useRightPanelStore.getState(), "openScientArtifact")
      .mockImplementation(mocks.openArtifact),
  );
  _fixture.stack.use(
    vi.spyOn(useRightPanelStore.getState(), "openBrowser").mockImplementation(mocks.openBrowser),
  );
  mocks.openArtifact.mockReset();
  mocks.openBrowser.mockReset();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  _fixture.container = document.createElement("div");
  _fixture.container.style.cssText = "width:1000px;height:700px";
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
const render = async (_fixture: _Fixture) => {
  const miniPlayer = selectThreadPreviewMiniPlayer(
    usePreviewMiniPlayerStore.getState().byThreadKey,
    threadRef,
  );
  await act(async () => {
    await _fixture.root0.rerender(
      <RegistryContext.Provider value={appAtomRegistry}>
        {miniPlayer ? (
          <ThreadPreviewMiniPlayer
            key={
              Object.keys(readThreadPreviewState(threadRef).sessions).length ? "ready" : "pending"
            }
            threadRef={threadRef}
            miniPlayer={miniPlayer}
            composerOverlayElement={null}
          />
        ) : null}
      </RegistryContext.Provider>,
    );
    await Promise.resolve();
  });
};
const player = () => document.querySelector<HTMLElement>("[data-preview-mini-player]");
async function key(target: Element, key: string) {
  await act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

it("measures and mounts a browser surface when its session arrives after the first render", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  usePreviewMiniPlayerStore.getState().open(threadRef, { kind: "browser", tabId: "browser" });
  await render(_fixture);
  expect(player()).toBeNull();
  await act(() =>
    applyPreviewServerEvent(threadRef, {
      type: "opened",
      threadId: threadRef.threadId,
      tabId: PreviewTabId.make("browser"),
      snapshot: {
        threadId: threadRef.threadId,
        tabId: PreviewTabId.make("browser"),
        viewport: FILL_PREVIEW_VIEWPORT,
        navStatus: { _tag: "Success", url: "about:blank", title: "" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-10-20T00:00:00.000Z",
      },
      serverEpoch: "fixture-epoch",
      revision: 1,
      createdAt: "2026-10-20T00:00:00.000Z",
    }),
  );
  await render(_fixture);
  expect(_fixture.container.querySelector("[data-browser-surface]")).not.toBeNull();
  expect(parseFloat(player()!.style.top) + parseFloat(player()!.style.height)).toBeLessThanOrEqual(
    500,
  );
});

it("keeps artifact sizing independent and supports keyboard move, resize, and panel handoff", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  usePreviewMiniPlayerStore.getState().openArtifact(threadRef, artifact);
  await render(_fixture);
  expect(_fixture.container.querySelector("[data-artifact-surface]")).toBeNull();
  expect(document.querySelector("[data-artifact-surface]")).not.toBeNull();
  const originalX = parseFloat(player()!.style.left);
  const originalHeight = player()!.style.height;
  await key(document.querySelector('[role="toolbar"]')!, "ArrowRight");
  await render(_fixture);
  expect(parseFloat(player()!.style.left)).toBe(originalX + 8);
  await key(document.querySelector('[data-preview-mini-player-resize="east"]')!, "ArrowRight");
  await render(_fixture);
  expect(player()!.style.width).toBe("412px");
  expect(player()!.style.height).toBe(originalHeight);
  await act(() =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Open preview in right panel"]')!
      .click(),
  );
  await render(_fixture);
  expect(mocks.openArtifact).toHaveBeenCalledWith(threadRef, artifact);
  expect(mocks.openBrowser).not.toHaveBeenCalled();
  expect(player()).toBeNull();
});

it("closes the shared floating surface with Escape without leaving a portal behind", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  usePreviewMiniPlayerStore.getState().openArtifact(threadRef, artifact);
  await render(_fixture);
  await key(document.querySelector('[role="toolbar"]')!, "Escape");
  await render(_fixture);
  expect(player()).toBeNull();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
