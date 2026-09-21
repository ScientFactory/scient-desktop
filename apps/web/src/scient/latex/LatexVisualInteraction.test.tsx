// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off -- Real hashing in a DOM-only component test.
import * as NodeCrypto from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PdfPresentationAnchor } from "../pdf/pdfPresentation";
import {
  LatexVisualInteraction,
  VISUAL_SOURCE_CHECKPOINT_DELAY_MS,
  type LatexVisualInteractionProps,
} from "./LatexVisualInteraction";
import { clearVisualDraft } from "./visualDrafts";

const source =
  "\\documentclass{article}\n\\begin{document}\nHello from Scient.\n\nSecond editable paragraph.\n\\end{document}\n";
let root: Root;
let mount: HTMLDivElement;
let pdf: HTMLDivElement;
let page: HTMLDivElement;
let first: HTMLSpanElement;
let second: HTMLSpanElement;
let props: LatexVisualInteractionProps;
const edit = vi.fn<(expected: string, next: string) => boolean>();
const editingChange = vi.fn<(editing: boolean) => void>();
let registeredAnchorProvider: (() => PdfPresentationAnchor | null) | null;
let draftBaseRevision: string;

async function render() {
  await act(() => root.render(<LatexVisualInteraction {...props} />));
}

async function settleManifest() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function click(target = first, clientX = 35, clientY = 10) {
  await act(() =>
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX, clientY })),
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

