/**
 * Word diagram capture against the real Mermaid, in a real browser: ordinary
 * diagrams become PNGs, and diagrams whose draw would load a resource fall
 * back to their source without the browser requesting anything.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { getMermaidRuntimePromise, renderMermaidDiagram } from "../diagrams/mermaidRuntime";
import { captureWordDiagrams } from "./captureDiagrams";

const PROBE = "__scient_word_capture_probe__";
const digest = `sha256:${"a".repeat(64)}` as const;

/** Resource requests the page made whose URL names the probe. */
const probeRequests = () =>
  performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes(PROBE));

const capture = async (sources: ReadonlyArray<string>) =>
  (
    await captureWordDiagrams({
      sourceDigest: digest,
      diagrams: sources.map((source, index) => ({
        id: `mermaid-${index.toString(16).padStart(16, "0")}`,
        source,
      })),
    })
  ).diagrams.map((entry) => entry.result._tag);

/** Lets any load a draw started reach the resource timeline. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

afterEach(() => {
  performance.clearResourceTimings();
});

describe("Word diagram capture with the real Mermaid", () => {
  it("records a request to the probe, so an absent one means nothing was fetched", async () => {
    const image = new Image();
    image.src = `/${PROBE}/control.png`;
    await settle();
    expect(probeRequests()).toHaveLength(1);
  });

  it("renders math, URLs as text, and theme directives to PNG", async () => {
    const results = await capture([
      'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["$$\\beta$$ and https://example.org/x"]',
      "%%{init: {'theme': 'forest', 'flowchart': {'curve': 'linear'}}}%%\nflowchart LR\nA[image: plot] --> B",
      'flowchart LR\nA["C:\\Users\\ada\\beta.csv"] --> B["a<b"]',
    ]);
    expect(results).toEqual(["png", "png", "png"]);
  });

  it("falls back, without a request, for markup, styles, and settings that would fetch", async () => {
    const results = await capture([
      `flowchart LR\nA["<img src='/${PROBE}/label.png'>"] --> B`,
      `flowchart LR\nA --> B\nstyle A fill:u\\72l(/${PROBE}/style.png)`,
      `flowchart LR\nA@{ img: "/${PROBE}/shape.png", h: 40 } --> B`,
      `sequenceDiagram\nparticipant A\nproperties A: {"icon": "/${PROBE}/icon.png"}\nA->>A: hi`,
      '%%{init: {"themeVariables": {"primaryColor": "\\u0075rl(probe)"}}}%%\nflowchart LR\nA --> B',
      '%%{init: {"themeCSS": ".node rect { fill: red }"}}%%\nflowchart LR\nA --> B',
    ]);
    await settle();
    expect(results).toEqual(Array.from({ length: 6 }, () => "render-failed"));
    expect(probeRequests()).toEqual([]);
  });

  it("needs the pre-render check: Mermaid's own strict draw requests the label's image", async () => {
    await renderMermaidDiagram(
      `flowchart LR\nA["<img src='/${PROBE}/unchecked.png'>"] --> B`,
      "light",
    );
    await settle();
    expect(probeRequests()).toEqual([expect.stringContaining(`/${PROBE}/unchecked.png`)]);
  });

  it("checks the settings Mermaid decodes, not the escaped text", async () => {
    const { default: mermaid } = await getMermaidRuntimePromise();
    const parsed = await mermaid.parse(
      '%%{init: {"themeVariables": {"primaryColor": "\\u0075rl(probe)"}}}%%\nflowchart LR\nA --> B',
    );
    // Mermaid's own sanitiser lets this through; Word capture refuses it (above).
    expect(parsed && parsed.config.themeVariables?.primaryColor).toBe("url(probe)");
  });
});
