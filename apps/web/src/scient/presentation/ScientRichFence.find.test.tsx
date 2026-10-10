// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { MarkdownFindContext } from "~/components/chat/markdownFindContext";
import { collectThreadFindRanges } from "~/components/chat/threadFindHighlights";
import { ScientRichFence } from "./ScientRichFence";

vi.mock("../diagrams/MermaidDiagramCard", () => ({
  MermaidDiagramCard: () => <div>Duplicated Alpha renderer chrome</div>,
}));
vi.mock("../visualizations/PlotlyChartCard", () => ({
  PlotlyChartCard: () => <div>Duplicated Alpha renderer chrome</div>,
}));
vi.mock("../visualizations/VegaLiteChartCard", () => ({
  VegaLiteChartCard: () => <div>Duplicated Alpha renderer chrome</div>,
}));

describe("scientific fences in thread find", () => {
  it.each(["mermaid", "plotly", "vega-lite"] as const)(
    "indexes %s source once and reveals only its selected source",
    async (kind) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const props: ComponentProps<typeof ScientRichFence> = {
        kind,
        language: kind,
        source: "Alpha source\nBeta",
        theme: "light",
        title: "Alpha title",
      };
      const render = (searching: boolean) => (
        <div data-timeline-row-id="row">
          <div data-thread-find-text>
            <MarkdownFindContext value={searching}>
              <ScientRichFence {...props} />
            </MarkdownFindContext>
          </div>
        </div>
      );
      try {
        await act(() => root.render(render(true)));
        const source = container.querySelector<HTMLPreElement>(
          "[data-scient-rich-fence-find-source]",
        )!;
        expect(source.hidden).toBe(true);
        expect(collectThreadFindRanges(container, "Alpha")).toHaveLength(1);
        await act(() => source.dispatchEvent(new Event("beforematch")));
        expect(source.hidden).toBe(false);
        expect(collectThreadFindRanges(container, "Alpha")).toHaveLength(1);
        await act(() => root.render(render(false)));
        expect(container.querySelector("[data-scient-rich-fence-find-source]")).toBeNull();
        expect(container.textContent).toBe("Duplicated Alpha renderer chrome");
      } finally {
        await act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
