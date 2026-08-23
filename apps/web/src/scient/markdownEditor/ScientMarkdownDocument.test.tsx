// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientMarkdownDocument } from "./ScientMarkdownDocument";

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
    const onUserSourceChange = vi.fn();
    return { host, onUserSourceChange, root };
  }

  it("keeps the rendered document DOM while activating and deactivating editing", async () => {
    const { host, onUserSourceChange, root } = renderDocument();
    const common = {
      source: "# Results\n\n- one\n  - nested\n",
      revision: "sha256:one",
      ariaLabel: "Results document",
      onUserSourceChange,
    } as const;
    await act(() => root.render(<ScientMarkdownDocument {...common} mode="read" />));
    const proseMirror = host.querySelector(".ProseMirror");
    const heading = proseMirror?.querySelector("h1");

    await act(() => root.render(<ScientMarkdownDocument {...common} mode="write" />));
    expect(host.querySelector(".ProseMirror")).toBe(proseMirror);
    expect(host.querySelector("h1")).toBe(heading);
    expect(proseMirror?.getAttribute("contenteditable")).toBe("true");

    await act(() => root.render(<ScientMarkdownDocument {...common} mode="read" />));
    expect(host.querySelector(".ProseMirror")).toBe(proseMirror);
    expect(proseMirror?.getAttribute("contenteditable")).toBe("false");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("adopts a clean agent edit in the same mounted view", async () => {
    const { host, onUserSourceChange, root } = renderDocument();
    const shared = {
      ariaLabel: "Agent-edited document",
      mode: "read" as const,
      onUserSourceChange,
    };
    await act(() =>
      root.render(
        <ScientMarkdownDocument {...shared} source={"# Before\n"} revision="sha256:before" />,
      ),
    );
    const proseMirror = host.querySelector(".ProseMirror");

    await act(() =>
      root.render(
        <ScientMarkdownDocument {...shared} source={"# Agent update\n"} revision="sha256:agent" />,
      ),
    );
    expect(host.querySelector(".ProseMirror")).toBe(proseMirror);
    expect(host.querySelector("h1")?.textContent.trim()).toBe("Agent update");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });
});
