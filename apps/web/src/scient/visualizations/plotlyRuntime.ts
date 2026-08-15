import type { Config, Data, Frame, Layout, PlotlyHTMLElement } from "plotly.js";

import type { ParsedPlotlySource, PlotlyFigureDocument } from "./plotlySpec";
import { ensurePlotlyMathRuntime } from "./plotlyMathRuntime";
import { releasePlotlyWebGlContexts } from "./plotlyWebGlContext";

export type PlotlyTheme = "light" | "dark";
export type PlotlySurface = "expanded" | "inline";
export type PlotlyInteractionMode = "lasso" | "pan" | "select" | "zoom";
export type PlotlyRuntime = typeof import("plotly.js");

export interface PlotlyViewState {
  readonly data: ReadonlyArray<Data>;
  readonly frames: ReadonlyArray<Partial<Frame>>;
  readonly layout: Partial<Layout>;
}

export interface PlotlyRuntimeFigure {
  readonly config: Partial<Config>;
  readonly data: Data[];
  readonly frames: Array<Partial<Frame>>;
  readonly layout: Partial<Layout>;
}

export interface MountedPlotlyView {
  readonly dispose: () => void;
  readonly getDimensions: () => { readonly height: number; readonly width: number };
  readonly getInteractionMode: () => PlotlyInteractionMode;
  readonly getState: () => PlotlyViewState;
  readonly graph: PlotlyHTMLElement;
  readonly reset: () => Promise<void>;
  readonly resize: () => void;
  readonly setInteractionMode: (mode: PlotlyInteractionMode) => Promise<void>;
  readonly setState: (state: PlotlyViewState) => Promise<void>;
  readonly toImage: (format: "png" | "svg", scale: number) => Promise<string>;
  readonly updatePresentation: (theme: PlotlyTheme, surface: PlotlySurface) => Promise<void>;
  readonly warnings: ReadonlyArray<string>;
}

let plotlyRuntimePromise: Promise<PlotlyRuntime> | null = null;
let plotlyResetRevision = 0;

/** Plotly is intentionally absent from the initial chat bundle. */
export function getPlotlyRuntimePromise(): Promise<PlotlyRuntime> {
  plotlyRuntimePromise ??= import("plotly.js-strict-dist-min")
    .then((module) => module.default)
    .catch((cause: unknown) => {
      plotlyRuntimePromise = null;
      throw cause;
    });
  return plotlyRuntimePromise;
}

export function normalizedPlotlyError(cause: unknown): Error {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    const line = cause.message.split("\n").find((value) => value.trim().length > 0);
    return new Error(line?.trim() || "Plotly could not render this figure.", { cause });
  }
  return new Error("Plotly could not render this figure.", { cause });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function scientPlotlyTemplate(theme: PlotlyTheme): Record<string, unknown> {
  const dark = theme === "dark";
  const foreground = dark ? "#e5e5e5" : "#262626";
  const secondary = dark ? "#d4d4d4" : "#525252";
  const grid = dark ? "#404040" : "#e5e5e5";
  const boundary = dark ? "#737373" : "#a3a3a3";
  const background = "rgba(0,0,0,0)";
  const font =
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const axis = () => ({
    color: secondary,
    gridcolor: grid,
    linecolor: boundary,
    tickcolor: boundary,
    title: { font: { color: foreground, family: font } },
  });

  return {
    layout: {
      annotationdefaults: { font: { color: foreground, family: font } },
      coloraxis: {
        colorbar: { tickfont: { color: secondary }, title: { font: { color: foreground } } },
      },
      font: { color: foreground, family: font },
      geo: { bgcolor: background, lakecolor: background, landcolor: background },
      hoverlabel: {
        bgcolor: dark ? "#171717" : "#ffffff",
        font: { color: foreground, family: font },
      },
      legend: { font: { color: secondary, family: font }, title: { font: { color: foreground } } },
      map: { style: dark ? "carto-darkmatter" : "carto-positron" },
      paper_bgcolor: background,
      plot_bgcolor: background,
      polar: { bgcolor: background, angularaxis: axis(), radialaxis: axis() },
      scene: { bgcolor: background, xaxis: axis(), yaxis: axis(), zaxis: axis() },
      ternary: { bgcolor: background, aaxis: axis(), baxis: axis(), caxis: axis() },
      title: { font: { color: foreground, family: font } },
      xaxis: axis(),
      yaxis: axis(),
    },
  };
}

