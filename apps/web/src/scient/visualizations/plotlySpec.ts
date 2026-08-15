import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export const MAX_PLOTLY_SOURCE_LENGTH = 1_000_000;
export const MAX_PLOTLY_VALUE_NODES = 500_000;
export const MAX_PLOTLY_TRACES = 512;
export const MAX_PLOTLY_FRAMES = 2_000;
export const MAX_PLOTLY_NESTING_DEPTH = 128;

export type PlotlyJsonObject = Record<string, unknown>;

export interface PlotlyFigureDocument {
  readonly config: PlotlyJsonObject;
  readonly data: ReadonlyArray<PlotlyJsonObject>;
  readonly frames: ReadonlyArray<PlotlyJsonObject>;
  readonly layout: PlotlyJsonObject;
}

export interface ParsedPlotlySource {
  readonly externalResources: ReadonlyArray<string>;
  readonly figure: PlotlyFigureDocument;
  readonly hasCartesian: boolean;
  readonly hasFrames: boolean;
  readonly hasGeoTopology: boolean;
  readonly hasMapTiles: boolean;
  readonly hasMath: boolean;
  readonly hasWebGl: boolean;
  readonly warnings: ReadonlyArray<string>;
}

const WEB_GL_TRACE_TYPES = new Set([
  "cone",
  "heatmapgl",
  "isosurface",
  "mesh3d",
  "parcoords",
  "pointcloud",
  "scatter3d",
  "scattergl",
  "scatterpolargl",
  "splom",
  "streamtube",
  "surface",
  "volume",
]);

const CARTESIAN_TRACE_TYPES = new Set([
  "bar",
  "box",
  "candlestick",
  "carpet",
  "contour",
  "contourcarpet",
  "funnel",
  "heatmap",
  "histogram",
  "histogram2d",
  "histogram2dcontour",
  "image",
  "ohlc",
  "pointcloud",
  "scatter",
  "scattercarpet",
  "scattergl",
  "splom",
  "violin",
  "waterfall",
]);

const TILE_MAP_TRACE_TYPES = new Set([
  "choroplethmap",
  "choroplethmapbox",
  "densitymap",
  "densitymapbox",
  "scattermap",
  "scattermapbox",
]);

const GEO_TOPOLOGY_TRACE_TYPES = new Set(["choropleth", "scattergeo"]);

const DEPRECATED_MAPBOX_TRACE_TYPES = new Set([
  "choroplethmapbox",
  "densitymapbox",
  "scattermapbox",
]);

const PLOTLY_TYPED_ARRAY_BYTES = new Map<string, number>([
  ["f4", 4],
  ["f8", 8],
  ["float32", 4],
  ["float64", 8],
  ["i1", 1],
  ["i2", 2],
  ["i4", 4],
  ["int8", 1],
  ["int16", 2],
  ["int32", 4],
  ["u1", 1],
  ["u1c", 1],
  ["u2", 2],
  ["u4", 4],
  ["uint8", 1],
  ["uint8c", 1],
  ["uint16", 2],
  ["uint32", 4],
]);

const BASE64_PATTERN = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

