interface ReleasableWebGlContext {
  readonly getExtension: (
    name: "WEBGL_lose_context",
  ) => { readonly loseContext: () => void } | null;
}

interface PlotlyCanvasLike {
  readonly getContext: (contextId: "webgl" | "webgl2") => ReleasableWebGlContext | null;
}

interface PlotlyCanvasRoot {
  readonly querySelectorAll: (selectors: "canvas") => Iterable<PlotlyCanvasLike>;
}

/** Immediately return discarded Plotly GPU contexts to Chromium's bounded pool. */
export function releasePlotlyWebGlContexts(root: PlotlyCanvasRoot): void {
  for (const canvas of root.querySelectorAll("canvas")) {
    try {
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // A context may already be lost or its canvas may already be detached.
      // Plotly.purge still completes the ordinary DOM/runtime cleanup.
    }
  }
}