function namedPlotlyTemplate(name: string, theme: PlotlyTheme): Record<string, unknown> | null {
  switch (name.trim().toLowerCase()) {
    case "plotly":
      return scientPlotlyTemplate(theme);
    case "plotly_dark":
      return scientPlotlyTemplate("dark");
    case "plotly_white":
    case "simple_white":
      return scientPlotlyTemplate("light");
    case "none":
      return {};
    default:
      return null;
  }
}

function usesHostThemeTemplate(template: unknown): boolean {
  return (
    template == null || (typeof template === "string" && template.trim().toLowerCase() === "plotly")
  );
}

function runtimeFigureFromDocument(
  document: PlotlyFigureDocument,
  theme: PlotlyTheme,
  surface: PlotlySurface,
  replaceHostTemplate = false,
): PlotlyRuntimeFigure {
  const layout = clone(document.layout) as Partial<Layout>;
  const config = clone(document.config) as Partial<Config>;
  const mutableLayout = layout as Record<string, unknown>;
  const mutableConfig = config as Record<string, unknown>;

  if (replaceHostTemplate || mutableLayout.template == null) {
    mutableLayout.template = scientPlotlyTemplate(theme);
  } else if (typeof mutableLayout.template === "string") {
    mutableLayout.template =
      namedPlotlyTemplate(mutableLayout.template, theme) ?? mutableLayout.template;
  }
  if (mutableLayout.uirevision == null) mutableLayout.uirevision = "scient-presentation";
  mutableLayout.autosize = true;
  delete mutableLayout.width;
  delete mutableLayout.height;

  mutableConfig.displayModeBar = false;
  mutableConfig.displaylogo = false;
  mutableConfig.editable = false;
  mutableConfig.responsive = true;
  mutableConfig.scrollZoom = surface === "expanded";
  mutableConfig.showEditInChartStudio = false;
  mutableConfig.showLink = false;
  mutableConfig.showSendToCloud = false;
  mutableConfig.staticPlot = false;
  mutableConfig.plotGlPixelRatio = Math.min(
    2,
    Math.max(1, typeof devicePixelRatio === "number" ? devicePixelRatio : 1),
  );

  return {
    config,
    data: clone(document.data) as Data[],
    frames: clone(document.frames) as Array<Partial<Frame>>,
    layout,
  };
}

export function preparePlotlyRuntimeFigure(
  parsed: ParsedPlotlySource,
  theme: PlotlyTheme,
  surface: PlotlySurface,
): PlotlyRuntimeFigure {
  const figure = runtimeFigureFromDocument(parsed.figure, theme, surface);
  if (parsed.hasCartesian && (figure.layout as Record<string, unknown>).dragmode == null) {
    (figure.layout as Record<string, unknown>).dragmode = "pan";
  }
  return figure;
}

function documentFromState(state: PlotlyViewState, config: Partial<Config>): PlotlyFigureDocument {
  return {
    config: clone(config) as Record<string, unknown>,
    data: clone(state.data) as Array<Record<string, unknown>>,
    frames: clone(state.frames) as Array<Record<string, unknown>>,
    layout: clone(state.layout) as Record<string, unknown>,
  };
}

