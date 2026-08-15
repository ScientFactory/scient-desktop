// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the lazy renderer seam.
import * as NodeFS from "node:fs";

import { parse as parseVega, type Spec as VegaSpec } from "vega";
import { compile, type TopLevelSpec } from "vega-lite";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyScientVegaRuntimeDefaults,
  createVegaResourceLoader,
  fetchVegaRemoteResource,
  MAX_VEGA_REMOTE_RESOURCE_BYTES,
  normalizedVegaLiteError,
  restoreVegaLiteViewState,
  SCIENT_VEGA_TOOLTIP_CURSOR,
  validateVegaResourceUri,
  vegaLiteThemeConfig,
} from "./vegaLiteRuntime";

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

  it("provides stable light and dark defaults without changing author data colors", () => {
    expect(vegaLiteThemeConfig("light")).toMatchObject({
      background: null,
      axis: { labelColor: "#525252" },
    });
    expect(vegaLiteThemeConfig("dark")).toMatchObject({
      background: null,
      axis: { labelColor: "#d4d4d4" },
    });
    expect(vegaLiteThemeConfig("dark")).not.toHaveProperty("range");
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
