// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeProjectId,
  ComputeSessionId,
  ComputeExecutionId,
  EnvironmentId,
  type AssetResource,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AssetUrlState } from "~/assets/assetUrls";
import type { ComputeFigurePresentation } from "./computeFigurePresentation";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  copy: vi.fn(),
  download: vi.fn(),
  native: vi.fn(),
  open: vi.fn(),
  float: vi.fn(),
  retry: vi.fn(),
}));
let asset: AssetUrlState;
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => asset,
  useAssetUrlRefresh: (env: EnvironmentId, resource: AssetResource | null) => () =>
    mocks.refresh(env, resource),
}));
vi.mock("~/components/preview/staticImageActions", () => ({
  copyStaticImage: mocks.copy,
  downloadStaticImage: mocks.download,
}));
vi.mock("./ComputeOutputViewDownload", () => ({ downloadComputeNativeFigure: mocks.native }));
vi.mock("~/scient/artifacts/staticArtifactViewerActions", () => ({
  openStaticArtifactInPanel: mocks.open,
  toggleStaticArtifactFloating: mocks.float,
}));
vi.mock("~/previewMiniPlayerStore", () => ({
  usePreviewMiniPlayerStore: (select: (state: unknown) => unknown) => select({ byThreadKey: {} }),
  selectThreadPreviewMiniPlayer: () => null,
}));

import { ComputeFigure } from "./ComputeFigure";

const environmentId = EnvironmentId.make("remote-host");
const threadRef = {} as ScopedThreadRef;
function figure(hash = "sha256:one", native = false): ComputeFigurePresentation {
  const resource = {
    _tag: "compute-output" as const,
    projectId: ComputeProjectId.make("project"),
    sessionId: ComputeSessionId.make("session"),
    executionId: ComputeExecutionId.make("execution"),
    contentHash: hash,
  };
  const inline = {
    surfaceId: `snapshot:${hash}`,
    contentKey: hash,
    resource,
    label: "Figure 1",
    fileName: "figure-1.png",
    mediaType: "image/png" as const,
    sourcePath: "plot.m",
  };
  return {
    inline,
    viewer: { ...inline, surfaceId: "following:figure-1" },
    reference: {
      _tag: "snapshot",
      projectId: resource.projectId,
      sessionId: resource.sessionId,
      executionId: resource.executionId,
      contentHash: hash,
    },
    nativeDownload: native
      ? {
          resource: { ...resource, contentHash: "sha256:native" },
          fileName: "figure-1.fig",
          byteLength: 16,
        }
      : null,
  };
}
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  asset = {
    _tag: "Success",
    url: "https://synthetic.test/image",
    expiresAt: 1000,
    refresh: mocks.retry,
  };
  mocks.refresh.mockResolvedValue("https://synthetic.test/refreshed");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function fixture(initial = figure(), observedProjectFile = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(() => root.unmount());
  });
  const render = async (presentation = initial) => {
    await act(() =>
      root.render(
        <ComputeFigure
          presentation={presentation}
          environmentId={environmentId}
          threadRef={threadRef}
          observedProjectFile={observedProjectFile}
        />,
      ),
    );
  };
  await render();
  return { container, render };
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function loaded(container: HTMLElement) {
  const img = container.querySelector("img")!;
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: 640 });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: 480 });
  await act(() => img.dispatchEvent(new Event("load")));
  return img;
}
async function menu() {
  await act(() => button("More image actions").click());
}
async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
    (item) => item.textContent === label,
  );
  if (!item) throw new Error(`Missing action: ${label}`);
  await act(() => item.click());
}

