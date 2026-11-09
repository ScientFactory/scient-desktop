import { describe, expect, it } from "vite-plus/test";

import { mountVegaLiteView } from "./vegaLiteRuntime";
import { buildVegaLiteRenderPlan, parseVegaLiteSource } from "./vegaLiteSpec";

const LONG_NAMES = [
  "Oligodendrocyte precursors",
  "Astrocytes",
  "Microglia",
  "Excitatory neurons",
  "Inhibitory neurons",
  "Endothelial cells",
];

function barChart(categories: ReadonlyArray<string>, extra: Record<string, unknown> = {}) {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: categories.map((category, index) => ({ category, value: index + 1 })) },
    mark: "bar",
    encoding: {
      x: { field: "category", type: "nominal", ...extra },
      y: { field: "value", type: "quantitative" },
    },
  };
}

async function categoryLabelTransforms(spec: Record<string, unknown>) {
  const container = document.createElement("div");
  container.style.width = "640px";
  document.body.append(container);
  const parsed = parseVegaLiteSource(JSON.stringify(spec));
  const mounted = await mountVegaLiteView({
    container,
    parsed,
    renderPlan: buildVegaLiteRenderPlan(parsed.spec),
    theme: "light",
    title: "Chart",
  });
  // Labels of every x axis, in drawing order.
  const transforms = [...container.querySelectorAll("g.role-axis")]
    .filter((axis) => axis.getAttribute("aria-label")?.startsWith("X-axis") === true)
    .flatMap((axis) => [...axis.querySelectorAll("g.role-axis-label text")])
    .map((label) => label.getAttribute("transform") ?? "");
  mounted.result.finalize();
  container.remove();
  return transforms;
}

describe("Vega-Lite category labels", () => {
  it("lies short labels flat", async () => {
    const transforms = await categoryLabelTransforms(barChart(["A", "B", "C", "D"]));
    expect(transforms).toHaveLength(4);
    expect(transforms.every((transform) => !transform.includes("rotate"))).toBe(true);
  });

  it("slants long labels that would touch", async () => {
    const transforms = await categoryLabelTransforms(barChart(LONG_NAMES));
    expect(transforms).toHaveLength(LONG_NAMES.length);
    expect(transforms.every((transform) => transform.includes("rotate(-45)"))).toBe(true);
  });

  it("stands labels upright when even slanted ones would touch", async () => {
    const many = Array.from({ length: 40 }, (_, index) => `Gene ${index + 1}`);
    const transforms = await categoryLabelTransforms({ ...barChart(many), width: 300 });
    expect(transforms).toHaveLength(many.length);
    expect(transforms.every((transform) => transform.includes("rotate(-90)"))).toBe(true);
  });

  it("keeps the angle a chart sets itself", async () => {
    const transforms = await categoryLabelTransforms(
      barChart(LONG_NAMES, { axis: { labelAngle: 30 } }),
    );
    expect(transforms).toHaveLength(LONG_NAMES.length);
    expect(transforms.every((transform) => transform.includes("rotate(30)"))).toBe(true);
  });

  it("keeps the angle a chart's config sets", async () => {
    const transforms = await categoryLabelTransforms({
      ...barChart(LONG_NAMES),
      config: { axis: { labelAngle: 30 } },
    });
    expect(transforms).toHaveLength(LONG_NAMES.length);
    expect(transforms.every((transform) => transform.includes("rotate(30)"))).toBe(true);
  });

  it("ignores a crowded number axis beside the categories", async () => {
    const numbers = Array.from({ length: 60 }, (_, index) => ({ n: index * 1000, v: index }));
    const { $schema, ...categories } = barChart(["A", "B", "C"]);
    const transforms = await categoryLabelTransforms({
      $schema,
      hconcat: [
        {
          data: { values: numbers },
          mark: "point",
          encoding: {
            x: { field: "n", type: "quantitative", axis: { labelOverlap: false, tickCount: 60 } },
            y: { field: "v", type: "quantitative" },
          },
        },
        categories,
      ],
    });
    const categoryLabels = transforms.slice(-3);
    expect(categoryLabels).toHaveLength(3);
    expect(categoryLabels.every((transform) => !transform.includes("rotate"))).toBe(true);
  });
});