function normalizedValidationIssues(
  runtime: PlotlyRuntime,
  figure: PlotlyRuntimeFigure,
): ReturnType<PlotlyRuntime["validate"]> {
  // Plotly's runtime returns `undefined` when validation finds no issues even
  // though its public TypeScript declaration promises an array.
  let issues = runtime.validate(figure.data, figure.layout) ?? [];
  let repairedTitle = false;
  for (const issue of issues) {
    const path = Array.isArray(issue.path)
      ? issue.path.map(String)
      : typeof issue.path === "string"
        ? issue.path.split(/[.[\]]+/u).filter(Boolean)
        : [];
    if (path.at(-1) !== "title" || !issue.msg.includes("must be linked to an object container")) {
      continue;
    }

    const root =
      issue.container === "data" && issue.trace != null
        ? (figure.data[issue.trace] as Record<string, unknown> | undefined)
        : (figure.layout as Record<string, unknown>);
    if (root == null) continue;
    let parent: Record<string, unknown> | undefined = root;
    for (const segment of path.slice(0, -1)) {
      const next = parent?.[segment];
      if (typeof next !== "object" || next == null || Array.isArray(next)) {
        parent = undefined;
        break;
      }
      parent = next as Record<string, unknown>;
    }
    if (parent == null || typeof parent.title !== "string") continue;
    const title = parent.title;
    parent.title = { text: title };
    repairedTitle = true;
  }
  if (repairedTitle) issues = runtime.validate(figure.data, figure.layout) ?? [];
  return issues;
}

function validationWarnings(
  runtime: PlotlyRuntime,
  figure: PlotlyRuntimeFigure,
): ReadonlyArray<string> {
  const issues = normalizedValidationIssues(runtime, figure);
  return issues.flatMap((issue) => {
    const path = Array.isArray(issue.path)
      ? issue.path.map(String)
      : typeof issue.path === "string"
        ? issue.path.split(/[.[\]]+/u).filter(Boolean)
        : [];
    const isCommandArgumentNoise =
      issue.code === "dynamic" &&
      issue.container === "layout" &&
      (path[0] === "sliders" || path[0] === "updatemenus") &&
      path.includes("args");
    if (isCommandArgumentNoise) return [];
    const message = issue.msg.trim();
    return message.length > 0 ? [message] : [];
  });
}

function reactPlotlyFigure(
  runtime: PlotlyRuntime,
  root: HTMLElement | PlotlyHTMLElement,
  figure: PlotlyRuntimeFigure,
): Promise<PlotlyHTMLElement> {
  // Plotly's object-form API updates data, layout, config, and frames as one
  // figure. The DefinitelyTyped declaration currently omits this overload.
  return (
    runtime.react as unknown as (
      graph: HTMLElement | PlotlyHTMLElement,
      nextFigure: PlotlyRuntimeFigure,
    ) => Promise<PlotlyHTMLElement>
  )(root, clone(figure));
}

interface PlotlyEventGraph {
  on(event: "plotly_webglcontextlost", callback: () => void): void;
  removeAllListeners(event: string): void;
}

function plotlyWebGlUnavailableMessage(graph: HTMLElement): string {
  const bounds = graph.getBoundingClientRect();
  if (!(bounds.width > 1 && bounds.height > 1)) {
    return "This figure needs a measurable layout size before WebGL can start. Retry after the card has finished laying out.";
  }
  return "This figure needs WebGL, but a graphics context is not available. Scroll away from other 3D or high-density figures, then retry.";
}

