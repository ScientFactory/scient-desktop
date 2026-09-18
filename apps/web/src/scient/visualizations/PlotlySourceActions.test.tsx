// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./usePlotlyViewportActivity", () => ({
  usePlotlyViewportActivity: () => ({ active: false, ref: () => undefined }),
}));
import { PlotlyChartCard } from "./PlotlyChartCard";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("identifies the copied source as Plotly JSON and preserves its exact bytes", async () => {
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const source = '{ "data": [{"x":[1,2], "y":[3,4]}], "layout": {} }';
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(<PlotlyChartCard source={source} language="plotly" theme="light" title={null} />),
    );
    await act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="More Plotly actions"]')!
        .click(),
    );
    const copy = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
      (item) => item.textContent === "Copy Plotly JSON",
    );
    expect(copy).toBeDefined();
    await act(() => copy!.click());
    expect(write).toHaveBeenCalledWith(source);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
