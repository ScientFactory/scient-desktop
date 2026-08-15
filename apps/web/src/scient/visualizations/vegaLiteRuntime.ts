import type { Loader, Spec as VegaSpec, View } from "vega";
import type { Result as VegaEmbedResult, VisualizationSpec } from "vega-embed";

import {
  type ParsedVegaLiteSource,
  type VegaLiteRenderPlan,
  prepareVegaLiteSpecForRuntime,
  vegaLiteDescription,
} from "./vegaLiteSpec";

export type VegaLiteTheme = "light" | "dark";
export type VegaLiteViewState = ReturnType<View["getState"]>;

export interface MountedVegaLiteView {
  readonly initialState: VegaLiteViewState;
  readonly result: VegaEmbedResult;
  readonly warnings: ReadonlyArray<string>;
}

export const MAX_VEGA_REMOTE_RESOURCE_BYTES = 20 * 1024 * 1024;
export const VEGA_REMOTE_RESOURCE_TIMEOUT_MS = 15_000;

const MICRO_CROSS_CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="white" stroke-linecap="round" stroke-width="3"/><path d="M8 3v10M3 8h10" fill="none" stroke="#171717" stroke-linecap="round" stroke-width="1"/></svg>';

/** Compact, dual-contrast inspection cursor with a native crosshair fallback. */
export const SCIENT_VEGA_TOOLTIP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  MICRO_CROSS_CURSOR_SVG,
)}") 8 8, crosshair`;

let vegaEmbedRuntimePromise: Promise<typeof import("vega-embed")> | null = null;

/** Vega is sizeable, so no renderer code enters the initial chat bundle. */
export function getVegaEmbedRuntimePromise(): Promise<typeof import("vega-embed")> {
  vegaEmbedRuntimePromise ??= import("vega-embed");
  return vegaEmbedRuntimePromise;
}

function logValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeWarning(values: ReadonlyArray<unknown>): string {
  return values
    .map(logValue)
    .join(" ")
    .replace(/^WARN\s*/u, "")
    .trim();
}

export function normalizedVegaLiteError(cause: unknown): Error {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    const line = cause.message.split("\n").find((value) => value.trim().length > 0);
    return new Error(line?.trim() || "Vega-Lite could not render this chart.", { cause });
  }
  return new Error("Vega-Lite could not render this chart.", { cause });
}

export function validateVegaResourceUri(uri: string): "data" | "remote" {
  if (uri.startsWith("data:")) return "data";

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(
      `Relative chart resource '${uri}' has no stable base in chat. Use inline data, an absolute HTTPS URL, or a project Vega-Lite file.`,
    );
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return "remote";
  throw new Error(`Chart resources using the '${parsed.protocol}' protocol are not supported.`);
}

