import { describe, expect, it } from "vite-plus/test";
import { parsePlotlySource } from "./plotlySpec";

const remote = "https://example.invalid/figure.png";
const button = (method: string, args: unknown, args2?: unknown) => ({
  data: [],
  layout: {
    updatemenus: [{ buttons: [{ method, args, ...(args2 === undefined ? {} : { args2 }) }] }],
  },
});

describe("Plotly deny-mode semantic resources", () => {
  it.each([
    [
      "template image defaults",
      { data: [], layout: { template: { layout: { imagedefaults: { source: remote } } } } },
    ],
    [
      "template layer defaults",
      {
        data: [],
        layout: { template: { layout: { map: { layerdefaults: { source: remote } } } } },
      },
    ],
    ["flattened relayout", button("relayout", [{ "images[0].source": remote }])],
    ["attribute/value relayout", button("relayout", ["images[0].source", remote])],
    ["toggle args2", button("relayout", [{ title: "Safe" }], [{ "images[0].source": remote }])],
    ["update layout", button("update", [{}, { "template.layout.imagedefaults.source": remote }])],
    ["restyle image source", button("restyle", ["source", [remote]])],
    ["deferred map trace", button("restyle", ["type", ["scattermap"]])],
    ["deferred topology trace", button("restyle", [{ type: "scattergeo" }])],
    ["inline animate frame", button("animate", [{ data: [{ type: "image", source: remote }] }])],
    [
      "stored animation frame",
      { data: [], frames: [{ data: [], layout: { images: [{ source: remote }] } }] },
    ],
    [
      "slider update",
      {
        data: [],
        layout: {
          sliders: [{ steps: [{ method: "relayout", args: ["images[0].source", remote] }] }],
        },
      },
    ],
    ["numbered map style", button("relayout", [{ "map2.style": "open-street-map" }])],
    ["relative resource", button("relayout", [{ "images[0].source": "/asset.png" }])],
    ["file resource", button("relayout", [{ "images[0].source": "file:///private/asset.png" }])],
    ["unsupported command", button("unreviewed-method", [{ x: [1] }])],
  ])("rejects %s before Plotly can execute it", (_name, figure) => {
    expect(() => parsePlotlySource(JSON.stringify(figure))).toThrow("requires network access");
  });

  it.each([
    button("restyle", [{ y: [[3, 4]], "marker.color": "red" }, [0]]),
    button("relayout", ["xaxis.range", [0, 2]]),
    button("update", [{ visible: [true] }, { title: { text: "Result" } }]),
    button("animate", ["frame-name", { frame: { duration: 100 } }]),
    button("skip", []),
    {
      data: [],
      layout: { template: { layout: { imagedefaults: { source: "data:image/png;base64,AA==" } } } },
    },
    { data: [{ type: "scatter", text: [remote], x: [1], y: [2] }] },
  ])("preserves offline figures and safe interactive commands (%#)", (figure) => {
    expect(() => parsePlotlySource(JSON.stringify(figure))).not.toThrow();
  });

  it("still reports resources to callers explicitly inspecting with allow mode", () => {
    expect(
      parsePlotlySource(JSON.stringify(button("relayout", ["images[0].source", remote])), {
        networkAccess: "allow",
      }).externalResources,
    ).toEqual([remote]);
  });
});
