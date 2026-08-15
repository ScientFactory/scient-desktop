import { describe, expect, it, vi } from "vite-plus/test";
import type { Layout, PlotlyHTMLElement, ValidateResult } from "plotly.js";

import {
  mountPlotlyView,
  preparePlotlyRuntimeFigure,
  type PlotlyRuntime,
  type PlotlyRuntimeFigure,
} from "./plotlyRuntime";
import { parsePlotlySource } from "./plotlySpec";

function parsedFigure() {
  return parsePlotlySource(
    JSON.stringify({
      data: [{ type: "scatter", x: [1, 2], y: [3, 4] }],
      layout: { title: { text: "Response" } },
      config: { displaylogo: true, scrollZoom: true },
      frames: [{ name: "later", data: [{ y: [5, 6] }] }],
    }),
  );
}

function runtimeFixture(): {
  readonly graph: PlotlyHTMLElement;
  readonly runtime: PlotlyRuntime;
  readonly spies: {
    readonly addFrames: ReturnType<typeof vi.fn>;
    readonly deleteFrames: ReturnType<typeof vi.fn>;
    readonly newPlot: ReturnType<typeof vi.fn>;
    readonly purge: ReturnType<typeof vi.fn>;
    readonly react: ReturnType<typeof vi.fn>;
    readonly relayout: ReturnType<typeof vi.fn>;
    readonly removeAllListeners: ReturnType<typeof vi.fn>;
    readonly resize: ReturnType<typeof vi.fn>;
    readonly validate: ReturnType<typeof vi.fn>;
  };
} {
  const removeAllListeners = vi.fn();
  const graph = {
    data: [{ type: "scatter", x: [1, 2], y: [3, 4] }],
    layout: { title: { text: "Response" } },
    getBoundingClientRect: () => ({ height: 360, width: 640 }),
    on: vi.fn(),
    removeAllListeners,
  } as unknown as PlotlyHTMLElement;
  const addFrames = vi.fn(async () => graph);
  const deleteFrames = vi.fn(async () => graph);
  const newPlot = vi.fn(async (_root, data, layout) => {
    graph.data = data;
    graph.layout = layout;
    return graph;
  });
  const react = vi.fn(async (_root, figure) => {
    graph.data = figure.data;
    graph.layout = figure.layout;
    return graph;
  });
  const purge = vi.fn();
  const relayout = vi.fn(async (_graph, update: Partial<Layout>) => {
    graph.layout = { ...graph.layout, ...update };
    return graph;
  });
  const resize = vi.fn();
  const validate = vi.fn(() => [{ msg: "A compatible attribute was ignored." }]);
  const runtime = {
    Plots: { resize },
    addFrames,
    deleteFrames,
    newPlot,
    purge,
    react,
    relayout,
    toImage: vi.fn(async () => "data:image/png;base64,AA=="),
    validate,
  } as unknown as PlotlyRuntime;
  return {
    graph,
    runtime,
    spies: {
      addFrames,
      deleteFrames,
      newPlot,
      purge,
      react,
      relayout,
      removeAllListeners,
      resize,
      validate,
    },
  };
}

