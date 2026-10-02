// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DocumentReaderControls, DocumentSearchBar } from "../writing/DocumentReaderControls";

describe("shared PDF and Visual controls", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const render = (props: Partial<ComponentProps<typeof DocumentReaderControls>> = {}) =>
    act(() =>
      root.render(
        <DocumentReaderControls
          label="Document"
          ready
          page={1}
          pageCount={3}
          scale={1}
          sidebarOpen={false}
          searchOpen={false}
          onPage={vi.fn()}
          onZoom={vi.fn()}
          onActualSize={vi.fn()}
          onFitWidth={vi.fn()}
          onToggleSidebar={vi.fn()}
          onToggleSearch={vi.fn()}
          onShowSearch={vi.fn()}
          shortcutLabel={() => ""}
          {...props}
        />,
      ),
    );
  const click = (label: string) =>
    act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  const enterPage = async (value: string) => {
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Page number"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
  };
  it("shares PDF zoom stepping, limits, percentage reset and fit width", async () => {
    const onZoom = vi.fn(),
      onActualSize = vi.fn(),
      onFitWidth = vi.fn();
    await render({ scale: 0.96, onZoom, onActualSize, onFitWidth });
    await click("Zoom in");
    expect(onZoom).toHaveBeenLastCalledWith(1);
    await click("Zoom out");
    expect(onZoom).toHaveBeenLastCalledWith(0.95);
    await act(() => host.querySelector<HTMLButtonElement>(".scient-pdf-zoom-label")!.click());
    expect(onActualSize).toHaveBeenCalledOnce();
    expect(host.querySelector('input[aria-label="Document zoom percentage"]')).toBeNull();
    await click("Fit width");
    expect(onFitWidth).toHaveBeenCalledOnce();
    await render({ scale: 5, onZoom });
    await click("Zoom in");
    expect(onZoom).toHaveBeenLastCalledWith(5);
    await render({ scale: 0.25, onZoom });
    await click("Zoom out");
    expect(onZoom).toHaveBeenLastCalledWith(0.25);
  });
  it("shares PDF page navigation and validation", async () => {
    const onPage = vi.fn();
    await render({ page: 2, onPage });
    await click("Previous page");
    expect(onPage).toHaveBeenLastCalledWith(1);
    await click("Next page");
    expect(onPage).toHaveBeenLastCalledWith(3);
    await enterPage(" 3 ");
    expect(onPage).toHaveBeenLastCalledWith(3);
    onPage.mockClear();
    for (const invalid of ["0", "4", "1.5", "other"]) await enterPage(invalid);
    expect(onPage).not.toHaveBeenCalled();
    await render({ page: 1 });
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')!.disabled,
    ).toBe(true);
    await render({ page: 3 });
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.disabled).toBe(
      true,
    );
  });
  it("shares search focus, counts, keyboard navigation and Escape", async () => {
    const onNavigate = vi.fn(),
      onClose = vi.fn();
    await act(() =>
      root.render(
        <DocumentSearchBar
          label="Search this document"
          query="heat"
          current={1}
          total={2}
          notFound={false}
          onQuery={vi.fn()}
          onNavigate={onNavigate}
          onClose={onClose}
        />,
      ),
    );
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(host.textContent).toContain("1 of 2");
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      ),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(true);
    await act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(false);
    await act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});
