// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientFileFreshnessNotices } from "../../fileSurfaces/ScientFileFreshnessControls";
import { ScientMarkdownSaveStatus } from "./ScientMarkdownSaveStatus";

describe("Scient Markdown save feedback", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await act(() => root.unmount());
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function mount(node: ReactNode): HTMLElement {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(node));
    return host;
  }

  it("announces the exact persisted state", () => {
    const host = mount(<ScientMarkdownSaveStatus status="saved" />);
    expect(host.querySelector("[role='status']")?.textContent).toContain("Saved");
    expect(host.querySelector("[data-scient-markdown-save-status='saved']")).not.toBeNull();
  });

  it("keeps a failed local edit visible and gives it explicit recovery actions", () => {
    const onReload = vi.fn();
    const onRetrySave = vi.fn();
    const host = mount(
      <ScientFileFreshnessNotices
        relativePath="notes/results.md"
        notice={null}
        readError={null}
        saveError={{
          relativePath: "notes/results.md",
          message: "Disk is full.",
        }}
        hasFallbackData
        onCancel={vi.fn()}
        onReload={onReload}
        onRequestOverwrite={vi.fn()}
        onRetrySave={onRetrySave}
        onResolve={vi.fn()}
      />,
    );

    expect(host.querySelector("[role='alert']")?.textContent).toContain(
      "Changes are still local and have not been saved. Disk is full.",
    );
    const buttons = [...host.querySelectorAll("button")];
    act(() => buttons.find((button) => button.textContent === "Retry save")?.click());
    expect(onRetrySave).toHaveBeenCalledOnce();
    act(() => buttons.find((button) => button.textContent === "Reload…")?.click());
    expect(onReload).toHaveBeenCalledOnce();
  });
});