describe("Plotly runtime", () => {
  it("applies host interaction policy without mutating canonical source", () => {
    const parsed = parsedFigure();
    const before = structuredClone(parsed.figure);
    const inline = preparePlotlyRuntimeFigure(parsed, "dark", "inline");
    const expanded = preparePlotlyRuntimeFigure(parsed, "dark", "expanded");

    expect(inline.config).toMatchObject({
      displayModeBar: false,
      displaylogo: false,
      editable: false,
      responsive: true,
      scrollZoom: false,
      showEditInChartStudio: false,
      showSendToCloud: false,
    });
    expect(inline.config.modeBarButtonsToRemove).toBeUndefined();
    expect(expanded.config.scrollZoom).toBe(true);
    expect(inline.layout.dragmode).toBe("pan");
    expect(expanded.layout.dragmode).toBe("pan");
    expect(inline.layout.template).toBeDefined();
    const templateLayout = (inline.layout.template as { layout: Record<string, unknown> }).layout;
    expect(templateLayout.xaxis).not.toBe(templateLayout.yaxis);
    expect(parsed.figure).toEqual(before);
  });

  it("preserves an authored template while making the disposable view responsive", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({
        data: [],
        layout: { template: { layout: { paper_bgcolor: "gold" } }, width: 1_200, height: 800 },
      }),
    );
    const prepared = preparePlotlyRuntimeFigure(parsed, "light", "inline");

    expect(prepared.layout.template).toEqual({ layout: { paper_bgcolor: "gold" } });
    expect(prepared.layout.width).toBeUndefined();
    expect(prepared.layout.height).toBeUndefined();
    expect(prepared.layout.autosize).toBe(true);
  });

  it("resolves common portable named templates without changing canonical source", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({ data: [], layout: { template: "plotly_white" } }),
    );
    const before = structuredClone(parsed.figure);
    const prepared = preparePlotlyRuntimeFigure(parsed, "dark", "inline");

    expect(prepared.layout.template).toMatchObject({
      layout: { font: { color: "#262626" } },
    });
    expect(parsed.figure).toEqual(before);
  });

  it("mounts, transfers state, resets, resizes, and disposes the real lifecycle boundary", async () => {
    const fixture = runtimeFixture();
    const container = {
      querySelectorAll: vi.fn(() => []),
      replaceChildren: vi.fn(),
    } as unknown as HTMLElement;
    const mounted = await mountPlotlyView({
      container,
      parsed: parsedFigure(),
      runtime: fixture.runtime,
      surface: "inline",
      theme: "light",
    });

    expect(fixture.spies.react).toHaveBeenCalledOnce();
    expect(fixture.spies.newPlot).not.toHaveBeenCalled();
    expect(fixture.spies.addFrames).not.toHaveBeenCalled();
    expect(mounted.warnings).toContain("A compatible attribute was ignored.");
    expect(mounted.getInteractionMode()).toBe("pan");

    await mounted.setInteractionMode("pan");
    expect(fixture.spies.relayout).toHaveBeenCalledWith(fixture.graph, { dragmode: "pan" });
    expect(mounted.getInteractionMode()).toBe("pan");

    const state = mounted.getState();
    await mounted.setState(state);
    expect(fixture.spies.react).toHaveBeenCalledTimes(2);
    expect(fixture.spies.deleteFrames).not.toHaveBeenCalled();

    await mounted.reset();
    mounted.resize();
    expect(fixture.spies.react).toHaveBeenCalledTimes(3);
    expect(fixture.spies.resize).toHaveBeenCalledOnce();

    const resetFigure = fixture.spies.react.mock.calls[2]?.[1] as PlotlyRuntimeFigure;
    expect(resetFigure.frames).toHaveLength(1);

    mounted.dispose();
    mounted.dispose();
    expect(fixture.spies.removeAllListeners).toHaveBeenCalledWith("plotly_webglcontextlost");
    expect(fixture.spies.purge).toHaveBeenCalledOnce();
    expect(container.replaceChildren).toHaveBeenCalledOnce();
  });

  it("treats Plotly's undefined no-issue validation result as an empty warning list", async () => {
    const fixture = runtimeFixture();
    fixture.spies.validate.mockReturnValueOnce(undefined);
    const mounted = await mountPlotlyView({
      container: { replaceChildren: vi.fn() } as unknown as HTMLElement,
      parsed: parsedFigure(),
      runtime: fixture.runtime,
      surface: "inline",
      theme: "light",
    });

    expect(mounted.warnings).toEqual([]);
    expect(fixture.spies.react).toHaveBeenCalledOnce();
    mounted.dispose();
  });

  it("omits validator noise for opaque animation arguments but keeps actionable warnings", async () => {
    const fixture = runtimeFixture();
    fixture.spies.validate.mockReturnValueOnce([
      {
        astr: "updatemenus[0].buttons[0].args[1]",
        code: "dynamic",
        container: "layout",
        msg: "A valid animation argument was reset to an equivalent value during defaults.",
        path: ["updatemenus", 0, "buttons", 0, "args", 1],
        trace: null,
      },
      {
        astr: "xaxis.range",
        code: "dynamic",
        container: "layout",
        msg: "The x-axis range was changed during defaults.",
        path: ["xaxis", "range"],
        trace: null,
      },
    ]);
    const mounted = await mountPlotlyView({
      container: { replaceChildren: vi.fn() } as unknown as HTMLElement,
      parsed: parsedFigure(),
      runtime: fixture.runtime,
      surface: "inline",
      theme: "light",
    });

    expect(mounted.warnings).toEqual(["The x-axis range was changed during defaults."]);
    mounted.dispose();
  });

  it("repairs compatible string title shorthand before rendering and revalidates it", async () => {
    const fixture = runtimeFixture();
    fixture.spies.validate.mockImplementation((data, layout) => {
      const issues: ValidateResult[] = [];
      if (typeof (layout.xaxis as { title?: unknown } | undefined)?.title === "string") {
        issues.push({
          astr: "xaxis.title",
          code: "object",
          container: "layout",
          msg: "In layout, key xaxis.title must be linked to an object container",
          path: ["xaxis", "title"],
          trace: null,
        });
      }
      if (
        typeof (data[0] as { colorbar?: { title?: unknown } } | undefined)?.colorbar?.title ===
        "string"
      ) {
        issues.push({
          astr: "colorbar.title",
          code: "object",
          container: "data",
          msg: "In data trace 0, key colorbar.title must be linked to an object container",
          path: ["colorbar", "title"],
          trace: 0,
        });
      }
      return issues;
    });
    const parsed = parsePlotlySource(
      JSON.stringify({
        data: [{ colorbar: { title: "Count" }, type: "heatmap", z: [[1]] }],
        layout: { xaxis: { title: "Day" } },
      }),
    );
    const before = structuredClone(parsed.figure);
    const mounted = await mountPlotlyView({
      container: { replaceChildren: vi.fn() } as unknown as HTMLElement,
      parsed,
      runtime: fixture.runtime,
      surface: "inline",
      theme: "light",
    });

    expect(fixture.spies.validate).toHaveBeenCalledTimes(2);
    const rendered = fixture.spies.react.mock.calls[0]?.[1] as PlotlyRuntimeFigure;
    expect(rendered.layout.xaxis).toMatchObject({ title: { text: "Day" } });
    expect((rendered.data[0] as { colorbar?: unknown }).colorbar).toMatchObject({
      title: { text: "Count" },
    });
    expect(mounted.warnings).toEqual([]);
    expect(parsed.figure).toEqual(before);
    await mounted.reset();
    const reset = fixture.spies.react.mock.calls[1]?.[1] as PlotlyRuntimeFigure;
    expect(reset.layout.xaxis).toMatchObject({ title: { text: "Day" } });
    expect((reset.data[0] as { colorbar?: unknown }).colorbar).toMatchObject({
      title: { text: "Count" },
    });
    expect(fixture.spies.validate).toHaveBeenCalledTimes(4);
    mounted.dispose();
  });

  it("purges a partial graph when the atomic figure mount fails", async () => {
    const fixture = runtimeFixture();
    fixture.spies.react.mockRejectedValueOnce(new Error("Invalid frame"));
    const container = {
      querySelectorAll: vi.fn(() => []),
      replaceChildren: vi.fn(),
    } as unknown as HTMLElement;

    await expect(
      mountPlotlyView({
        container,
        parsed: parsedFigure(),
        runtime: fixture.runtime,
        surface: "inline",
        theme: "light",
      }),
    ).rejects.toThrow("Invalid frame");

    expect(fixture.spies.purge).toHaveBeenCalledWith(container);
    expect(container.replaceChildren).toHaveBeenCalledOnce();
  });

  it("turns Plotly's raw WebGL fallback into a local recoverable error", async () => {
    const fixture = runtimeFixture();
    const parsed = parsePlotlySource(
      JSON.stringify({ data: [{ type: "scattergl", x: [1], y: [2] }] }),
    );
    Object.assign(fixture.graph, {
      querySelector: vi.fn((selector: string) =>
        selector === ".no-webgl" ? { textContent: "get.webgl.org" } : null,
      ),
    });
    const container = {
      querySelectorAll: vi.fn(() => []),
      replaceChildren: vi.fn(),
    } as unknown as HTMLElement;

    await expect(
      mountPlotlyView({
        container,
        parsed,
        runtime: fixture.runtime,
        surface: "inline",
        theme: "light",
      }),
    ).rejects.toThrow("a graphics context is not available");

    expect(fixture.spies.purge).toHaveBeenCalledWith(container);
    expect(container.replaceChildren).toHaveBeenCalledOnce();
  });

  it("does not blame GPU budget when Plotly's WebGL fallback is a zero-size layout", async () => {
    const fixture = runtimeFixture();
    const parsed = parsePlotlySource(
      JSON.stringify({ data: [{ type: "scattergl", x: [1], y: [2] }] }),
    );
    Object.assign(fixture.graph, {
      getBoundingClientRect: () => ({ height: 0, width: 0 }),
      querySelector: vi.fn((selector: string) =>
        selector === ".no-webgl" ? { textContent: "get.webgl.org" } : null,
      ),
    });

    await expect(
      mountPlotlyView({
        container: {
          querySelectorAll: vi.fn(() => []),
          replaceChildren: vi.fn(),
        } as unknown as HTMLElement,
        parsed,
        runtime: fixture.runtime,
        surface: "inline",
        theme: "light",
      }),
    ).rejects.toThrow("measurable layout size");
  });

  it("uses the latest surface and host theme when resetting transferred state", async () => {
    const fixture = runtimeFixture();
    const mounted = await mountPlotlyView({
      container: { replaceChildren: vi.fn() } as unknown as HTMLElement,
      parsed: parsedFigure(),
      runtime: fixture.runtime,
      surface: "inline",
      theme: "light",
    });

    await mounted.updatePresentation("dark", "expanded");
    await mounted.reset();

    const presentationFigure = fixture.spies.react.mock.calls[1]?.[1] as PlotlyRuntimeFigure;
    const resetFigure = fixture.spies.react.mock.calls[2]?.[1] as PlotlyRuntimeFigure;
    const presentationConfig = presentationFigure.config as Record<string, unknown>;
    const resetConfig = resetFigure.config as Record<string, unknown>;
    const presentationLayout = presentationFigure.layout as Record<string, unknown>;
    const resetLayout = resetFigure.layout as Record<string, unknown>;
    expect(presentationConfig.scrollZoom).toBe(true);
    expect(resetConfig.scrollZoom).toBe(true);
    expect(resetLayout.uirevision).not.toBe(presentationLayout.uirevision);
    expect(presentationLayout.template).toEqual(resetLayout.template);
    expect(JSON.stringify(resetLayout.template)).toContain("#e5e5e5");
  });
});
