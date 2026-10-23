import { render as _fixtureRender, act } from "../../../test/render";
import { type ComponentProps } from "react";

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
      await using _fixture = _createFixture();

      const container = document.createElement("div");
      document.body.append(container);
      const root = _fixture.stack.use(
        await _fixtureRender(null, { container: container, router: false }),
      );
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
        await act(async () => await root.rerender(render(true)));
        const source = container.querySelector<HTMLPreElement>(
          "[data-scient-rich-fence-find-source]",
        )!;
        expect(source.hidden).toBe(true);
        expect(collectThreadFindRanges(container, "Alpha")).toHaveLength(1);
        await act(() => source.dispatchEvent(new Event("beforematch")));
        expect(source.hidden).toBe(false);
        expect(collectThreadFindRanges(container, "Alpha")).toHaveLength(1);
        await act(async () => await root.rerender(render(false)));
        expect(container.querySelector("[data-scient-rich-fence-find-source]")).toBeNull();
        expect(container.textContent).toBe("Duplicated Alpha renderer chrome");
      } finally {
        await act(async () => await root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
