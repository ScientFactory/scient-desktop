import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mermaidSvgToPngBlob = vi.fn();
const parse = vi.fn();
const render = vi.fn();
const close = vi.fn();
const openIsolatedMermaid = vi.fn();
vi.mock("./isolatedMermaid", () => ({ openIsolatedMermaid }));
vi.mock("../diagrams/mermaidExport", () => ({ mermaidSvgToPngBlob }));

const { captureWordDiagrams } = await import("./captureDiagrams");
const digest = `sha256:${"a".repeat(64)}` as const;
const idOf = (index: number) => `mermaid-${index.toString(16).padStart(16, "0")}`;
const planOf = (...sources: ReadonlyArray<string>) => ({
  sourceDigest: digest,
  diagrams: sources.map((source, index) => ({ id: idOf(index), source })),
});
const png = (bytes = 3) => new Blob([new Uint8Array(bytes).fill(1)], { type: "image/png" });

beforeEach(() => {
  mermaidSvgToPngBlob.mockReset().mockResolvedValue(png());
  parse.mockReset().mockResolvedValue({ config: {} });
  render.mockReset().mockResolvedValue({ svg: "<svg/>", diagramType: "flowchart-v2", refused: 0 });
  close.mockReset();
  openIsolatedMermaid.mockReset().mockResolvedValue({ parse, render, close, window: {} as Window });
});

const tags = async (...sources: ReadonlyArray<string>) =>
  (await captureWordDiagrams(planOf(...sources))).diagrams.map((entry) => entry.result._tag);

describe("Word Mermaid capture", () => {
  it("captures PNG bytes drawn in the isolated frame, and closes it", async () => {
    expect(await captureWordDiagrams(planOf("flowchart LR\nA --> B"))).toEqual({
      sourceDigest: digest,
      diagrams: [{ id: idOf(0), result: { _tag: "png", base64: "AQEB" } }],
    });
    expect(render).toHaveBeenCalledWith("flowchart LR\nA --> B");
    expect(openIsolatedMermaid).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("renders label text that mentions url( or web addresses", async () => {
    const labels = [
      'flowchart LR\nA["https://example.org/url(report)"] --> B',
      'flowchart LR\nA["mentions url(x), image(y) and @import"] --> B',
      'flowchart LR\nA["url(x)"];style A fill:#f9f',
      'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["C:\\Users\\ada\\beta.csv"]',
    ];
    expect(await tags(...labels)).toEqual(labels.map(() => "png"));
  });

  it("falls back when the frame refused a load while drawing", async () => {
    render.mockResolvedValueOnce({ svg: "<svg/>", diagramType: "sequence", refused: 1 });
    const joined =
      'sequenceDiagram\nparticipant A;properties A: {"icon":"https://example.invalid/pixel.png"}\nA->>A: hi';
    expect(await tags(joined, "flowchart LR\nA --> B")).toEqual(["render-failed", "png"]);
    expect(mermaidSvgToPngBlob).toHaveBeenCalledTimes(1);
  });

  it("refuses styles and settings that name an outside resource without drawing", async () => {
    parse
      .mockResolvedValueOnce({ config: {} })
      .mockResolvedValueOnce({ config: {} })
      .mockResolvedValueOnce({ config: { themeCSS: ".node rect { fill: red }" } })
      .mockResolvedValueOnce({ config: { themeVariables: { primaryColor: "url(x)" } } })
      .mockResolvedValueOnce({
        config: { theme: "base", themeVariables: { primaryColor: "#f00" } },
      });
    expect(
      await tags(
        "stateDiagram-v2\nclassDef c background-image:url(https://example.invalid/p)",
        "flowchart LR\nA --> B;classDef c background:u\\72l(//example.invalid/p)",
        "%%{init: {}}%%\nflowchart LR\nA --> B",
        "%%{init: {}}%%\nflowchart LR\nA --> B",
        "%%{init: {}}%%\nflowchart LR\nA --> B",
      ),
    ).toEqual(["render-failed", "render-failed", "render-failed", "render-failed", "png"]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("draws the repaired copy after a syntax error, and falls back when nothing parses", async () => {
    parse.mockResolvedValueOnce(null).mockResolvedValueOnce({ config: {} });
    expect(await tags("flowchart LR\nA[Plot (log)] --> B")).toEqual(["png"]);
    expect(render).toHaveBeenCalledWith(
      expect.not.stringMatching(/^flowchart LR\nA\[Plot \(log\)\]/u),
    );
    parse.mockReset().mockResolvedValue(null);
    expect(await tags("not a diagram at all")).toEqual(["render-failed"]);
  });

  it("never fails the export: frame, draw, rasterise, and size failures fall back", async () => {
    render
      .mockRejectedValueOnce(new Error("Parse error"))
      .mockResolvedValue({ svg: "<svg/>", diagramType: "flowchart-v2", refused: 0 });
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
    openIsolatedMermaid.mockRejectedValueOnce(new Error("Mermaid did not load for Word export."));
    expect(await tags("flowchart LR\nA --> B", "flowchart LR\nC --> D")).toEqual([
      "render-failed",
      "render-failed",
    ]);
  });

  it("falls back for a diagram over chat's size limit instead of drawing Mermaid's stand-in", async () => {
    // Few edges, one long label: Mermaid parses it, then draws a stand-in over maxTextSize.
    const oversized = `flowchart LR\nA["${"x".repeat(50_000)}"] --> B`;
    expect(oversized.length).toBeGreaterThan(50_000);
    expect(await tags(oversized, "   ", "flowchart LR\nA --> B")).toEqual([
      "render-failed",
      "render-failed",
      "png",
    ]);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("falls back when Mermaid drew its own error diagram", async () => {
    render.mockResolvedValueOnce({ svg: "<svg/>", diagramType: "error", refused: 0 });
    expect(await tags("flowchart LR\nA --> B")).toEqual(["render-failed"]);
    expect(mermaidSvgToPngBlob).not.toHaveBeenCalled();
  });

  it("stops embedding once the diagrams' total PNG budget is spent", async () => {
    mermaidSvgToPngBlob.mockResolvedValue(png(2 * 1024 * 1024));
    const sources = Array.from({ length: 5 }, (_, index) => `flowchart LR\nA${index} --> B`);
    expect(await tags(...sources)).toEqual(["png", "png", "png", "png", "render-failed"]);
  });
});
