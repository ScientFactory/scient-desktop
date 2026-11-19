// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the lazy renderer seam.
import * as NodeFS from "node:fs";

import { parse as parseVega, type Spec as VegaSpec, View } from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyScientVegaRuntimeDefaults,
  authorSetsXLabelAngle,
  axisLabelsCollide,
  categoryAxisLabels,
  createVegaResourceLoader,
  fetchVegaRemoteResource,
  MAX_VEGA_REMOTE_RESOURCE_BYTES,
  normalizedVegaLiteError,
  restoreVegaLiteViewState,
  SCIENT_VEGA_TOOLTIP_CURSOR,
  validateVegaResourceUri,
  vegaLiteThemeConfig,
  type XCategoryLabelAngle,
} from "./vegaLiteRuntime";

function categoryBars(categories: ReadonlyArray<string>) {
  return {
    data: { values: categories.map((category, index) => ({ category, value: index + 1 })) },
    mark: "bar",
    encoding: {
      x: { field: "category", type: "nominal" },
      y: { field: "value", type: "quantitative" },
    },
  } satisfies TopLevelSpec;
}

async function drawnCategoryLabels(spec: TopLevelSpec, angle: XCategoryLabelAngle) {
  const view = new View(
    parseVega(compile({ ...spec, config: vegaLiteThemeConfig("light", angle) }).spec),
    { renderer: "none" },
  );
  await view.runAsync();
  const axes = categoryAxisLabels(view, angle);
  view.finalize();
  return axes;
}

function compiledSpecWithMarks(marks: ReadonlyArray<Record<string, unknown>>) {
  return { marks } as unknown as Parameters<typeof applyScientVegaRuntimeDefaults>[0];
}

function allCompiledMarks(spec: VegaSpec): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const visit = (marks: unknown) => {
    if (!Array.isArray(marks)) return;
    for (const mark of marks) {
      if (typeof mark !== "object" || mark == null || Array.isArray(mark)) continue;
      const record = mark as Record<string, unknown>;
      result.push(record);
      visit(record.marks);
    }
  };
  visit(spec.marks);
  return result;
}

function compiledCursor(mark: Record<string, unknown>): string | null {
  const encode = mark.encode;
  if (typeof encode !== "object" || encode == null || Array.isArray(encode)) return null;
  for (const phase of ["update", "enter"]) {
    const encodedPhase = (encode as Record<string, unknown>)[phase];
    if (typeof encodedPhase !== "object" || encodedPhase == null || Array.isArray(encodedPhase)) {
      continue;
    }
    const cursor = (encodedPhase as Record<string, unknown>).cursor;
    if (typeof cursor !== "object" || cursor == null || Array.isArray(cursor)) continue;
    const value = (cursor as Record<string, unknown>).value;
    if (typeof value === "string") return value;
  }
  return null;
}

function compileWithScientDefaults(spec: TopLevelSpec): VegaSpec {
  const compiled = compile(spec).spec;
  const prepared = applyScientVegaRuntimeDefaults(compiled);
  parseVega(prepared);
  return prepared;
}

