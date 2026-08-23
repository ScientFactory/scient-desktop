// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientMarkdownWorkspaceSurface } from "./ScientMarkdownWorkspaceSurface";

describe("ScientMarkdownWorkspaceSurface", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await act(() => root.unmount());
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("keeps the rich document mounted and loads source mode only when requested", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const persist = vi.fn(async () => ({ revision: "unexpected" }));
    const callbacks = {
      persist,
      onPendingChange: vi.fn(),
      onSaveConfirmed: vi.fn(),
      onSaveFailure: vi.fn(),
      onExternalConflict: vi.fn(),
    };

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...callbacks}
          source={"# Results\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"}
          revision="r0"
          mode="read"
          ariaLabel="Results"
        />,
      ),
    );
    const richDocument = host.querySelector(".ProseMirror");
    expect(richDocument?.querySelector("table")).not.toBeNull();
    expect(host.querySelector(".cm-editor")).toBeNull();

    await import("./source/ScientMarkdownSourceDocument");
    await act(async () => {
      root.render(
        <ScientMarkdownWorkspaceSurface
          {...callbacks}
          source={"# Results\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"}
          revision="r0"
          mode="split"
          ariaLabel="Results"
        />,
      );
    });
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    expect(host.querySelector(".ProseMirror")).toBe(richDocument);
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    expect(host.querySelector("[aria-label='Document actions']")).not.toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });
});
