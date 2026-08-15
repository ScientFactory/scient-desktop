import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { TopLevelSpec } from "vega-lite";

export const MAX_VEGA_LITE_SOURCE_LENGTH = 1_000_000;
export const MAX_VEGA_LITE_INLINE_ROWS = 100_000;
const MAX_VEGA_LITE_VALUE_NODES = 250_000;

export interface ParsedVegaLiteSource {
  readonly externalResources: ReadonlyArray<string>;
  readonly spec: TopLevelSpec;
}

export interface VegaLiteRenderPlan {
  readonly responsive: boolean;
  readonly spec: TopLevelSpec;
}

const VEGA_LITE_SCHEMA_VERSION =
  /\/schema\/vega-lite\/v(?<major>\d+)(?:\.\d+)*(?:-[a-z0-9.-]+)?\.json(?:[?#].*)?$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function inspectSpec(spec: Record<string, unknown>): {
  readonly externalResources: ReadonlyArray<string>;
  readonly inlineRows: number;
} {
  const stack: Array<{ readonly key: string | null; readonly value: unknown }> = [
    { key: null, value: spec },
  ];
  const externalResources = new Set<string>();
  let inlineRows = 0;
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    visitedNodes += 1;
    if (visitedNodes > MAX_VEGA_LITE_VALUE_NODES) {
      throw new Error(
        `The chart specification is too complex to render (more than ${MAX_VEGA_LITE_VALUE_NODES.toLocaleString()} values).`,
      );
    }

    if (Array.isArray(current.value)) {
      if (current.key === "values") inlineRows += current.value.length;
      for (const value of current.value) stack.push({ key: null, value });
      continue;
    }
    if (!isRecord(current.value)) continue;

    for (const [key, value] of Object.entries(current.value)) {
      if (
        (key === "url" || key === "href") &&
        typeof value === "string" &&
        /^https?:\/\//iu.test(value)
      ) {
        externalResources.add(value);
      }
      if (current.key === "datasets" && Array.isArray(value)) {
        inlineRows += value.length;
      }
      stack.push({ key, value });
    }
  }

  return { externalResources: [...externalResources], inlineRows };
}

export function parseVegaLiteSource(source: string): ParsedVegaLiteSource {
  if (source.trim().length === 0) {
    throw new Error("The Vega-Lite source is empty.");
  }
  if (source.length > MAX_VEGA_LITE_SOURCE_LENGTH) {
    throw new Error(
      `The chart source is too large to render (${source.length.toLocaleString()} characters; maximum ${MAX_VEGA_LITE_SOURCE_LENGTH.toLocaleString()}).`,
    );
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const firstError = errors[0];
  if (firstError != null) throw new Error(parseErrorMessage(source, firstError));
  if (!isRecord(parsed)) {
    throw new Error("A Vega-Lite chart must be a JSON object.");
  }

  const schema = parsed.$schema;
  if (typeof schema === "string" && /\/schema\/vega\/v?\d/i.test(schema)) {
    throw new Error(
      "This fence contains a low-level Vega specification. Use a Vega-Lite specification or an ordinary json fence.",
    );
  }

  const inspection = inspectSpec(parsed);
  if (inspection.inlineRows > MAX_VEGA_LITE_INLINE_ROWS) {
    throw new Error(
      `The chart contains too many inline rows (${inspection.inlineRows.toLocaleString()}; maximum ${MAX_VEGA_LITE_INLINE_ROWS.toLocaleString()}).`,
    );
  }

  return {
    externalResources: inspection.externalResources,
    spec: parsed as unknown as TopLevelSpec,
  };
}

function isSingleOrLayerSpec(spec: Record<string, unknown>): boolean {
  return "mark" in spec || "layer" in spec;
}

interface UnitLayerCandidate {
  readonly spec: Record<string, unknown>;
}

function isSelectionParameter(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (value.select === "point" || value.select === "interval" || isRecord(value.select))
  );
}

function collectUnitLayerCandidates(layer: unknown, candidates: Array<UnitLayerCandidate>): void {
  if (!Array.isArray(layer)) return;
  for (const child of layer) {
    if (!isRecord(child)) continue;
    if ("mark" in child) {
      candidates.push({ spec: child });
      continue;
    }
    collectUnitLayerCandidates(child.layer, candidates);
  }
}

