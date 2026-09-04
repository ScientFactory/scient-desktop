// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const asset = vi.hoisted(() => ({
  url: "https://signed.test/initial",
  failed: false,
  refresh: vi.fn(),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () =>
    asset.failed
      ? { _tag: "Failure", refresh: asset.refresh }
      : { _tag: "Success", url: asset.url, expiresAt: 0, refresh: asset.refresh },
}));
vi.mock("~/components/media/MediaActions", () => ({
  useMediaActionUrl: () => async () => asset.url,
}));

import { ScientInlineWorkspaceImage } from "./ScientInlineWorkspaceImage";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  asset.url = "https://signed.test/initial";
  asset.failed = false;
  asset.refresh.mockClear();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("workspace file image display lifetime", () => {
  it("keeps decorative file images unnamed while retaining useful action names and chat labels", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(async () => {
      await act(() => root.unmount());
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
      act(() =>
        root.render(
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
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(async () => {
      await act(() => root.unmount());
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
      act(() =>
        root.render(
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
    await act(() => original.dispatchEvent(new Event("load")));
    asset.url = "https://signed.test/byte-action-token";
    await render();
    expect(host.querySelector("img")).toBe(original);
    expect(original.src).toBe("https://signed.test/initial");
    expect(host.textContent).not.toContain("Loading image…");
    asset.failed = true;
    await render();
    expect(host.querySelector("img")).toBe(original);
    expect(host.textContent).not.toContain("Unable to display this image");
    asset.failed = false;
    asset.url = "https://signed.test/retry-token";
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
    expect(retried.src).toBe("https://signed.test/retry-token");
    expect(asset.refresh).toHaveBeenCalledOnce();
    await act(() => retried.dispatchEvent(new Event("load")));
    await render("thread-b", "#detail");
    const relocated = host.querySelector<HTMLImageElement>("img")!;
    expect(relocated).not.toBe(retried);
    expect(relocated.src).toBe("https://signed.test/retry-token#detail");
    expect(host.textContent).toContain("Loading image…");
  });
});