describe("compute figure presentation", () => {
  it("keeps a historical viewer on its immutable snapshot", async () => {
    const original = figure();
    const presentation = { ...original, viewer: original.inline };
    const { container } = await fixture(presentation);
    await loaded(container);
    await act(() => button("View Figure 1").click());
    expect(mocks.open).toHaveBeenCalledWith(threadRef, presentation.inline);
  });

  it("keeps download state and failures across signed URL renewal", async () => {
    const { container, render } = await fixture();
    await loaded(container);
    let reject!: (error: Error) => void;
    mocks.download.mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    await menu();
    await choose("Download original");
    asset = {
      _tag: "Success",
      url: "https://synthetic.test/renewed",
      expiresAt: 2000,
      refresh: mocks.retry,
    };
    await render();
    await act(async () => reject(new Error("Download interrupted")));
    expect(container.textContent).toContain("Download interrupted");
    await loaded(container);
    expect(button("View Figure 1").disabled).toBe(false);
  });

  it("isolates failures between peer figures", async () => {
    const first = await fixture(figure("sha256:first"));
    const second = await fixture(figure("sha256:second"));
    await loaded(second.container);
    await act(() => first.container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(first.container.textContent).toContain("Figure preview unavailable");
    expect(second.container.textContent).not.toContain("Figure preview unavailable");
    expect(
      second.container.querySelector<HTMLButtonElement>('button[aria-label="View Figure 1"]')!
        .disabled,
    ).toBe(false);
  });

  it("waits for image decoding, then opens the existing following viewer directly", async () => {
    const presentation = figure();
    const { container } = await fixture(presentation);
    const card = container.querySelector<HTMLElement>("[data-scient-visual-card]")!;
    const header = container.querySelector<HTMLElement>("[data-scient-compute-figure-header]")!;
    const toolbar = container.querySelector<HTMLElement>("[aria-label='Figure actions']")!;
    expect(card.classList.contains("flex-col")).toBe(true);
    expect(card.classList.contains("overflow-hidden")).toBe(true);
    expect(header.classList.contains("h-6.5")).toBe(true);
    expect(header.classList.contains("border-b")).toBe(true);
    expect(header.textContent).toContain("Figure 1");
    expect(toolbar.getAttribute("role")).toBe("group");
    expect(toolbar.dataset.slot).toBeUndefined();
    expect(container.querySelector("[data-scient-toolbar-move]")).toBeNull();
    expect(button("Open Figure 1 in viewer").classList.contains("size-5.5")).toBe(true);
    expect(button("More image actions").classList.contains("size-5.5")).toBe(true);
    for (const label of ["Open Figure 1 in viewer", "More image actions"]) {
      const classes = button(label).classList;
      expect(classes.contains("rounded-xs")).toBe(true);
      expect(classes.contains("text-muted-foreground")).toBe(true);
      expect(button(label).dataset.variant).toBe("ghost-muted");
      expect(classes.contains("sm:size-6")).toBe(false);
    }
    expect(button("View Figure 1").disabled).toBe(true);
    expect(container.textContent).toContain("Loading figure");
    await loaded(container);
    await act(() => button("View Figure 1").click());
    expect(mocks.open).toHaveBeenCalledWith(threadRef, presentation.viewer);
    expect(container.textContent).not.toContain("Loading figure");
    expect(mocks.refresh).not.toHaveBeenCalled();
    await menu();
    expect(document.body.textContent).toContain("640 × 480");
    expect(document.body.textContent).not.toContain("Download MATLAB FIG");
    expect(document.body.textContent).not.toContain("Move controls");
  });
  it("keeps the fixed header separate from the loading figure body", async () => {
    const { container } = await fixture();
    const card = container.querySelector<HTMLElement>("[data-scient-visual-card]")!;
    const header = container.querySelector<HTMLElement>("[data-scient-compute-figure-header]")!;
    const body = container.querySelector<HTMLElement>("[data-scient-compute-figure-body]")!;
    expect([...card.children]).toEqual([header, body]);
    expect(body.classList.contains("h-32")).toBe(true);
    expect(body.classList.contains("w-64")).toBe(true);
    expect(header.querySelector("[role=status]")).toBeNull();
    expect(body.querySelector("[role=status]")?.textContent).toContain("Loading figure");
  });
  it("retries decoding even when the signed URL does not change", async () => {
    const { container } = await fixture();
    const old = container.querySelector("img")!;
    await act(() => old.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("Figure preview unavailable");
    await act(() => button("Try again").click());
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(container.querySelector("img")).not.toBe(old);
    await loaded(container);
    await act(() => old.dispatchEvent(new Event("error")));
    expect(button("View Figure 1").disabled).toBe(false);
  });
  it("isolates resource revisions even if the server returns the same URL", async () => {
    const { container, render } = await fixture();
    const old = await loaded(container);
    await render(figure("sha256:two"));
    expect(button("View Figure 1").disabled).toBe(true);
    await act(() => old.dispatchEvent(new Event("load")));
    expect(button("View Figure 1").disabled).toBe(true);
    await loaded(container);
    expect(button("View Figure 1").disabled).toBe(false);
  });
  it("keeps original and native downloads usable after preview failure and resolves each exact resource on demand", async () => {
    const presentation = figure("sha256:one", true);
    const { container } = await fixture(presentation);
    await act(() => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(mocks.refresh).not.toHaveBeenCalled();
    await menu();
    await choose("Download MATLAB FIG");
    expect(mocks.refresh).toHaveBeenCalledWith(
      environmentId,
      presentation.nativeDownload!.resource,
    );
    expect(mocks.native).toHaveBeenCalledWith(
      "https://synthetic.test/refreshed",
      presentation.nativeDownload,
    );
    await menu();
    await choose("Download original");
    expect(mocks.refresh).toHaveBeenCalledWith(environmentId, presentation.inline.resource);
    expect(mocks.download).toHaveBeenCalledWith("https://synthetic.test/refreshed", "figure-1.png");
  });
  it("starts copy within the action and supplies refreshed snapshot bytes, not the following resource", async () => {
    const { container } = await fixture();
    await loaded(container);
    await menu();
    await choose("Copy image");
    expect(mocks.copy).toHaveBeenCalledOnce();
    await expect(mocks.copy.mock.calls[0]![0]).resolves.toBe("https://synthetic.test/refreshed");
  });
  it("shows download failure locally without losing the decoded image", async () => {
    const { container } = await fixture();
    await loaded(container);
    mocks.refresh.mockResolvedValueOnce(null);
    await menu();
    await choose("Download original");
    expect(container.textContent).toContain("Reconnect and try again");
    expect(button("View Figure 1").disabled).toBe(false);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("keeps observed-file provenance in overflow metadata instead of the command group", async () => {
    const { container } = await fixture(figure(), true);
    expect(container.querySelector("[role=note]")).toBeNull();
    expect(container.querySelector('[data-slot="compact-command-group-separator"]')).toBeNull();
    expect(container.textContent).not.toContain("Observed project file");
    await menu();
    expect(document.body.textContent).toContain("Observed project file; creator not verified");
  });
  it("offers retry for URL resolution failure without mounting a broken image", async () => {
    asset = { _tag: "Failure", refresh: mocks.retry };
    const { container, render } = await fixture();
    expect(container.querySelector("img")).toBeNull();
    await act(() => button("Try again").click());
    expect(mocks.retry).toHaveBeenCalledOnce();
    asset = {
      _tag: "Success",
      url: "https://synthetic.test/image",
      expiresAt: 1000,
      refresh: mocks.retry,
    };
    await render();
    await loaded(container);
    expect(button("View Figure 1").disabled).toBe(false);
  });
});
