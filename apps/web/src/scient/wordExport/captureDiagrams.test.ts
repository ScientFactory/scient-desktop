import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const renderMermaidDiagram = vi.fn();
const mermaidSvgToPngBlob = vi.fn();
vi.mock("../diagrams/mermaidRuntime", () => ({
  renderMermaidDiagram,
  MermaidRenderError: class MermaidRenderError extends Error {
    constructor(cause: unknown) {
      super("Mermaid failed", { cause });
    }
  },
}));
vi.mock("../diagrams/mermaidExport", () => ({ mermaidSvgToPngBlob }));

const { captureWordDiagrams } = await import("./captureDiagrams");
const digest = `sha256:${"a".repeat(64)}` as const;
const plan = {
  sourceDigest: digest,
  diagrams: [{ id: "mermaid-0123456789abcdef", source: "flowchart LR\nA --> B" }],
};

beforeEach(() => {
  renderMermaidDiagram.mockReset();
  mermaidSvgToPngBlob.mockReset();
});

describe("Word Mermaid capture", () => {
  it("captures PNG bytes from a rendered diagram", async () => {
    renderMermaidDiagram.mockResolvedValue({ svg: "<svg/>" });
    mermaidSvgToPngBlob.mockResolvedValue(
      new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" }),
    );
    expect(await captureWordDiagrams(plan)).toEqual({
      sourceDigest: digest,
      diagrams: [{ id: plan.diagrams[0]!.id, result: { _tag: "png", base64: "AQID" } }],
    });
  });

  it("falls back only for Mermaid syntax failures", async () => {
    const { MermaidRenderError } = await import("../diagrams/mermaidRuntime");
    renderMermaidDiagram.mockRejectedValue(
      new MermaidRenderError(new Error("Parse error on line 1")),
    );
    expect((await captureWordDiagrams(plan)).diagrams[0]?.result._tag).toBe("render-failed");
    renderMermaidDiagram.mockRejectedValue(new MermaidRenderError(new Error("module load failed")));
    await expect(captureWordDiagrams(plan)).rejects.toThrow("Mermaid failed");
  });

  it("stops when PNG encoding fails or grows beyond the budget", async () => {
    renderMermaidDiagram.mockResolvedValue({ svg: "<svg/>" });
    mermaidSvgToPngBlob.mockRejectedValueOnce(new Error("canvas unavailable"));
    await expect(captureWordDiagrams(plan)).rejects.toThrow("canvas unavailable");
    mermaidSvgToPngBlob.mockResolvedValue(
      new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/png" }),
    );
    await expect(captureWordDiagrams(plan)).rejects.toThrow(/PNG limit/);
  });

  it("refuses source-controlled resources before Mermaid creates DOM", async () => {
    await expect(
      captureWordDiagrams({
        ...plan,
        diagrams: [
          {
            ...plan.diagrams[0]!,
            source: 'flowchart LR\n A@{ img: "https://example.invalid/plot.png" }',
          },
        ],
      }),
    ).rejects.toThrow(/external resource/);
    expect(renderMermaidDiagram).not.toHaveBeenCalled();
  });
});
