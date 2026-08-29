// @vitest-environment happy-dom

import { MarkdownSaveQueue } from "@scientfactory/scient-markdown";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientCm6SpikeSurface } from "./ScientCm6SpikeSurface";
import { ScientCm6EditorView } from "./view";

describe("ScientCm6SpikeSurface", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await act(() => root.unmount());
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("disposes its save lane and editor controller on unmount", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const dispose = vi.spyOn(MarkdownSaveQueue.prototype, "dispose");
    const destroy = vi.spyOn(ScientCm6EditorView.prototype, "destroy");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(() =>
      root.render(
        <ScientCm6SpikeSurface
          source="# Results\n"
          revision="r0"
          ariaLabel="Results"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );
    expect(host.querySelector(".cm-editor")).not.toBeNull();

    await act(() => root.unmount());

    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
    });
    expect(dispose).toHaveBeenCalledWith({ flush: true });
    expect(host.querySelector(".cm-editor")).toBeNull();
  });
});
