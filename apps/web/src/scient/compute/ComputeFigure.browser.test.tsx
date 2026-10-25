import { render as _fixtureRender, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
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
async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  const pixels = document.createElement("canvas");
  pixels.width = 640;
  pixels.height = 480;
  _fixture.imageUrl = pixels.toDataURL("image/png");
  asset = {
    _tag: "Success",
    url: _fixture.imageUrl,
    expiresAt: 1000,
    refresh: mocks.retry,
  };
  mocks.refresh.mockResolvedValue("https://synthetic.test/refreshed");
}
async function _cleanupFixture1(_fixture: _Fixture) {
  vi.unstubAllGlobals();
}
async function fixture(_fixture: _Fixture, initial = figure(), observedProjectFile = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const holdLoad = (event: Event) => {
    if (event.target instanceof HTMLImageElement && !_fixture.readyImages.has(event.target)) {
      event.stopImmediatePropagation();
    }
  };
  container.addEventListener("load", holdLoad, true);
  _fixture.stack.defer(() => container.removeEventListener("load", holdLoad, true));
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: container, router: false }),
  );
  const render = async (presentation = initial) => {
    await act(
      async () =>
        await root.rerender(
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
function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function loaded(_fixture: _Fixture, container: HTMLElement) {
  const img = container.querySelector("img")!;
  await img.decode();
  expect(img.naturalWidth).toBe(640);
  expect(img.naturalHeight).toBe(480);
  _fixture.readyImages.add(img);
  await act(() => {
    img.src = img.src;
  });
  await vi.waitFor(() => expect(button("View Figure 1", container).disabled).toBe(false));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const original = figure();
    const presentation = { ...original, viewer: original.inline };
    const { container } = await fixture(_fixture, presentation);
    await loaded(_fixture, container);
    await act(() => button("View Figure 1").click());
    expect(mocks.open).toHaveBeenCalledWith(threadRef, presentation.inline);
  });

  it("keeps download state and failures across signed URL renewal", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { container, render } = await fixture(_fixture);
    await loaded(_fixture, container);
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
      url: `${_fixture.imageUrl}#renewed`,
      expiresAt: 2000,
      refresh: mocks.retry,
    };
    await render();
    await act(async () => reject(new Error("Download interrupted")));
    expect(container.textContent).toContain("Download interrupted");
    await loaded(_fixture, container);
    expect(button("View Figure 1").disabled).toBe(false);
  });

  it("isolates failures between peer figures", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const first = await fixture(_fixture, figure("sha256:first"));
    const second = await fixture(_fixture, figure("sha256:second"));
    await loaded(_fixture, second.container);
    await act(() => first.container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(first.container.textContent).toContain("Figure preview unavailable");
    expect(second.container.textContent).not.toContain("Figure preview unavailable");
    expect(
      second.container.querySelector<HTMLButtonElement>('button[aria-label="View Figure 1"]')!
        .disabled,
    ).toBe(false);
  });

  it("waits for image decoding, then opens the existing following viewer directly", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const presentation = figure();
    const { container } = await fixture(_fixture, presentation);
    expect(button("View Figure 1").disabled).toBe(true);
    expect(container.textContent).toContain("Loading figure");
    await loaded(_fixture, container);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // regression: 92bd49cd55 fix(compute): attach figure actions to card header
    const { container } = await fixture(_fixture);
    const card = container.querySelector<HTMLElement>("[data-scient-visual-card]")!;
    const header = container.querySelector<HTMLElement>("[data-scient-compute-figure-header]")!;
    const body = container.querySelector<HTMLElement>("[data-scient-compute-figure-body]")!;
    expect([...card.children]).toEqual([header, body]);
    expect(header.querySelector("[aria-label='Figure actions']")?.getAttribute("role")).toBe(
      "group",
    );
    expect(container.querySelector("[data-scient-toolbar-move]")).toBeNull();
    expect(header.querySelector("[role=status]")).toBeNull();
    expect(body.querySelector("[role=status]")?.textContent).toContain("Loading figure");
  });
  it("retries decoding even when the signed URL does not change", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { container } = await fixture(_fixture);
    const old = container.querySelector("img")!;
    await act(() => old.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("Figure preview unavailable");
    await act(() => button("Try again").click());
    expect(mocks.retry).toHaveBeenCalledOnce();
    expect(container.querySelector("img")).not.toBe(old);
    await loaded(_fixture, container);
    await act(() => old.dispatchEvent(new Event("error")));
    expect(button("View Figure 1").disabled).toBe(false);
  });
  it("isolates resource revisions even if the server returns the same URL", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { container, render } = await fixture(_fixture);
    const old = await loaded(_fixture, container);
    await render(figure("sha256:two"));
    expect(button("View Figure 1").disabled).toBe(true);
    await act(() => old.dispatchEvent(new Event("load")));
    expect(button("View Figure 1").disabled).toBe(true);
    await loaded(_fixture, container);
    expect(button("View Figure 1").disabled).toBe(false);
  });
  it("keeps original and native downloads usable after preview failure and resolves each exact resource on demand", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const presentation = figure("sha256:one", true);
    const { container } = await fixture(_fixture, presentation);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { container } = await fixture(_fixture);
    await loaded(_fixture, container);
    await menu();
    await choose("Copy image");
    expect(mocks.copy).toHaveBeenCalledOnce();
    await expect(mocks.copy.mock.calls[0]![0]).resolves.toBe("https://synthetic.test/refreshed");
  });
  it("shows download failure locally without losing the decoded image", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { container } = await fixture(_fixture);
    await loaded(_fixture, container);
    mocks.refresh.mockResolvedValueOnce(null);
    await menu();
    await choose("Download original");
    expect(container.textContent).toContain("Reconnect and try again");
    expect(button("View Figure 1").disabled).toBe(false);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("keeps observed-file provenance in overflow metadata instead of the command group", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { container } = await fixture(_fixture, figure(), true);
    expect(container.querySelector("[role=note]")).toBeNull();
    expect(container.querySelector('[data-slot="compact-command-group-separator"]')).toBeNull();
    expect(container.textContent).not.toContain("Observed project file");
    await menu();
    expect(document.body.textContent).toContain("Observed project file; creator not verified");
  });
  it("offers retry for URL resolution failure without mounting a broken image", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    asset = { _tag: "Failure", refresh: mocks.retry };
    const { container, render } = await fixture(_fixture);
    expect(container.querySelector("img")).toBeNull();
    await act(() => button("Try again").click());
    expect(mocks.retry).toHaveBeenCalledOnce();
    asset = {
      _tag: "Success",
      url: _fixture.imageUrl,
      expiresAt: 1000,
      refresh: mocks.retry,
    };
    await render();
    await loaded(_fixture, container);
    expect(button("View Figure 1").disabled).toBe(false);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    imageUrl: "",
    readyImages: new WeakSet<HTMLImageElement>(),
    stack,
    cleanup,
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
