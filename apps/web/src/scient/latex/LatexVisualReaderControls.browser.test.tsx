import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ComponentProps } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { DocumentReaderControls, ReaderSearchField } from "../writing/DocumentReaderControls";

describe("shared PDF and Visual controls", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.unstubAllGlobals();
  }
  const render = async (
    _fixture: _Fixture,
    props: Partial<ComponentProps<typeof DocumentReaderControls>> = {},
  ) =>
    await act(
      async () =>
        await _fixture.root0.rerender(
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
  const click = async (_fixture: _Fixture, label: string) =>
    await act(() =>
      _fixture.host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
    );
  const enterPage = async (_fixture: _Fixture, value: string) => {
    const field = _fixture.host.querySelector<HTMLInputElement>('input[aria-label="Page number"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
  };
  it("shares PDF zoom stepping, limits, and a percentage that fits the width", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onZoom = vi.fn();
    const onActualSize = vi.fn();
    const onFitWidth = vi.fn();
    await render(_fixture, { scale: 0.96, onZoom, onActualSize, onFitWidth });
    await click(_fixture, "Zoom in");
    expect(onZoom).toHaveBeenLastCalledWith(1);
    await click(_fixture, "Zoom out");
    expect(onZoom).toHaveBeenLastCalledWith(0.95);
    await act(() =>
      _fixture.host.querySelector<HTMLButtonElement>(".scient-pdf-zoom-label")!.click(),
    );
    expect(onFitWidth).toHaveBeenCalledOnce();
    expect(onActualSize).not.toHaveBeenCalled();
    expect(_fixture.host.querySelector('input[aria-label="Document zoom percentage"]')).toBeNull();
    // There is no separate Fit width button.
    expect(_fixture.host.querySelector(".scient-pdf-action-fit")).toBeNull();
    await render(_fixture, { scale: 5, onZoom });
    await click(_fixture, "Zoom in");
    expect(onZoom).toHaveBeenLastCalledWith(5);
    await render(_fixture, { scale: 0.25, onZoom });
    await click(_fixture, "Zoom out");
    expect(onZoom).toHaveBeenLastCalledWith(0.25);
  });
  it("shares PDF page navigation and validation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onPage = vi.fn();
    await render(_fixture, { page: 2, onPage });
    await click(_fixture, "Previous page");
    expect(onPage).toHaveBeenLastCalledWith(1);
    await click(_fixture, "Next page");
    expect(onPage).toHaveBeenLastCalledWith(3);
    await enterPage(_fixture, " 3 ");
    expect(onPage).toHaveBeenLastCalledWith(3);
    onPage.mockClear();
    for (const invalid of ["0", "4", "1.5", "other"]) await enterPage(_fixture, invalid);
    expect(onPage).not.toHaveBeenCalled();
    await render(_fixture, { page: 1 });
    expect(
      _fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')!
        .disabled,
    ).toBe(true);
    await render(_fixture, { page: 3 });
    expect(
      _fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.disabled,
    ).toBe(true);
  });
  it("searches in a quiet field: focus on request, count, arrows, keys and Escape", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onNavigate = vi.fn();
    const onClear = vi.fn();
    const onQuery = vi.fn();
    const field = (query: string, focusRequest: number) => (
      <ReaderSearchField
        label="Document"
        query={query}
        current={query ? 1 : 0}
        total={query ? 2 : 0}
        notFound={false}
        focusRequest={focusRequest}
        onQuery={onQuery}
        onNavigate={onNavigate}
        onClear={onClear}
      />
    );
    await act(async () => await _fixture.root0.rerender(field("", 0)));
    const input = _fixture.host.querySelector<HTMLInputElement>(
      'input[aria-label="Search Document"]',
    )!;
    expect(input.placeholder).toBe("Search");
    // At rest: no count and no arrows, and focus stays where it was.
    expect(_fixture.host.querySelector('button[aria-label="Next result"]')).toBeNull();
    expect(document.activeElement).not.toBe(input);
    await act(async () => await _fixture.root0.rerender(field("", 1)));
    expect(document.activeElement).toBe(input);
    await act(async () => await _fixture.root0.rerender(field("heat", 1)));
    expect(_fixture.host.textContent).toContain("1/2");
    expect(_fixture.host.querySelector('button[aria-label="Next result"]')).not.toBeNull();
    await act(() =>
      _fixture.host
        .querySelector<HTMLButtonElement>('button[aria-label="Previous result"]')!
        .click(),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(true);
    await act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(false);
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      ),
    );
    expect(onNavigate).toHaveBeenLastCalledWith(true);
    await act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onClear).toHaveBeenCalledOnce();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
