import { parse as parseVega, Warn, logger } from "vega";
import { guessMode, type VisualizationSpec } from "vega-embed";
import { compile, version as vegaLiteVersion } from "vega-lite";
import { describe, expect, it } from "vite-plus/test";

import {
  buildVegaLiteRenderPlan,
  MAX_VEGA_LITE_INLINE_ROWS,
  MAX_VEGA_LITE_SOURCE_LENGTH,
  parseVegaLiteSource,
  prepareVegaLiteSpecForRuntime,
  vegaLiteDescription,
} from "./vegaLiteSpec";

const BAR_SPEC = `{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "description": "Treatment response",
  "data": {"values": [{"group": "A", "value": 3}]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "group", "type": "nominal"},
    "y": {"field": "value", "type": "quantitative"}
  }
}`;

const BUNDLED_VEGA_LITE_MAJOR = Number(/^\d+/u.exec(vegaLiteVersion)?.[0]);

const LAYERED_HOVER_SPEC = {
  data: {
    values: [
      { day: 1, outcome: 4 },
      { day: 2, outcome: 7 },
    ],
  },
  params: [
    {
      name: "hover",
      select: { clear: "pointerout", on: "pointerover", type: "point" },
    },
  ],
  layer: [
    {
      mark: "bar",
      encoding: {
        x: { field: "day", type: "ordinal" },
        y: { field: "outcome", type: "quantitative" },
        opacity: { condition: { param: "hover", value: 1 }, value: 0.5 },
      },
    },
    {
      transform: [{ filter: { param: "hover" } }],
      mark: "text",
      encoding: {
        x: { field: "day", type: "ordinal" },
        y: { field: "outcome", type: "quantitative" },
        text: { field: "outcome" },
      },
    },
  ],
} as const;

const LAYERED_LEGEND_SPEC = {
  width: 520,
  data: {
    values: [
      { group: "A", high: 8, low: 5, mean: 6.5, week: 0 },
      { group: "B", high: 7, low: 4, mean: 5.5, week: 0 },
    ],
  },
  params: [
    {
      bind: "legend",
      name: "legendSelect",
      select: { fields: ["group"], type: "point" },
    },
  ],
  layer: [
    {
      mark: "area",
      encoding: {
        color: { field: "group", legend: null, scale: { scheme: "tableau10" }, type: "nominal" },
        x: { field: "week", type: "quantitative" },
        y: { field: "low", type: "quantitative" },
        y2: { field: "high" },
      },
    },
    {
      mark: "line",
      encoding: {
        color: {
          field: "group",
          legend: { title: "Treatment group" },
          scale: { scheme: "tableau10" },
          type: "nominal",
        },
        opacity: { condition: { param: "legendSelect", value: 1 }, value: 0.15 },
        x: { field: "week", type: "quantitative" },
        y: { field: "mean", type: "quantitative" },
      },
    },
    {
      mark: "point",
      encoding: {
        color: { field: "group", legend: null, scale: { scheme: "tableau10" }, type: "nominal" },
        x: { field: "week", type: "quantitative" },
        y: { field: "mean", type: "quantitative" },
      },
    },
  ],
} as const;

function compileAndParse(spec: unknown): ReadonlyArray<string> {
  const warnings: string[] = [];
  const compileLogger = logger(Warn, undefined, (_method, _level, values) => {
    warnings.push(values.join(" "));
  });
  const compiled = compile(spec as never, { logger: compileLogger }).spec;
  parseVega(compiled);
  return warnings;
}

function embedModeWarnings(spec: unknown): ReadonlyArray<string> {
  const warnings: string[] = [];
  const embedLogger = logger(Warn, undefined, (_method, _level, values) => {
    warnings.push(values.join(" "));
  });
  expect(guessMode(spec as VisualizationSpec, embedLogger, "vega-lite")).toBe("vega-lite");
  return warnings;
}

