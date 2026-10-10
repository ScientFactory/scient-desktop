// @vitest-environment happy-dom
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./LatexMathField", () => ({
  LatexMathField: ({ value }: { value: string }) => <span>{value}</span>,
}));
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => (
    <span data-tooltip={typeof content === "string" ? content : undefined}>{children}</span>
  ),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import type { Editor } from "@tiptap/core";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { FileSaveCoordinator } from "~/components/files/fileSaveCoordinator";

import { LatexVisualEditor } from "./LatexVisualEditor";
import {
  checkpointVisualDraft,
  clearVisualDraft,
  confirmVisualDraft,
  flushVisualDraft,
  readPersistedVisualDraft,
} from "./visualDrafts";
import { readStartupRecovery, readStoredRecovery, removeRecovery } from "./visualRecovery";
import { clearTypingDraft, readTypingDraft } from "./visualTyping";

const KEY = "synthetic-recovery-test";
const SOURCE_SLOT = `scient:latex-visual-draft:source:${KEY}`;
const TYPING_SLOT = `scient:latex-visual-draft:typing:${KEY}`;
const PARKED_LIST = `scient:latex-visual-draft:recovered:${KEY}`;
const tex = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const MONDAY = tex("Monday text");
const AGENT = tex("Monday base\n\nAgent paragraph added on Tuesday.");
const SAVE_DELAY = 40;

interface FileView {
  readonly source: string;
  readonly revision: number;
}

/**
 * The host is modelled on the single-file surface: an accepted edit replaces
 * the shown buffer at once, the revision moves only when the real save
 * coordinator's revision-checked write is acknowledged, and that
 * acknowledgement is what clears the editor's checkpoint.
 */
