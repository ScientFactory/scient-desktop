import { afterAll, describe, expect, it, vi } from "vite-plus/test";

vi.stubGlobal("window", globalThis);

vi.mock("mathjax/es5/tex-svg.js", () => {
  Object.assign(globalThis, {
    MathJax: {
      startup: { promise: Promise.resolve() },
      typesetPromise: vi.fn(async () => undefined),
    },
  });
  return { default: {} };
});

afterAll(() => vi.unstubAllGlobals());

describe("Plotly math runtime", () => {
  it("loads the local MathJax component and exposes its browser API", async () => {
    delete (window as Window & { MathJax?: unknown }).MathJax;
    const { ensurePlotlyMathRuntime } = await import("./plotlyMathRuntime");

    await ensurePlotlyMathRuntime();

    expect(
      (window as Window & { MathJax?: { typesetPromise?: unknown } }).MathJax?.typesetPromise,
    ).toBeTypeOf("function");
  });
});
