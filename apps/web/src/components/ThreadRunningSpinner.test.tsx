// FILE: ThreadRunningSpinner.test.tsx
// Purpose: Lock down the sidebar running indicator's accessible motion behavior.
// Layer: Sidebar UI primitive tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadRunningSpinner } from "./ThreadRunningSpinner";

describe("ThreadRunningSpinner", () => {
  it("preserves the status geometry while respecting reduced-motion preferences", () => {
    const markup = renderToStaticMarkup(<ThreadRunningSpinner className="test-size" />);

    expect(markup).toContain("<span");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("size-3");
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).toContain("[animation-duration:1.6s]");
    expect(markup).toContain("test-size");
    expect(markup).toContain("conic-gradient");
    expect(markup).toContain("radial-gradient");
  });
});
