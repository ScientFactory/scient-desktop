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

  it("opens find as a bounded row in document flow instead of a clipped popover", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source="Find this text.\n"
          revision="r0"
          mode="read"
          ariaLabel="Find fixture"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );

    const findButton = host.querySelector<HTMLButtonElement>("[aria-label='Find in document']");
    expect(findButton).not.toBeNull();
    await act(() => findButton!.click());

    const richPane = host.querySelector(".scient-markdown-rich-pane");
    const findBar = host.querySelector(".scient-markdown-find-bar");
    expect(findBar?.parentElement).toBe(richPane);
    expect(host.querySelector(".scient-markdown-find-popover")).toBeNull();
    expect(findBar?.querySelector("[aria-label='Find text']")).toBe(document.activeElement);
  });
});
