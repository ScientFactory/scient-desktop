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

  it("mounts one always-editable rich document with no source pane", async () => {
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
          ariaLabel="Results"
        />,
      ),
    );
    const richDocument = host.querySelector(".ProseMirror");
    expect(richDocument?.querySelector("table")).not.toBeNull();
    expect(richDocument?.getAttribute("contenteditable")).toBe("true");
    expect(host.querySelector(".cm-editor")).toBeNull();
    // The dock is always present but starts collapsed: only the handle shows.
    expect(host.querySelector("[aria-label='Document actions']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Show formatting tools']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Bold (Cmd+B)']")).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("expands the collapsed editing controls from the handle", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    await act(() =>
      root.render(
        <ScientMarkdownWorkspaceSurface
          source={"# Results\n"}
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

    expect(host.querySelector(".ProseMirror")).not.toBeNull();
    const handle = host.querySelector<HTMLButtonElement>("[aria-label='Show formatting tools']");
    expect(handle).not.toBeNull();
    expect(host.querySelector("[aria-label='Bold (Cmd+B)']")).toBeNull();

    await act(() => handle!.click());

    expect(host.querySelector("[aria-label='Bold (Cmd+B)']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Hide formatting tools']")).not.toBeNull();
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
          ariaLabel="Find fixture"
          persist={vi.fn(async () => ({ revision: "r1" }))}
          onPendingChange={vi.fn()}
          onSaveConfirmed={vi.fn()}
          onSaveFailure={vi.fn()}
          onExternalConflict={vi.fn()}
        />,
      ),
    );

    const editor = host.querySelector(".ProseMirror");
    expect(editor).not.toBeNull();
    await act(() =>
      editor!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    const richPane = host.querySelector(".scient-markdown-rich-pane");
    const findBar = host.querySelector(".scient-markdown-find-bar");
    expect(findBar).not.toBeNull();
    expect(findBar?.parentElement).toBe(richPane);
    expect(host.querySelector(".scient-markdown-find-popover")).toBeNull();
  });
});
