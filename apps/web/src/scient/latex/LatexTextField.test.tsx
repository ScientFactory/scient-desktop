// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LatexDraftContext, LatexTextField, replaceLatexFieldDraft } from "./LatexTextField";

describe("pending LaTeX field ownership", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const publish = vi.fn();
  const pending = new Set<string>();
  const reportDraft = (id: string, value: boolean) => {
    if (value) pending.add(id);
    else pending.delete(id);
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    publish.mockReset();
    pending.clear();
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = (value = "Original", key = "field-a") =>
    act(() =>
      root.render(
        <LatexDraftContext value={{ reportDraft, undo: () => {} }}>
          <LatexTextField value={value} draftKey={key} onValueChange={publish} />
        </LatexDraftContext>,
      ),
    );
  const field = () => host.querySelector("textarea")!;
  const type = (value: string, isPending = true) =>
    act(() => {
      field().focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        value,
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
      expect(pending.size).toBe(isPending ? 1 : 0);
    });
  const tick = () => act(() => vi.advanceTimersByTime(300));

  it("keeps the original base when an outside value arrives before publication", async () => {
    await render();
    await type("Unfinished");
    await render("External");
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(field().value).toBe("Unfinished");
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("scient.latex.field:field-a")!)).toEqual({
      base: "Original",
      text: "Unfinished",
    });
  });

  it("never sends an old field draft to a replacement owner", async () => {
    await render();
    await type("Unfinished");
    await render("Original", "field-b");
    await tick();
    await act(() => field().blur());
    expect(publish).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem("scient.latex.field:field-b")).toBeNull();
    expect(JSON.parse(localStorage.getItem("scient.latex.field:field-a")!)).toEqual({
      base: "Original",
      text: "Unfinished",
    });
  });

  it("reports composition synchronously and does not publish unfinished IME on blur", async () => {
    await render();
    await act(() => {
      field().focus();
      field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(pending.size).toBe(1);
    });
    await type("שלום");
    await act(() => field().blur());
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(pending.size).toBe(1);
    await act(() =>
      field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await tick();
    expect(publish).toHaveBeenCalledExactlyOnceWith("שלום");
  });

  it("acknowledges accepted local text and starts the next draft on that base", async () => {
    await render();
    await type("First");
    await tick();
    expect(publish).toHaveBeenCalledExactlyOnceWith("First");
    await render("First");
    expect(pending.size).toBe(0);
    await type("Second");
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem("scient.latex.field:field-a")!)).toEqual({
      base: "First",
      text: "Second",
    });
  });

  it("retires a canceled draft without publishing it", async () => {
    await render();
    await type("Unfinished");
    window.dispatchEvent(new Event("pagehide"));
    await type("Original", false);
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(localStorage.getItem("scient.latex.field:field-a")).toBeNull();
  });

  it("stops reporting unfinished input once a grouped edit replaces the field's text", async () => {
    await render();
    await type("Unfinished");
    // A row cleared from another cell replaces this cell's text.
    await act(() => replaceLatexFieldDraft(field(), ""));
    expect(field().value).toBe("");
    expect(pending.size).toBe(0);
    await tick();
    expect(publish).not.toHaveBeenCalled();
    expect(localStorage.getItem("scient.latex.field:field-a")).toBeNull();
  });

  it("stops reporting a restored draft once a grouped edit replaces it", async () => {
    localStorage.setItem("scient.latex.field:field-a", '{"base":"Original","text":"Restored"}');
    await render();
    expect(field().value).toBe("Restored");
    expect(pending.size).toBe(1);
    await act(() => replaceLatexFieldDraft(field(), ""));
    expect(pending.size).toBe(0);
  });

  it("edits fields that do not have a recovery key", async () => {
    await act(() => root.render(<LatexTextField value="Original" onValueChange={publish} />));
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        "Updated",
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();
    expect(publish).toHaveBeenCalledExactlyOnceWith("Updated");
  });
});
