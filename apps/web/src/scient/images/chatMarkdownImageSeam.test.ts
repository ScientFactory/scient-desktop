// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const chatMarkdownSource = NodeFS.readFileSync(
  new URL("../../components/ChatMarkdown.tsx", import.meta.url),
  "utf8",
);
const imageCardSource = NodeFS.readFileSync(
  new URL("./ScientInlineWorkspaceImage.tsx", import.meta.url),
  "utf8",
);

describe("ChatMarkdown workspace-image seam", () => {
  it("mounts one Scient-owned inline image component", () => {
    expect(chatMarkdownSource).toContain("ScientInlineWorkspaceImage,");
    expect(chatMarkdownSource).toContain("ScientPendingWorkspaceImage,");
    expect(chatMarkdownSource.match(/<ScientInlineWorkspaceImage/gu)).toHaveLength(1);
    expect(chatMarkdownSource.match(/<ScientPendingWorkspaceImage/gu)).toHaveLength(1);
  });

  it("uses a stable local-image card while streaming and preserves ordinary images", () => {
    expect(chatMarkdownSource).toContain("resolveInlineWorkspaceImage({ alt, cwd, src })");
    expect(chatMarkdownSource).toContain('reason={isStreaming ? "streaming" : "unavailable"}');
    expect(chatMarkdownSource).toContain("classifyMarkdownImageSource(srcString, cwd)");
    expect(chatMarkdownSource).toContain("<ChatMarkdownWorkspaceImage");
    expect(chatMarkdownSource).toContain("<ChatMarkdownImageFallback");
  });

  it("uses authorized asset URLs and never executes SVG as document markup", () => {
    expect(imageCardSource).toContain("useAssetUrlState(props.threadRef.environmentId, resource)");
    expect(imageCardSource).toContain("<img");
    expect(imageCardSource).not.toContain("dangerouslySetInnerHTML");
    expect(imageCardSource).not.toContain("<iframe");
  });
});
