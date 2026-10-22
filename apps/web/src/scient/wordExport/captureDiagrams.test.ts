import { describe, expect, it, vi } from "vite-plus/test";

const { mermaidSvgToPngBlob, renderMermaidDiagram } = vi.hoisted(() => ({
  mermaidSvgToPngBlob: vi.fn(),
  renderMermaidDiagram: vi.fn(),
}));
vi.mock("../diagrams/mermaidRuntime", () => ({
  MAX_MERMAID_SOURCE_LENGTH: 50_000,
  renderMermaidDiagram,
}));
vi.mock("../diagrams/mermaidExport", () => ({ mermaidSvgToPngBlob }));

const { captureWordDiagrams } = await import("./captureDiagrams");
const digest = `sha256:${"a".repeat(64)}` as const;
const idOf = (index: number) => `mermaid-${index.toString(16).padStart(16, "0")}`;
const planOf = (...sources: ReadonlyArray<string>) => ({
  sourceDigest: digest,
  diagrams: sources.map((source, index) => ({ id: idOf(index), source })),
});
const png = (bytes = 3) => new Blob([new Uint8Array(bytes).fill(1)], { type: "image/png" });

function setup() {
  mermaidSvgToPngBlob.mockReset().mockResolvedValue(png());
  renderMermaidDiagram
    .mockReset()
    .mockResolvedValue({ svg: "<svg/>", diagramType: "flowchart-v2" });
}

const tags = async (...sources: ReadonlyArray<string>) =>
  (await captureWordDiagrams(planOf(...sources))).diagrams.map((entry) => entry.result._tag);

