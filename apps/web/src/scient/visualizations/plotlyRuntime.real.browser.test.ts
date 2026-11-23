import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import plotlyExpressLine from "./plotlyExpressLine.fixture.json";
import { getPlotlyRuntimePromise, mountPlotlyView, type MountedPlotlyView } from "./plotlyRuntime";
import { parsePlotlySource } from "./plotlySpec";

// These run the real Plotly bundle and MathJax: the mocked unit tests could not catch that
// Plotly's validator throws on one-series Plotly Express figures, or that a math label hung.

type DisposableView = MountedPlotlyView & Disposable;

async function mount(figure: unknown): Promise<DisposableView> {
  const container = document.createElement("div");
  container.style.width = "480px";
  container.style.height = "320px";
  document.body.append(container);
  const view = await mountPlotlyView({
    container,
    parsed: parsePlotlySource(JSON.stringify(figure)),
    surface: "inline",
    theme: "light",
  });
  return Object.assign(view, {
    [Symbol.dispose]: () => {
      view.dispose();
      container.remove();
    },
  });
}

it("loads the Plotly 4.2 strict bundle", async () => {
  const runtime = await getPlotlyRuntimePromise();
  expect((runtime as unknown as { version: string }).version).toBe("4.2.0");
});

it("draws a one-series Plotly Express figure written by plotly.py 7", async () => {
  using view = await mount(plotlyExpressLine);

  expect(view.graph.querySelector(".scatterlayer .trace")).not.toBeNull();
  expect(view.warnings).toEqual([]);
});

it("applies both toggle button arguments without validator warnings", async () => {
  using view = await mount({
    data: [{ type: "scatter", mode: "lines", x: [1, 2], y: [1, 2], line: { color: "red" } }],
    layout: {
      updatemenus: [
        {
          type: "buttons",
          active: -1,
          buttons: [
            {
              label: "Toggle color",
              method: "restyle",
              args: [{ "line.color": "blue" }],
              args2: [{ "line.color": "red" }],
            },
          ],
        },
      ],
    },
  });

  expect(view.warnings).toEqual([]);
  const color = () => view.graph.querySelector<SVGPathElement>(".js-line")?.style.stroke;
  const toggle = page.getByText("Toggle color", { exact: true });
  expect(color()).toBe("rgb(255, 0, 0)");
  await toggle.click();
  await expect.poll(color).toBe("rgb(0, 0, 255)");
  await toggle.click();
  await expect.poll(color).toBe("rgb(255, 0, 0)");
});

it("draws a figure with an on-demand TeX macro and the figure queued after it", async () => {
  const math = mount({
    data: [{ type: "scatter", x: [1, 2], y: [1, 2] }],
    layout: { title: { text: "$\\boldsymbol{\\beta}$" } },
  });
  const next = mount({ data: [{ type: "bar", x: ["a", "b"], y: [1, 2] }] });

  using mathView = await math;
  using nextView = await next;
  expect(mathView.graph.querySelector(".scatterlayer .trace")).not.toBeNull();
  expect(nextView.graph.querySelector(".barlayer .trace")).not.toBeNull();
});

it("never turns a TeX \\href into a script link", async () => {
  const label = "$\\href{javascript:window.__scientPlotlyHref=1}{x}$";
  using view = await mount({
    data: [{ type: "scatter", name: label, x: [1, 2], y: [1, 2] }],
    layout: {
      annotations: [{ text: label, x: 1, y: 1 }],
      showlegend: true,
      title: { text: label },
    },
  });

  expect(
    view.graph.querySelector('a[href^="javascript:" i], a[*|href^="javascript:" i]'),
  ).toBeNull();
});
