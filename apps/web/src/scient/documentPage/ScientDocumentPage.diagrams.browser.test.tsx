import { render, act } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ScientDocumentPageInput } from "@t3tools/contracts";
import { MermaidRenderError, type RenderedMermaidDiagram } from "../diagrams/mermaidRuntime";
import * as katex from "../math/katexRuntime";
import { DocumentPageTracker } from "./documentPageReadiness";
import { ScientDocumentPage } from "./ScientDocumentPage";

const renderer = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../diagrams/mermaidRuntime", async (original) => ({
  ...(await original<typeof import("../diagrams/mermaidRuntime")>()),
  renderMermaidDiagram: renderer.render,
}));

function setup() {
  renderer.render.mockReset().mockResolvedValue({
    svg: "<svg><text>Current diagram</text></svg>",
    diagramType: "flowchart-v2",
  });
}

function diagramPage(source: string, tracker: DocumentPageTracker) {
  const input = {
    protocol: 1,
    captureId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    documentKind: "workspace-file",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    profile: "document",
    title: "Diagram fixture",
    language: null,
    direction: "auto",
    createdAt: null,
    markdown: `\`\`\`mermaid\n${source}\n\`\`\`\n`,
    assets: [],
    warnings: [],
  } satisfies ScientDocumentPageInput;
  return (
    <ScientDocumentPage
      input={input}
      inputUrl={new URL("https://capture.test/document.json")}
      katex={katex}
      tracker={tracker}
      renderWarnings={[]}
    />
  );
}

function deferredDiagram() {
  let resolve!: (value: RenderedMermaidDiagram) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<RenderedMermaidDiagram>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("PDF diagram renderer boundary", () => {
  // Every typed content code takes the same branch (isMermaidContentError); one stands for all.
  it.each(["semantic"])(
    "prints labelled original source for a typed Pele %s content error",
    async (code) => {
      setup();
      renderer.render.mockRejectedValue(
        new MermaidRenderError(Object.assign(new Error(`Pele rejected ${code}`), { code })),
      );
      const tracker = new DocumentPageTracker();
      const source = `bad-${code}`;
      await using screen = await render(diagramPage(source, tracker), { router: false });
      await expect
        .poll(() => screen.container.querySelector('[data-scient-diagram="failed"]')?.textContent)
        .toContain(source);
      expect(screen.container.textContent).toContain("Diagram could not be rendered");
      expect(tracker.failed).toBe(false);
      expect(tracker.diagnostics).toMatchObject([{ severity: "warning", code: "diagram-failed" }]);
      expect(await tracker.settle()).toBe(true);
    },
  );

  it.each(["Chunk load failed"])(
    "withholds printing after an execution failure: %s",
    async (message) => {
      setup();
      renderer.render.mockRejectedValue(new MermaidRenderError(new Error(message)));
      const tracker = new DocumentPageTracker();
      await using screen = await render(diagramPage("flowchart LR\nA", tracker), { router: false });
      await expect
        .poll(() => screen.container.querySelector('[data-scient-diagram="error"]') !== null)
        .toBe(true);
      expect(tracker.failed).toBe(true);
      expect(tracker.diagnostics).toMatchObject([
        { severity: "fatal", code: "diagram-incomplete" },
      ]);
      expect(screen.container.querySelector("svg")).toBeNull();
      expect(await tracker.settle()).toBe(true);
    },
  );

  it("uses the single renderer API and records omitted-resource warnings before readiness", async () => {
    setup();
    renderer.render.mockResolvedValue({
      svg: "<svg><text>Local picture label</text></svg>",
      diagramType: "flowchart-v2",
      blocked: ["https://example.invalid/image.png"],
    });
    const tracker = new DocumentPageTracker();
    const source = "flowchart LR\nA --> B";
    await using screen = await render(diagramPage(source, tracker), { router: false });
    await expect
      .poll(() => screen.container.querySelector('[data-scient-diagram="rendered"]')?.textContent)
      .toBe("Local picture label");
    expect(renderer.render).toHaveBeenCalledExactlyOnceWith(source, "light");
    expect(tracker.diagnostics).toMatchObject([
      { severity: "warning", code: "remote-image-omitted" },
    ]);
    expect(tracker.failed).toBe(false);
    expect(await tracker.settle()).toBe(true);
  });

  it("removes a previous SVG immediately and ignores obsolete results and diagnostics", async () => {
    setup();
    const pending = deferredDiagram();
    renderer.render
      .mockResolvedValueOnce({
        svg: "<svg><text>Old picture</text></svg>",
        diagramType: "flowchart-v2",
      })
      .mockReturnValueOnce(pending.promise);
    const tracker = new DocumentPageTracker();
    await using screen = await render(diagramPage("old source", tracker), { router: false });
    await expect.poll(() => screen.container.querySelector("svg")?.textContent).toBe("Old picture");
    await screen.rerender(diagramPage("pending source", tracker));
    expect(screen.container.querySelector("svg")).toBeNull();
    expect(
      screen.container.querySelector('[data-scient-diagram="pending"]')?.textContent,
    ).toContain("pending source");
    await screen.rerender(diagramPage("current source", tracker));
    await expect
      .poll(() => screen.container.querySelector("svg")?.textContent)
      .toBe("Current diagram");
    expect(await tracker.settle()).toBe(true);
    await act(() =>
      pending.resolve({
        svg: "<svg><text>Obsolete</text></svg>",
        diagramType: "flowchart-v2",
        blocked: ["https://obsolete.test/image.png"],
      }),
    );
    expect(screen.container.querySelector("svg")?.textContent).toBe("Current diagram");
    expect(tracker.diagnostics).toEqual([]);
  });

  it("releases an obsolete tracker's work and ignores a failure after capture replacement", async () => {
    setup();
    const pending = deferredDiagram();
    renderer.render.mockReturnValueOnce(pending.promise);
    const oldTracker = new DocumentPageTracker();
    const tracker = new DocumentPageTracker();
    await using screen = await render(diagramPage("same source", oldTracker), { router: false });
    await screen.rerender(diagramPage("same source", tracker));
    await expect
      .poll(() => screen.container.querySelector("svg")?.textContent)
      .toBe("Current diagram");
    expect(await oldTracker.settle()).toBe(true);
    await act(() => pending.reject(new MermaidRenderError(new Error("Late load failure"))));
    expect(oldTracker.diagnostics).toEqual([]);
    expect(tracker.diagnostics).toEqual([]);
    expect(await tracker.settle()).toBe(true);
  });
});
