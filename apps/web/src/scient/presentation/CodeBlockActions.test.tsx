// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CodeBlockActions } from "./CodeBlockActions";

describe("code block actions", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function render(wrapped: boolean) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <CodeBlockActions wrapped={wrapped} onWrapChange={() => {}} readCode={() => "x\n"} />,
      ),
    );
    return host.querySelector<HTMLElement>("[aria-pressed]")!;
  }

  it("shows the wrap toggle on while lines wrap, as upstream's code block does", () => {
    const on = render(true);
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.dataset.variant).toBe("secondary");
    expect(render(false).dataset.variant).toBe("ghost-muted");
  });
});
