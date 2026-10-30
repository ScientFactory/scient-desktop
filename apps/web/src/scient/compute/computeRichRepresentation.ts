import type { ComputeProjectedOutput, ComputeRepresentation } from "@t3tools/contracts";

import { computeProjectedStaticImage, type ComputeStaticImageOutput } from "./computeResultPresentation";

const COMPUTE_TABLE_MEDIA_TYPE = "application/vnd.dataresource+json";
const COMPUTE_PLOTLY_MEDIA_TYPE = "application/vnd.plotly.v1+json";
const COMPUTE_VEGA_LITE_MEDIA_TYPE = /^application\/vnd\.vegalite\.v[3-6]\+json$/u;
const MAX_COMPUTE_TABLE_ROWS = 100;
const MAX_COMPUTE_TABLE_COLUMNS = 24;
const MAX_CELL_TEXT = 512;
const MAX_RICH_SOURCE = 1_000_000;

type RepresentationOutput = Extract<ComputeProjectedOutput, { readonly _tag: "representation" }>;
type Cell = string | number | boolean | null;
export interface ComputeTablePreview {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>;
  readonly truncated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate before creating a bounded DOM; never render arbitrary HTML or nested objects. */
export function parseComputeTable(source: string): ComputeTablePreview | null {
  if (source.length > MAX_RICH_SOURCE) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !record(value) ||
    !record(value.schema) ||
    !Array.isArray(value.schema.fields) ||
    !Array.isArray(value.data)
  )
    return null;
  const fields = value.schema.fields;
  if (fields.length === 0 || fields.length > 1024) return null;
  const names = fields.map((field: unknown) => (record(field) ? field.name : null));
  if (
    names.some((name) => typeof name !== "string" || name.length === 0 || name.length > 256) ||
    new Set(names).size !== names.length
  )
    return null;
  const columns = names.slice(0, MAX_COMPUTE_TABLE_COLUMNS) as string[];
  let truncated =
    fields.length > columns.length ||
    value.data.length > MAX_COMPUTE_TABLE_ROWS ||
    (record(value.scientPreview) && value.scientPreview.truncated === true);
  const rows: Cell[][] = [];
  for (const row of value.data.slice(0, MAX_COMPUTE_TABLE_ROWS)) {
    if (!record(row)) return null;
    const cells: Cell[] = [];
    for (const column of columns) {
      const cell = Object.hasOwn(row, column) ? row[column] : null;
      if (cell === null || typeof cell === "boolean") cells.push(cell);
      else if (typeof cell === "number" && Number.isFinite(cell)) cells.push(cell);
      else if (typeof cell === "string") {
        if (cell.length > MAX_CELL_TEXT) truncated = true;
        cells.push(cell.length > MAX_CELL_TEXT ? cell.slice(0, MAX_CELL_TEXT) + "…" : cell);
      } else return null;
    }
    rows.push(cells);
  }
  return { columns, rows, truncated };
}

export type ComputeDisplay =
  | { readonly kind: "plotly"; readonly source: string }
  | { readonly kind: "vega-lite"; readonly source: string }
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "latex"; readonly text: string }
  | { readonly kind: "image"; readonly image: ComputeStaticImageOutput }
  | { readonly kind: "table"; readonly table: ComputeTablePreview }
  | { readonly kind: "json"; readonly json: string }
  | { readonly kind: "text"; readonly text: string };

function inline(representation: ComputeRepresentation | undefined): string | null {
  if (representation === undefined) return null;
  const { data } = representation;
  const value = data._tag === "text" ? data.text : data._tag === "json" ? data.json : null;
  return value === null || value.length > MAX_RICH_SOURCE ? null : value;
}

/**
 * Renderers for one rich result in Jupyter's preference order; a renderer that cannot show its
 * representation falls through to the next. Only inline, bounded data is eligible, except images,
 * which are retained resources.
 */
export function computeDisplays(output: RepresentationOutput): ReadonlyArray<ComputeDisplay> {
  const byType = new Map(output.bundle.representations.map((item) => [item.mediaType, item]));
  const text = (mediaType: string) => inline(byType.get(mediaType));
  const displays: ComputeDisplay[] = [];
  const plotly = byType.get(COMPUTE_PLOTLY_MEDIA_TYPE);
  // PlotlyChartCard owns Plotly validation, resource policy, limits and recoverable errors.
  if (plotly?.data._tag === "json" && plotly.data.json.length <= MAX_RICH_SOURCE)
    displays.push({ kind: "plotly", source: plotly.data.json });
  const vegaLite = output.bundle.representations.find((item) =>
    COMPUTE_VEGA_LITE_MEDIA_TYPE.test(item.mediaType),
  );
  if (vegaLite?.data._tag === "json" && vegaLite.data.json.length <= MAX_RICH_SOURCE)
    displays.push({ kind: "vega-lite", source: vegaLite.data.json });
  const html = text("text/html");
  if (html !== null) displays.push({ kind: "html", html });
  const markdown = text("text/markdown");
  if (markdown !== null) displays.push({ kind: "markdown", text: markdown });
  const latex = text("text/latex");
  if (latex !== null) displays.push({ kind: "latex", text: latex });
  const image = computeProjectedStaticImage(output);
  if (image !== null) displays.push({ kind: "image", image });
  const table = text(COMPUTE_TABLE_MEDIA_TYPE);
  const parsedTable = table === null ? null : parseComputeTable(table);
  if (parsedTable !== null) displays.push({ kind: "table", table: parsedTable });
  const json = byType.get("application/json");
  if (json?.data._tag === "json" && json.data.json.length <= MAX_RICH_SOURCE)
    displays.push({ kind: "json", json: json.data.json });
  const plain = text("text/plain");
  if (plain !== null) displays.push({ kind: "text", text: plain });
  return displays;
}

/** The figure a result shows, when its preferred renderer is an image. */
export function computeDisplayedStaticImage(
  output: RepresentationOutput,
): ComputeStaticImageOutput | null {
  const display = computeDisplays(output)[0];
  return display?.kind === "image" ? display.image : null;
}

/** Strips one pair of math delimiters; mixed prose and math stays Markdown. */
export function computeLatexMath(source: string): string | null {
  const trimmed = source.trim();
  for (const [open, close] of [
    ["$$", "$$"],
    ["\\[", "\\]"],
    ["\\(", "\\)"],
    ["$", "$"],
  ] as const) {
    if (trimmed.length <= open.length + close.length) continue;
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) continue;
    const inner = trimmed.slice(open.length, -close.length);
    return /(?<!\\)\$/u.test(inner) ? null : inner.trim();
  }
  return /(?<!\\)\$/u.test(trimmed) ? null : trimmed;
}
