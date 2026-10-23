import { render as _fixtureRender, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  useParams: () => null,
}));

import { ToastProvider, toastManager, stackedThreadToast } from "./toast";

it("opts into a full-width body and shared action row without changing other stacked toasts", async () => {
  await using _fixture = _createFixture();

  const container = document.createElement("div");
  document.body.append(container);
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: container, router: false }),
  );
  const ids: Array<ReturnType<typeof toastManager.add>> = [];
  try {
    await act(async () => await root.rerender(<ToastProvider />));
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
    expect(originalTitle.parentElement!.nextElementSibling?.textContent).toBe(
      "Original description",
    );
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
    await act(async () => await root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
