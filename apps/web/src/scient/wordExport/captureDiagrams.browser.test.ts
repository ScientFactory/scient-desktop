/**
 * Word diagram capture against the real Mermaid, in a real browser: ordinary
 * diagrams become PNGs, and a diagram that names an outside resource makes no
 * request at all — the isolated frame refuses the load — and falls back to
 * its source.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { getMermaidRuntimePromise, renderMermaidDiagram } from "../diagrams/mermaidRuntime";
import { captureWordDiagrams } from "./captureDiagrams";
import { openIsolatedMermaid } from "./isolatedMermaid";

const PROBE = "__scient_word_capture_probe__";
const digest = `sha256:${"a".repeat(64)}` as const;

/**
 * Probe loads that reached the server. Chromium also lists loads its policy
 * refused, but those never get a response: no status and no response time.
 */
const probeRequests = (target: Window = window) =>
  (target.performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => entry.name.includes(PROBE))
    .filter((entry) => entry.responseStatus !== 0 || entry.responseStart > 0)
    .map((entry) => entry.name);
/** Loads the policy refused: listed, but never answered. */
const refusedProbeLoads = (target: Window) =>
  (target.performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(
    (entry) => entry.responseStatus === 0 && entry.responseStart === 0,
  ).length;

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

/** Diagrams whose draw asks the browser to load something. */
const FETCHING = {
  labelImage: `flowchart LR\nA["<img src='/${PROBE}/label.png'>"] --> B`,
  remoteLabelImage: "flowchart LR\nA[\"<img src='https://example.invalid/pixel.png'>\"] --> B",
  shapeImage: `flowchart LR\nA@{ img: "/${PROBE}/shape.png", h: 40 } --> B`,
  actorIcon: `sequenceDiagram\nparticipant A\nproperties A: {"icon": "/${PROBE}/icon.png"}\nA->>A: hi`,
  // `;` separates statements, so the icon hides on the participant's line.
  joinedActorIcon: `sequenceDiagram\nparticipant A;properties A: {"icon":"/${PROBE}/joined.png"}\nA->>A: hi`,
  styledLabel: `flowchart LR\nA["<span style='background:url(/${PROBE}/span.png)'>x</span>"] --> B`,
};

/** State diagrams take a `classDef` style list as the rest of the line, so CSS `url()` parses. */
const STYLED_STATE = `stateDiagram-v2\nclassDef c background-image:url(/${PROBE}/state.png)\n[*] --> A:::c`;

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

  it("needs isolation: Mermaid's strict draw in the page requests a label's image", async () => {
    await renderMermaidDiagram(FETCHING.labelImage.replace("label.png", "page.png"), "light");
    await settle();
    expect(probeRequests()).toEqual([expect.stringContaining(`/${PROBE}/page.png`)]);
  });

  it("renders math, URLs and url( as text, and theme directives to PNG", async () => {
    const results = await capture([
      'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["$$\\beta$$ and https://example.org/x"]',
      "%%{init: {'theme': 'forest', 'flowchart': {'curve': 'linear'}}}%%\nflowchart LR\nA[image: plot] --> B",
      'flowchart LR\nA["C:\\Users\\ada\\beta.csv"] --> B["a<b"]',
      'flowchart LR\nA["https://example.org/url(report)"] --> B["mentions url(x) and image(y)"]',
      'flowchart LR\nA["url(x)"];style A fill:#f9f',
    ]);
    expect(results).toEqual(["png", "png", "png", "png", "png"]);
  });

  it("makes no request for a diagram that names an outside resource, and falls back", async () => {
    const results = await capture(Object.values(FETCHING));
    await settle();
    expect(results).toEqual(Object.values(FETCHING).map(() => "render-failed"));
    expect(probeRequests()).toEqual([]);
  });

  it("refuses every load in the frame itself, before any request", async () => {
    const mermaid = await openIsolatedMermaid();
    try {
      for (const [name, source] of Object.entries(FETCHING)) {
        // An image shape waits for its image, so its refused load fails the draw.
        const refused = await mermaid.render(source).then(
          (drawn) => drawn.refused,
          () => Number.POSITIVE_INFINITY,
        );
        expect(refused, name).toBeGreaterThan(0);
      }
      // A style the secondary check would refuse is still harmless when drawn.
      const styled = await mermaid.render(STYLED_STATE);
      expect(styled.svg).toContain("<svg");
      expect(styled.refused).toBeGreaterThan(0);
      await settle();
      // Every load was attempted and refused; none reached the server.
      expect(refusedProbeLoads(mermaid.window)).toBeGreaterThan(0);
      expect(probeRequests(mermaid.window)).toEqual([]);
      expect(probeRequests()).toEqual([]);
    } finally {
      mermaid.close();
    }
  });

  it("refuses styles and settings that name an outside resource before drawing", async () => {
    const styles = [STYLED_STATE, STYLED_STATE.replace("url(", "u\\72l(")];
    // They are valid diagrams, so it is the style check that refuses them.
    const mermaid = await openIsolatedMermaid();
    try {
      for (const source of styles) expect(await mermaid.parse(source), source).not.toBeNull();
    } finally {
      mermaid.close();
    }
    const results = await capture([
      ...styles,
      '%%{init: {"themeVariables": {"primaryColor": "\\u0075rl(probe)"}}}%%\nflowchart LR\nA --> B',
      '%%{init: {"themeCSS": ".node rect { fill: red }"}}%%\nflowchart LR\nA --> B',
    ]);
    await settle();
    expect(results).toEqual(Array.from({ length: 4 }, () => "render-failed"));
    expect(probeRequests()).toEqual([]);
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
