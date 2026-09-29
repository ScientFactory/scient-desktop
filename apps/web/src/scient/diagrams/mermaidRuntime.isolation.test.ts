// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const frame = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./isolatedMermaid", () => ({ sharedIsolatedMermaid: async () => frame }));
const page = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: page }));

const drawn = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" id="d"><g id="n">${body}</g></svg>`;

describe("Mermaid runtime isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    frame.render.mockReset();
    page.render.mockReset();
  });

  it("draws chat diagrams in the frame and strips what they would load", async () => {
    frame.render.mockResolvedValue({
      svg: drawn('<image href="https://icons.example/a.png"/><text>A</text>'),
      diagramType: "sequence",
      refused: 2,
    });
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const rendered = await renderMermaidDiagram("sequenceDiagram\nA->>A: hi", "dark");

    expect(frame.render).toHaveBeenCalledWith("sequenceDiagram\nA->>A: hi", {
      theme: "dark",
      awaitRefusals: false,
    });
    expect(page.render).not.toHaveBeenCalled();
    expect(rendered.svg).not.toContain("icons.example");
    expect(rendered.svg).toContain("<text>A</text>");
    expect(rendered.blocked).toEqual(["https://icons.example/a.png"]);
  });

  it("reports nothing blocked for an ordinary diagram and caches each renderer apart", async () => {
    frame.render.mockResolvedValue({
      svg: drawn("<text>A</text>"),
      diagramType: "flowchart-v2",
      refused: 0,
    });
    page.render.mockResolvedValue({ svg: drawn("<text>A</text>"), diagramType: "flowchart-v2" });
    const { renderMermaidDiagram } = await import("./mermaidRuntime");

    const first = await renderMermaidDiagram("flowchart LR\nA", "light");
    await renderMermaidDiagram("flowchart LR\nA", "light");
    await renderMermaidDiagram("flowchart LR\nA", "light", "page");

    expect(first.blocked).toBeUndefined();
    expect(frame.render).toHaveBeenCalledTimes(1);
    expect(page.render).toHaveBeenCalledTimes(1);
  });
});
