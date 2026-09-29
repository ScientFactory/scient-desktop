/**
 * Diagrams drawn in the page itself (the PDF document page) against the real Mermaid, in a
 * real browser: a picture a diagram names outside the capture is never requested, the
 * diagram draws without it, and the address is reported for the export notes.
 */
import { describe, expect, it } from "vite-plus/test";

import { renderMermaidDiagram } from "./mermaidRuntime";

const PROBE = "__scient_page_diagram_probe__";

/** Probe loads that reached the server (refused loads get no status and no response time). */
const probeRequests = () =>
  (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => entry.name.includes(PROBE))
    .filter((entry) => entry.responseStatus !== 0 || entry.responseStart > 0)
    .map((entry) => entry.name);

describe("Mermaid drawn in the page", () => {
  it("draws an image shape without its outside picture and reports the address", async () => {
    const address = `/${PROBE}/shape.png`;
    const rendered = await renderMermaidDiagram(
      `flowchart LR\nA@{ img: "${address}", label: "Picture node", h: 40 } --> B`,
      "light",
      "page",
    );
    expect(rendered.svg).toContain("Picture node");
    expect(rendered.svg).not.toContain(PROBE);
    expect(rendered.blocked).toEqual([address]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(probeRequests()).toEqual([]);
  });

  it("gives the page its own image loading back after the draw", async () => {
    await renderMermaidDiagram("flowchart LR\nA --> B", "light", "page");
    const image = new Image();
    image.src = "/scient-page-own-image.png";
    expect(image.getAttribute("src")).toBe("/scient-page-own-image.png");
    const svgImage = document.createElementNS("http://www.w3.org/2000/svg", "image");
    svgImage.setAttribute("href", "/scient-page-own-image.png");
    expect(svgImage.getAttribute("href")).toBe("/scient-page-own-image.png");
  });
});