describe("parseVegaLiteSource", () => {
  it("parses JSONC, keeps the canonical description, and inventories resources", () => {
    const parsed = parseVegaLiteSource(`{
      // Agents occasionally emit helpful JSONC comments.
      "description": "External cohort",
      "data": {"url": "https://example.test/cohort.csv"},
      "mark": "point",
    }`);

    expect(parsed.externalResources).toEqual(["https://example.test/cohort.csv"]);
    expect(vegaLiteDescription(parsed.spec)).toBe("External cohort");
  });

  it("does not label portable data URIs or relative paths as external data", () => {
    const parsed = parseVegaLiteSource(`{
      "data": {"url": "data:text/csv,a%2Cb"},
      "transform": [{"lookup": "a", "from": {"data": {"url": "./local.csv"}, "key": "a", "fields": ["b"]}}],
      "mark": "point"
    }`);
    expect(parsed.externalResources).toEqual([]);
  });

  it("reports the first JSON error with line and column", () => {
    expect(() => parseVegaLiteSource('{\n  "mark": "bar",\n  nope\n}')).toThrow(
      /Invalid JSON at line 3, column 3/u,
    );
  });

  it("rejects empty, non-object, low-level Vega, oversized, and over-row sources", () => {
    expect(() => parseVegaLiteSource("  ")).toThrow("source is empty");
    expect(() => parseVegaLiteSource("[]")).toThrow("must be a JSON object");
    expect(() =>
      parseVegaLiteSource('{"$schema":"https://vega.github.io/schema/vega/v6.json"}'),
    ).toThrow("low-level Vega");
    expect(() =>
      parseVegaLiteSource(`{"mark":"bar","x":"${"x".repeat(MAX_VEGA_LITE_SOURCE_LENGTH)}"}`),
    ).toThrow("source is too large");
    const rows = Array.from({ length: MAX_VEGA_LITE_INLINE_ROWS + 1 }, () => 1);
    expect(() =>
      parseVegaLiteSource(JSON.stringify({ data: { values: rows }, mark: "tick" })),
    ).toThrow("too many inline rows");
  });

  it("accepts the complete ordinary bar chart", () => {
    expect(parseVegaLiteSource(BAR_SPEC).spec).toMatchObject({ mark: "bar" });
  });
});

describe("buildVegaLiteRenderPlan", () => {
  it("adds non-destructive responsive defaults to unsized single views", () => {
    const spec = parseVegaLiteSource(BAR_SPEC).spec;
    const plan = buildVegaLiteRenderPlan(spec);
    const prepared = plan.spec as unknown as Record<string, unknown>;

    expect(plan.responsive).toBe(true);
    expect(prepared.width).toBe("container");
    expect(prepared.autosize).toEqual({ type: "fit", contains: "padding", resize: true });
    expect((spec as unknown as Record<string, unknown>).width).toBeUndefined();
  });

  it("preserves authored dimensions and multi-view sizing", () => {
    const fixed = { mark: "bar", width: 640 } as never;
    const faceted = { facet: { field: "group" }, spec: { mark: "bar" } } as never;
    expect(buildVegaLiteRenderPlan(fixed)).toEqual({ responsive: false, spec: fixed });
    expect(buildVegaLiteRenderPlan(faceted)).toEqual({ responsive: false, spec: faceted });
  });

  it("gives a layered hover selection one view without changing the authored source", () => {
    const source = structuredClone(LAYERED_HOVER_SPEC) as never;
    const plan = buildVegaLiteRenderPlan(source);
    const prepared = plan.spec as unknown as {
      layer: Array<{ name?: string }>;
      params: Array<{ views?: string[] }>;
    };

    expect(prepared.params[0]?.views).toEqual([prepared.layer[0]?.name]);
    expect(prepared.layer[0]?.name).toMatch(/^scient_interaction_hover/u);
    expect((source as { params: Array<{ views?: string[] }> }).params[0]?.views).toBeUndefined();
    expect(compileAndParse(plan.spec)).toEqual([]);
  });

  it("keeps a required shared legend and scopes its selection to the legend layer", () => {
    const source = structuredClone(LAYERED_LEGEND_SPEC) as never;
    const plan = buildVegaLiteRenderPlan(source);
    const prepared = plan.spec as unknown as {
      layer: Array<{
        encoding: { color: { legend?: unknown } };
        name?: string;
      }>;
      params: Array<{ views?: string[] }>;
    };

    expect(plan.responsive).toBe(false);
    expect(prepared.params[0]?.views).toEqual([prepared.layer[1]?.name]);
    expect(prepared.layer[0]?.encoding.color).not.toHaveProperty("legend");
    expect(prepared.layer[2]?.encoding.color).not.toHaveProperty("legend");
    expect(
      (source as { layer: Array<{ encoding: { color: { legend: unknown } } }> }).layer[0]?.encoding
        .color.legend,
    ).toBeNull();
    expect(compileAndParse(plan.spec)).toEqual([]);
  });

  it("respects explicit view ownership and avoids generated-name collisions", () => {
    const explicit = {
      width: 500,
      params: [{ name: "focus", select: { type: "point" }, views: ["points"] }],
      layer: [{ mark: "point", name: "points" }],
    } as never;
    expect(buildVegaLiteRenderPlan(explicit).spec).toBe(explicit);

    const colliding = {
      width: 500,
      params: [{ name: "focus", select: { type: "point" } }],
      layer: [
        {
          mark: "rule",
          name: "scient_interaction_focus",
          transform: [{ filter: { param: "focus" } }],
        },
        { mark: "point" },
      ],
    } as never;
    const prepared = buildVegaLiteRenderPlan(colliding).spec as unknown as {
      params: Array<{ views: string[] }>;
    };
    expect(prepared.params[0]?.views).toEqual(["scient_interaction_focus_2"]);
  });

  it("scopes the compact string form of a layered selection", () => {
    const plan = buildVegaLiteRenderPlan({
      width: 500,
      data: { values: [{ x: 1, y: 2 }] },
      params: [{ name: "brush", select: "interval" }],
      layer: [
        {
          mark: "point",
          encoding: {
            x: { field: "x", type: "quantitative" },
            y: { field: "y", type: "quantitative" },
          },
        },
        {
          mark: "rule",
          encoding: { x: { datum: 1, type: "quantitative" } },
        },
      ],
    } as never);
    const prepared = plan.spec as unknown as { params: Array<{ views?: string[] }> };

    expect(prepared.params[0]?.views).toEqual(["scient_interaction_brush"]);
    expect(compileAndParse(plan.spec)).toEqual([]);
  });
});