describe("Word Mermaid capture", () => {
  it("returns an empty plan unchanged without loading a renderer", async () => {
    setup();
    expect(await captureWordDiagrams(planOf())).toEqual({ sourceDigest: digest, diagrams: [] });
    expect(renderMermaidDiagram).not.toHaveBeenCalled();
  });

  it("captures PNG bytes from the shared renderer without changing source identity", async () => {
    setup();
    expect(await captureWordDiagrams(planOf("flowchart LR\nA --> B"))).toEqual({
      sourceDigest: digest,
      diagrams: [{ id: idOf(0), result: { _tag: "png", base64: "AQEB" } }],
    });
    expect(renderMermaidDiagram).toHaveBeenCalledWith("flowchart LR\nA --> B", "light");
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("renders label text that mentions url( or web addresses", async () => {
    setup();
    const labels = [
      'flowchart LR\nA["https://example.org/url(report)"] --> B',
      'flowchart LR\nA["mentions url(x), image(y) and @import"] --> B',
      'flowchart LR\nA["url(x)"];style A fill:#f9f',
      'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["C:\\Users\\ada\\beta.csv"]',
    ];
    expect(await tags(...labels)).toEqual(labels.map(() => "png"));
  });

  it("falls back when the shared renderer reports an omitted resource", async () => {
    setup();
    renderMermaidDiagram.mockResolvedValueOnce({
      svg: "<svg/>",
      diagramType: "sequence",
      blocked: ["https://example.invalid/pixel.png"],
    });
    const joined =
      'sequenceDiagram\nparticipant A;properties A: {"icon":"https://example.invalid/pixel.png"}\nA->>A: hi';
    expect(await tags(joined, "flowchart LR\nA --> B")).toEqual(["render-failed", "png"]);
    expect(mermaidSvgToPngBlob).toHaveBeenCalledTimes(1);
  });

  it("refuses styles and settings that name an outside resource without drawing", async () => {
    setup();
    expect(
      await tags(
        "stateDiagram-v2\nclassDef c background-image:url(https://example.invalid/p)",
        "flowchart LR\nA --> B;classDef c background:u\\72l(//example.invalid/p)",
        '%%{init: {"themeCSS": ".node rect { fill: red }"}}%%\nflowchart LR\nA --> B',
        '%%{init: {"themeVariables": {"primaryColor": "\\u0075rl(x)"}}}%%\nflowchart LR\nA --> B',
        '%%{init: {"theme": "base", "themeVariables": {"primaryColor": "#f00"}}}%%\nflowchart LR\nA --> B',
      ),
    ).toEqual(["render-failed", "render-failed", "render-failed", "render-failed", "png"]);
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("delegates original-first recovery exactly once and never rewrites the plan source", async () => {
    setup();
    const source = "flowchart LR\nA[Plot (log)] --> B";
    const plan = planOf(source);
    renderMermaidDiagram.mockResolvedValueOnce({
      svg: "<svg>Recovered</svg>",
      diagramType: "flowchart-v2",
      recovery: { originalSource: source, source: 'flowchart LR\nA["Plot (log)"] --> B' },
    });
    expect((await captureWordDiagrams(plan)).diagrams[0]?.result._tag).toBe("png");
    expect(renderMermaidDiagram).toHaveBeenCalledExactlyOnceWith(source, "light");
    expect(mermaidSvgToPngBlob).toHaveBeenCalledWith("<svg>Recovered</svg>", "light");
    expect(plan.diagrams[0]?.source).toBe(source);
    renderMermaidDiagram.mockRejectedValueOnce(new Error("No diagram type detected"));
    expect(await tags("not a diagram at all")).toEqual(["render-failed"]);
  });

  it("never fails the export: load, draw, rasterise, and size failures fall back", async () => {
    setup();
    renderMermaidDiagram
      .mockRejectedValueOnce(new Error("Parse error"))
      .mockResolvedValue({ svg: "<svg/>", diagramType: "flowchart-v2", blocked: [] });
    mermaidSvgToPngBlob
      .mockResolvedValueOnce(png())
      .mockRejectedValueOnce(new Error("The diagram contains an external resource"))
      .mockRejectedValueOnce(new Error("canvas unavailable"))
      .mockResolvedValueOnce(png(2 * 1024 * 1024 + 1))
      .mockResolvedValueOnce(new Blob(["x"], { type: "image/jpeg" }))
      .mockResolvedValue(png());
    const sources = Array.from({ length: 7 }, (_, index) => `flowchart LR\nA${index} --> B`);
    expect(await tags(...sources)).toEqual([
      "render-failed",
      "png",
      "render-failed",
      "render-failed",
      "render-failed",
      "render-failed",
      "png",
    ]);
    renderMermaidDiagram.mockRejectedValue(new Error("The diagram renderer failed to load."));
    expect(await tags("flowchart LR\nA --> B", "flowchart LR\nC --> D")).toEqual([
      "render-failed",
      "render-failed",
    ]);
  });

  it("falls back for a diagram over chat's size limit before loading the renderer", async () => {
    setup();
    const oversized = `flowchart LR\nA["${"x".repeat(50_000)}"] --> B`;
    expect(oversized.length).toBeGreaterThan(50_000);
    expect(await tags(oversized, "   ", "flowchart LR\nA --> B")).toEqual([
      "render-failed",
      "render-failed",
      "png",
    ]);
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("falls back when Mermaid drew its own error diagram", async () => {
    setup();
    renderMermaidDiagram.mockResolvedValueOnce({
      svg: "<svg/>",
      diagramType: "error",
      blocked: [],
    });
    expect(await tags("flowchart LR\nA --> B")).toEqual(["render-failed"]);
    expect(mermaidSvgToPngBlob).not.toHaveBeenCalled();
  });

  it("stops embedding once the diagrams' total PNG budget is spent", async () => {
    setup();
    mermaidSvgToPngBlob.mockResolvedValue(png(2 * 1024 * 1024));
    const sources = Array.from({ length: 5 }, (_, index) => `flowchart LR\nA${index} --> B`);
    expect(await tags(...sources)).toEqual(["png", "png", "png", "png", "render-failed"]);
  });

  it("refuses an unsafe recovered projection before rasterization", async () => {
    setup();
    renderMermaidDiagram.mockResolvedValueOnce({
      svg: "<svg/>",
      diagramType: "flowchart-v2",
      recovery: { source: "flowchart LR\nA\nstyle A fill:url(remote.svg)" },
    });
    expect(await tags("flowchart LR\nA[Plot (log)]")).toEqual(["render-failed"]);
    expect(mermaidSvgToPngBlob).not.toHaveBeenCalled();
  });

  it("charges the aggregate budget only for bytes that were successfully encoded", async () => {
    setup();
    const unreadable = png(2 * 1024 * 1024);
    using _read = vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(new Error("Read failed"));
    mermaidSvgToPngBlob.mockResolvedValueOnce(unreadable).mockResolvedValue(png(2 * 1024 * 1024));
    const sources = Array.from({ length: 5 }, (_, index) => `flowchart LR\nA${index} --> B`);
    expect(await tags(...sources)).toEqual(["render-failed", "png", "png", "png", "png"]);
  });
});