async function responseTextWithinLimit(response: Response): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VEGA_REMOTE_RESOURCE_BYTES) {
    throw new Error(
      `The remote chart resource is too large (${declaredLength.toLocaleString()} bytes; maximum ${MAX_VEGA_REMOTE_RESOURCE_BYTES.toLocaleString()}).`,
    );
  }

  const reader = response.body?.getReader();
  if (reader == null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_VEGA_REMOTE_RESOURCE_BYTES) {
      throw new Error("The remote chart resource exceeded the 20 MiB limit.");
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    received += next.value.byteLength;
    if (received > MAX_VEGA_REMOTE_RESOURCE_BYTES) {
      await reader.cancel();
      throw new Error("The remote chart resource exceeded the 20 MiB limit.");
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchVegaRemoteResource(
  uri: string,
  options: Partial<RequestInit> = {},
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<string> {
  validateVegaResourceUri(uri);
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), VEGA_REMOTE_RESOURCE_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(uri, {
      ...options,
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Unable to load chart data (${response.status} ${response.statusText}).`);
    }
    return await responseTextWithinLimit(response);
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error("The chart data request timed out after 15 seconds.", { cause });
    }
    if (cause instanceof TypeError) {
      throw new Error(
        "Unable to load chart data from this viewing device. The address may be unavailable or may not allow browser access (CORS).",
        { cause },
      );
    }
    throw cause;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export interface VegaResourceLoader {
  readonly failures: ReadonlyArray<Error>;
  readonly loader: Loader;
}

function resourceFailure(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("The chart resource could not be loaded.", { cause });
}

export function createVegaResourceLoader(vega: typeof import("vega")): VegaResourceLoader {
  const defaultLoader = vega.loader({ http: { credentials: "omit" } });
  const failures: Error[] = [];
  const recordFailure = (cause: unknown): Error => {
    const error = resourceFailure(cause);
    if (!failures.some((failure) => failure.message === error.message)) failures.push(error);
    return error;
  };
  const loader: Loader = {
    async load(uri, options) {
      try {
        const kind = validateVegaResourceUri(uri);
        return kind === "data"
          ? await defaultLoader.load(uri, options)
          : await fetchVegaRemoteResource(uri);
      } catch (cause) {
        throw recordFailure(cause);
      }
    },
    async sanitize(uri, options) {
      try {
        validateVegaResourceUri(uri);
        return await defaultLoader.sanitize(uri, options);
      } catch (cause) {
        throw recordFailure(cause);
      }
    },
    async http(uri, options) {
      try {
        return await fetchVegaRemoteResource(uri, options);
      } catch (cause) {
        throw recordFailure(cause);
      }
    },
    file(filename) {
      return Promise.reject(
        recordFailure(
          new Error(
            `Local chart resource '${filename}' must be resolved through a project Vega-Lite file.`,
          ),
        ),
      );
    },
  };
  return { failures, loader };
}

export function vegaLiteThemeConfig(theme: VegaLiteTheme): Record<string, unknown> {
  const dark = theme === "dark";
  const text = dark ? "#e5e5e5" : "#262626";
  const secondaryText = dark ? "#d4d4d4" : "#525252";
  const grid = dark ? "#404040" : "#e5e5e5";
  const boundary = dark ? "#737373" : "#a3a3a3";
  const font =
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  return {
    background: null,
    font,
    view: { stroke: null, continuousWidth: 560, continuousHeight: 320 },
    axis: {
      domainColor: boundary,
      gridColor: grid,
      labelColor: secondaryText,
      labelFont: font,
      tickColor: boundary,
      titleColor: text,
      titleFont: font,
    },
    legend: {
      labelColor: secondaryText,
      labelFont: font,
      titleColor: text,
      titleFont: font,
    },
    header: {
      labelColor: secondaryText,
      labelFont: font,
      titleColor: text,
      titleFont: font,
    },
    title: { color: text, font, subtitleColor: secondaryText, subtitleFont: font },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasEncodedProperty(encode: Record<string, unknown>, property: string): boolean {
  return ["enter", "update", "hover"].some((phase) => {
    const encodedPhase = encode[phase];
    return isRecord(encodedPhase) && encodedPhase[property] != null;
  });
}

function applyTooltipCursorDefaults(marks: unknown): void {
  if (!Array.isArray(marks)) return;

  for (const value of marks) {
    if (!isRecord(value)) continue;
    const encode = value.encode;
    if (
      value.interactive !== false &&
      isRecord(encode) &&
      hasEncodedProperty(encode, "tooltip") &&
      !hasEncodedProperty(encode, "cursor")
    ) {
      const update = isRecord(encode.update) ? encode.update : {};
      update.cursor = { value: SCIENT_VEGA_TOOLTIP_CURSOR };
      encode.update = update;
    }
    applyTooltipCursorDefaults(value.marks);
  }
}

/** Adds only runtime presentation defaults; the authored Vega-Lite source is untouched. */
export function applyScientVegaRuntimeDefaults(spec: VegaSpec): VegaSpec {
  applyTooltipCursorDefaults(spec.marks);
  return spec;
}

/** Restores transferred interaction state before the mounted view is exposed as ready. */
export async function restoreVegaLiteViewState(
  view: Pick<View, "runAsync" | "setState">,
  state: VegaLiteViewState | null | undefined,
): Promise<void> {
  if (state == null) return;
  view.setState(state);
  await view.runAsync();
}

export async function mountVegaLiteView(input: {
  readonly container: HTMLElement;
  readonly initialState?: VegaLiteViewState | null | undefined;
  readonly parsed: ParsedVegaLiteSource;
  readonly renderPlan: VegaLiteRenderPlan;
  readonly theme: VegaLiteTheme;
  readonly title: string;
}): Promise<MountedVegaLiteView> {
  const [runtime, { createScientVegaTooltipHandler }] = await Promise.all([
    getVegaEmbedRuntimePromise(),
    import("./vegaLiteTooltip"),
  ]);
  const warnings: string[] = [];
  const logger = runtime.vega.logger(runtime.vega.Warn, undefined, (_method, _level, values) => {
    const warning = normalizeWarning(values);
    if (warning.length > 0 && !warnings.includes(warning)) warnings.push(warning);
  });

  let result: VegaEmbedResult | null = null;
  try {
    const renderSpec = prepareVegaLiteSpecForRuntime(
      input.renderPlan.spec,
      runtime.vegaLite.version,
    );
    const resourceLoader = createVegaResourceLoader(runtime.vega);
    result = await runtime.default(input.container, renderSpec as VisualizationSpec, {
      actions: false,
      ast: true,
      config: vegaLiteThemeConfig(input.theme),
      defaultStyle: false,
      expressionFunctions: {
        // Vega 6.3.1's CSP interpreter omitted hypot; upstream fixed it for 6.4.
        // Registering the standard function keeps codegen/interpreter behavior aligned.
        hypot: Math.hypot,
      },
      loader: resourceLoader.loader,
      logger,
      mode: "vega-lite",
      patch: applyScientVegaRuntimeDefaults,
      renderer: "svg",
      tooltip: createScientVegaTooltipHandler(input.theme),
    });

    const firstResourceFailure = resourceLoader.failures[0];
    if (firstResourceFailure != null) {
      throw firstResourceFailure;
    }

    // Capture the authored default before restoring a transferred interaction state.
    // Both inline and expanded views can then reset to the same canonical chart.
    const initialState = result.view.getState();
    await restoreVegaLiteViewState(result.view, input.initialState);
    if (vegaLiteDescription(input.parsed.spec) == null) result.view.description(input.title);
    result.view.globalCursor(false);
    return {
      initialState,
      result,
      warnings,
    };
  } catch (cause) {
    result?.finalize();
    throw normalizedVegaLiteError(cause);
  }
}
