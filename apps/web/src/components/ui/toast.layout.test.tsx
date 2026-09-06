// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));
vi.mock("~/composerDraftStore", () => ({ useComposerDraftStore: () => null }));

import { ToastProvider, toastManager, stackedThreadToast } from "./toast";

it("opts into a full-width body and shared action row without changing other stacked toasts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ids: Array<ReturnType<typeof toastManager.add>> = [];
  try {
    await act(() => root.render(<ToastProvider />));
    await act(() => {
      ids.push(
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Compact notice",
            description: "Full-width description",
            actionProps: { children: "Review in settings" },
            timeout: 0,
            data: {
              fullWidthDescription: true,
              actionLeadingContent: <button type="button">What’s shared?</button>,
            },
          }),
        ),
      );
      ids.push(
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Ordinary notice",
            description: "Original description",
            actionProps: { children: "Settings" },
            timeout: 0,
          }),
        ),
      );
    });
    const titles = [...document.querySelectorAll('[data-slot="toast-title"]')];
    const compactTitle = titles.find((title) => title.textContent === "Compact notice")!;
    const originalTitle = titles.find((title) => title.textContent === "Ordinary notice")!;
    expect(compactTitle).toBeTruthy();
    expect(originalTitle).toBeTruthy();
    expect(compactTitle.parentElement!.querySelector('[data-slot="toast-description"]')).toBeNull();
    expect(
      originalTitle.parentElement!.querySelector('[data-slot="toast-description"]')?.textContent,
    ).toBe("Original description");
    const header = compactTitle.parentElement!.parentElement!;
    expect(header.querySelector('[data-slot="toast-icon"]')).not.toBeNull();
    expect(header.nextElementSibling?.getAttribute("data-slot")).toBe("toast-description");
    const leading = document.querySelector('[data-slot="toast-action-leading"]')!;
    expect(leading.textContent).toBe("What’s shared?");
    expect(leading.parentElement!.querySelector('[data-slot="toast-action"]')?.textContent).toBe(
      "Review in settings",
    );
    expect(document.querySelectorAll('[data-slot="toast-action-leading"]')).toHaveLength(1);
  } finally {
    await act(() => {
      for (const id of ids) toastManager.close(id);
    });
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
