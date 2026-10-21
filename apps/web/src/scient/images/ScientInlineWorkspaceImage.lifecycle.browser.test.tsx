import "../../index.css";
import { render as _fixtureRender, act } from "../../../test/render";

import { EnvironmentId, ThreadId, type AssetImageDimensions } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

const asset = vi.hoisted(() => ({
  url: "",
  failed: false,
  dimensions: undefined as AssetImageDimensions | undefined,
  refresh: vi.fn(),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () =>
    asset.failed
      ? { _tag: "Failure", refresh: asset.refresh }
      : {
          _tag: "Success",
          url: asset.url,
          imageDimensions: asset.dimensions,
          expiresAt: 0,
          refresh: asset.refresh,
        },
}));
vi.mock("~/components/media/MediaActions", () => ({
  useMediaActionUrl: () => async () => asset.url,
}));

import { ScientInlineWorkspaceImage } from "./ScientInlineWorkspaceImage";

const imageUrl = (token: string) => {
  const [width, height] = token === "initial" ? [720, 1400] : [1400, 720];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><metadata>${token}</metadata><rect width="${width}" height="${height}" fill="black"/></svg>`)}`;
};
async function _setupFixture0(_fixture: _Fixture) {
  asset.url = imageUrl("initial");
  asset.failed = false;
  asset.dimensions = undefined;
  asset.refresh.mockClear();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  for (const cleanup of _fixture.cleanups.splice(0)) await cleanup();
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

describe("workspace file image display lifetime", () => {
  it("keeps decorative file images unnamed while retaining useful action names and chat labels", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.cleanups.push(async () => {
      await act(async () => await root.unmount());
    });
    const image = {
      absolutePath: "/workspace/decoration.png",
      alt: "decoration.png",
      displayPath: "decoration.png",
      fileName: "decoration.png",
      relativePath: "decoration.png",
      source: "decoration.png",
      workspaceRoot: "/workspace",
    };
    const render = async (filePresentation: boolean) =>
      await act(
        async () =>
          await root.rerender(
            <ScientInlineWorkspaceImage
              image={image}
              threadRef={{
                environmentId: EnvironmentId.make("environment-a"),
                threadId: ThreadId.make("thread-a"),
              }}
              markdownSource="![](decoration.png)"
              authoredAlt=""
              filePresentation={filePresentation}
            />,
          ),
      );
    await render(true);
    expect(host.querySelector('[role="figure"]')?.hasAttribute("aria-label")).toBe(false);
    expect(host.querySelector<HTMLImageElement>("img")?.alt).toBe("");
    expect(host.querySelector('button[aria-label="More image actions"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Expand decoration.png"]')).not.toBeNull();
    await render(false);
    expect(host.querySelector('[role="figure"]')?.getAttribute("aria-label")).toBe(
      "decoration.png",
    );
  });

  it("retains loaded pixels through capability refresh/failure and resets only on retry or source identity", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    asset.dimensions = { width: 720, height: 1400 };
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.cleanups.push(async () => {
      await act(async () => await root.unmount());
    });
    const image = {
      absolutePath: "/workspace/figure.png",
      alt: "Figure",
      displayPath: "figure.png",
      fileName: "figure.png",
      relativePath: "figure.png",
      source: "figure.png",
      workspaceRoot: "/workspace",
    };
    const render = async (thread = "thread-a", fragment = "") =>
      await act(
        async () =>
          await root.rerender(
            <ScientInlineWorkspaceImage
              image={image}
              threadRef={{
                environmentId: EnvironmentId.make("environment-a"),
                threadId: ThreadId.make(thread),
              }}
              markdownSource="![Figure](figure.png)"
              filePresentation
              srcFragment={fragment}
            />,
          ),
      );
    await render();
    const original = host.querySelector<HTMLImageElement>("img")!;
    const imageFrame = () => host.querySelector<HTMLElement>("[data-scient-visual-card]")!;
    expect(imageFrame().style.aspectRatio).toBe("720 / 1400");
    expect(original.getAttribute("width")).toBe("720");
    expect(original.getAttribute("height")).toBe("1400");
    await original.decode();
    expect(original.naturalWidth).toBe(720);
    expect(original.naturalHeight).toBe(1400);
    await expect.poll(() => host.textContent).not.toContain("Loading image…");
    asset.url = imageUrl("byte-action-token");
    asset.dimensions = { width: 1400, height: 720 };
    await render();
    expect(host.querySelector("img")).toBe(original);
    expect(original.src).toBe(imageUrl("initial"));
    expect(imageFrame().style.aspectRatio).toBe("720 / 1400");
    expect(host.textContent).not.toContain("Loading image…");
    asset.failed = true;
    await render();
    expect(host.querySelector("img")).toBe(original);
    expect(host.textContent).not.toContain("Unable to display this image");
    asset.failed = false;
    asset.url = imageUrl("retry-token");
    await render();
    await act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="More image actions"]')!.click(),
    );
    await act(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === "Refresh image")!
        .click(),
    );
    const retried = host.querySelector<HTMLImageElement>("img")!;
    expect(retried).not.toBe(original);
    expect(retried.src).toBe(imageUrl("retry-token"));
    expect(imageFrame().style.aspectRatio).toBe("1400 / 720");
    expect(asset.refresh).toHaveBeenCalledOnce();
    await retried.decode();
    await expect.poll(() => host.textContent).not.toContain("Loading image…");
    const holdNativeDelivery = (event: Event) => {
      if (
        event.isTrusted &&
        event.target instanceof HTMLImageElement &&
        host.contains(event.target)
      )
        event.stopImmediatePropagation();
    };
    document.addEventListener("load", holdNativeDelivery, true);
    document.addEventListener("error", holdNativeDelivery, true);
    using delivery = {
      [Symbol.dispose]() {
        document.removeEventListener("load", holdNativeDelivery, true);
        document.removeEventListener("error", holdNativeDelivery, true);
      },
    };
    await render("thread-b", "#detail");
    const relocated = host.querySelector<HTMLImageElement>("img")!;
    expect(relocated).not.toBe(retried);
    expect(relocated.src).toBe(`${imageUrl("retry-token")}#detail`);
    expect(host.textContent).toContain("Loading image…");
    await act(async () => {
      await relocated.decode();
      expect(relocated.naturalWidth).toBe(1400);
      expect(relocated.naturalHeight).toBe(720);
      delivery[Symbol.dispose]();
      relocated.dispatchEvent(new Event("load"));
    });
    await expect.poll(() => host.textContent).not.toContain("Loading image…");
    expect(host.querySelector("img")).toBe(relocated);
    expect(asset.refresh).toHaveBeenCalledOnce();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    cleanups: [] as Array<() => Promise<void>>,
    _ownedDOM: [] as Node[],

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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