function visitCompositionRecords(
  root: Record<string, unknown>,
  visit: (record: Record<string, unknown>) => void,
): void {
  const stack = [root];
  while (stack.length > 0) {
    const record = stack.pop()!;
    visit(record);

    const children: Array<Record<string, unknown>> = [];
    if (isRecord(record.spec)) children.push(record.spec);
    for (const key of ["layer", "concat", "hconcat", "vconcat"] as const) {
      const value = record[key];
      if (!Array.isArray(value)) continue;
      for (const child of value) {
        if (isRecord(child)) children.push(child);
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
}

function selectionFields(parameter: Record<string, unknown>): ReadonlySet<string> {
  const select = parameter.select;
  if (!isRecord(select) || !Array.isArray(select.fields)) return new Set();
  return new Set(select.fields.filter((field): field is string => typeof field === "string"));
}

function selectionEncodings(parameter: Record<string, unknown>): ReadonlySet<string> {
  const select = parameter.select;
  if (!isRecord(select) || !Array.isArray(select.encodings)) return new Set();
  return new Set(
    select.encodings.filter((channel): channel is string => typeof channel === "string"),
  );
}

function encodingMatchesSelection(
  channel: string,
  definition: Record<string, unknown>,
  fields: ReadonlySet<string>,
  encodings: ReadonlySet<string>,
): boolean {
  return (
    encodings.has(channel) || (typeof definition.field === "string" && fields.has(definition.field))
  );
}

function matchingLegendEncoding(
  candidate: UnitLayerCandidate,
  parameter: Record<string, unknown>,
): { readonly channel: string; readonly definition: Record<string, unknown> } | null {
  const encoding = candidate.spec.encoding;
  if (!isRecord(encoding)) return null;
  const fields = selectionFields(parameter);
  const encodings = selectionEncodings(parameter);

  for (const [channel, value] of Object.entries(encoding)) {
    if (
      isRecord(value) &&
      value.legend !== null &&
      encodingMatchesSelection(channel, value, fields, encodings)
    ) {
      return { channel, definition: value };
    }
  }
  return null;
}

function referencesSelectionFilter(value: unknown, parameterName: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => referencesSelectionFilter(entry, parameterName));
  }
  if (!isRecord(value)) return false;
  if (value.param === parameterName) return true;
  return Object.values(value).some((entry) => referencesSelectionFilter(entry, parameterName));
}

function chooseInteractionOwner(
  candidates: ReadonlyArray<UnitLayerCandidate>,
  parameter: Record<string, unknown>,
): UnitLayerCandidate | null {
  if (parameter.bind === "legend") {
    const legendOwner = candidates.find(
      (candidate) => matchingLegendEncoding(candidate, parameter) != null,
    );
    if (legendOwner != null) return legendOwner;
  }

  const parameterName = typeof parameter.name === "string" ? parameter.name : "";
  return (
    candidates.find(
      (candidate) => !referencesSelectionFilter(candidate.spec.transform, parameterName),
    ) ??
    candidates[0] ??
    null
  );
}

function collectViewNameCounts(root: Record<string, unknown>): Map<string, number> {
  const counts = new Map<string, number>();
  visitCompositionRecords(root, (record) => {
    if (typeof record.name === "string") {
      counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
    }
  });
  return counts;
}

function generatedViewName(
  parameter: Record<string, unknown>,
  usedNames: ReadonlySet<string>,
): string {
  const suffix =
    typeof parameter.name === "string"
      ? parameter.name.replace(/[^a-zA-Z0-9_]/gu, "_").replace(/^([0-9])/u, "_$1")
      : "selection";
  const base = `scient_interaction_${suffix || "selection"}`;
  let candidate = base;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  return candidate;
}

function sameScale(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function preserveRequiredSharedLegend(
  candidates: ReadonlyArray<UnitLayerCandidate>,
  owner: UnitLayerCandidate,
  parameter: Record<string, unknown>,
): void {
  if (parameter.bind !== "legend") return;
  const ownerMatch = matchingLegendEncoding(owner, parameter);
  if (ownerMatch == null) return;
  const ownerField = ownerMatch.definition.field;

  for (const candidate of candidates) {
    const encoding = candidate.spec.encoding;
    if (!isRecord(encoding)) continue;
    const definition = encoding[ownerMatch.channel];
    if (
      !isRecord(definition) ||
      definition.legend !== null ||
      definition.field !== ownerField ||
      !sameScale(definition.scale, ownerMatch.definition.scale)
    ) {
      continue;
    }
    const { legend: _legend, ...withSharedLegend } = definition;
    encoding[ownerMatch.channel] = withSharedLegend;
  }
}

function scopeLayeredSelections(
  record: Record<string, unknown>,
  viewNameCounts: Map<string, number>,
  usedViewNames: Set<string>,
): void {
  if (!Array.isArray(record.layer) || !Array.isArray(record.params)) return;
  const candidates: Array<UnitLayerCandidate> = [];
  collectUnitLayerCandidates(record.layer, candidates);
  if (candidates.length === 0) return;

  record.params = record.params.map((value) => {
    if (!isSelectionParameter(value) || value.views != null) return value;
    const owner = chooseInteractionOwner(candidates, value);
    if (owner == null) return value;

    let ownerName = typeof owner.spec.name === "string" ? owner.spec.name : null;
    if (ownerName != null && viewNameCounts.get(ownerName) !== 1) return value;
    if (ownerName == null) {
      ownerName = generatedViewName(value, usedViewNames);
      owner.spec.name = ownerName;
      usedViewNames.add(ownerName);
      viewNameCounts.set(ownerName, 1);
    }

    preserveRequiredSharedLegend(candidates, owner, value);
    return { ...value, views: [ownerName] };
  });
}

function hasUnscopedLayerSelection(root: Record<string, unknown>): boolean {
  let found = false;
  visitCompositionRecords(root, (record) => {
    if (
      Array.isArray(record.layer) &&
      Array.isArray(record.params) &&
      record.params.some((parameter) => isSelectionParameter(parameter) && parameter.views == null)
    ) {
      found = true;
    }
  });
  return found;
}

function scopeComposedLayerSelections(root: Record<string, unknown>): void {
  const viewNameCounts = collectViewNameCounts(root);
  const usedViewNames = new Set(viewNameCounts.keys());
  visitCompositionRecords(root, (record) => {
    scopeLayeredSelections(record, viewNameCounts, usedViewNames);
  });
}

/** Builds a disposable render copy without changing the canonical fenced source. */
export function buildVegaLiteRenderPlan(spec: TopLevelSpec): VegaLiteRenderPlan {
  const source = spec as unknown as Record<string, unknown>;
  const needsResponsiveDefaults = source.width == null && isSingleOrLayerSpec(source);
  const needsSelectionScoping = hasUnscopedLayerSelection(source);
  const responsive = source.width === "container" || needsResponsiveDefaults;
  if (!needsResponsiveDefaults && !needsSelectionScoping) {
    return { responsive, spec };
  }

  const prepared = structuredClone(source);
  if (needsResponsiveDefaults) {
    prepared.width = "container";
    if (prepared.autosize == null) {
      prepared.autosize = { type: "fit", contains: "padding", resize: true };
    }
  }
  if (needsSelectionScoping) scopeComposedLayerSelections(prepared);

  return {
    responsive,
    spec: prepared as unknown as TopLevelSpec,
  };
}

/**
 * Prepares a disposable spec for the one bundled compiler. `$schema` helps
 * editors select validation metadata; Vega-Embed otherwise treats an older
 * declaration as a runtime warning even when the current compiler accepts it.
 */
export function prepareVegaLiteSpecForRuntime(
  spec: TopLevelSpec,
  runtimeVersion: string,
): TopLevelSpec {
  const source = spec as unknown as Record<string, unknown>;
  if (typeof source.$schema !== "string") return spec;

  const declaredMajorText = VEGA_LITE_SCHEMA_VERSION.exec(source.$schema)?.groups?.major;
  const runtimeMajorText = /^(?<major>\d+)/u.exec(runtimeVersion)?.groups?.major;
  if (runtimeMajorText == null) {
    throw new Error("Scient could not determine the bundled Vega-Lite version.");
  }

  const declaredMajor = declaredMajorText == null ? null : Number(declaredMajorText);
  const runtimeMajor = Number(runtimeMajorText);
  if (declaredMajor != null && declaredMajor > runtimeMajor) {
    throw new Error(
      `This chart targets Vega-Lite v${declaredMajor}, but this version of Scient supports Vega-Lite v${runtimeMajor}.`,
    );
  }

  const prepared = { ...source };
  delete prepared.$schema;
  return prepared as unknown as TopLevelSpec;
}

export function vegaLiteDescription(spec: TopLevelSpec): string | null {
  const description = (spec as unknown as Record<string, unknown>).description;
  return typeof description === "string" && description.trim().length > 0
    ? description.trim()
    : null;
}
