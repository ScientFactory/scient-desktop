import { describe, expect, it } from "vitest";

import { PACKAGED_RENDERER_READINESS_EXPRESSION } from "./packagedStartupRendererReadiness";

function evaluateRendererReadiness(input: {
  readonly readyState: string;
  readonly rendererReady?: string;
}): boolean {
  const evaluate = new Function(
    "document",
    `return ${PACKAGED_RENDERER_READINESS_EXPRESSION};`,
  ) as (document: unknown) => boolean;

  return evaluate({
    readyState: input.readyState,
    documentElement: {
      dataset: {
        ...(input.rendererReady === undefined ? {} : { scientRendererReady: input.rendererReady }),
      },
    },
  });
}

describe("packaged renderer readiness", () => {
  it("requires both a complete document and the renderer-owned React commit marker", () => {
    expect(evaluateRendererReadiness({ readyState: "loading", rendererReady: "true" })).toBe(false);
    expect(evaluateRendererReadiness({ readyState: "complete" })).toBe(false);
    expect(evaluateRendererReadiness({ readyState: "complete", rendererReady: "false" })).toBe(
      false,
    );
    expect(evaluateRendererReadiness({ readyState: "complete", rendererReady: "true" })).toBe(true);
  });
});
