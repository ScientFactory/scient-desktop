import { EnvironmentId } from "@t3tools/contracts";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const captured = vi.hoisted(() => ({
  requests: [] as Array<{ widthInches: number; source: string; algorithmNumber?: number }>,
  response: { _tag: "unavailable", message: "Synthetic compiler response" } as
    | { _tag: "unavailable"; message: string }
    | {
        _tag: "ready";
        pdfBase64: string;
        raster?: { pngBase64: string; widthPoints: number; heightPoints: number };
      },
  pdfLoads: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/scient-latex", () => ({
  renderEnvironmentLatexArtwork: ({
    request,
  }: {
    request: { widthInches: number; source: string; algorithmNumber?: number };
  }) => {
    captured.requests.push(request);
    return request;
  },
}));
vi.mock("~/lib/runtime", () => ({
  runtime: {
    runPromise: async () => captured.response,
  },
}));
vi.mock("~/state/session", () => ({ readPreparedConnection: () => ({}) }));
vi.mock("../pdf/pdfRuntime", () => ({ startPdfDocumentLoad: captured.pdfLoads }));

import { LatexTikzArtwork } from "./LatexTikzView";

it.each(["scient-latex-figure-panel", "scient-latex-compiled-algorithm"])(
  "requests artwork at the unscaled width of %s after observing layout",
  async (className) => {
    captured.requests.length = 0;
    captured.response = { _tag: "unavailable", message: "Synthetic compiler response" };
    const panel = document.createElement("div");
    panel.className = className;
    panel.style.cssText = "box-sizing:border-box;width:420px;padding:7px;border:3px solid black";
    document.body.append(panel);
    const root = createRoot(panel);
    const source = String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}`;
    try {
      root.render(
        <LatexTikzArtwork
          source={source}
          preamble="\\usepackage{tikz}"
          environmentId={EnvironmentId.make("artwork-width-test")}
          cwd="synthetic-workspace"
          relativePath="main.tex"
          algorithmNumber={3}
        />,
      );
      await expect.poll(() => captured.requests.length).toBe(1);
      expect(captured.requests[0]!.widthInches).toBe(panel.clientWidth / 96);
      expect(captured.requests[0]!.source).toBe(source);
      expect(captured.requests[0]!.algorithmNumber).toBe(3);
      panel.style.transform = "scale(0.7)";
      panel.style.width = "690px";
      await expect.poll(() => captured.requests.length).toBe(2);
      expect(captured.requests[1]!.widthInches).toBe(panel.clientWidth / 96);
      expect(captured.requests[1]!.source).toBe(source);
      expect(panel.querySelector(".scient-latex-tikz")?.getAttribute("contenteditable")).toBe(
        "false",
      );
    } finally {
      root.unmount();
      panel.remove();
    }
  },
);

it("decodes an isolated raster without starting PDF paint and retains its physical size", async () => {
  captured.requests.length = 0;
  captured.pdfLoads.mockClear();
  const pixels = document.createElement("canvas");
  pixels.width = 8;
  pixels.height = 4;
  const context = pixels.getContext("2d")!;
  context.fillStyle = "green";
  context.fillRect(0, 0, 8, 4);
  captured.response = {
    _tag: "ready",
    pdfBase64: "synthetic",
    raster: {
      pngBase64: pixels.toDataURL("image/png").split(",")[1]!,
      widthPoints: 3,
      heightPoints: 1.5,
    },
  };
  const panel = document.createElement("div");
  panel.className = "scient-latex-figure-panel";
  panel.style.width = "420px";
  document.body.append(panel);
  const root = createRoot(panel);
  try {
    root.render(
      <LatexTikzArtwork
        source={String.raw`\begin{tikzpicture}\draw(0,0)--(1,1);\end{tikzpicture}`}
        preamble="\\usepackage{tikz}"
        environmentId={EnvironmentId.make("raster-test")}
        cwd="/synthetic"
        relativePath="main.tex"
      />,
    );
    await expect.poll(() => panel.querySelector("canvas")?.hidden).toBe(false);
    const painted = panel.querySelector("canvas")!;
    expect([painted.width, painted.height]).toEqual([8, 4]);
    expect([painted.style.width, painted.style.height]).toEqual(["4px", "2px"]);
    expect([...painted.getContext("2d")!.getImageData(0, 0, 1, 1).data]).toEqual([0, 128, 0, 255]);
    expect(captured.pdfLoads).not.toHaveBeenCalled();
    expect(panel.querySelector("[role=status]")).toBeNull();
  } finally {
    root.unmount();
    panel.remove();
    captured.response = { _tag: "unavailable", message: "Synthetic compiler response" };
  }
});

it("retains the PDF renderer for responses without native pixels", async () => {
  captured.requests.length = 0;
  const destroy = vi.fn(async () => {});
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  captured.pdfLoads.mockReset();
  captured.pdfLoads.mockReturnValue({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 72 * scale, height: 36 * scale }),
        render,
      }),
    }),
    destroy,
  });
  captured.response = { _tag: "ready", pdfBase64: "JVBERg==" };
  const panel = document.createElement("div");
  panel.className = "scient-latex-figure-panel";
  panel.style.width = "420px";
  document.body.append(panel);
  const root = createRoot(panel);
  try {
    root.render(
      <LatexTikzArtwork
        source={String.raw`\begin{tikzpicture}\draw(0,0)--(1,1);\end{tikzpicture}`}
        preamble="\\usepackage{tikz}"
        environmentId={EnvironmentId.make("pdf-fallback-test")}
        cwd="/synthetic"
        relativePath="main.tex"
      />,
    );
    await expect.poll(() => panel.querySelector("canvas")?.hidden).toBe(false);
    const painted = panel.querySelector("canvas")!;
    expect([painted.width, painted.height]).toEqual([192, 96]);
    expect([painted.style.width, painted.style.height]).toEqual(["96px", "48px"]);
    expect(captured.pdfLoads).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  } finally {
    root.unmount();
    panel.remove();
    captured.response = { _tag: "unavailable", message: "Synthetic compiler response" };
    captured.pdfLoads.mockReset();
  }
});

it("releases a raster that finishes decoding after its editor is unmounted", async () => {
  captured.requests.length = 0;
  captured.pdfLoads.mockClear();
  let finishDecode!: (bitmap: ImageBitmap) => void;
  const decode = vi.spyOn(window, "createImageBitmap").mockImplementation(
    () =>
      new Promise<ImageBitmap>((resolve) => {
        finishDecode = resolve;
      }),
  );
  const close = vi.fn();
  captured.response = {
    _tag: "ready",
    pdfBase64: "synthetic",
    raster: { pngBase64: "AA==", widthPoints: 3, heightPoints: 1.5 },
  };
  const panel = document.createElement("div");
  panel.className = "scient-latex-figure-panel";
  panel.style.width = "420px";
  document.body.append(panel);
  const root = createRoot(panel);
  let unmounted = false;
  try {
    root.render(
      <LatexTikzArtwork
        source={String.raw`\begin{tikzpicture}\draw(0,0)--(1,1);\end{tikzpicture}`}
        preamble="\\usepackage{tikz}"
        environmentId={EnvironmentId.make("canceled-raster-test")}
        cwd="/synthetic"
        relativePath="main.tex"
      />,
    );
    await expect.poll(() => decode.mock.calls.length).toBe(1);
    const canvas = panel.querySelector("canvas")!;
    const paint = vi.spyOn(canvas.getContext("2d")!, "drawImage");
    root.unmount();
    unmounted = true;
    finishDecode({ width: 8, height: 4, close } as ImageBitmap);
    await expect.poll(() => close.mock.calls.length).toBe(1);
    expect(paint).not.toHaveBeenCalled();
    expect(captured.pdfLoads).not.toHaveBeenCalled();
  } finally {
    if (!unmounted) root.unmount();
    decode.mockRestore();
    panel.remove();
    captured.response = { _tag: "unavailable", message: "Synthetic compiler response" };
  }
});
