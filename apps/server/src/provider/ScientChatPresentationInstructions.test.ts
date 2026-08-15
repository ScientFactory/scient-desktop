import { describe, expect, it } from "vite-plus/test";

import { SCIENT_CHAT_PRESENTATION_INSTRUCTIONS } from "./ScientChatPresentationInstructions.js";

describe("Scient chat presentation instructions", () => {
  it("distinguishes the Mermaid card filename from its rendered title", () => {
    expect(SCIENT_CHAT_PRESENTATION_INSTRUCTIONS).toContain('title="study-design.mmd"');
    expect(SCIENT_CHAT_PRESENTATION_INSTRUCTIONS).toContain(
      "Mermaid's internal `title:` remains part of the rendered diagram",
    );
  });

  it("asks agents to size composed Vega-Lite views deliberately", () => {
    expect(SCIENT_CHAT_PRESENTATION_INSTRUCTIONS).toContain(
      "For facet, repeat, or concatenated views, choose explicit child dimensions",
    );
  });

  it("advertises the portable workspace-image contract without requiring a specialized tool", () => {
    expect(SCIENT_CHAT_PRESENTATION_INSTRUCTIONS).toContain(
      "supported workspace images referenced with ordinary Markdown image syntax",
    );
    expect(SCIENT_CHAT_PRESENTATION_INSTRUCTIONS).toContain(
      "reference it with a path relative to the current workspace",
    );
    expect(SCIENT_CHAT_PRESENTATION_INSTRUCTIONS).toContain(
      "Prefer SVG for vector figures and PNG for raster or pixel-based results",
    );
    expect(SCIENT_CHAT_PRESENTATION_INSTRUCTIONS).not.toContain("must use SVG");
  });
});
