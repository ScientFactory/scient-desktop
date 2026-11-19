import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);

const assetState = vi.hoisted(() => ({
  lastEnvironmentId: null as unknown,
  lastResource: null as unknown,
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown) => {
    assetState.lastEnvironmentId = environmentId;
    assetState.lastResource = resource;
    return {
      _tag: "Success" as const,
      expiresAt: Date.now() + 60_000,
      refresh: () => undefined,
      url: "https://environment.test/api/assets/figure.svg",
    };
  },
}));

import {
  nextInlineImageBackground,
  ScientInlineWorkspaceImage,
  ScientPendingWorkspaceImage,
} from "./ScientInlineWorkspaceImage";

describe("inline workspace image presentation", () => {
  it("cycles through automatic, light, and dark inspection backgrounds", () => {
    expect(nextInlineImageBackground("automatic")).toBe("light");
    expect(nextInlineImageBackground("light")).toBe("dark");
    expect(nextInlineImageBackground("dark")).toBe("automatic");
  });

  it("renders a source-preserving, accessible loading card through a rooted asset resource", () => {
    const markup = renderToStaticMarkup(
      <ScientInlineWorkspaceImage
        image={{
          absolutePath: "/workspace/project/figures/result.svg",
          alt: "Treatment response by week",
          displayPath: "figures/result.svg",
          fileName: "result.svg",
          relativePath: "figures/result.svg",
          source: "figures/result.svg",
          workspaceRoot: "/workspace/project",
        }}
        markdownSource="![Treatment response by week](figures/result.svg)"
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
      />,
    );

    expect(markup).toContain("data-scient-inline-workspace-image");
    expect(markup).toContain('role="figure"');
    expect(markup).toContain("Treatment response by week");
    expect(markup).toContain("figures/result.svg");
    expect(markup).toContain("Loading image…");
    expect(markup).not.toContain("iframe");
    expect(assetState.lastEnvironmentId).toBe("environment-1");
    expect(assetState.lastResource).toEqual({
      _tag: "workspace-file",
      cwd: "/workspace/project",
      relativePath: "figures/result.svg",
      threadId: "thread-1",
      path: "/workspace/project/figures/result.svg",
    });
  });

  it("keeps local image identity visible while streaming without loading raw file URLs", () => {
    const markup = renderToStaticMarkup(
      <ScientPendingWorkspaceImage
        image={{
          absolutePath: "/workspace/project/figures/result.svg",
          alt: "Treatment response by week",
          displayPath: "figures/result.svg",
          fileName: "result.svg",
          relativePath: "figures/result.svg",
          source: "figures/result.svg",
          workspaceRoot: "/workspace/project",
        }}
        markdownSource="![Treatment response by week](figures/result.svg)"
        reason="streaming"
      />,
    );

    expect(markup).toContain('data-scient-inline-workspace-image-pending="streaming"');
    expect(markup).toContain("Image preview will appear when this response finishes.");
    expect(markup).not.toContain("/workspace/project/figures/result.svg");
  });
});
