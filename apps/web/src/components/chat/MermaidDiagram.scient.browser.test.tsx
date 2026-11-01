import { describe, expect, it, vi } from "vite-plus/test";
import type { MountOptions } from "pele/lazy";
import { renderMermaidSvg } from "./MermaidDiagram";

const renderer = vi.hoisted(() => ({
  type: "flowchart",
  load: vi.fn(),
  destroy: vi.fn(),
  svg: "",
  options: undefined as MountOptions | undefined,
}));

vi.mock("pele/lazy", () => ({
  detectType: () => renderer.type,
  load: renderer.load,
  parse: () => ({ type: "flowchart", nodes: new Map() }),
  mount: (host: HTMLElement, _source: string, options: MountOptions) => {
    renderer.options = options;
    host.replaceChildren(options.sanitize!(renderer.svg));
    return {
      result: { mermaidType: "flowchart-v2" },
      refresh: () => undefined,
      destroy: renderer.destroy,
    };
  },
}));

function setup() {
  renderer.type = "flowchart";
  renderer.load.mockReset().mockResolvedValue(true);
  renderer.destroy.mockReset();
  renderer.svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Source</text></svg>';
  renderer.options = undefined;
}

describe("upstream lazy renderer snapshot seam", () => {
  it("retries a failed diagram chunk and destroys the measuring mount", async () => {
    setup();
    renderer.type = "sequence";
    renderer.load.mockRejectedValueOnce(new Error("Chunk failed"));
    await expect(renderMermaidSvg("sequenceDiagram\nA->>B: hello")).rejects.toThrow(
      "failed to load",
    );
    const before = document.body.childElementCount;
    const result = await renderMermaidSvg("sequenceDiagram\nA->>B: hello");
    expect(renderer.load).toHaveBeenCalledTimes(2);
    expect(renderer.destroy).toHaveBeenCalledOnce();
    expect(document.body.childElementCount).toBe(before);
    expect(result.svg).toContain("Source");
    expect(renderer.options).toMatchObject({
      images: false,
      links: false,
      zoom: false,
      autoDirection: false,
      maxEdges: 500,
    });
  });

  it("sanitizes active elements, navigation and CSS resource attributes before DOM insertion", async () => {
    setup();
    renderer.svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <style>@import url(https://example.invalid/theme.css)</style>
      <a href="javascript:alert(1)"><text>Kept</text></a>
      <image href="https://example.invalid/image.png"/>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Hostile</div></foreignObject>
      <rect onclick="alert(1)" fill="url(https://example.invalid/fill.svg)" />
      <script>alert(1)</script>
    </svg>`;
    const result = await renderMermaidSvg("flowchart LR\nA");
    expect(result.svg).toContain("Kept");
    expect(result.svg).not.toMatch(
      /example\.invalid|javascript:|onclick|<script|<image|<a\s|<style|foreignObject/i,
    );
    expect(renderer.destroy).toHaveBeenCalledOnce();
  });
});