describe("prepareVegaLiteSpecForRuntime", () => {
  it("removes compatible schema metadata only from the disposable render copy", () => {
    for (const major of [
      BUNDLED_VEGA_LITE_MAJOR - 2,
      BUNDLED_VEGA_LITE_MAJOR - 1,
      BUNDLED_VEGA_LITE_MAJOR,
    ]) {
      const parsed = parseVegaLiteSource(BAR_SPEC.replace("/v6.json", `/v${major}.json`));
      const prepared = prepareVegaLiteSpecForRuntime(
        parsed.spec,
        vegaLiteVersion,
      ) as unknown as Record<string, unknown>;

      expect(prepared).not.toHaveProperty("$schema");
      expect((parsed.spec as unknown as Record<string, unknown>).$schema).toBe(
        `https://vega.github.io/schema/vega-lite/v${major}.json`,
      );
      expect(compileAndParse(prepared)).toEqual([]);
      expect(embedModeWarnings(prepared)).toEqual([]);
    }
  });

  it("removes Vega-Embed's version-only warning from a compatible prior-major chart", () => {
    const priorMajor = BUNDLED_VEGA_LITE_MAJOR - 1;
    const parsed = parseVegaLiteSource(BAR_SPEC.replace("/v6.json", `/v${priorMajor}.json`));
    expect(embedModeWarnings(parsed.spec)).toEqual([
      `The input spec uses Vega-Lite v${priorMajor}, but the current version of Vega-Lite is v${vegaLiteVersion}.`,
    ]);

    const prepared = prepareVegaLiteSpecForRuntime(parsed.spec, vegaLiteVersion);
    expect(embedModeWarnings(prepared)).toEqual([]);
  });

  it("leaves schema-less specs untouched", () => {
    const spec = { mark: "point" } as never;
    expect(prepareVegaLiteSpecForRuntime(spec, vegaLiteVersion)).toBe(spec);
  });

  it("rejects a declared future major instead of silently misrendering it", () => {
    const futureMajor = BUNDLED_VEGA_LITE_MAJOR + 1;
    const parsed = parseVegaLiteSource(BAR_SPEC.replace("/v6.json", `/v${futureMajor}.json`));
    expect(() => prepareVegaLiteSpecForRuntime(parsed.spec, vegaLiteVersion)).toThrow(
      `targets Vega-Lite v${futureMajor}`,
    );
  });
});