async function checkpoint() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(VISUAL_SOURCE_CHECKPOINT_DELAY_MS);
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", NodeCrypto.webcrypto);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
    return new DOMRect(
      this.startOffset * 7,
      10,
      Math.max(7, (this.endOffset - this.startOffset) * 7),
      12,
    );
  });
  edit.mockReset().mockReturnValue(true);
  editingChange.mockReset();
  registeredAnchorProvider = null;
  draftBaseRevision = "disk-one";
  mount = document.createElement("div");
  pdf = document.createElement("div");
  page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  const layer = document.createElement("div");
  layer.className = "textLayer";
  first = document.createElement("span");
  first.textContent = "Hello from Scient.";
  second = document.createElement("span");
  second.textContent = "Second editable paragraph.";
  layer.append(first, second);
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
      readDocumentTextItems: async () => ({
        revisionId: props.host.revisionId,
        items: Array.from(
          props.host.container?.querySelectorAll(".textLayer span") ?? [],
          (span) => span.textContent ?? "",
        ),
      }),
      pointFromClient: () => ({ page: 1, x: 35, y: 10 }),
      registerAnchorProvider: (provider) => {
        registeredAnchorProvider = provider;
      },
    },
    source,
    fileRevision: "disk-one",
    getDraftBaseRevision: () => draftBaseRevision,
    sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(source).digest("hex")}`,
    ready: true,
    revisionId: "pdf-one",
    onEdit: edit,
    onEditingChange: editingChange,
  };
  await render();
  await settleManifest();
});

afterEach(async () => {
  vi.useRealTimers();
  clearVisualDraft("test-document");
  await act(() => root.unmount());
  mount.remove();
  pdf.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("source-backed PDF visual interaction", () => {
  it("keeps typing local and checkpoints source only after a quiet interval", async () => {
    await click();
    expect(first.classList.contains("scient-latex-visual-editable")).toBe(true);
    expect(document.activeElement).toBe(textarea());
    vi.useFakeTimers();
    await type("Hello from smoothly edited Scient.");
    await type("Hello from very smoothly edited Scient.");
    expect(edit).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(VISUAL_SOURCE_CHECKPOINT_DELAY_MS - 1);
    });
    expect(edit).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(
      source,
      source.replace("Hello from Scient.", "Hello from very smoothly edited Scient."),
    );
    expect(
      JSON.parse(localStorage.getItem("scient:latex-visual-draft:v3:test-document")!),
    ).toMatchObject({
      schemaVersion: 3,
      text: "Hello from very smoothly edited Scient.",
      source: source.replace("Hello from Scient.", "Hello from very smoothly edited Scient."),
      baseRevision: "disk-one",
      checkpoint: { text: "Hello from very smoothly edited Scient." },
    });
  });

  it("keeps journal and Discard identity pinned across an intermediate save confirmation", async () => {
    await click();
    vi.useFakeTimers();
    const firstCheckpoint = source.replace("Hello from Scient.", "First checkpoint.");
    await type("First checkpoint.");
    await checkpoint();

    props = { ...props, source: firstCheckpoint };
    await render();
    const pendingCheckpoint = source.replace("Hello from Scient.", "Pending checkpoint.");
    await type("Pending checkpoint.");
    await checkpoint();

    // The first checkpoint reaches disk while the later checkpoint remains
    // pending. The disk revision advances, but the shared transaction owner
    // deliberately keeps its original Discard identity.
    props = { ...props, source: pendingCheckpoint, fileRevision: "disk-two" };
    await render();
    await type("Continued after intermediate confirmation.");
    expect(
      JSON.parse(localStorage.getItem("scient:latex-visual-draft:v3:test-document")!),
    ).toMatchObject({
      baseRevision: "disk-one",
      source: source.replace("Hello from Scient.", "Continued after intermediate confirmation."),
    });
    await checkpoint();
    expect(
      JSON.parse(localStorage.getItem("scient:latex-visual-draft:v3:test-document")!),
    ).toMatchObject({ baseRevision: "disk-one" });
  });

  it("treats blur and movement between blocks as one uninterrupted session", async () => {
    await click();
    vi.useFakeTimers();
    await type("First paragraph changed.");
    await act(() => {
      second.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      textarea().blur();
    });
    expect(editingChange).toHaveBeenLastCalledWith(true);
    expect(editingChange).not.toHaveBeenCalledWith(false);

    await click(second, 70, 10);
    expect(edit).toHaveBeenCalledOnce();
    expect(textarea().value).toBe("Second editable paragraph.");
    expect(editingChange).not.toHaveBeenCalledWith(false);

    await type("Second paragraph changed.");
    await act(() =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    expect(edit).toHaveBeenCalledTimes(2);
    expect(editingChange).toHaveBeenLastCalledWith(false);
    expect(
      JSON.parse(localStorage.getItem("scient:latex-visual-draft:v3:test-document")!),
    ).toMatchObject({
      source: source
        .replace("Hello from Scient.", "First paragraph changed.")
        .replace("Second editable paragraph.", "Second paragraph changed."),
    });
  });

  it("keeps an earlier block recoverable when the next block is left unchanged", async () => {
    await click();
    await type("First durable paragraph.");
    await click(second, 70, 10);
    await act(() =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    const intendedSource = source.replace("Hello from Scient.", "First durable paragraph.");
    expect(
      JSON.parse(localStorage.getItem("scient:latex-visual-draft:v3:test-document")!),
    ).toMatchObject({ source: intendedSource });

    await act(() => root.unmount());
    root = createRoot(mount);
    await render();
    expect(
      mount.querySelector<HTMLTextAreaElement>('[aria-label="Recover unapplied visual source"]')
        ?.value,
    ).toBe(intendedSource);
  });

  it("maps page whitespace to a nearby proven editable token without a lookup", async () => {
    await act(() =>
      page.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 10 })),
    );
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBeGreaterThan(0);
    expect(mount.querySelector('[role="status"]')).toBeNull();
  });

  it("activates qualified prose from the keyboard and returns focus on Escape", async () => {
    first.firstChild!.textContent = "Hello from Scient.";
    await settleManifest();
    first.focus();
    expect(first.getAttribute("aria-keyshortcuts")).toBe("Enter Space F2");
    await act(() =>
      first.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );

    expect(document.activeElement).toBe(textarea());
    expect(textarea().tabIndex).toBe(0);
    await type("Keyboard-edited prose.");
    await act(() =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );

    expect(edit).toHaveBeenCalledWith(
      source,
      source.replace("Hello from Scient.", "Keyboard-edited prose."),
    );
    expect(document.activeElement).toBe(first);
    expect(textarea().tabIndex).toBe(-1);
  });

  it("keeps unsupported or ambiguous text quietly read-only", async () => {
    const repeated =
      "\\begin{document}\nRepeated prose here.\n\nRepeated prose here.\n\\end{document}\n";
    first.textContent = "Repeated prose here.";
    second.remove();
    props = {
      ...props,
      source: repeated,
      sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(repeated).digest("hex")}`,
      revisionId: "pdf-two",
      host: { ...props.host, revisionId: "pdf-two" },
    };
    await render();
    await settleManifest();
    await click();
    expect(document.activeElement).not.toBe(textarea());
    expect(edit).not.toHaveBeenCalled();
    expect(mount.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps a unique fragment read-only when omitted PDF text leaves its run incomplete", async () => {
    const fragmented = "\\begin{document}\nA unique editable sentence.\n\\end{document}\n";
    first.textContent = "A";
    second.textContent = "unique editable sentence.";
    props = {
      ...props,
      source: fragmented,
      sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(fragmented).digest("hex")}`,
      revisionId: "pdf-fragmented",
      host: { ...props.host, revisionId: "pdf-fragmented" },
    };
    await render();
    await settleManifest();

    expect(second.classList.contains("scient-latex-visual-editable")).toBe(false);
    await click(second);
    expect(document.activeElement).not.toBe(textarea());
    expect(edit).not.toHaveBeenCalled();
  });

  it("does not redirect a click on unsupported text to a nearby editable span", async () => {
    const mixed =
      "\\begin{document}\nRepeated prose. Repeated prose.\n\nUnique editable neighbour.\n\\end{document}\n";
    first.textContent = "Repeated prose.";
    second.textContent = "Unique editable neighbour.";
    props = {
      ...props,
      source: mixed,
      sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(mixed).digest("hex")}`,
      revisionId: "pdf-mixed",
      host: { ...props.host, revisionId: "pdf-mixed" },
    };
    await render();
    await settleManifest();
    await click(first);
    expect(document.activeElement).not.toBe(textarea());
    await click(second);
    expect(document.activeElement).toBe(textarea());
  });

  it("keeps the published old PDF interactive while its successor stages", async () => {
    await click();
    await act(() =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    props = { ...props, revisionId: "pdf-two", ready: false };
    await render();
    await click();
    expect(document.activeElement).toBe(textarea());
  });

  it("retains the completed edit anchor through staging and clears it after the exact swap", async () => {
    await click();
    await type("Hello from anchored Scient.");
    await act(() =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    const nextSource = source.replace("Hello from Scient.", "Hello from anchored Scient.");
    expect(edit).toHaveBeenCalledWith(source, nextSource);
    expect(registeredAnchorProvider?.()).not.toBeNull();

    // Exact C may be requested and staged for several frames while A still
    // owns the painted container. Finishing the edit must not lose its anchor.
    props = {
      ...props,
      source: nextSource,
      sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(nextSource).digest("hex")}`,
      revisionId: "pdf-three",
    };
    await render();
    expect(props.host.revisionId).toBe("pdf-one");
    expect(registeredAnchorProvider?.()).not.toBeNull();

    // Publication has already captured the old-page anchor before exposing C's
    // host identity. The retained transaction can now be released.
    props = { ...props, host: { ...props.host, revisionId: "pdf-three" } };
    await render();
    expect(registeredAnchorProvider?.()).toBeNull();
  });

  it("keeps a re-edit anchor tied to the PDF that is still painted", async () => {
    await click();
    await type("First local edit before publication.");
    await act(() =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    const firstSource = source.replace(
      "Hello from Scient.",
      "First local edit before publication.",
    );

    // The source has advanced to B, but PDF A remains the atomic presentation
    // while B is staging. A second click must rebase the editor without
    // pretending that B's text is already visible on the page.
    props = {
      ...props,
      source: firstSource,
      sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(firstSource).digest("hex")}`,
      ready: false,
      revisionId: "pdf-two",
    };
    await render();
    await settleManifest();
    await click();
    expect(textarea().value).toBe("First local edit before publication.");

    await type("Second local edit before publication.");
    await act(() =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    const secondSource = source.replace(
      "Hello from Scient.",
      "Second local edit before publication.",
    );
    props = {
      ...props,
      source: secondSource,
      sourceRevision: `sha256:${NodeCrypto.createHash("sha256").update(secondSource).digest("hex")}`,
      revisionId: "pdf-three",
    };
    await render();

    expect(edit).toHaveBeenLastCalledWith(firstSource, secondSource);
    expect(props.host.revisionId).toBe("pdf-one");
    expect(registeredAnchorProvider?.()).not.toBeNull();
  });

  it("ignores a queued manifest rebuild from a container replaced before its microtask", async () => {
    const replacementPdf = document.createElement("div");
    const replacementPage = document.createElement("div");
    replacementPage.className = "page";
    replacementPage.dataset.pageNumber = "1";
    const replacementLayer = document.createElement("div");
    replacementLayer.className = "textLayer";
    const replacementSpan = document.createElement("span");
    replacementSpan.textContent = "Hello from Scient.";
    replacementLayer.append(replacementSpan);
    replacementPage.append(replacementLayer);
    replacementPdf.append(replacementPage);
    document.body.append(replacementPdf);

    await act(() => {
      first.firstChild!.textContent = "Hello from Scient.";
      props = {
        ...props,
        host: { ...props.host, container: replacementPdf, revisionId: "pdf-two" },
        revisionId: "pdf-two",
      };
      root.render(<LatexVisualInteraction {...props} />);
    });
    await settleManifest();

    expect(replacementSpan.classList.contains("scient-latex-visual-editable")).toBe(true);
    await click(replacementSpan);
    expect(document.activeElement).toBe(textarea());
    replacementPdf.remove();
  });

  it("never ends editing merely because the native textarea loses focus", async () => {
    await click();
    await act(() => textarea().blur());
    expect(textarea().classList.contains("is-active")).toBe(true);
    expect(editingChange).not.toHaveBeenCalledWith(false);
  });

  it("finishes and checkpoints when the pointer leaves the PDF document", async () => {
    await click();
    vi.useFakeTimers();
    await type("Leave-document checkpoint.");
    await act(() =>
      mount.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true })),
    );
    expect(edit).toHaveBeenCalledOnce();
    expect(editingChange).toHaveBeenLastCalledWith(false);
  });

  it("lets a keyboard or programmatic mode transition finish the transaction", async () => {
    let finish: (() => void) | null = null;
    props = {
      ...props,
      registerFinishEditing: (registered) => {
        finish = registered;
      },
    };
    await render();
    await click();
    vi.useFakeTimers();
    await type("Mode-switch checkpoint.");
    await act(() => finish?.());
    expect(edit).toHaveBeenCalledOnce();
    expect(editingChange).toHaveBeenLastCalledWith(false);
  });

  it("does not checkpoint a partial IME composition", async () => {
    await click();
    vi.useFakeTimers();
    await act(() =>
      textarea().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    );
    await type("Hello from 日本.");
    await checkpoint();
    expect(edit).not.toHaveBeenCalled();
    await act(() =>
      textarea().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await checkpoint();
    expect(edit).toHaveBeenCalledOnce();
  });

  it("retains an IME draft if the session ends before compositionend", async () => {
    await click();
    await act(() =>
      textarea().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    );
    await type("Unfinished 日本");
    await act(() =>
      mount.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true })),
    );
    expect(edit).not.toHaveBeenCalled();
    expect(
      mount.querySelector<HTMLTextAreaElement>('[aria-label="Recover unapplied visual source"]')
        ?.value,
    ).toBe(source.replace("Hello from Scient.", "Unfinished 日本"));
  });

  it("preserves a CAS conflict as durable recovery instead of clobbering source", async () => {
    await click();
    vi.useFakeTimers();
    edit.mockReturnValue(false);
    await type("Conflict-safe text.");
    await checkpoint();
    expect(
      mount.querySelector<HTMLTextAreaElement>('[aria-label="Recover unapplied visual source"]')
        ?.value,
    ).toBe(source.replace("Hello from Scient.", "Conflict-safe text."));
    expect(textarea().classList.contains("is-active")).toBe(false);
    expect(
      JSON.parse(localStorage.getItem("scient:latex-visual-draft:v3:test-document")!),
    ).toMatchObject({
      schemaVersion: 3,
      text: "Conflict-safe text.",
      source: source.replace("Hello from Scient.", "Conflict-safe text."),
    });
  });

  it("retains uncheckpointed input across a mode or tab unmount", async () => {
    await click();
    vi.useFakeTimers();
    await type("Do not lose this draft");
    await act(() => root.unmount());
    root = createRoot(mount);
    await render();
    expect(
      mount.querySelector<HTMLTextAreaElement>('[aria-label="Recover unapplied visual source"]')
        ?.value,
    ).toBe(source.replace("Hello from Scient.", "Do not lose this draft"));
    expect(edit).not.toHaveBeenCalled();
  });

  it("does not authorize a rotated or mismatched PDF and shows no refusal toast", async () => {
    props = { ...props, host: { ...props.host, revisionId: "older-pdf" } };
    await render();
    await click();
    props = { ...props, host: { ...props.host, revisionId: "pdf-one", rotation: 90 } };
    await render();
    await click();
    expect(edit).not.toHaveBeenCalled();
    expect(mount.querySelector('[role="status"]')).toBeNull();
  });

  it("invalidates a session when source changes outside its CAS checkpoints", async () => {
    await click();
    props = { ...props, source: source.replace("Scient", "external") };
    await render();
    expect(textarea().classList.contains("is-active")).toBe(false);
    await type("Unrelated edit");
    expect(edit).not.toHaveBeenCalled();
  });
});
