import { render as _fixtureRender, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";

vi.mock("./usePlotlyViewportActivity", () => ({
  usePlotlyViewportActivity: () => ({ active: false, ref: () => undefined }),
}));
import { PlotlyChartCard } from "./PlotlyChartCard";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

it("identifies the copied source as Plotly JSON and preserves its exact bytes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const source = '{ "data": [{"x":[1,2], "y":[3,4]}], "layout": {} }';
  const container = document.createElement("div");
  document.body.append(container);
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: container, router: false }),
  );
  try {
    await act(
      async () =>
        await root.rerender(
          <PlotlyChartCard source={source} language="plotly" theme="light" title={null} />,
        ),
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
    await act(async () => await root.unmount());
    container.remove();
  }
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
