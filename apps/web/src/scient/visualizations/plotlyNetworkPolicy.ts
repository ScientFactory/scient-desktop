const NETWORK_TRACE_TYPES = new Set([
  "choropleth",
  "scattergeo",
  "choroplethmap",
  "choroplethmapbox",
  "densitymap",
  "densitymapbox",
  "scattermap",
  "scattermapbox",
]);
const METHODS = new Set(["restyle", "relayout", "update", "animate", "skip"]);
const INLINE_IMAGE = /^data:image\/(?:gif|jpeg|png|webp);base64,/iu;
const RESOURCE_CONTAINERS = new Set([
  "images",
  "imagedefaults",
  "layers",
  "layerdefaults",
  "map",
  "mapbox",
  "data",
  "args",
  "args2",
]);

/** Plotly update keys use dotted/indexed paths as well as ordinary nested JSON. */
function segments(key: string): string[] {
  return key
    .split(/[.[\]]+/u)
    .filter(Boolean)
    .map((part) => part.replace(/^(mapbox|map)\d+$/u, "$1"));
}

export interface PlotlyNetworkInspection {
  readonly externalResources: readonly string[];
  readonly requiresNetwork: boolean;
  readonly unsupportedCommand: boolean;
}

/** Inspect both initial values and the commands/frames that Plotly can execute later. */
export function inspectPlotlyNetwork(value: unknown): PlotlyNetworkInspection {
  const resources = new Set<string>();
  const stack: Array<{ value: unknown; path: string[]; depth: number }> = [
    { value, path: [], depth: 0 },
  ];
  let requiresNetwork = false;
  let unsupportedCommand = false;
  let visited = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++visited > 500_000 || current.depth > 128)
      throw new Error("The Plotly figure is too complex to inspect safely.");
    const key = current.path.at(-1);
    if (typeof current.value === "string") {
      if (key === "type" && NETWORK_TRACE_TYPES.has(current.value.toLowerCase()))
        requiresNetwork = true;
      const resource =
        key === "url" ||
        key === "geojson" ||
        key === "topojsonURL" ||
        (key === "source" && current.path.some((part) => RESOURCE_CONTAINERS.has(part))) ||
        (key === "style" && current.path.some((part) => part === "map" || part === "mapbox"));
      if (resource && current.value.trim() && !INLINE_IMAGE.test(current.value.trim()))
        resources.add(current.value);
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        stack.push({ ...current, value: child, depth: current.depth + 1 });
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const object = current.value as Record<string, unknown>;
    const command = current.path.includes("updatemenus") || current.path.includes("sliders");
    if (command && (Object.hasOwn(object, "args") || Object.hasOwn(object, "args2"))) {
      const method = object.method ?? "restyle";
      if (typeof method !== "string" || !METHODS.has(method)) unsupportedCommand = true;
      for (const name of ["args", "args2"] as const) {
        const args = object[name];
        // restyle/relayout also accept [attribute, value, ...], bypassing an object-key walk.
        if (
          (method === "restyle" || method === "relayout") &&
          Array.isArray(args) &&
          typeof args[0] === "string"
        ) {
          stack.push({
            value: args[1],
            path: [...current.path, name, ...segments(args[0])],
            depth: current.depth + 1,
          });
        }
      }
    }
    for (const [name, child] of Object.entries(object)) {
      stack.push({
        value: child,
        path: [...current.path, ...segments(name)],
        depth: current.depth + 1,
      });
    }
  }
  return {
    externalResources: [...resources],
    requiresNetwork: requiresNetwork || resources.size > 0,
    unsupportedCommand,
  };
}

export function assertPlotlyNetworkDenied(value: unknown): void {
  const inspection = inspectPlotlyNetwork(value);
  if (inspection.requiresNetwork || inspection.unsupportedCommand) {
    throw new Error(
      "This Plotly figure requires network access, which is blocked in Scient's embedded renderer. Use inline data or a static image instead.",
    );
  }
}