describe("recovering unsaved work", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  /** What the workspace holds. */
  let disk: FileView;
  /** What the host shows: its buffer, and the last revision it confirmed. */
  let shown: FileView;
  let show: (next: FileView) => void;
  let save: "completes" | "fails" | "waits";
  let publicationGate: Promise<void> | null;
  const pausePublication = () => {
    let release!: () => void;
    publicationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };
  let singleFileDocument: boolean;
  let coordinator: FileSaveCoordinator<FileView, Error>;
  const writes = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    writes.mockReset();
    singleFileDocument = true;
    save = "completes";
    publicationGate = null;
    localStorage.clear();
    clearVisualDraft(KEY);
    clearTypingDraft(KEY);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    storageLimit?.mockRestore();
    storageLimit = null;
    await act(async () => root.unmount());
    container.remove();
    clearVisualDraft(KEY);
    clearTypingDraft(KEY);
    vi.unstubAllGlobals();
  });

  // Runs once while the tree renders, after the editor has read its startup
  // state and before any of its effects: what another view does in that gap.
  let afterEditorRender: (() => void) | null = null;
  function AfterEditorRender() {
    const run = afterEditorRender;
    afterEditorRender = null;
    run?.();
    return null;
  }

  const settle = (ms = 20) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const acknowledged = () => settle(SAVE_DELAY + 60);
  async function mount(source: string, revision: number) {
    disk = { source, revision };
    shown = disk;
    coordinator = new FileSaveCoordinator<FileView, Error>({
      debounceMs: SAVE_DELAY,
      initialRevision: `r${revision}`,
      persist: async (contents, expectedRevision) => {
        if (publicationGate) await publicationGate;
        if (save === "waits") return new Promise(() => {});
        if (save === "fails" || expectedRevision !== `r${disk.revision}`)
          return AsyncResult.failure(Cause.fail(new Error("not saved")));
        disk = { source: contents, revision: disk.revision + 1 };
        return AsyncResult.success(disk);
      },
      revisionFromResult: (saved) => `r${saved.revision}`,
      onPendingChange: () => {},
      onConfirmed: (contents, saved) => {
        confirmVisualDraft(KEY, contents);
        show({ source: shown.source, revision: saved.revision });
      },
    });
    function Harness() {
      const [value, setValue] = useState(shown);
      useEffect(() => {
        show = (next) => {
          shown = next;
          setValue(next);
        };
      }, []);
      return (
        <>
          <LatexVisualEditor
            draftKey={KEY}
            fileRevision={`r${value.revision}`}
            source={value.source}
            disabled={false}
            singleFileDocument={singleFileDocument}
            onEditingChange={() => {}}
            onOpenSource={() => {}}
            onEdit={(expected, next) => {
              if (shown.source !== expected) return false;
              writes(expected, next);
              show({ source: next, revision: shown.revision });
              coordinator.change(next);
              return true;
            }}
          />
          <AfterEditorRender />
        </>
      );
    }
    await act(async () => {
      root.render(<Harness />);
    });
    await settle();
  }
  /** Something else wrote the file; the host adopts it. */
  const changeOutside = (source: string) =>
    act(async () => {
      disk = { source, revision: disk.revision + 1 };
      coordinator.syncConfirmedFileRevision(`r${disk.revision}`);
      show(disk);
    });
  /** The user edits in the Source view: the buffer changes, with no checkpoint. */
  const editInSourceView = (source: string) =>
    act(async () => {
      show({ source, revision: shown.revision });
      coordinator.change(source);
    });
  async function reopen() {
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(disk.source, disk.revision);
  }
  const storeSourceDraft = (source: string, baseRevision: string) =>
    localStorage.setItem(SOURCE_SLOT, JSON.stringify({ source, baseRevision }));
  const storeTypingDraft = (baseSource: string, content: unknown[]) =>
    localStorage.setItem(
      TYPING_SLOT,
      JSON.stringify({ baseSource, content: { type: "doc", content } }),
    );
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  let storageLimit: { mockRestore: () => void } | null = null;
  const noRoomFor = (...slots: string[]) => {
    const original = localStorage.setItem.bind(localStorage);
    storageLimit = vi.spyOn(localStorage, "setItem").mockImplementation((name, value) => {
      if (slots.includes(name)) throw new Error("quota");
      original(name, value);
    });
    return storageLimit;
  };
  const noRoomToPark = () => noRoomFor(PARKED_LIST);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  const click = (label: string) => act(async () => button(label)!.click());
  const bar = () => container.querySelector(".scient-latex-visual-recovery");
  const message = () => bar()?.querySelector(".scient-latex-visual-recovery-message")?.textContent;
  const page = () => container.querySelector(".ProseMirror")?.textContent;
  const editable = () =>
    container.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true";
  const pm = () =>
    (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  const type = (position: number, text: string) =>
    act(async () => {
      pm().commands.setTextSelection(position);
      pm().commands.insertContent(text);
    });
  const parked = () => readStoredRecovery(KEY);
  const checkpoint = () => readPersistedVisualDraft(KEY);
  const sides = (side: string) =>
    [...container.querySelectorAll(`pre[data-side="${side}"]`)].map((node) =>
      [...node.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent)
        .join(""),
    );

  it("retains unapplied raw block input across outside updates and reopening", async () => {
    const base = tex("\\unsupported{Original}");
    const draft = "\\unsupported{Unfinished raw input 😀";
    await mount(base, 1);
    const raw = container.querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!;
    expect(raw).not.toBeNull();
    await act(async () => raw.click());
    const field = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Block LaTeX source"]',
    )!;
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        draft,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(writes).not.toHaveBeenCalled();
    expect(parked()).toMatchObject({ source: null, text: draft });
    await changeOutside(tex("Outside replacement"));
    expect(parked()?.text).toBe(draft);
    await reopen();
    expect(message()).toBe("Unsaved text");
    await click("View");
    expect(container.querySelector('[aria-label="Recovered writing"]')?.textContent).toBe(draft);
    expect(button("Use recovered")).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
  });

  it("retires only its own unapplied raw input after Cancel", async () => {
    await mount(tex("\\unsupported{Original}"), 1);
    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!.click(),
    );
    const field = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Block LaTeX source"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        "Raw draft",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(parked()?.text).toBe("Raw draft");
    await click("Cancel");
    expect(parked()).toBeNull();
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps raw input available after storage failure and releases it on Discard", async () => {
    await mount(tex("\\unsupported{Original}"), 1);
    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!.click(),
    );
    const field = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Block LaTeX source"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        "Earlier durable raw draft",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(parked()?.text).toBe("Earlier durable raw draft");
    noRoomToPark();
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        "Raw draft after quota",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(editable()).toBe(false);
    await click("View");
    expect(container.querySelector('[aria-label="Recovered writing"]')?.textContent).toBe(
      "Raw draft after quota",
    );
    await click("Discard");
    expect(bar()).toBeNull();
    expect(parked()).toBeNull();
    expect(editable()).toBe(true);
    expect(writes).not.toHaveBeenCalled();
  });

  it("hands raw input to the accepted-source journal before retiring its fragment", async () => {
    save = "waits";
    const base = tex("\\unsupported{Original}");
    await mount(base, 1);
    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!.click(),
    );
    const field = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Block LaTeX source"]',
    )!;
    const draft = "\\unsupported{Changed}";
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        draft,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Apply LaTeX");
    const next = base.replace("\\unsupported{Original}", draft);
    expect(writes).toHaveBeenCalledExactlyOnceWith(base, next);
    expect(parked()).toBeNull();
    expect(checkpoint()).toEqual({ source: next, baseRevision: "r1" });
    expect(disk.source).toBe(base);
    await reopen();
    expect(message()).toBe("Unsaved changes");
    expect(parked()?.source).toBe(next);
  });

  it("sits in the footer as one line with plain actions", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(tex("Monday base"), 1);
    const footer = container.querySelector("footer.scient-latex-reader-footer");
    expect(footer).not.toBeNull();
    expect(bar()?.parentElement).toBe(footer);
    expect(message()).toBe("Unsaved changes");
    expect([...bar()!.querySelectorAll(":scope > button")].map((b) => b.textContent)).toEqual([
      "Compare",
      "Discard",
    ]);
  });

  it("has a one-action form for a narrow footer, with Discard inside the comparison", async () => {
    // Which form is visible is the stylesheet's choice by footer width; both behave the same.
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    const compact = () =>
      bar()!.querySelector<HTMLButtonElement>("button[data-compact][aria-expanded]")!;
    expect(compact().textContent).toBe("Unsaved changes");
    expect(compact().getAttribute("aria-expanded")).toBe("false");
    expect(bar()!.querySelector(".scient-latex-visual-recovery-panel")).toBeNull();
    await act(async () => compact().click());
    expect(compact().getAttribute("aria-expanded")).toBe("true");
    expect(sides("recovered")).toEqual(["Monday text"]);
    const inside = bar()!.querySelector<HTMLButtonElement>(
      ".scient-latex-visual-recovery-panel button[data-compact]",
    )!;
    expect(inside.textContent).toBe("Discard");
    await act(async () => inside.click());
    expect(bar()).toBeNull();
    expect(parked()).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(disk.source).toBe(AGENT);
  });

  it("never changes the file before the comparison is opened", async () => {
    // Even when the file is still at the revision the work was based on.
    storeSourceDraft(MONDAY, "r1");
    await mount(tex("Monday base"), 1);
    expect(button("Use recovered")).toBeUndefined();
    expect(button("Restore")).toBeUndefined();
    await acknowledged();
    expect(writes).not.toHaveBeenCalled();
    expect(disk.source).toBe(tex("Monday base"));
    expect(page()).toContain("Monday base");
  });

  it("shows both sides and replaces the file only by the explicit choice", async () => {
    const release = pausePublication();
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    await click("Compare");
    expect(sides("current")).toEqual(["Monday base\n \nAgent paragraph added on Tuesday."]);
    expect(sides("recovered")).toEqual(["Monday text"]);
    expect(writes).not.toHaveBeenCalled();
    await click("Use recovered");
    expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
    expect(shown.source).toBe(MONDAY);
    expect(page()).toContain("Monday text");
    expect(bar()).toBeNull();
    // Not saved yet: the work is in the live slot, against the revision it replaced.
    expect(disk.source).toBe(AGENT);
    expect(parked()).toBeNull();
    expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r2" });
    // The acknowledged save is what clears it.
    release();
    await acknowledged();
    expect(disk).toEqual({ source: MONDAY, revision: 3 });
    expect(checkpoint()).toBeNull();
  });

  it("names each side of a difference for a screen reader", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    await click("Compare");
    expect(container.querySelector('pre[data-side="current"]')?.textContent).toMatch(/^File: /u);
    expect(container.querySelector('pre[data-side="recovered"]')?.textContent).toMatch(
      /^Recovered: /u,
    );
  });

  it("closes the comparison with the same control", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    await click("Compare");
    expect(container.querySelector(".scient-latex-visual-recovery-panel")).not.toBeNull();
    await click("Hide");
    expect(container.querySelector(".scient-latex-visual-recovery-panel")).toBeNull();
  });

  it("refreshes the comparison when the file changes again, and applies only against what is shown", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    await click("Compare");
    const again = tex(
      "Monday base\n\nAgent paragraph added on Tuesday.\n\nAnd one more on Wednesday.",
    );
    await changeOutside(again);
    await settle();
    expect(sides("current")[0]).toContain("And one more on Wednesday.");
    await click("Use recovered");
    expect(writes).toHaveBeenCalledExactlyOnceWith(again, MONDAY);
  });

  it("is refused when the file moves between the comparison and the click", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    await click("Compare");
    const again = tex("Monday base\n\nAgent paragraph, reworded on Wednesday.");
    await act(async () => {
      // The file moved underneath; the editor has not been told yet.
      disk = { source: again, revision: 3 };
      shown = disk;
      button("Use recovered")!.click();
    });
    expect(writes).not.toHaveBeenCalled();
    expect(disk.source).toBe(again);
    expect(message()).toBe("Unsaved changes · not applied, compare again");
    // The recovered work is still parked for the next attempt.
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
  });

  it("discards only when asked, and then removes the recovered work", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    expect(parked()).not.toBeNull();
    await click("Discard");
    expect(bar()).toBeNull();
    expect(parked()).toBeNull();
    expect(checkpoint()).toBeNull();
    expect(shown.source).toBe(AGENT);
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps the editor writable, and writing does not replace the recovered work", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    expect(editable()).toBe(true);
    await type(12, " kept writing");
    await settle(300);
    expect(disk.source).toContain("kept writing");
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
    await click("Compare");
    expect(sides("current")[0]).toContain("kept writing");
    expect(sides("recovered")).toEqual(["Monday text"]);
  });

  it("offers no way past the comparison while new writing is still unsaved", async () => {
    // The file is at the revision the work was based on, and stays there while
    // the save of the new writing is pending. Only the comparison, which shows
    // that writing, can replace it.
    storeSourceDraft(MONDAY, "r1");
    save = "waits";
    await mount(tex("Monday base"), 1);
    await type(12, " kept writing");
    await settle(300);
    expect(shown).toEqual({ source: tex("Monday base kept writing"), revision: 1 });
    expect([...bar()!.querySelectorAll(":scope > button")].map((b) => b.textContent)).toEqual([
      "Compare",
      "Discard",
    ]);
    await click("Compare");
    expect(sides("current")).toEqual(["Monday base kept writing"]);
    expect(writes.mock.calls.every(([, next]) => next !== MONDAY)).toBe(true);
  });

  it("keeps recovered work that equals a buffer which is not saved yet", async () => {
    storeSourceDraft(MONDAY, "r1");
    save = "waits";
    await mount(AGENT, 2);
    await editInSourceView(MONDAY);
    await settle(300);
    // The buffer matches, but nothing was saved: the stored copy must stay.
    expect(disk.source).toBe(AGENT);
    expect(parked()).toMatchObject({ source: MONDAY });
    await click("Compare");
    expect(container.querySelector(".scient-latex-visual-recovery-panel")?.textContent).toContain(
      "No differences from the file.",
    );
    expect(button("Use recovered")).toBeUndefined();
    await click("Discard");
    expect(bar()).toBeNull();
  });

  it("still reinstalls a typing snapshot over the exact source it was typed on", async () => {
    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base plus typed")]);
    await mount(base, 1);
    await settle(400);
    expect(bar()).toBeNull();
    expect(page()).toContain("Old base plus typed");
    expect(disk.source).toBe(tex("Old base plus typed"));
  });

  it("owns only the snapshot it put back, not one another view stored before it was installed", async () => {
    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base plus typed")]);
    // Another view stores different typing after this editor has read the
    // snapshot and before it installs it.
    const theirs = JSON.stringify({
      baseSource: base,
      content: { type: "doc", content: [paragraph("Written in the other view")] },
    });
    afterEditorRender = () => localStorage.setItem(TYPING_SLOT, theirs);
    await mount(base, 1);
    await settle(400);
    // Ours was put back, converted and published; theirs is still stored.
    expect(shown.source).toBe(tex("Old base plus typed"));
    expect(localStorage.getItem(TYPING_SLOT)).toBe(theirs);
  });

  it("does not reinstall a typing snapshot over a newer file; it shows the file and offers the writing", async () => {
    save = "waits";
    storeTypingDraft(tex("Old base"), [paragraph("Old base plus typed")]);
    const newer = tex("Old base\n\nAgent paragraph added on Tuesday.");
    await mount(newer, 2);
    await settle(400);
    expect(page()).toContain("Agent paragraph added on Tuesday.");
    expect(page()).not.toContain("plus typed");
    expect(message()).toBe("Unsaved changes");
    expect(writes).not.toHaveBeenCalled();
    // Moved out of the live slot, not lost.
    expect(readTypingDraft(KEY)).toBeNull();
    expect(parked()).toMatchObject({ origin: "typing", source: tex("Old base plus typed") });

    await click("Compare");
    await click("Use recovered");
    expect(writes).toHaveBeenCalledExactlyOnceWith(newer, tex("Old base plus typed"));
    expect(parked()).toBeNull();
    expect(checkpoint()).toEqual({ source: tex("Old base plus typed"), baseRevision: "r2" });
  });

  it("offers unconvertible writing as text to copy, without a way to apply it", async () => {
    storeTypingDraft("no document here", [
      { type: "unknownNode", content: [{ type: "text", text: "Words I typed" }] },
    ]);
    await mount(AGENT, 2);
    expect(message()).toBe("Unsaved text");
    await click("View");
    expect(container.querySelector('pre[aria-label="Recovered writing"]')?.textContent).toBe(
      "Words I typed",
    );
    expect(button("Use recovered")).toBeUndefined();
    expect(button("Copy")).toBeDefined();
    expect(writes).not.toHaveBeenCalled();
    await click("Discard");
    expect(parked()).toBeNull();
  });

  it("shows the next recovered work after one is discarded", async () => {
    storeTypingDraft(tex("Old base"), [paragraph("Old base plus typed")]);
    storeSourceDraft(MONDAY, "r1");
    await mount(AGENT, 2);
    await click("Compare");
    expect(sides("recovered")).toEqual(["Monday text"]);
    await click("Discard");
    await click("Compare");
    expect(sides("recovered")).toEqual(["Old base plus typed"]);
    await click("Discard");
    expect(bar()).toBeNull();
  });

  it("retains immediately painted typing when its source changes before publication", async () => {
    const base = tex("Old base");
    await mount(base, 1);
    const newer = tex("Old base\n\nAgent paragraph added on Tuesday.");
    await act(async () => {
      pm().commands.setTextSelection(9);
      disk = { source: newer, revision: 2 };
      shown = disk;
      pm().commands.insertContent(" typed");
      coordinator.syncConfirmedFileRevision("r2");
      show(disk);
    });
    await settle(300);
    flushVisualDraft(KEY);
    // Publication cannot overwrite the outside revision. Exact typing survives.
    expect(disk.source).toBe(newer);
    expect(checkpoint()).toBeNull();
    expect(JSON.stringify(readTypingDraft(KEY)?.content)).toContain("Old base typed");
    await reopen();
    await settle(300);
    expect(page()).toContain("Agent paragraph added on Tuesday.");
    expect(parked()?.text).toContain("Old base typed");
  });

  it("discards only its own refused writing, not a snapshot another view stored since", async () => {
    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base typed")]);
    await mount(tex("Old base\n\nAgent paragraph."), 2);
    await settle(300);
    expect(button("Discard")).toBeDefined();
    // Another view of the same document stores its own unsaved typing.
    const theirs = JSON.stringify({
      baseSource: base,
      content: { type: "doc", content: [paragraph("Written in the other view")] },
    });
    localStorage.setItem(TYPING_SLOT, theirs);
    await click("Discard");
    expect(localStorage.getItem(TYPING_SLOT)).toBe(theirs);
    expect(JSON.stringify(readTypingDraft(KEY)?.content)).toContain("Written in the other view");
    expect(page()).toContain("Agent paragraph.");
  });

  it("removes its own refused writing when the user discards it", async () => {
    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base typed")]);
    await mount(tex("Old base\n\nAgent paragraph."), 2);
    await settle(300);
    expect(readStoredRecovery(KEY)?.text).toContain("Old base typed");
    await click("Discard");
    expect(readTypingDraft(KEY)).toBeNull();
    expect(readStoredRecovery(KEY)).toBeNull();
  });

  it("keeps an admitted edit recoverable when an outside source arrives before disk acknowledgement", async () => {
    const base = tex("Old base");
    await mount(base, 1);
    save = "fails";
    const newer = tex("Old base\n\nAgent paragraph.");
    await act(async () => {
      // Source admission is immediate; disk acknowledgement still waits.
      pm().commands.setTextSelection(3);
      pm().commands.setNode("heading", { level: 1 });
      disk = { source: newer, revision: 2 };
      coordinator.syncConfirmedFileRevision("r2");
      show(disk);
    });
    await settle(300);
    expect(writes).toHaveBeenCalledTimes(1);
    flushVisualDraft(KEY);
    expect(checkpoint()?.source).toContain("\\section{Old base}");
    await reopen();
    expect(page()).toContain("Agent paragraph.");
    expect(message()).toBe("Unsaved changes");
    await click("Compare");
    expect(sides("recovered").join("\n")).toContain("\\section{Old base}");
    expect(parked()).toMatchObject({ origin: "source", baseRevision: "r1" });
  });

  it("offers a document made of several files for comparing and copying only", async () => {
    singleFileDocument = false;
    storeSourceDraft(MONDAY, "r1");
    await mount(tex("Monday base"), 1);
    expect(bar()?.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toContain(
      "several files",
    );
    await click("Compare");
    expect(sides("recovered")).toEqual(["Monday text"]);
    expect(button("Use recovered")).toBeUndefined();
    expect(button("Copy")).toBeDefined();
    expect(writes).not.toHaveBeenCalled();
    expect(parked()).not.toBeNull();
  });

  it("does not act on recovered work that another view already resolved", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(tex("Monday base"), 1);
    await click("Compare");
    // Another view of the same document discards it, then parks different work.
    removeRecovery(KEY, parked()!);
    storeSourceDraft(tex("Written in the other view"), "r1");
    readStartupRecovery(KEY, { source: tex("Monday base") });
    await click("Use recovered");
    expect(writes).not.toHaveBeenCalled();
    // This view now shows what is actually stored.
    await click("Compare");
    expect(sides("recovered")).toEqual(["Written in the other view"]);
  });

  it("does not replace writing that has not reached the comparison yet", async () => {
    storeSourceDraft(MONDAY, "r1");
    await mount(tex("Monday base"), 1);
    await click("Compare");
    await act(async () => {
      pm().commands.setTextSelection(12);
      pm().commands.insertContent(" more");
      // Clicked before the new writing reached the source that is compared.
      button("Use recovered")!.click();
    });
    await settle(300);
    expect(writes.mock.calls.every(([, next]) => next !== MONDAY)).toBe(true);
    expect(disk.source).toBe(tex("Monday base more"));
    expect(parked()).toMatchObject({ source: MONDAY });
    expect(message()).toBe("Unsaved changes · not applied, compare again");
  });

  it.each(["waits", "fails"] as const)(
    "keeps applied work recoverable when its save %s",
    async (outcome) => {
      storeSourceDraft(MONDAY, "r1");
      save = outcome;
      await mount(tex("Monday base"), 1);
      await click("Compare");
      await click("Use recovered");
      await acknowledged();
      // The host shows the applied work, but the workspace never received it.
      expect(shown.source).toBe(MONDAY);
      expect(disk.source).toBe(tex("Monday base"));
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      await reopen();
      expect(message()).toBe("Unsaved changes");
      expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
    },
  );

  it("keeps the parked copy when the applied work could not be journaled", async () => {
    storeSourceDraft(MONDAY, "r1");
    save = "waits";
    await mount(AGENT, 2);
    noRoomFor(SOURCE_SLOT);
    await click("Compare");
    await click("Use recovered");
    await settle(100);
    expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
    // Nothing else stores the applied work yet, so the parked copy stays.
    expect(checkpoint()).toBeNull();
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
    expect(message()).toBe("Unsaved changes");
    storageLimit?.mockRestore();
    await reopen();
    expect(message()).toBe("Unsaved changes");
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
  });

  it("keeps a typing snapshot it cannot load as text, safe from later typing", async () => {
    const base = tex("Old base");
    storeTypingDraft(base, [{ type: "unsupportedNode", attrs: { body: "Only copy of writing" } }]);
    await mount(base, 1);
    await settle(300);
    expect(message()).toBe("Unsaved text");
    // Ordinary writing afterwards succeeds and does not clear it.
    await type(9, " typed");
    await settle(300);
    expect(disk.source).toBe(tex("Old base typed"));
    expect(parked()).toMatchObject({ source: null, text: "Only copy of writing" });
    await click("View");
    expect(container.querySelector('pre[aria-label="Recovered writing"]')?.textContent).toBe(
      "Only copy of writing",
    );
  });

  describe("when the work cannot be set aside", () => {
    it("keeps the editor read-only so writing cannot replace it, until the user chooses", async () => {
      storeSourceDraft(MONDAY, "r1");
      const full = noRoomToPark();
      await mount(AGENT, 2);
      expect(message()).toBe("Unsaved changes · editing paused");
      expect(editable()).toBe(false);
      expect(container.querySelector('footer ~ [role="status"].sr-only')?.textContent).toContain(
        "Read-only",
      );
      // Still in its live slot, exactly as it was found.
      expect(parked()).toBeNull();
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      await click("Compare");
      expect(sides("recovered")).toEqual(["Monday text"]);
      full.mockRestore();
      await click("Discard");
      expect(bar()).toBeNull();
      expect(checkpoint()).toBeNull();
      expect(editable()).toBe(true);
      expect(writes).not.toHaveBeenCalled();
    });

    it("applies it from its slot by the same explicit choice", async () => {
      const release = pausePublication();
      storeSourceDraft(MONDAY, "r1");
      noRoomToPark();
      await mount(AGENT, 2);
      await click("Compare");
      await click("Use recovered");
      expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
      expect(bar()).toBeNull();
      expect(editable()).toBe(true);
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r2" });
      release();
      await acknowledged();
      expect(disk.source).toBe(MONDAY);
      expect(checkpoint()).toBeNull();
    });

    it.each(["waits", "fails"] as const)(
      "keeps work applied from its slot recoverable when its save %s, at the same revision too",
      async (outcome) => {
        // The record's base revision is the file's revision, so the checkpoint
        // written on applying is identical to the record that was offered.
        storeSourceDraft(MONDAY, "r2");
        noRoomToPark();
        save = outcome;
        await mount(AGENT, 2);
        await click("Compare");
        await click("Use recovered");
        await acknowledged();
        expect(bar()).toBeNull();
        expect(editable()).toBe(true);
        expect(disk.source).toBe(AGENT);
        expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r2" });
        await reopen();
        expect(message()).toBe("Unsaved changes · editing paused");
        await click("Compare");
        expect(sides("recovered")).toEqual(["Monday text"]);
      },
    );

    it("keeps the record in its slot when applying it could not rewrite the slot", async () => {
      storeSourceDraft(MONDAY, "r1");
      noRoomFor(PARKED_LIST, SOURCE_SLOT);
      save = "waits";
      await mount(AGENT, 2);
      await click("Compare");
      await click("Use recovered");
      await settle(100);
      expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
      // The slot still holds the same recovered source; the offer is settled.
      expect(bar()).toBeNull();
      expect(editable()).toBe(true);
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      storageLimit?.mockRestore();
      await reopen();
      expect(message()).toBe("Unsaved changes");
    });

    it("is not replaced when the read-only editor closes with an older unwritten checkpoint", async () => {
      storeSourceDraft(MONDAY, "r1");
      checkpointVisualDraft(KEY, "", "", tex("Older, never written"), "r0");
      noRoomToPark();
      await mount(AGENT, 2);
      expect(editable()).toBe(false);
      await act(async () => root.unmount());
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      root = createRoot(container);
    });

    it("stays read-only when the applied work could not be journaled, until it is discarded", async () => {
      // Typing from an older file waits in its slot, and nothing else can be stored.
      storeTypingDraft(tex("Old base"), [paragraph("Old base plus typed")]);
      const stored = localStorage.getItem(TYPING_SLOT);
      noRoomFor(PARKED_LIST, SOURCE_SLOT);
      save = "waits";
      await mount(AGENT, 2);
      await click("Compare");
      await click("Use recovered");
      await settle(100);
      expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, tex("Old base plus typed"));
      // The snapshot is still the only stored copy, so it stays and stays protected.
      expect(localStorage.getItem(TYPING_SLOT)).toBe(stored);
      expect(editable()).toBe(false);
      await click("Discard");
      await settle(100);
      expect(bar()).toBeNull();
      expect(editable()).toBe(true);
      expect(shown.source).toBe(tex("Old base plus typed"));
    });

    it("reinstalls waiting typing only after the work in the slot is resolved", async () => {
      const base = tex("Old base");
      storeTypingDraft(base, [paragraph("Old base plus typed")]);
      storeSourceDraft(MONDAY, "r1");
      const full = noRoomToPark();
      await mount(base, 2);
      await settle(300);
      // Reinstalled typing would be checkpointed over the copy in the slot.
      expect(page()).not.toContain("plus typed");
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      expect(readTypingDraft(KEY)).not.toBeNull();
      full.mockRestore();
      await click("Discard");
      await settle(300);
      expect(page()).toContain("Old base plus typed");
      expect(shown.source).toBe(tex("Old base plus typed"));
    });

    it("puts back typing made on the recovered work once that work is applied", async () => {
      // The typing was made on top of the unsaved source that is being applied.
      storeTypingDraft(MONDAY, [paragraph("Monday text and more")]);
      storeSourceDraft(MONDAY, "r1");
      const full = noRoomToPark();
      await mount(AGENT, 2);
      expect(message()).toBe("Unsaved changes · editing paused");
      await click("Compare");
      expect(sides("recovered")).toEqual(["Monday text"]);
      full.mockRestore();
      await click("Use recovered");
      await settle(300);
      expect(bar()).toBeNull();
      expect(editable()).toBe(true);
      expect(page()).toContain("Monday text and more");
      await acknowledged();
      expect(disk.source).toBe(tex("Monday text and more"));
    });

    it("says on the line that an edit it could store nowhere needs the document kept open", async () => {
      const base = tex("Old base");
      await mount(base, 1);
      // Another view's unsaved work occupies the slot, and nothing can be parked.
      const theirs = JSON.stringify({ source: tex("Another view"), baseRevision: "r1" });
      localStorage.setItem(SOURCE_SLOT, theirs);
      noRoomToPark();
      await act(async () => {
        pm().commands.setTextSelection(3);
        pm().commands.setNode("heading", { level: 1 });
        disk = { source: tex("Old base\n\nAgent paragraph."), revision: 2 };
        coordinator.syncConfirmedFileRevision("r2");
        show(disk);
      });
      await settle(300);
      expect(message(), container.textContent ?? "").toBe(
        "Unsaved changes · keep this document open",
      );
      expect(editable()).toBe(false);
      expect(localStorage.getItem(SOURCE_SLOT)).toBe(theirs);
      // Using it does not take the slot from the other view's work either.
      await click("Compare");
      await click("Use recovered");
      await settle(100);
      expect(localStorage.getItem(SOURCE_SLOT)).toBe(theirs);
      expect(shown.source).toContain("\\section{Old base}");
    });

    it("keeps an unloadable typing snapshot in place and the editor read-only", async () => {
      const base = tex("Old base");
      storeTypingDraft(base, [
        { type: "unsupportedNode", attrs: { body: "Only copy of writing" } },
      ]);
      const stored = localStorage.getItem(TYPING_SLOT);
      noRoomToPark();
      await mount(base, 1);
      await settle(300);
      expect(message()).toBe("Unsaved text · editing paused");
      expect(editable()).toBe(false);
      expect(localStorage.getItem(TYPING_SLOT)).toBe(stored);
    });
  });
});
