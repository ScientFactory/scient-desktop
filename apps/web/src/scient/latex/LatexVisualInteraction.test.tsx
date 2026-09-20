// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off -- Real hashing in a DOM-only component test, no browser automation.
import * as NodeCrypto from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LatexVisualInteraction, type LatexVisualInteractionProps } from "./LatexVisualInteraction";
import { clearVisualDraft } from "./visualDrafts";

const source = "\\documentclass{article}\n\\begin{document}\nHello from Scient.\n\\end{document}\n";
let root: Root;
let mount: HTMLDivElement;
let pdf: HTMLDivElement;
let span: HTMLSpanElement;
let props: LatexVisualInteractionProps;
const edit = vi.fn<(expected: string, next: string) => boolean>();
const locate = vi.fn<(point: unknown) => Promise<number | string>>();

async function render() {
  await act(() => root.render(<LatexVisualInteraction {...props} />));
}
async function settleHash() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function click() {
  await act(async () =>
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 35, clientY: 10 })),
  );
}
function textarea() {
  return mount.querySelector<HTMLTextAreaElement>(".scient-latex-visual-input")!;
}
async function type(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea(),
      value,
    );
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", NodeCrypto.webcrypto);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    return new DOMRect(this.startOffset * 7, 10, 7, 12);
  });
  edit.mockReset().mockReturnValue(true);
  locate.mockReset().mockResolvedValue(3);
  mount = document.createElement("div");
  pdf = document.createElement("div");
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  const layer = document.createElement("div");
  layer.className = "textLayer";
  span = document.createElement("span");
  span.textContent = "Hello from Scient.";
  layer.append(span);
  page.append(layer);
  pdf.append(page);
  document.body.append(pdf, mount);
  root = createRoot(mount);
  props = {
    draftKey: "test-document",
    host: {
      revisionId: "pdf-one",
      container: pdf,
      ready: true,
      pointFromClient: () => ({ page: 1, x: 35, y: 10 }),
    },
    source,
    sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(source).digest("hex")}`,
    ready: true,
    revisionId: "pdf-one",
    locate,
    onEdit: edit,
  };
  await render();
  await settleHash();
});
afterEach(async () => {
  clearVisualDraft("test-document");
  await act(() => root.unmount());
  mount.remove();
  pdf.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("exact-output visual interaction", () => {
  it("keeps the caret and focused input while a replacement PDF is being authorized", async () => {
    await click();
    const caret = mount.querySelector<HTMLElement>(".scient-latex-visual-caret");
    expect(caret).not.toBeNull();
    const top = caret!.style.top;
    props = { ...props, host: { ...props.host, ready: false } };
    await render();
    expect(mount.querySelector<HTMLElement>(".scient-latex-visual-caret")?.style.top).toBe(top);
    expect(document.activeElement).toBe(textarea());
    await type("Hello from smoothly edited Scient.");
    expect(mount.querySelector(".scient-latex-visual-caret")).not.toBeNull();
  });
  it("retains unqualified input across a mode or tab unmount", async () => {
    locate.mockImplementation(() => new Promise(() => {}));
    await click();
    await type("Do not lose this draft");
    await act(() => root.unmount());
    root = createRoot(mount);
    await render();
    expect(
      mount.querySelector<HTMLTextAreaElement>('[aria-label="Recover unapplied visual text"]')
        ?.value,
    ).toBe("Do not lose this draft");
  });
  it("buffers rapid typing while navigation is pending and writes only after qualification", async () => {
    let resolve!: (line: number) => void;
    locate.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await click();
    expect(document.activeElement).toBe(textarea());
    await type("Rapid early input");
    expect(edit).not.toHaveBeenCalled();
    await act(() => resolve(3));
    expect(edit).toHaveBeenCalledWith(
      source,
      source.replace("Hello from Scient.", "Rapid early input"),
    );
  });
  it("preserves early input for recovery when mapping is refused", async () => {
    let resolve!: (reason: string) => void;
    locate.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await click();
    await type("Keep these words");
    await act(() => resolve("Mapping unavailable"));
    expect(edit).not.toHaveBeenCalled();
    expect(
      mount.querySelector<HTMLTextAreaElement>('[aria-label="Recover unapplied visual text"]')
        ?.value,
    ).toBe("Keep these words");
  });
  it("refuses the retained old text layer and rotated pages", async () => {
    props = { ...props, host: { ...props.host, revisionId: "older-pdf" } };
    await render();
    await click();
    expect(locate).not.toHaveBeenCalled();
    props = { ...props, host: { ...props.host, revisionId: "pdf-one", rotation: 90 } };
    await render();
    await click();
    expect(locate).not.toHaveBeenCalled();
    expect(mount.textContent).toContain("upright");
  });
  it("does not reuse an active transaction after an external source replacement", async () => {
    await click();
    props = { ...props, source: source.replace("Scient", "external") };
    await render();
    await type("Unrelated edit");
    expect(edit).not.toHaveBeenCalled();
  });
  it("clicks through SyncTeX, edits only source, and never substitutes page text", async () => {
    await click();
    expect(document.activeElement).toBe(textarea());
    expect(textarea().value).toBe("Hello from Scient.");
    await type("Hello from Science.");
    expect(edit).toHaveBeenCalledWith(source, source.replace("Scient.", "Science."));
    expect(span.textContent).toBe("Hello from Scient.");
    expect(mount.querySelector("canvas, .textLayer, [contenteditable]")).toBeNull();
  });
  it("rejects clicks against an old PDF even when the source is already saved", async () => {
    props = { ...props, source: source.replace("Scient", "Changed") };
    await render();
    await settleHash();
    await click();
    expect(locate).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });
  it("rejects superseded asynchronous navigation", async () => {
    let resolve!: (line: number) => void;
    locate.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await click();
    props = { ...props, revisionId: "pdf-two" };
    await render();
    await act(() => resolve(3));
    expect(mount.textContent).toContain("changed during lookup");
    expect(edit).not.toHaveBeenCalled();
  });
  it("does not persist partial IME composition", async () => {
    await click();
    await act(() =>
      textarea().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    );
    await type("Hello from 日本.");
    expect(edit).not.toHaveBeenCalled();
    await act(() =>
      textarea().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    expect(edit).toHaveBeenCalledTimes(1);
  });
  it("refuses a concurrent buffer replacement instead of clobbering it", async () => {
    await click();
    edit.mockReturnValue(false);
    await type("Lost edit");
    expect(mount.textContent).toContain("not applied");
    await type("Another edit");
    expect(edit).toHaveBeenCalledTimes(1);
  });
  it("keeps ambiguous regions read-only and preserves their PDF text", async () => {
    locate.mockResolvedValue("No reliable source mapping");
    await click();
    await type("wrong");
    expect(edit).not.toHaveBeenCalled();
    expect(span.textContent).toBe("Hello from Scient.");
  });
});
