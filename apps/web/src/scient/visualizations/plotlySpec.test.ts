// @effect-diagnostics nodeBuiltinImport:off -- Static audit of the manual Plotly fixture corpus.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  MAX_PLOTLY_FRAMES,
  MAX_PLOTLY_NESTING_DEPTH,
  MAX_PLOTLY_SOURCE_LENGTH,
  MAX_PLOTLY_TRACES,
  parsePlotlySource,
  plotlyFigureDescription,
  plotlyFigureTitle,
} from "./plotlySpec";

describe("parsePlotlySource", () => {
  it("accepts portable Plotly JSONC while retaining figure structure", () => {
    const parsed = parsePlotlySource(`{
      // Compatible producer output
      "data": [{ "type": "scatter", "x": [1, 2], "y": [3, 5] }],
      "layout": {
        "title": { "text": "Dose response" },
        "meta": { "description": "Response rises with dose." },
      },
      "config": { "scrollZoom": true },
    }`);

    expect(parsed.figure.data).toHaveLength(1);
    expect(parsed.figure.config.scrollZoom).toBe(true);
    expect(parsed.hasCartesian).toBe(true);
    expect(plotlyFigureTitle(parsed.figure)).toBe("Dose response");
    expect(plotlyFigureDescription(parsed.figure)).toBe("Response rises with dose.");
  });

  it("exposes Cartesian interaction tools only when a compatible subplot exists", () => {
    expect(parsePlotlySource(JSON.stringify({ data: [{ x: [1], y: [2] }] })).hasCartesian).toBe(
      true,
    );
    expect(
      parsePlotlySource(JSON.stringify({ data: [{ type: "scatter3d", x: [1], y: [2], z: [3] }] }))
        .hasCartesian,
    ).toBe(false);
    expect(
      parsePlotlySource(
        JSON.stringify({
          data: [
            { type: "surface", z: [[1]] },
            { type: "scattergl", x: [1], y: [2] },
          ],
        }),
      ).hasCartesian,
    ).toBe(true);
  });

  it("classifies WebGL, animation, math, map, and external-resource capabilities", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({
        data: [
          { type: "scattergl", x: [1], y: [2] },
          { type: "scattermap", lat: [31.8], lon: [35.2] },
          { type: "choropleth", locations: ["ISR"], z: [1] },
        ],
        frames: [{ name: "later", data: [{ y: [3] }] }],
        layout: {
          images: [{ source: "https://example.test/overlay.png" }],
          title: { text: "$E = mc^2$" },
        },
        config: { topojsonURL: "https://example.test/topology/" },
      }),
    );

    expect(parsed.hasWebGl).toBe(true);
    expect(parsed.hasMapTiles).toBe(true);
    expect(parsed.hasGeoTopology).toBe(true);
    expect(parsed.hasNetworkContent).toBe(true);
    expect(parsed.hasFrames).toBe(true);
    expect(parsed.hasMath).toBe(true);
    expect(parsed.externalResources).toEqual([
      "https://example.test/topology/",
      "https://example.test/overlay.png",
    ]);
  });

  it.each([
    [
      "an external image",
      { data: [], layout: { images: [{ source: "https://example.test/overlay.png" }] } },
    ],
    ["a relative image", { data: [], layout: { images: [{ source: "/overlay.png" }] } }],
    ["a topology URL", { data: [], config: { topojsonURL: "https://example.test/" } }],
    ["map tiles", { data: [{ type: "scattermap", lat: [31.8], lon: [35.2] }] }],
    ["geo topology", { data: [{ type: "choropleth", locations: ["ISR"], z: [1] }] }],
  ])("accepts %s and classifies its network requirements", (_label, figure) => {
    const parsed = parsePlotlySource(JSON.stringify(figure));
    expect(parsed.externalResources.length > 0 || parsed.hasMapTiles || parsed.hasGeoTopology).toBe(
      true,
    );
  });

  it("allows bounded inline raster images without granting network access", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({
        data: [],
        layout: { images: [{ source: "data:image/png;base64,iVBORw0KGgo=" }] },
      }),
    );

    expect(parsed.externalResources).toEqual([]);
    expect(parsed.hasNetworkContent).toBe(false);
  });

  it("warns about compatible deprecated Mapbox traces", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({ data: [{ type: "scattermapbox", lat: [1], lon: [2] }] }),
    );

    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("deprecated Mapbox");
    expect(parsed.hasWebGl).toBe(true);
  });

  it("renders Plotly Express scatter output without treating dormant template defaults as active traces", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({
        data: [
          { type: "scatter", name: "early", x: [1, 2], y: [3, 4] },
          { type: "scatter", name: "late", x: [1, 2], y: [4, 5] },
        ],
        layout: {
          template: {
            data: {
              choropleth: [{ type: "choropleth" }],
              scattergeo: [{ type: "scattergeo" }],
              scattermap: [{ type: "scattermap" }],
            },
          },
        },
      }),
    );

    expect(parsed.hasCartesian).toBe(true);
    expect(parsed.hasGeoTopology).toBe(false);
    expect(parsed.hasMapTiles).toBe(false);
    expect(parsed.hasNetworkContent).toBe(false);
    expect(parsed.externalResources).toEqual([]);
  });

  it.each<[string, unknown, ReadonlyArray<string>]>([
    [
      "an attribute/value image update",
      {
        data: [],
        layout: {
          updatemenus: [
            {
              buttons: [
                {
                  method: "relayout",
                  args: ["images[0].source", "https://example.test/later.png"],
                },
              ],
            },
          ],
        },
      },
      ["https://example.test/later.png"],
    ],
    [
      "a flattened image update",
      {
        data: [],
        layout: {
          updatemenus: [
            {
              buttons: [
                {
                  method: "relayout",
                  args: [{ "images[0].source": "https://example.test/flattened.png" }],
                },
              ],
            },
          ],
        },
      },
      ["https://example.test/flattened.png"],
    ],
    [
      "a template image default",
      {
        data: [],
        layout: {
          template: {
            layout: { imagedefaults: { source: "https://example.test/default.png" } },
          },
        },
      },
      ["https://example.test/default.png"],
    ],
    [
      "a framed image",
      {
        data: [],
        frames: [
          {
            data: [],
            layout: { images: [{ source: "https://example.test/frame.png" }] },
          },
        ],
      },
      ["https://example.test/frame.png"],
    ],
  ])("accepts and discloses %s", (_label, figure, resources) => {
    const parsed = parsePlotlySource(JSON.stringify(figure));
    expect(parsed.hasNetworkContent).toBe(true);
    expect(parsed.externalResources).toEqual(resources);
  });

  it("accepts and discloses a deferred map trace", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({
        data: [{ type: "scatter", x: [1], y: [2] }],
        layout: {
          sliders: [
            {
              steps: [{ method: "restyle", args: ["type", ["scattermap"]] }],
            },
          ],
        },
      }),
    );

    expect(parsed.hasNetworkContent).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["[]", "must be a JSON object"],
    ['{ "data": {} }', "`data` must be an array"],
    ['{ "data": [1] }', "Every Plotly `data` entry must be an object"],
    ['{ "data": [], "layout": [] }', "`layout` must be an object"],
    ['{ "data": [],', "Invalid JSON at line 1"],
  ])("rejects invalid input", (source, expected) => {
    expect(() => parsePlotlySource(source)).toThrow(expected);
  });

  it("enforces source, trace, and frame bounds before loading Plotly", () => {
    expect(() =>
      parsePlotlySource(`{"data":[],"x":"${"x".repeat(MAX_PLOTLY_SOURCE_LENGTH)}"}`),
    ).toThrow("too large");
    expect(() =>
      parsePlotlySource(
        JSON.stringify({ data: Array.from({ length: MAX_PLOTLY_TRACES + 1 }, () => ({})) }),
      ),
    ).toThrow("too many traces");
    expect(() =>
      parsePlotlySource(
        JSON.stringify({
          data: [],
          frames: Array.from({ length: MAX_PLOTLY_FRAMES + 1 }, () => ({})),
        }),
      ),
    ).toThrow("too many animation frames");
    expect(() =>
      parsePlotlySource(
        JSON.stringify({
          data: [],
          nested: Array.from({ length: MAX_PLOTLY_NESTING_DEPTH + 1 }).reduce(
            (value) => [value],
            null as unknown,
          ),
        }),
      ),
    ).toThrow("nested too deeply");
  });

  it("accepts Plotly.py typed-array JSON objects", () => {
    const parsed = parsePlotlySource(
      JSON.stringify({
        data: [
          {
            type: "scattergl",
            x: { dtype: "f8", bdata: "AAAAAAAA8D8AAAAAAAAAQA==" },
            y: { dtype: "i2", bdata: "AQACAA==" },
          },
        ],
      }),
    );

    expect(parsed.figure.data[0]?.x).toEqual({
      dtype: "f8",
      bdata: "AAAAAAAA8D8AAAAAAAAAQA==",
    });
  });

  it("rejects truncated or dimensionally inconsistent Plotly.py typed arrays", () => {
    expect(() =>
      parsePlotlySource(
        JSON.stringify({ data: [{ type: "scattergl", y: { dtype: "u1", bdata: "AAAAA" } }] }),
      ),
    ).toThrow("not complete valid base64");
    expect(() =>
      parsePlotlySource(
        JSON.stringify({
          data: [{ type: "heatmap", z: { dtype: "i2", bdata: "AQACAA==", shape: "3,2" } }],
        }),
      ),
    ).toThrow("requires 12 bytes");
  });

  it("keeps the manual visual-review corpus valid except for its named recovery case", () => {
    const fixture = NodeFS.readFileSync(
      new URL("../../../../../docs/fixtures/scient-chat-plotly.md", import.meta.url),
      "utf8",
    );
    const sources = [...fixture.matchAll(/```plotly(?: [^\n]*)?\n([\s\S]*?)\n```/gu)].map(
      (match) => match[1] ?? "",
    );

    expect(sources).toHaveLength(8);
    for (const source of sources.slice(0, -1))
      expect(() => parsePlotlySource(source)).not.toThrow();
    expect(() => parsePlotlySource(sources.at(-1) ?? "")).toThrow("Invalid JSON");
  });
});
