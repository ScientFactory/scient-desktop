import { describe, expect, it, vi } from "vite-plus/test";

const renderer = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../../components/chat/MermaidDiagram", () => ({ renderMermaidSvg: renderer.render }));

function setup() {
  renderer.render.mockReset();
}

describe("Scient uses the upstream renderer", () => {
  it("retains blocked-resource notices even when Pele omits the resource before emitting SVG", async () => {
    setup();
    renderer.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>',
      diagramType: "flowchart-v2",
      resources: ["https://icons.example/a.png"],
    });
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const source = 'flowchart LR\nA@{ img: "https://icons.example/a.png", label: "A", h: 40 }';
    const result = await renderMermaidDiagram(source, "dark");
    expect(renderer.render).toHaveBeenCalledExactlyOnceWith(source);
    expect(result.blocked).toEqual(["https://icons.example/a.png"]);
    expect(result.svg).not.toContain("icons.example");
    expect(result.svg).toContain("<text>A</text>");
  });

  it("deduplicates concurrent requests, rebases instances and never caches failures", async () => {
    setup();
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const source = "flowchart LR\nCache --> Retry";
    renderer.render.mockRejectedValueOnce(new Error("Chunk unavailable"));
    await expect(renderMermaidDiagram(source, "light")).rejects.toThrow("Chunk unavailable");
    renderer.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><g id="node"/></svg>',
      diagramType: "flowchart-v2",
    });
    const copies = await Promise.all(
      Array.from({ length: 12 }, () => renderMermaidDiagram(source, "light")),
    );
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(new Set(copies.map(({ svg }) => svg)).size).toBe(12);
    await renderMermaidDiagram(source, "dark");
    expect(renderer.render).toHaveBeenCalledTimes(3);
  });
});
