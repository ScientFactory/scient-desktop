import { describe, expect, it, vi } from "vite-plus/test";

import { renderMermaidDiagram } from "../diagrams/mermaidRuntime";
import { recoveryFixtures } from "../diagrams/mermaidRecovery.fixtures";
import { captureWordDiagrams } from "./captureDiagrams";
import { mermaidSourceConfigFetchRisk } from "./diagramSafety";

const PROBE = "__scient_word_capture_probe__";
const digest = `sha256:${"a".repeat(64)}` as const;
const probeRequests = () =>
  (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => entry.name.includes(PROBE) && !entry.name.endsWith("/control.png"))
    .map((entry) => entry.name);

const planOf = (sources: ReadonlyArray<string>) => ({
  sourceDigest: digest,
  diagrams: sources.map((source, index) => ({
    id: `mermaid-${index.toString(16).padStart(16, "0")}`,
    source,
  })),
});
const capture = async (sources: ReadonlyArray<string>) =>
  (await captureWordDiagrams(planOf(sources))).diagrams.map((entry) => entry.result._tag);

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

describe("Word capture through the shared Pele renderer", () => {
  it("calibrates observation with a page-owned request", async () => {
    // Vitest's dependency requests can fill Chromium's bounded timing buffer.
    performance.clearResourceTimings();
    const image = new Image();
    image.src = `/${PROBE}/control.png`;
    await image.decode().catch(() => undefined);
    await vi.waitFor(() =>
      expect(
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.endsWith(`/${PROBE}/control.png`)),
      ).toBe(true),
    );
  });

  it("never requests an authored label image in the shared renderer", async () => {
    const rendered = await renderMermaidDiagram(FETCHING.labelImage, "light");
    expect(rendered.blocked).toContain(`/${PROBE}/label.png`);
    expect(rendered.svg).not.toContain(PROBE);
    expect(probeRequests()).toEqual([]);
  });

  it("renders math, URLs and url( as text, and safe theme directives to PNG", async () => {
    expect(
      await capture([
        'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["$$\\beta$$ and https://example.org/x"]',
        "%%{init: {'theme': 'forest', 'flowchart': {'curve': 'linear'}}}%%\nflowchart LR\nA[image: plot] --> B",
        'flowchart LR\nA["C:\\Users\\ada\\beta.csv"] --> B["a<b"]',
        'flowchart LR\nA["https://example.org/url(report)"] --> B["mentions url(x) and image(y)"]',
        'flowchart LR\nA["url(x)"];style A fill:#f9f',
        "---\nconfig:\n  theme: forest\n  flowchart:\n    curve: linear\n---\nflowchart LR\nA --> B",
      ]),
    ).toEqual(["png", "png", "png", "png", "png", "png"]);
  });

  it("rejects empty and oversized sources without embedding a stand-in", async () => {
    const oversized = `flowchart LR\nA["${"x".repeat(50_000)}"] --> B`;
    expect(await capture([oversized, "   "])).toEqual(["render-failed", "render-failed"]);
  });

  it("captures resource-looking label and comment prose without a false omission or fallback", async () => {
    const sources = [
      `flowchart LR\nA["icon: 'https://example.org/reference'"] --> B`,
      `flowchart LR\nA[img: 'https://example.org/reference'] --> B`,
      `flowchart LR\nA["favicon: 'https://example.org/reference'"] --> B`,
      `flowchart LR\n%% A@{ img: 'https://example.org/reference' }\n%% properties A: {"icon":"https://example.org/reference"}\nA --> B`,
      `sequenceDiagram\nparticipant A as icon: 'https://example.org/reference'\nA->>A: img: 'https://example.org/reference'`,
    ];
    const captured = await captureWordDiagrams(planOf(sources));
    expect(captured.diagrams.map((entry) => entry.result._tag)).toEqual(sources.map(() => "png"));
    for (const { result } of captured.diagrams) {
      if (result._tag !== "png") throw new Error("Expected a native PNG for inert prose.");
      expect(
        Array.from(atob(result.base64).slice(0, 8), (character) => character.charCodeAt(0)),
      ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    for (const source of sources) {
      const rendered = await renderMermaidDiagram(source, "light");
      expect(rendered.blocked, source).toBeUndefined();
    }
    expect(probeRequests()).toEqual([]);
  });

  it("falls back independently for every authored resource without a network request", async () => {
    expect(await capture([...Object.values(FETCHING), "flowchart LR\nLocal --> Result"])).toEqual([
      ...Object.values(FETCHING).map(() => "render-failed"),
      "png",
    ]);
    expect(probeRequests()).toEqual([]);
  });

  it("retains defense in depth when resources are rendered outside Word's preflight", async () => {
    for (const source of [...Object.values(FETCHING), STYLED_STATE]) {
      const result = await renderMermaidDiagram(source, "light");
      expect(result.svg).toContain("<svg");
      expect(result.svg).not.toContain(PROBE);
      expect(result.blocked?.length).toBeGreaterThan(0);
    }
    expect(probeRequests()).toEqual([]);
  });

  it("refuses decoded unsafe settings and styles before native image capture", async () => {
    const escaped =
      '%%{init: {"themeVariables": {"primaryColor": "\\u0075rl(probe)"}}}%%\nflowchart LR\nA --> B';
    expect(mermaidSourceConfigFetchRisk(escaped)).not.toBeNull();
    expect(
      await capture([
        STYLED_STATE,
        STYLED_STATE.replace("url(", "u\\72l("),
        escaped,
        '%%{init: {"themeCSS": ".node rect { fill: red }"}}%%\nflowchart LR\nA --> B',
        `---\nconfig:\n  themeCSS: "@font-face{src:url(/${PROBE}/font.woff2)}"\n---\nflowchart LR\nA --> B`,
      ]),
    ).toEqual(Array.from({ length: 5 }, () => "render-failed"));
    expect(probeRequests()).toEqual([]);
  });

  it("uses original-first recovery for native PNG bytes without modifying captured source", async () => {
    const fixture = recoveryFixtures.find((entry) => entry.name === "round nested parentheses")!;
    const plan = planOf([fixture.source, "not a diagram"]);
    const result = await captureWordDiagrams(plan);
    expect(plan.diagrams[0]?.source).toBe(fixture.source);
    expect(result.sourceDigest).toBe(digest);
    const image = result.diagrams[0]?.result;
    expect(image?._tag).toBe("png");
    if (image?._tag !== "png") throw new Error("Expected a captured PNG.");
    expect(
      Array.from(
        Uint8Array.from(atob(image.base64), (character) => character.charCodeAt(0)).slice(0, 8),
      ),
    ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(result.diagrams[1]?.result._tag).toBe("render-failed");
    const rendered = await renderMermaidDiagram(fixture.source, "light");
    expect(rendered.recovery?.originalSource).toBe(fixture.source);
    expect(rendered.recovery?.source).toBe(fixture.expected);
  });
});
