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
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function mount(node: ReactNode): HTMLElement {
    return mountWithRerender(node).host;
  }

  function mountWithRerender(node: ReactNode): {
    readonly host: HTMLElement;
    readonly rerender: (nextNode: ReactNode) => void;
  } {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(node));
    return {
      host,
      rerender: (nextNode) => act(() => root.render(nextNode)),
    };
  }

  it("announces a successful save without adding persistent header chrome", () => {
    const host = mount(<ScientMarkdownSaveStatus status="saved" />);
    expect(host.querySelector("[role='status']")?.textContent).toContain("Saved");
    expect(host.querySelector("[data-scient-markdown-save-status='saved']")).not.toBeNull();
    expect(host.querySelector("[data-scient-markdown-visible-save-status]")).toBeNull();
    expect(host.querySelector("svg")).toBeNull();
  });

  it("shows delayed saving text without adding a second spinner", () => {
    vi.useFakeTimers();
    const host = mount(<ScientMarkdownSaveStatus status="saving" />);

    expect(host.querySelector("[role='status']")?.textContent).toContain("Saving…");
    expect(host.querySelector("[data-scient-markdown-visible-save-status]")).toBeNull();
    expect(host.querySelector("svg")).toBeNull();

    act(() => vi.advanceTimersByTime(2_999));
    expect(host.querySelector("[data-scient-markdown-visible-save-status]")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(
      host.querySelector("[data-scient-markdown-visible-save-status='saving']")?.textContent,
    ).toBe("Saving…");
    expect(host.querySelector("svg")).toBeNull();
  });

  it("cancels the delayed saving text when the save settles", () => {
    vi.useFakeTimers();
    const { host, rerender } = mountWithRerender(<ScientMarkdownSaveStatus status="saving" />);

    act(() => vi.advanceTimersByTime(1_500));
    rerender(<ScientMarkdownSaveStatus status="saved" />);
    act(() => vi.advanceTimersByTime(1_500));

    expect(host.querySelector("[data-scient-markdown-visible-save-status]")).toBeNull();
    expect(host.querySelector("[role='status']")?.textContent).toContain("Saved");
  });

  it.each(["unsaved", "failed", "conflict"] as const)(
    "keeps the %s state visibly actionable",
    (status) => {
      const host = mount(<ScientMarkdownSaveStatus status={status} />);
      expect(host.querySelector(`[data-scient-markdown-visible-save-status='${status}']`)).not.toBe(
        null,
      );
      expect(host.querySelector(".lucide-circle-alert")).not.toBeNull();
    },
  );

  it("leaves loading to the existing file reload indicator", () => {
    const host = mount(<ScientMarkdownSaveStatus status="loading" />);
    expect(host.querySelector("[role='status']")?.textContent).toContain("Loading");
    expect(host.querySelector("[data-scient-markdown-visible-save-status]")).toBeNull();
    expect(host.querySelector("svg")).toBeNull();
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
        saveRetryReady
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

  it("holds conflict actions until the matching disk bytes are loaded", () => {
    const onRequestOverwrite = vi.fn();
    const onResolve = vi.fn();
    const host = mount(
      <ScientFileFreshnessNotices
        relativePath="notes/results.md"
        notice={{
          kind: "external-change",
          relativePath: "notes/results.md",
          contents: null,
          revision: "r2",
        }}
        readError={null}
        saveError={null}
        saveRetryReady={false}
        hasFallbackData
        onCancel={vi.fn()}
        onReload={vi.fn()}
        onRequestOverwrite={onRequestOverwrite}
        onRetrySave={vi.fn()}
        onResolve={onResolve}
      />,
    );

    const buttons = [...host.querySelectorAll("button")];
    const useMine = buttons.find((button) => button.textContent === "Use my edits");
    const reload = buttons.find((button) => button.textContent === "Reload from disk");
    expect(useMine?.disabled).toBe(true);
    expect(reload?.disabled).toBe(true);
    act(() => useMine?.click());
    act(() => reload?.click());
    expect(onRequestOverwrite).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("enables conflict recovery only with one complete disk snapshot", () => {
    const onRequestOverwrite = vi.fn();
    const onResolve = vi.fn();
    const host = mount(
      <ScientFileFreshnessNotices
        relativePath="notes/results.md"
        notice={{
          kind: "external-change",
          relativePath: "notes/results.md",
          contents: "External contents",
          revision: "r2",
        }}
        readError={null}
        saveError={null}
        saveRetryReady
        hasFallbackData
        onCancel={vi.fn()}
        onReload={vi.fn()}
        onRequestOverwrite={onRequestOverwrite}
        onRetrySave={vi.fn()}
        onResolve={onResolve}
      />,
    );

    const buttons = [...host.querySelectorAll("button")];
    const useMine = buttons.find((button) => button.textContent === "Use my edits");
    const reload = buttons.find((button) => button.textContent === "Reload from disk");
    expect(useMine?.disabled).toBe(false);
    expect(reload?.disabled).toBe(false);
    act(() => useMine?.click());
    act(() => reload?.click());
    expect(onRequestOverwrite).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledExactlyOnceWith("discard");
  });
});
