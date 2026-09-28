import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const renderMermaidDiagram = vi.fn();
const mermaidSvgToPngBlob = vi.fn();
const parse = vi.fn();
vi.mock("../diagrams/mermaidRuntime", () => ({
  renderMermaidDiagram,
  getMermaidRuntimePromise: async () => ({ default: { parse } }),
}));
vi.mock("../diagrams/mermaidExport", () => ({ mermaidSvgToPngBlob }));

const { captureWordDiagrams } = await import("./captureDiagrams");
const digest = `sha256:${"a".repeat(64)}` as const;
const ID = "mermaid-0123456789abcdef";
const planOf = (...sources: ReadonlyArray<string>) => ({
  sourceDigest: digest,
  diagrams: sources.map((source, index) => ({ id: `${ID.slice(0, -1)}${index}`, source })),
});
const png = (bytes = 3) => new Blob([new Uint8Array(bytes).fill(1)], { type: "image/png" });

beforeEach(() => {
  renderMermaidDiagram.mockReset().mockResolvedValue({ svg: "<svg/>" });
  mermaidSvgToPngBlob.mockReset().mockResolvedValue(png());
  parse.mockReset().mockResolvedValue({ diagramType: "flowchart-v2", config: {} });
});

const tags = async (...sources: ReadonlyArray<string>) =>
  (await captureWordDiagrams(planOf(...sources))).diagrams.map((entry) => entry.result._tag);

describe("Word Mermaid capture", () => {
  it("captures PNG bytes from a rendered diagram", async () => {
    expect(await captureWordDiagrams(planOf("flowchart LR\nA --> B"))).toEqual({
      sourceDigest: digest,
      diagrams: [{ id: `${ID.slice(0, -1)}0`, result: { _tag: "png", base64: "AQEB" } }],
    });
    expect(renderMermaidDiagram).toHaveBeenCalledWith("flowchart LR\nA --> B", "light");
  });

  it("renders ordinary diagrams: math, URLs as text, image: labels, Windows paths", async () => {
    const benign = [
      'flowchart LR\nA["$$\\frac{1}{2}$$"] --> B["$$\\beta + \\alpha$$"]',
      'flowchart LR\nA["See https://example.org/paper and //cdn.example.org"] --> B',
      "flowchart LR\nA[image: the plot] --> B[img: raw]",
      'flowchart LR\nA["C:\\Users\\ada\\data\\beta.csv"] --> B',
      'flowchart LR\nA["a<b and x < 5"] --> B["<b>bold</b><br/>next"]',
      "%%{init: {'theme': 'dark'}}%%\nflowchart LR\nA --> B",
      "sequenceDiagram\nAlice->>Bob: see https://example.org/api(v2)",
      'flowchart LR\nA@{ shape: rounded, label: "Start" } --> B',
    ];
    expect(await tags(...benign)).toEqual(benign.map(() => "png"));
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(benign.length);
  });

  it("turns a diagram whose draw could fetch a resource into a source fallback, without rendering it", async () => {
    const unsafe = [
      "flowchart LR\nA[\"<img src='https://example.invalid/pixel.png'>\"] --> B",
      'flowchart LR\nA["<span style=\\"color:red\\">x</span>"] --> B',
      'flowchart LR\nA["<svg><image href=x /></svg>"]',
      "flowchart LR\nA --> B\nstyle A fill:url(https://example.invalid/p)",
      "flowchart LR\nA --> B\nclassDef c background:u\\72l(//example.invalid/p)",
      "flowchart LR\nA --> B\nstyle A background-image:image-set('x.png' 1x)",
      "flowchart LR\nA --> B\nclassDef c font:@\\69mport",
      'flowchart LR\n A@{ img: "https://example.invalid/plot.png" }',
      'flowchart LR\n A@{ label: "}", "\\x69mg": "https://example.invalid/plot.png" }',
      'sequenceDiagram\nparticipant A\nproperties A: {"icon": "https://example.invalid/a.png"}',
    ];
    expect(await tags(...unsafe)).toEqual(unsafe.map(() => "render-failed"));
    expect(renderMermaidDiagram).not.toHaveBeenCalled();
  });

  it("checks settings as Mermaid read them and allows only theme and layout keys", async () => {
    const source = "%%{init: {}}%%\nflowchart LR\nA --> B";
    const withConfig = async (config: unknown) => {
      parse.mockResolvedValueOnce({ diagramType: "flowchart-v2", config });
      return (await tags(source))[0];
    };
    expect(await withConfig({ theme: "base", themeVariables: { primaryColor: "#ff0000" } })).toBe(
      "png",
    );
    expect(await withConfig({ flowchart: { curve: "linear", nodeSpacing: 40 }, wrap: true })).toBe(
      "png",
    );
    expect(await withConfig({ themeCSS: ".node rect { fill: red }" })).toBe("render-failed");
    expect(await withConfig({ fontFamily: "Inter" })).toBe("render-failed");
    // A JSON escape spells url( only after Mermaid decodes it; the decoded value is what is checked.
    expect(await withConfig({ themeVariables: { primaryColor: "url(x)" } })).toBe("render-failed");
    expect(await withConfig({ themeVariables: { primaryColor: "<img>" } })).toBe("render-failed");
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(2);
  });

  it("checks the repaired copy the renderer falls back to after a syntax error", async () => {
    parse
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({ diagramType: "flowchart", config: {} });
    expect(await tags("flowchart LR\nA[Plot (log)] --> B")).toEqual(["png"]);
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockReset().mockResolvedValue(false);
    expect(await tags("not a diagram at all")).toEqual(["render-failed"]);
  });

  it("never fails the export: render, rasterise, and size failures fall back per diagram", async () => {
    renderMermaidDiagram
      .mockRejectedValueOnce(new Error("module load failed"))
      .mockResolvedValue({ svg: "<svg/>" });
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
    parse.mockRejectedValueOnce(new Error("Mermaid did not load"));
    expect(await tags("flowchart LR\nA --> B")).toEqual(["render-failed"]);
  });

  it("stops embedding once the diagrams' total PNG budget is spent", async () => {
    mermaidSvgToPngBlob.mockResolvedValue(png(2 * 1024 * 1024));
    const sources = Array.from({ length: 5 }, (_, index) => `flowchart LR\nA${index} --> B`);
    expect(await tags(...sources)).toEqual(["png", "png", "png", "png", "render-failed"]);
  });
});
