// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileLinkResolutionNotice } from "./FileLinkResolutionNotice";

describe("FileLinkResolutionNotice", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("names where the link pointed, in the past tense, and can be dismissed", async () => {
    const onDismiss = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(() =>
      root.render(<FileLinkResolutionNotice missingPath="/repo/plan.md" onDismiss={onDismiss} />),
    );

    expect(host.querySelector("[role=status]")?.textContent).toBe(
      "Opened from a link to /repo/plan.md, which was missing when checked.",
    );
    await act(() => host.querySelector<HTMLButtonElement>("button[aria-label=Dismiss]")!.click());
    expect(onDismiss).toHaveBeenCalledOnce();
    await act(() => root.unmount());
  });
});