export async function mountPlotlyView(input: {
  readonly container: HTMLElement;
  readonly initialState?: PlotlyViewState | null | undefined;
  readonly onWebGlContextLost?: (() => void) | undefined;
  readonly parsed: ParsedPlotlySource;
  readonly runtime?: PlotlyRuntime | undefined;
  readonly surface: PlotlySurface;
  readonly theme: PlotlyTheme;
}): Promise<MountedPlotlyView> {
  const [runtime, mathWarning] = await Promise.all([
    input.runtime == null ? getPlotlyRuntimePromise() : Promise.resolve(input.runtime),
    input.parsed.hasMath
      ? ensurePlotlyMathRuntime().then(
          () => null,
          () =>
            "Mathematical labels could not be typeset. The figure is shown with its source notation.",
        )
      : Promise.resolve(null),
  ]);
  const authoredFigure = preparePlotlyRuntimeFigure(input.parsed, input.theme, input.surface);
  const authoredConfig = clone(authoredFigure.config);
  const usesHostTemplate = usesHostThemeTemplate(input.parsed.figure.layout.template);
  const initialFigure =
    input.initialState == null
      ? authoredFigure
      : runtimeFigureFromDocument(
          documentFromState(input.initialState, authoredConfig),
          input.theme,
          input.surface,
          usesHostTemplate,
        );
  if (initialFigure !== authoredFigure) normalizedValidationIssues(runtime, initialFigure);
  const warnings = [
    ...input.parsed.warnings,
    ...(mathWarning == null ? [] : [mathWarning]),
    ...validationWarnings(runtime, authoredFigure),
  ].filter((warning, index, all) => all.indexOf(warning) === index);

  let graph: PlotlyHTMLElement;
  try {
    graph = await reactPlotlyFigure(runtime, input.container, initialFigure);
    if (input.parsed.hasWebGl && graph.querySelector(".no-webgl") != null) {
      throw new Error(plotlyWebGlUnavailableMessage(graph));
    }
  } catch (cause) {
    if (input.parsed.hasWebGl) releasePlotlyWebGlContexts(input.container);
    runtime.purge(input.container);
    input.container.replaceChildren();
    throw cause;
  }
  let currentFrames = initialFigure.frames;

  const eventGraph = graph as PlotlyHTMLElement & PlotlyEventGraph;
  if (input.onWebGlContextLost != null) {
    eventGraph.on("plotly_webglcontextlost", input.onWebGlContextLost);
  }
  let disposed = false;
  let currentSurface = input.surface;
  let currentTheme = input.theme;

  const currentState = (): PlotlyViewState => ({
    data: clone(graph.data),
    frames: clone(currentFrames),
    layout: clone(graph.layout),
  });
  const currentInteractionMode = (): PlotlyInteractionMode => {
    const mode = graph.layout.dragmode;
    return mode === "lasso" || mode === "pan" || mode === "select" || mode === "zoom"
      ? mode
      : "zoom";
  };

  const applyFigure = async (figure: PlotlyRuntimeFigure): Promise<void> => {
    if (disposed) throw new Error("The Plotly view is no longer available.");
    normalizedValidationIssues(runtime, figure);
    await reactPlotlyFigure(runtime, graph, figure);
    currentFrames = clone(figure.frames);
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      eventGraph.removeAllListeners("plotly_webglcontextlost");
      if (input.parsed.hasWebGl) releasePlotlyWebGlContexts(graph);
      runtime.purge(graph);
      input.container.replaceChildren();
    },
    getDimensions() {
      const bounds = graph.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    },
    getInteractionMode: currentInteractionMode,
    getState: currentState,
    graph,
    async reset() {
      const figure = preparePlotlyRuntimeFigure(input.parsed, currentTheme, currentSurface);
      (figure.layout as Record<string, unknown>).uirevision =
        `scient-reset-${String(++plotlyResetRevision)}`;
      await applyFigure(figure);
    },
    resize() {
      if (!disposed) runtime.Plots.resize(graph);
    },
    async setInteractionMode(mode) {
      if (disposed) throw new Error("The Plotly view is no longer available.");
      await runtime.relayout(graph, { dragmode: mode });
    },
    async setState(state) {
      await applyFigure(
        runtimeFigureFromDocument(
          documentFromState(state, authoredConfig),
          currentTheme,
          currentSurface,
          usesHostTemplate,
        ),
      );
    },
    async toImage(format, scale) {
      if (disposed) throw new Error("The Plotly view is no longer available.");
      const dimensions = graph.getBoundingClientRect();
      return runtime.toImage(graph, {
        format,
        height: Math.max(1, Math.round(dimensions.height)),
        scale,
        width: Math.max(1, Math.round(dimensions.width)),
      });
    },
    async updatePresentation(theme, surface) {
      const state = currentState();
      await applyFigure(
        runtimeFigureFromDocument(
          documentFromState(state, authoredConfig),
          theme,
          surface,
          usesHostTemplate,
        ),
      );
      currentTheme = theme;
      currentSurface = surface;
    },
    warnings,
  };
}