function isRecord(value: unknown): value is PlotlyJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTypedArraySpec(value: PlotlyJsonObject): void {
  const hasDtype = Object.hasOwn(value, "dtype");
  const hasBdata = Object.hasOwn(value, "bdata");
  if (!hasDtype && !hasBdata) return;
  if (typeof value.dtype !== "string" || typeof value.bdata !== "string") {
    throw new Error("Plotly typed-array data must include string `dtype` and `bdata` values.");
  }

  const bytesPerElement = PLOTLY_TYPED_ARRAY_BYTES.get(value.dtype);
  if (bytesPerElement == null) {
    throw new Error(`Plotly typed-array data uses an unsupported dtype: ${value.dtype}.`);
  }
  if (!BASE64_PATTERN.test(value.bdata)) {
    throw new Error(
      "Plotly typed-array `bdata` is not complete valid base64. Use the complete value produced by Plotly.py or ordinary JSON arrays.",
    );
  }

  const padding = value.bdata.endsWith("==") ? 2 : value.bdata.endsWith("=") ? 1 : 0;
  const byteLength = (value.bdata.length / 4) * 3 - padding;
  if (byteLength % bytesPerElement !== 0) {
    throw new Error(
      `Plotly typed-array \`bdata\` has an invalid byte length for dtype ${value.dtype}.`,
    );
  }

  if (value.shape == null) return;
  if (typeof value.shape !== "string" && typeof value.shape !== "number") {
    throw new Error("Plotly typed-array `shape` must be a number or comma-separated string.");
  }
  const dimensions = String(value.shape).split(",").map(Number);
  if (
    dimensions.length === 0 ||
    dimensions.length > 3 ||
    dimensions.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 0)
  ) {
    throw new Error("Plotly typed-array `shape` must contain one to three non-negative integers.");
  }
  const expectedBytes =
    dimensions.reduce((total, dimension) => total * dimension, 1) * bytesPerElement;
  if (expectedBytes !== byteLength) {
    throw new Error(
      `Plotly typed-array \`shape\` requires ${expectedBytes.toLocaleString()} bytes, but \`bdata\` contains ${byteLength.toLocaleString()}.`,
    );
  }
}

function sourceLocation(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function parseErrorMessage(source: string, error: ParseError): string {
  const location = sourceLocation(source, error.offset);
  const reason = printParseErrorCode(error.error).replace(/([a-z])([A-Z])/g, "$1 $2");
  return `Invalid JSON at line ${location.line}, column ${location.column}: ${reason}.`;
}

function isExternalResourceKey(path: ReadonlyArray<string>, key: string): boolean {
  if (key === "geojson" || key === "topojsonURL" || key === "url") return true;
  if (key === "source") {
    return path.includes("images") || path.includes("layers") || path.includes("map");
  }
  return key === "style" && (path.includes("map") || path.includes("mapbox"));
}

function inspectFigure(root: PlotlyJsonObject): {
  readonly externalResources: ReadonlyArray<string>;
  readonly hasMath: boolean;
} {
  const stack: Array<{
    readonly depth: number;
    readonly key: string | null;
    readonly path: ReadonlyArray<string>;
    readonly value: unknown;
  }> = [{ depth: 0, key: null, path: [], value: root }];
  const externalResources = new Set<string>();
  let hasMath = false;
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_PLOTLY_NESTING_DEPTH) {
      throw new Error(
        `The Plotly figure is nested too deeply to render (maximum depth ${String(MAX_PLOTLY_NESTING_DEPTH)}).`,
      );
    }
    visitedNodes += 1;
    if (visitedNodes > MAX_PLOTLY_VALUE_NODES) {
      throw new Error(
        `The Plotly figure is too complex to render (more than ${MAX_PLOTLY_VALUE_NODES.toLocaleString()} values).`,
      );
    }

    if (typeof current.value === "string") {
      if (/\$[^$\n]+\$/u.test(current.value)) hasMath = true;
      if (
        current.key != null &&
        isExternalResourceKey(current.path, current.key) &&
        /^https?:\/\//iu.test(current.value)
      ) {
        externalResources.add(current.value);
      }
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const value of current.value) {
        stack.push({ depth: current.depth + 1, key: current.key, path: current.path, value });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;

    validateTypedArraySpec(current.value);

    for (const [key, value] of Object.entries(current.value)) {
      stack.push({
        depth: current.depth + 1,
        key,
        path: [...current.path, key],
        value,
      });
    }
  }

  return { externalResources: [...externalResources], hasMath };
}

function objectArray(value: unknown, name: string): ReadonlyArray<PlotlyJsonObject> {
  if (!Array.isArray(value)) throw new Error(`Plotly figure \`${name}\` must be an array.`);
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error(`Every Plotly \`${name}\` entry must be an object.`);
  }
  return value;
}

