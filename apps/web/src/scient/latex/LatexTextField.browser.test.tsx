import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { LatexDraftContext, LatexTextField, replaceLatexFieldDraft } from "./LatexTextField";

describe("pending LaTeX field ownership", () => {
  const publish = vi.fn();
  const pending = new Set<string>();
  const reportDraft = (id: string, value: boolean) => {
    if (value) pending.add(id);
    else pending.delete(id);
  };
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());
    publish.mockReset();
    pending.clear();
    localStorage.clear();
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
  const render = async (
    _fixture: _Fixture,
    value = "Original",
    key = "field-a",
    commitOn: "idle" | "blur" = "idle",
  ) =>
    await act(
      async () =>
        await _fixture.root0.rerender(
          <LatexDraftContext value={{ reportDraft, undo: () => {} }}>
            <LatexTextField
              value={value}
              draftKey={key}
              onValueChange={publish}
              commitOn={commitOn}
            />
          </LatexDraftContext>,
        ),
    );
  const field = (_fixture: _Fixture) => _fixture.host.querySelector("textarea")!;
  const type = async (_fixture: _Fixture, value: string, isPending = true) =>
    await act(() => {
      field(_fixture).focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(_fixture),
        value,
      );
      field(_fixture).dispatchEvent(new Event("input", { bubbles: true }));
      expect(pending.size).toBe(isPending ? 1 : 0);
    });
  const tick = async () => await act(() => vi.advanceTimersByTime(300));

  it("holds explicit field edits until Enter or blur and clears the acknowledged draft", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "Original", "field-a", "blur");
    await type(_fixture, "Renamed");
    await tick();
    expect(publish).not.toHaveBeenCalled();
    await act(() =>
      field(_fixture).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(publish).toHaveBeenLastCalledWith("Renamed", expect.any(String));
    await render(_fixture, "Renamed", "field-a", "blur");
    expect(pending.size).toBe(0);
    await type(_fixture, "Another");
    await act(() => field(_fixture).blur());
    expect(publish).toHaveBeenLastCalledWith("Another", expect.any(String));
  });

  it("keeps the original base when an outside value arrives before publication", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await type(_fixture, "Unfinished");
    await render(_fixture, "External");
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(field(_fixture).value).toBe("Unfinished");
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("scient.latex.field:field-a")!)).toEqual({
      base: "Original",
      text: "Unfinished",
    });
  });

  it("never sends an old field draft to a replacement owner", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await type(_fixture, "Unfinished");
    await render(_fixture, "Original", "field-b");
    await tick();
    await act(() => field(_fixture).blur());
    expect(publish).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem("scient.latex.field:field-b")).toBeNull();
    expect(JSON.parse(localStorage.getItem("scient.latex.field:field-a")!)).toEqual({
      base: "Original",
      text: "Unfinished",
    });
  });

  it("reports composition synchronously and does not publish unfinished IME on blur", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(() => {
      field(_fixture).focus();
      field(_fixture).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(pending.size).toBe(1);
    });
    await type(_fixture, "שלום");
    await act(() => field(_fixture).blur());
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(pending.size).toBe(1);
    await act(() =>
      field(_fixture).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await tick();
    expect(publish).toHaveBeenCalledExactlyOnceWith("שלום");
  });

  it("acknowledges accepted local text and starts the next draft on that base", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await type(_fixture, "First");
    await tick();
    expect(publish).toHaveBeenCalledExactlyOnceWith("First");
    await render(_fixture, "First");
    expect(pending.size).toBe(0);
    await type(_fixture, "Second");
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("scient.latex.field:field-a")!)).toEqual({
      base: "First",
      text: "Second",
    });
  });

  it("retires a canceled draft without publishing it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await type(_fixture, "Unfinished");
    window.dispatchEvent(new Event("pagehide"));
    await type(_fixture, "Original", false);
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(localStorage.getItem("scient.latex.field:field-a")).toBeNull();
  });

  it("stops reporting unfinished input once a grouped edit replaces the field's text", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await type(_fixture, "Unfinished");
    // A row cleared from another cell replaces this cell's text.
    await act(() => replaceLatexFieldDraft(field(_fixture), ""));
    expect(field(_fixture).value).toBe("");
    expect(pending.size).toBe(0);
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(localStorage.getItem("scient.latex.field:field-a")).toBeNull();
  });

  it("stops reporting a restored draft once a grouped edit replaces it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    localStorage.setItem("scient.latex.field:field-a", '{"base":"Original","text":"Restored"}');
    await render(_fixture);
    expect(field(_fixture).value).toBe("Restored");
    expect(pending.size).toBe(1);
    await act(() => replaceLatexFieldDraft(field(_fixture), ""));
    expect(pending.size).toBe(0);
  });

  it("edits fields that do not have a recovery key", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(
      async () =>
        await _fixture.root0.rerender(<LatexTextField value="Original" onValueChange={publish} />),
    );
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(_fixture),
        "Updated",
      );
      field(_fixture).dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();
    expect(publish).toHaveBeenCalledExactlyOnceWith("Updated");
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