describe("Vega-Lite runtime policy", () => {
  it("allows portable and remote resources but rejects ambiguous or local resources", () => {
    expect(validateVegaResourceUri("data:text/csv,a%2Cb")).toBe("data");
    expect(validateVegaResourceUri("https://example.test/data.csv")).toBe("remote");
    expect(validateVegaResourceUri("http://127.0.0.1:8000/data.json")).toBe("remote");
    expect(() => validateVegaResourceUri("data/results.csv")).toThrow("no stable base in chat");
    expect(() => validateVegaResourceUri("file:///tmp/results.csv")).toThrow("not supported");
  });

  it("loads bounded remote text without credentials and reports HTTP failures", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("a,b\n1,2", { status: 200 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404, statusText: "Not Found" }));

    await expect(
      fetchVegaRemoteResource("https://example.test/data.csv", {}, fetchImplementation),
    ).resolves.toBe("a,b\n1,2");
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
    await expect(
      fetchVegaRemoteResource("https://example.test/missing.csv", {}, fetchImplementation),
    ).rejects.toThrow("404 Not Found");
  });

  it("explains viewing-device network and CORS failures", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      fetchVegaRemoteResource("https://example.test/cors-blocked.csv", {}, fetchImplementation),
    ).rejects.toThrow("may not allow browser access (CORS)");
  });

  it("rejects resources whose declared size exceeds the runtime bound", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("tiny", {
        headers: { "content-length": String(MAX_VEGA_REMOTE_RESOURCE_BYTES + 1) },
      }),
    );
    await expect(
      fetchVegaRemoteResource("https://example.test/large.csv", {}, fetchImplementation),
    ).rejects.toThrow("too large");
  });

  it("provides stable light and dark defaults", () => {
    expect(vegaLiteThemeConfig("light")).toMatchObject({
      background: null,
      axis: { labelColor: "#525252" },
    });
    expect(vegaLiteThemeConfig("dark")).toMatchObject({
      background: null,
      axis: { labelColor: "#d4d4d4" },
    });
  });

  it("lays category labels flat by default and lets a chart's own angle win", () => {
    expect(vegaLiteThemeConfig("light")).toMatchObject({ axisXDiscrete: { labelAngle: 0 } });
    const authored = compile({
      data: { values: [{ category: "A", value: 1 }] },
      mark: "bar",
      encoding: {
        x: { field: "category", type: "nominal", axis: { labelAngle: 30 } },
        y: { field: "value", type: "quantitative" },
      },
      config: vegaLiteThemeConfig("light"),
    }).spec.axes?.find((axis) => axis.orient === "bottom");
    expect(authored?.labelAngle).toBe(30);
  });

  it("leaves category labels alone when the chart's config sets their angle", async () => {
    for (const scope of ["axis", "axisX", "axisDiscrete", "axisXBand"]) {
      const spec = { ...categoryBars(["A", "B"]), config: { [scope]: { labelAngle: 30 } } };
      expect(authorSetsXLabelAngle(spec)).toBe(true);
      const view = new View(
        parseVega(
          compile({ ...spec, config: { ...vegaLiteThemeConfig("light", null), ...spec.config } })
            .spec,
        ),
        { renderer: "none" },
      );
      await view.runAsync();
      // Drawn at the chart's own 30 degrees.
      expect(categoryAxisLabels(view, 30 as XCategoryLabelAngle)[0]).toHaveLength(2);
      view.finalize();
    }
    expect(authorSetsXLabelAngle(categoryBars(["A"]))).toBe(false);
    expect(
      authorSetsXLabelAngle({ ...categoryBars(["A"]), config: { axisY: { labelAngle: 30 } } }),
    ).toBe(false);
    expect(vegaLiteThemeConfig("light", null)).not.toHaveProperty("axisXDiscrete");
  });

  it("judges only category axes, so a crowded number axis beside them changes nothing", async () => {
    const numbers = Array.from({ length: 60 }, (_, index) => ({ n: index * 1000, v: index }));
    const axes = await drawnCategoryLabels(
      {
        hconcat: [
          {
            data: { values: numbers },
            mark: "point",
            encoding: {
              x: { field: "n", type: "quantitative", axis: { labelOverlap: false, tickCount: 60 } },
              y: { field: "v", type: "quantitative" },
            },
          },
          categoryBars(["A", "B", "C"]),
        ],
      },
      0,
    );
    expect(axes).toHaveLength(1);
    expect(axes[0]).toHaveLength(3);
    expect(axisLabelsCollide(axes, 0)).toBe(false);
  });

  it("judges category axes inside facets, whose scales the view cannot reach", async () => {
    const axes = await drawnCategoryLabels(
      {
        data: {
          values: ["p", "q"].flatMap((group) =>
            ["Oligodendrocyte precursors", "Astrocytes", "Microglia"].map((category) => ({
              category,
              group,
              value: 1,
            })),
          ),
        },
        facet: { field: "group" },
        resolve: { scale: { x: "independent" } },
        spec: { mark: "bar", encoding: categoryBars([]).encoding },
      } as unknown as TopLevelSpec,
      0,
    );
    expect(axes).toHaveLength(2);
    expect(axisLabelsCollide(axes, 0)).toBe(true);
  });

  it("skips an axis whose angle the chart set itself", async () => {
    const authored = categoryBars(["Oligodendrocyte precursors", "Astrocytes", "Microglia"]);
    const axes = await drawnCategoryLabels(
      {
        ...authored,
        encoding: { ...authored.encoding, x: { ...authored.encoding.x, axis: { labelAngle: 30 } } },
      },
      0,
    );
    expect(axes).toHaveLength(0);
  });

  it("finds the category labels of a drawn chart and tells when they touch", async () => {
    const short = await drawnCategoryLabels(categoryBars(["A", "B", "C", "D"]), 0);
    expect(short).toHaveLength(1);
    expect(short[0]?.map((label) => label.x)).toEqual(
      [...(short[0]?.map((label) => label.x) ?? [])].sort((a, b) => a - b),
    );
    expect(short[0]).toHaveLength(4);
    expect(axisLabelsCollide(short, 0)).toBe(false);

    const long = await drawnCategoryLabels(
      categoryBars(["Oligodendrocyte precursors", "Astrocytes", "Microglia", "Neurons"]),
      0,
    );
    expect(axisLabelsCollide(long, 0)).toBe(true);
    // Twenty-pixel bands leave room for slanted 11-pixel text.
    expect(
      axisLabelsCollide(
        await drawnCategoryLabels(
          categoryBars(["Oligodendrocyte precursors", "Astrocytes", "Microglia", "Neurons"]),
          -45,
        ),
        -45,
      ),
    ).toBe(false);
  });

  it("stands slanted labels upright when their bands are narrower than the text is tall", () => {
    const label = (x: number) => ({ fontSize: 11, x, x1: x - 40, x2: x });
    expect(axisLabelsCollide([[label(0), label(20), label(40)]], -45)).toBe(false);
    expect(axisLabelsCollide([[label(0), label(12), label(24)]], -45)).toBe(true);
    expect(axisLabelsCollide([[label(0)], []], 0)).toBe(false);
  });

  it("adds the compact inspection cursor only to tooltip marks without an existing cursor", () => {
    const tooltipOnly = {
      encode: { update: { tooltip: { field: "value" } } },
      type: "rect",
    };
    const clickable = {
      encode: {
        update: { cursor: { value: "pointer" }, tooltip: { field: "value" } },
      },
      type: "symbol",
    };
    const authored = {
      encode: {
        enter: { cursor: { value: "help" } },
        update: { tooltip: { field: "value" } },
      },
      type: "symbol",
    };
    const inert = {
      encode: { update: { tooltip: { field: "value" } } },
      interactive: false,
      type: "text",
    };
    const nested = {
      encode: { update: { tooltip: { field: "nested" } } },
      type: "arc",
    };

    applyScientVegaRuntimeDefaults(
      compiledSpecWithMarks([
        tooltipOnly,
        clickable,
        authored,
        inert,
        {
          marks: [nested],
          type: "group",
        },
      ]),
    );

    expect(tooltipOnly.encode.update).toMatchObject({
      cursor: { value: SCIENT_VEGA_TOOLTIP_CURSOR },
    });
    expect(clickable.encode.update.cursor).toEqual({ value: "pointer" });
    expect(authored.encode.enter.cursor).toEqual({ value: "help" });
    expect(inert.encode.update).not.toHaveProperty("cursor");
    expect(nested.encode.update).toMatchObject({
      cursor: { value: SCIENT_VEGA_TOOLTIP_CURSOR },
    });

    expect(SCIENT_VEGA_TOOLTIP_CURSOR).toContain('") 8 8, crosshair');
    const encodedSvg = SCIENT_VEGA_TOOLTIP_CURSOR.slice(
      SCIENT_VEGA_TOOLTIP_CURSOR.indexOf(",") + 1,
      SCIENT_VEGA_TOOLTIP_CURSOR.lastIndexOf('")'),
    );
    expect(decodeURIComponent(encodedSvg)).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"',
    );
    expect(decodeURIComponent(encodedSvg)).toContain('d="M8 3v10M3 8h10"');
  });

  it("preserves real Vega-Lite click, brush, link, and authored cursor semantics", () => {
    const baseData = { values: [{ group: "A", value: 4 }] };
    const tooltipOnly = compileWithScientDefaults({
      data: baseData,
      encoding: {
        tooltip: [{ field: "group" }, { field: "value" }],
        x: { field: "group" },
        y: { field: "value", type: "quantitative" },
      },
      mark: "bar",
    });
    const clickable = compileWithScientDefaults({
      data: baseData,
      encoding: {
        tooltip: [{ field: "group" }],
        x: { field: "value", type: "quantitative" },
        y: { field: "value", type: "quantitative" },
      },
      mark: "point",
      params: [{ name: "focus", select: { type: "point" } }],
    });
    const brush = compileWithScientDefaults({
      data: baseData,
      encoding: {
        x: { field: "value", type: "quantitative" },
        y: { field: "value", type: "quantitative" },
      },
      mark: "point",
      params: [{ name: "brush", select: { type: "interval" } }],
    });
    const linked = compileWithScientDefaults({
      data: { values: [{ group: "A", url: "https://example.test", value: 4 }] },
      encoding: {
        href: { field: "url" },
        tooltip: [{ field: "group" }],
        x: { field: "group" },
        y: { field: "value", type: "quantitative" },
      },
      mark: "bar",
    });
    const authored = compileWithScientDefaults({
      data: baseData,
      encoding: {
        tooltip: [{ field: "group" }],
        x: { field: "group" },
        y: { field: "value", type: "quantitative" },
      },
      mark: { cursor: "help", type: "bar" },
    });

    expect(allCompiledMarks(tooltipOnly).map(compiledCursor)).toContain(SCIENT_VEGA_TOOLTIP_CURSOR);
    expect(allCompiledMarks(clickable).map(compiledCursor)).toContain("pointer");
    expect(allCompiledMarks(brush).map(compiledCursor)).toContain("move");
    expect(allCompiledMarks(linked).map(compiledCursor)).toContain("pointer");
    expect(allCompiledMarks(authored).map(compiledCursor)).toContain("help");
  });

  it("normalizes renderer failures to one useful line", () => {
    expect(normalizedVegaLiteError(new Error("First problem\nsecondary detail")).message).toBe(
      "First problem",
    );
  });

  it("finishes restoring transferred interaction state before exposing the view", async () => {
    const calls: string[] = [];
    const view = {
      setState: vi.fn(() => {
        calls.push("setState");
        return view;
      }),
      runAsync: vi.fn(async () => {
        calls.push("runAsync");
        await Promise.resolve();
        calls.push("settled");
        return view;
      }),
    };

    await restoreVegaLiteViewState(view as never, { signals: { focus: "A" } } as never);

    expect(calls).toEqual(["setState", "runAsync", "settled"]);
  });

  it("retains loader failures that Vega may otherwise downgrade to warnings", async () => {
    const defaultLoader = {
      file: vi.fn(),
      http: vi.fn(),
      load: vi.fn().mockResolvedValue("portable"),
      sanitize: vi.fn().mockResolvedValue({ href: "data:text/plain,portable" }),
    };
    const runtime = createVegaResourceLoader({
      loader: vi.fn(() => defaultLoader),
    } as unknown as typeof import("vega"));

    await expect(runtime.loader.load("./missing.csv")).rejects.toThrow("no stable base in chat");
    expect(runtime.failures).toHaveLength(1);
    expect(runtime.failures[0]?.message).toContain("no stable base in chat");
    await expect(runtime.loader.load("data:text/plain,portable")).resolves.toBe("portable");
  });

  it("loads each resource once when a chart is drawn again", async () => {
    const defaultLoader = {
      file: vi.fn(),
      http: vi.fn(),
      load: vi.fn().mockResolvedValue("portable"),
      sanitize: vi.fn(),
    };
    const runtime = createVegaResourceLoader({
      loader: vi.fn(() => defaultLoader),
    } as unknown as typeof import("vega"));

    await runtime.loader.load("data:text/plain,portable");
    await runtime.loader.load("data:text/plain,portable");
    await runtime.loader.load("data:text/plain,other");
    expect(defaultLoader.load).toHaveBeenCalledTimes(2);
  });
});

describe("Vega-Lite CSP and bundle seam", () => {
  const runtimeSource = NodeFS.readFileSync(
    new URL("./vegaLiteRuntime.ts", import.meta.url),
    "utf8",
  );

  it("keeps the renderer lazy and uses the CSP-safe interpreter path", () => {
    expect(runtimeSource).toContain('vegaEmbedRuntimePromise ??= import("vega-embed")');
    expect(runtimeSource).not.toMatch(/^import (?!type).*from ["']vega-embed["']/mu);
    expect(runtimeSource).toContain('import("./vegaLiteTooltip")');
    expect(runtimeSource).toContain("ast: true");
    expect(runtimeSource).toContain("hypot: Math.hypot");
    expect(runtimeSource).toContain("resourceLoader.failures[0]");
  });
});
