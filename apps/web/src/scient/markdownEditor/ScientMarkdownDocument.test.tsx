// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientMarkdownDocument } from "./ScientMarkdownDocument";
import { ScientMarkdownEditorView } from "./prosemirror/view";

describe("ScientMarkdownDocument", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await act(() => root.unmount());
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function renderDocument() {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    return { host, root };
  }

  it("keeps the rendered document DOM while activating and deactivating editing", async () => {
    const { host, root } = renderDocument();
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Results\n\n- one\n  - nested\n",
      revision: "sha256:one",
      mode: "read",
      ariaLabel: "Results document",
      onUserSourceChange,
    });
    await act(() => root.render(<ScientMarkdownDocument controller={controller} mode="read" />));
    const proseMirror = host.querySelector(".ProseMirror");
    const heading = proseMirror?.querySelector("h1");

    await act(() => root.render(<ScientMarkdownDocument controller={controller} mode="write" />));
    expect(host.querySelector(".ProseMirror")).toBe(proseMirror);
    expect(host.querySelector("h1")).toBe(heading);
    expect(proseMirror?.getAttribute("contenteditable")).toBe("true");

    await act(() => root.render(<ScientMarkdownDocument controller={controller} mode="read" />));
    expect(host.querySelector(".ProseMirror")).toBe(proseMirror);
    expect(proseMirror?.getAttribute("contenteditable")).toBe("false");
    expect(onUserSourceChange).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("leaves controller lifetime with the owning workspace", async () => {
    const { root } = renderDocument();
    const controller = new ScientMarkdownEditorView({
      source: "# Before\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Agent-edited document",
      onUserSourceChange: vi.fn(),
    });
    const destroy = vi.spyOn(controller, "destroy");
    await act(() => root.render(<ScientMarkdownDocument controller={controller} mode="write" />));

    roots.pop();
    await act(() => root.unmount());
    expect(destroy).not.toHaveBeenCalled();
    controller.destroy();
  });
});
