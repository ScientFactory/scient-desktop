import { describe, expect, it, vi } from "vite-plus/test";

import { releasePlotlyWebGlContexts } from "./plotlyWebGlContext";

describe("Plotly WebGL context release", () => {
  it("actively releases WebGL 2 and WebGL 1 canvases", () => {
    const loseWebGl2 = vi.fn();
    const loseWebGl = vi.fn();
    const webGl2 = { getExtension: vi.fn(() => ({ loseContext: loseWebGl2 })) };
    const webGl = { getExtension: vi.fn(() => ({ loseContext: loseWebGl })) };
    const root = {
      querySelectorAll: vi.fn(() => [
        { getContext: vi.fn((type: string) => (type === "webgl2" ? webGl2 : null)) },
        { getContext: vi.fn((type: string) => (type === "webgl" ? webGl : null)) },
      ]),
    };

    releasePlotlyWebGlContexts(root);

    expect(loseWebGl2).toHaveBeenCalledOnce();
    expect(loseWebGl).toHaveBeenCalledOnce();
  });

  it("continues releasing other canvases when one is already unavailable", () => {
    const loseContext = vi.fn();
    const root = {
      querySelectorAll: vi.fn(() => [
        {
          getContext: vi.fn(() => {
            throw new Error("Context already lost");
          }),
        },
        {
          getContext: vi.fn(() => ({ getExtension: () => ({ loseContext }) })),
        },
      ]),
    };

    expect(() => releasePlotlyWebGlContexts(root)).not.toThrow();
    expect(loseContext).toHaveBeenCalledOnce();
  });
});