function optionalObject(value: unknown, name: string): PlotlyJsonObject {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`Plotly figure \`${name}\` must be an object.`);
  return value;
}

function traceTypes(data: ReadonlyArray<PlotlyJsonObject>): ReadonlySet<string> {
  return new Set(
    data.flatMap((trace) =>
      typeof trace.type === "string" ? [trace.type.trim().toLowerCase()] : [],
    ),
  );
}

export function parsePlotlySource(source: string): ParsedPlotlySource {
  if (source.trim().length === 0) throw new Error("The Plotly source is empty.");
  if (source.length > MAX_PLOTLY_SOURCE_LENGTH) {
    throw new Error(
      `The Plotly source is too large to render (${source.length.toLocaleString()} characters; maximum ${MAX_PLOTLY_SOURCE_LENGTH.toLocaleString()}).`,
    );
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const firstError = errors[0];
  if (firstError != null) throw new Error(parseErrorMessage(source, firstError));
  if (!isRecord(parsed)) throw new Error("A Plotly figure must be a JSON object.");

  const data = objectArray(parsed.data, "data");
  if (data.length > MAX_PLOTLY_TRACES) {
    throw new Error(
      `The Plotly figure has too many traces (${data.length.toLocaleString()}; maximum ${MAX_PLOTLY_TRACES.toLocaleString()}).`,
    );
  }
  const frames = parsed.frames == null ? [] : objectArray(parsed.frames, "frames");
  if (frames.length > MAX_PLOTLY_FRAMES) {
    throw new Error(
      `The Plotly figure has too many animation frames (${frames.length.toLocaleString()}; maximum ${MAX_PLOTLY_FRAMES.toLocaleString()}).`,
    );
  }

  const figure: PlotlyFigureDocument = {
    config: optionalObject(parsed.config, "config"),
    data,
    frames,
    layout: optionalObject(parsed.layout, "layout"),
  };
  const inspection = inspectFigure(parsed);
  const types = traceTypes(data);
  const hasImplicitScatter = data.some(
    (trace) => typeof trace.type !== "string" || trace.type.trim().length === 0,
  );
  const deprecatedMapboxTypes = [...types].filter((type) =>
    DEPRECATED_MAPBOX_TRACE_TYPES.has(type),
  );

  return {
    externalResources: inspection.externalResources,
    figure,
    hasCartesian: hasImplicitScatter || [...types].some((type) => CARTESIAN_TRACE_TYPES.has(type)),
    hasFrames: frames.length > 0,
    hasGeoTopology: [...types].some((type) => GEO_TOPOLOGY_TRACE_TYPES.has(type)),
    hasMapTiles: [...types].some((type) => TILE_MAP_TRACE_TYPES.has(type)),
    hasMath: inspection.hasMath,
    hasWebGl: [...types].some(
      (type) => WEB_GL_TRACE_TYPES.has(type) || TILE_MAP_TRACE_TYPES.has(type),
    ),
    warnings:
      deprecatedMapboxTypes.length === 0
        ? []
        : [
            `This figure uses deprecated Mapbox trace ${deprecatedMapboxTypes.length === 1 ? "type" : "types"}: ${deprecatedMapboxTypes.join(", ")}. Plotly currently supports the figure, but current producers should prefer map traces.`,
          ],
  };
}

export function plotlyFigureTitle(figure: PlotlyFigureDocument): string | null {
  const title = figure.layout.title;
  if (typeof title === "string") return title.trim() || null;
  if (!isRecord(title) || typeof title.text !== "string") return null;
  return title.text.replace(/<[^>]+>/gu, "").trim() || null;
}

export function plotlyFigureDescription(figure: PlotlyFigureDocument): string | null {
  const meta = figure.layout.meta;
  if (!isRecord(meta)) return null;
  for (const key of ["description", "caption", "alt"] as const) {
    const value = meta[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}
