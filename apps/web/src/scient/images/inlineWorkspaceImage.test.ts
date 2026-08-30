import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  inlineImageFormatLabel,
  inlineWorkspaceImageMarkdownSource,
  inlineWorkspaceImageResource,
  resolveInlineWorkspaceImage,
} from "./inlineWorkspaceImage";

describe("inline workspace image resolution", () => {
  it.each([
    ["figures/result.png", "figures/result.png", "PNG"],
    ["./figures/result.SVG", "figures/result.SVG", "SVG"],
    ["plots/photo.jpeg", "plots/photo.jpeg", "JPEG"],
    ["plots/animation.gif?revision=2", "plots/animation.gif", "GIF"],
    ["plots/microscopy.webp", "plots/microscopy.webp", "WEBP"],
    ["plots/capture.avif", "plots/capture.avif", "AVIF"],
    ["plots/app.ico", "plots/app.ico", "ICO"],
  ] as const)("resolves supported workspace image %s", (source, relativePath, format) => {
    const image = resolveInlineWorkspaceImage({
      alt: "Treatment response",
      cwd: "/workspace/project",
      src: source,
    });

    expect(image).toMatchObject({
      absolutePath: `/workspace/project/${relativePath}`,
      alt: "Treatment response",
      relativePath,
      workspaceRoot: "/workspace/project",
    });
    expect(inlineImageFormatLabel(image?.fileName ?? "")).toBe(format);
  });

  it("supports encoded spaces and falls back to the filename for empty alternative text", () => {
    expect(
      resolveInlineWorkspaceImage({
        alt: "",
        cwd: "/workspace/project",
        src: "figures/dose%20response.svg",
      }),
    ).toMatchObject({
      absolutePath: "/workspace/project/figures/dose response.svg",
      alt: "dose response.svg",
      relativePath: "figures/dose response.svg",
    });
  });

  it("does not capture remote, non-image, or outside-workspace destinations", () => {
    for (const src of [
      "https://example.test/figure.svg",
      "results/table.csv",
      "../outside/figure.png",
      "%2e%2e/outside/figure.png",
      "/tmp/outside/figure.png",
    ]) {
      expect(resolveInlineWorkspaceImage({ cwd: "/workspace/project", src })).toBeNull();
    }
  });

  it("normalizes rooted Windows image resources without making identity thread-specific", () => {
    expect(
      resolveInlineWorkspaceImage({
        cwd: "C:\\workspace\\project",
        src: "figures/result.svg",
      }),
    ).toMatchObject({
      absolutePath: "C:\\workspace\\project\\figures\\result.svg",
      relativePath: "figures/result.svg",
      workspaceRoot: "C:\\workspace\\project",
    });
  });

  it("creates a rooted resource while retaining the compatibility locator", () => {
    const image = resolveInlineWorkspaceImage({
      cwd: "/workspace/project",
      src: "figures/result.svg",
    });
    expect(image).not.toBeNull();
    if (!image) return;

    expect(
      inlineWorkspaceImageResource(image, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      _tag: "workspace-file",
      cwd: "/workspace/project",
      relativePath: "figures/result.svg",
      threadId: "thread-1",
      path: "/workspace/project/figures/result.svg",
    });
  });

  it("serializes a portable Markdown image when the rendered node has been normalized", () => {
    expect(inlineWorkspaceImageMarkdownSource("Dose [mg]", "figures/dose response.svg")).toBe(
      "![Dose \\[mg\\]](<figures/dose response.svg>)",
    );
    expect(
      inlineWorkspaceImageMarkdownSource(
        "Dose [mg]",
        "figures/dose response.svg",
        'Primary "analysis"',
      ),
    ).toBe('![Dose \\[mg\\]](<figures/dose response.svg> "Primary \\"analysis\\"")');
  });
});
