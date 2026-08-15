interface MathJaxStartup {
  readonly promise?: Promise<unknown> | undefined;
  readonly typeset?: boolean | undefined;
}

interface MathJaxGlobal {
  readonly startup?: MathJaxStartup | undefined;
  readonly typesetPromise?: ((elements?: HTMLElement[]) => Promise<unknown>) | undefined;
}

type MathJaxWindow = Window & typeof globalThis & { MathJax?: MathJaxGlobal | undefined };

let mathJaxPromise: Promise<void> | null = null;

/**
 * Load Plotly's math-label dependency locally and only for figures that use TeX.
 * MathJax's component bundle contains a Node-only `eval("require")` fallback;
 * the browser path never executes it, so Electron's CSP remains unchanged.
 */
export function ensurePlotlyMathRuntime(): Promise<void> {
  if (mathJaxPromise != null) return mathJaxPromise;

  mathJaxPromise = (async () => {
    const mathWindow = window as MathJaxWindow;
    if (typeof mathWindow.MathJax?.typesetPromise === "function") return;

    mathWindow.MathJax = {
      startup: { typeset: false },
    };
    await import("mathjax/es5/tex-svg.js");

    const loaded = mathWindow.MathJax;
    if (loaded?.startup?.promise != null) await loaded.startup.promise;
    if (typeof loaded?.typesetPromise !== "function") {
      throw new Error("MathJax loaded without its browser typesetting API.");
    }
  })().catch((cause: unknown) => {
    mathJaxPromise = null;
    throw cause;
  });

  return mathJaxPromise;
}
