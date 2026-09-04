import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownImageSource } from "./markdownImageSource";

const context = {
  cwd: "/workspace/project",
  documentPath: "notes/report.md",
  threadRef: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread") },
};

describe("Markdown image display/action identity", () => {
  it("resolves from the document directory and keeps fragments out of byte capabilities", () => {
    const result = resolveMarkdownImageSource("../figures/dose%20response.svg#panel", context);
    expect(result).toMatchObject({
      kind: "workspace",
      relativePath: "figures/dose response.svg",
      suffix: "#panel",
      fileName: "dose response.svg",
      absolutePath: "/workspace/project/figures/dose response.svg",
      resource: {
        _tag: "workspace-file",
        cwd: context.cwd,
        relativePath: "figures/dose response.svg",
        path: "/workspace/project/figures/dose response.svg",
        threadId: context.threadRef.threadId,
      },
    });
  });

  it("keeps direct images outside workspace-file authority", () => {
    expect(resolveMarkdownImageSource("https://example.test/plot.svg#panel", context)).toEqual({
      kind: "direct",
      url: "https://example.test/plot.svg#panel",
      fileName: "plot.svg",
    });
    expect(resolveMarkdownImageSource("data:image/svg+xml;base64,PHN2Zy8+", context)).toEqual({
      kind: "direct",
      url: "data:image/svg+xml;base64,PHN2Zy8+",
      fileName: "image.svg",
    });
  });

  it.each([
    "../../secret.png",
    "%2e%2e/%2e%2e/secret.png",
    "/tmp/secret.png",
    "file:///tmp/secret.png",
    "javascript:alert(1)",
    "http://example.test/image.png",
    "https://",
    "%00.png",
  ])("does not broaden image access for %s", (source) => {
    expect(resolveMarkdownImageSource(source, context)).toBeNull();
  });

  it("does not decode an authored encoded percent twice", () => {
    expect(resolveMarkdownImageSource("./literal%2520.png", context)).toMatchObject({
      kind: "workspace",
      relativePath: "notes/literal%20.png",
    });
  });

  it.each([
    ["/workspace/project", "/workspace/project/~/photo.png"],
    ["C:\\workspace\\project", "C:\\workspace\\project\\~\\photo.png"],
  ])("copies the exact rooted file path under %s without shell expansion", (cwd, absolutePath) => {
    expect(
      resolveMarkdownImageSource("~/photo.png", { ...context, cwd, documentPath: "note.md" }),
    ).toMatchObject({
      kind: "workspace",
      relativePath: "~/photo.png",
      absolutePath,
      resource: { cwd, relativePath: "~/photo.png", path: absolutePath },
    });
  });
});
