// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited chat-markdown seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

// ChatMarkdown's image renderer calls the Scient image gates in scientMarkdownImage.
const chatMarkdownSource = [
  NodeFS.readFileSync(new URL("../../components/ChatMarkdown.tsx", import.meta.url), "utf8"),
  NodeFS.readFileSync(new URL("./scientMarkdownImage.tsx", import.meta.url), "utf8"),
].join("\n");
const imageCardSource = NodeFS.readFileSync(
  new URL("./ScientInlineWorkspaceImage.tsx", import.meta.url),
  "utf8",
);

describe("ChatMarkdown workspace-image seam", () => {
  it("mounts one of each Scient-owned image component", () => {
    expect(chatMarkdownSource).toContain("ScientInlineWorkspaceImage,");
    expect(chatMarkdownSource).toContain("ScientPendingWorkspaceImage,");
    expect(chatMarkdownSource.match(/<ScientInlineWorkspaceImage/gu)).toHaveLength(1);
    expect(chatMarkdownSource.match(/<ScientPendingWorkspaceImage/gu)).toHaveLength(1);
    expect(chatMarkdownSource.match(/<ScientRemoteImageReference/gu)).toHaveLength(1);
  });

  // regression: e34e687915 fix(chat): make rich media reliable and copyable
  it("uses authorized asset URLs and never executes SVG as document markup", () => {
    expect(imageCardSource).toContain("useAssetUrlState(props.threadRef.environmentId, resource)");
    expect(imageCardSource).toContain("<img");
    expect(imageCardSource).not.toContain("dangerouslySetInnerHTML");
    expect(imageCardSource).not.toContain("<iframe");
  });
});
