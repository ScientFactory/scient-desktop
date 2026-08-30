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

  it("does not re-run external-source reconciliation for unrelated renders", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const receiveExternalSource = vi.spyOn(ScientCm6EditorView.prototype, "receiveExternalSource");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const shared = {
      source: "# Results\n",
      revision: "r0",
      persist: vi.fn(async () => ({ revision: "r1" })),
      onPendingChange: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
    };

    await act(() => root.render(<ScientCm6SpikeSurface {...shared} ariaLabel="Results" />));
    expect(receiveExternalSource).toHaveBeenCalledOnce();

    await act(() =>
      root.render(
        <ScientCm6SpikeSurface
          {...shared}
          ariaLabel="Renamed results"
          onExternalConflict={vi.fn()}
        />,
      ),
    );

    expect(receiveExternalSource).toHaveBeenCalledOnce();
  });

  it("delegates conflict resolution to the file-level owner with its fresh revision", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const resolveExternalConflict = vi.spyOn(
      ScientCm6EditorView.prototype,
      "resolveExternalConflict",
    );
    const retry = vi.spyOn(MarkdownSaveQueue.prototype, "retry");
    const onSaveResolutionApplied = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const shared = {
      source: "# Local draft\n",
      revision: "r0",
      ariaLabel: "Results",
      persist: vi.fn(async () => ({ revision: "r2" })),
      onPendingChange: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
      onSaveResolutionApplied,
    };

    await act(() => root.render(<ScientCm6SpikeSurface {...shared} />));
    await act(() =>
      root.render(
        <ScientCm6SpikeSurface
          {...shared}
          saveResolution={{ action: "retry", revision: "r-agent" }}
        />,
      ),
    );

    expect(resolveExternalConflict).toHaveBeenCalledExactlyOnceWith("local");
    expect(retry).toHaveBeenCalledExactlyOnceWith("r-agent");
    expect(onSaveResolutionApplied).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("Keep mine");
    expect(host.textContent).not.toContain("Reload from disk");
  });
});
