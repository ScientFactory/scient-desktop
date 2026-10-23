import { render as _fixtureRender, type Screen, act, fakeTimers } from "../../../test/render";
import { waitForTestReceipt } from "../../../test/receipt";
import { useEffect, useState, type ReactNode } from "react";

import { describe, expect, it, vi, type TestContext } from "vite-plus/test";

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
import { createTestCheckpointStore } from "~/scient/markdownEditor/persistence/markdownDraftCheckpointTestkit";

import { LatexVisualEditor } from "./LatexVisualEditor";
import {
  readMountedLatexVisualTestEditor,
  stubLatexReadingFonts,
  useLatexVisualTestOwner,
} from "./latexVisualTestOwner";
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
  const writeReceipts = new Map<(source: string) => boolean, () => void>();
  const confirmedReceipts = new Map<string, () => void>();
  // Arm before publishing or mounting, but start cancellation only when awaited:
  // an abort during mount must not reject a receipt that has no consumer yet.
  // Fixture cleanup also removes armed receipts that an earlier failure skips.
  const nextWriteReceipt = (
    _fixture: _Fixture,
    matches: (source: string) => boolean = () => true,
  ) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    writeReceipts.set(matches, resolve);
    const dispose = () => {
      if (writeReceipts.get(matches) === resolve) writeReceipts.delete(matches);
    };
    _fixture.cleanup.defer(dispose);
    return () => waitForTestReceipt(_fixture.context.signal, promise, dispose);
  };
  const nextConfirmation = (_fixture: _Fixture, source: string) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    confirmedReceipts.set(source, resolve);
    const dispose = () => {
      if (confirmedReceipts.get(source) === resolve) confirmedReceipts.delete(source);
    };
    _fixture.cleanup.defer(dispose);
    return () => waitForTestReceipt(_fixture.context.signal, promise, dispose);
  };
  const publishWriteReceipt = (source: string) => {
    for (const [matches, resolve] of writeReceipts) {
      if (!matches(source)) continue;
      writeReceipts.delete(matches);
      resolve();
    }
  };

  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.restoreFonts = stubLatexReadingFonts();
    writes.mockReset();
    singleFileDocument = true;
    save = "completes";
    publicationGate = null;
    localStorage.clear();
    clearVisualDraft(KEY);
    clearTypingDraft(KEY);
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    _fixture.storageLimit?.mockRestore();
    _fixture.storageLimit = null;
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    clearVisualDraft(KEY);
    clearTypingDraft(KEY);
    _fixture.restoreFonts();
    vi.unstubAllGlobals();
  }

  const settle = async (ms = 20) => await act(() => vi.advanceTimersByTimeAsync(ms));
  const acknowledged = async () => await settle(SAVE_DELAY + 60);
  async function mount(
    _fixture: _Fixture,
    source: string,
    revision: number,
    openingSave?: () => Promise<void>,
  ) {
    disk = { source, revision };
    shown = disk;
    coordinator = new FileSaveCoordinator<FileView, Error>({
      debounceMs: SAVE_DELAY,
      initialRevision: `r${revision}`,
      initialSource: source,
      journal: { key: KEY, store: createTestCheckpointStore() },
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
        confirmedReceipts.get(contents)?.();
        confirmedReceipts.delete(contents);
      },
    });
    function Harness() {
      const [value, setValue] = useState(shown);
      const owner = useLatexVisualTestOwner(value.source);
      useEffect(() => {
        show = (next) => {
          shown = next;
          setValue(next);
        };
      }, []);
      return (
        <LatexVisualEditor
          draftKey={KEY}
          fileRevision={`r${value.revision}`}
          source={value.source}
          sourceSnapshot={owner.snapshot}
          disabled={false}
          singleFileDocument={singleFileDocument}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(request) => {
            const outcome = owner.edit(request, shown.source === request.edit.source);
            if (!outcome.accepted) return outcome;
            const next = outcome.snapshot.source;
            writes(request.edit.source, next);
            show({ source: next, revision: shown.revision });
            coordinator.change(next);
            publishWriteReceipt(next);
            return outcome;
          }}
        />
      );
    }
    await waitForTestReceipt(_fixture.context.signal, coordinator.ready());
    await _fixture.root0.rerender(<Harness />);
    await vi.waitFor(() => {
      const mounted = readMountedLatexVisualTestEditor(_fixture.container);
      expect(mounted).not.toBeNull();
      expect(mounted!.view.dom.dataset.latexLoading).not.toBe("true");
    });
    if (openingSave) await openingSave();
    _fixture.clock ??= _fixture.cleanup.use(fakeTimers());
  }
  /** Something else wrote the file; the host adopts it. */
  const changeOutside = async (source: string) =>
    await act(async () => {
      disk = { source, revision: disk.revision + 1 };
      coordinator.syncConfirmedFileRevision(`r${disk.revision}`, disk.source);
      show(disk);
    });
  /** The user edits in the Source view: the buffer changes, with no checkpoint. */
  const editInSourceView = async (source: string) =>
    await act(async () => {
      show({ source, revision: shown.revision });
      coordinator.change(source);
    });
  async function reopen(_fixture: _Fixture) {
    _fixture.clock?.[Symbol.dispose]();
    _fixture.clock = undefined;
    await act(async () => await _fixture.root0.unmount());
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    await mount(_fixture, disk.source, disk.revision);
  }
  const storeSourceDraft = (source: string, baseRevision: string) =>
    localStorage.setItem(SOURCE_SLOT, JSON.stringify({ source, baseRevision }));
  const storeTypingDraft = (baseSource: string, content: unknown[]) =>
    localStorage.setItem(
      TYPING_SLOT,
      JSON.stringify({ baseSource, content: { type: "doc", content } }),
    );
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

  const noRoomFor = (_fixture: _Fixture, ...slots: string[]) => {
    const original = localStorage.setItem.bind(localStorage);
    _fixture.storageLimit = vi.spyOn(localStorage, "setItem").mockImplementation((name, value) => {
      if (slots.includes(name)) throw new Error("quota");
      original(name, value);
    });
    return _fixture.storageLimit;
  };
  const noRoomToPark = (_fixture: _Fixture) => noRoomFor(_fixture, PARKED_LIST);
  const button = (_fixture: _Fixture, label: string) =>
    [..._fixture.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  const click = async (_fixture: _Fixture, label: string) =>
    await act(async () => button(_fixture, label)!.click());
  const bar = (_fixture: _Fixture) =>
    _fixture.container.querySelector(".scient-latex-visual-recovery");
  const message = (_fixture: _Fixture) =>
    bar(_fixture)?.querySelector(".scient-latex-visual-recovery-message")?.textContent;
  const page = (_fixture: _Fixture) =>
    _fixture.container.querySelector(".ProseMirror")?.textContent;
  const editable = (_fixture: _Fixture) =>
    _fixture.container.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true";
  const pm = (_fixture: _Fixture) =>
    (_fixture.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  const type = async (_fixture: _Fixture, position: number, text: string) =>
    await act(async () => {
      pm(_fixture).commands.setTextSelection(position);
      pm(_fixture).commands.insertContent(text);
    });
  const parked = () => readStoredRecovery(KEY);
  const checkpoint = () => readPersistedVisualDraft(KEY);
  const sides = (_fixture: _Fixture, side: string) =>
    [..._fixture.container.querySelectorAll(`pre[data-side="${side}"]`)].map((node) =>
      [...node.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent)
        .join(""),
    );

  it("retains unapplied raw block input across outside updates and reopening", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("\\unsupported{Original}");
    const draft = "\\unsupported{Unfinished raw input 😀";
    await mount(_fixture, base, 1);
    const raw = _fixture.container.querySelector<HTMLElement>(
      '[aria-label="Edit this block’s LaTeX"]',
    )!;
    expect(raw).not.toBeNull();
    await act(async () => raw.click());
    const field = _fixture.container.querySelector<HTMLTextAreaElement>(
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
    await reopen(_fixture);
    expect(message(_fixture)).toBe("Unsaved text");
    await click(_fixture, "View");
    expect(_fixture.container.querySelector('[aria-label="Recovered writing"]')?.textContent).toBe(
      draft,
    );
    expect(button(_fixture, "Use recovered")).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
  });

  it("retires only its own unapplied raw input after Cancel", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, tex("\\unsupported{Original}"), 1);
    await act(async () =>
      _fixture.container
        .querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!
        .click(),
    );
    const field = _fixture.container.querySelector<HTMLTextAreaElement>(
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
    await click(_fixture, "Cancel");
    expect(parked()).toBeNull();
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps raw input available after storage failure and releases it on Discard", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, tex("\\unsupported{Original}"), 1);
    await act(async () =>
      _fixture.container
        .querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!
        .click(),
    );
    const field = _fixture.container.querySelector<HTMLTextAreaElement>(
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
    noRoomToPark(_fixture);
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        "Raw draft after quota",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(editable(_fixture)).toBe(false);
    await click(_fixture, "View");
    expect(_fixture.container.querySelector('[aria-label="Recovered writing"]')?.textContent).toBe(
      "Raw draft after quota",
    );
    await click(_fixture, "Discard");
    expect(bar(_fixture)).toBeNull();
    expect(parked()).toBeNull();
    expect(editable(_fixture)).toBe(true);
    expect(writes).not.toHaveBeenCalled();
  });

  it("hands raw input to the accepted-source journal before retiring its fragment", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    save = "waits";
    const base = tex("\\unsupported{Original}");
    await mount(_fixture, base, 1);
    await act(async () =>
      _fixture.container
        .querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!
        .click(),
    );
    const field = _fixture.container.querySelector<HTMLTextAreaElement>(
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
    await click(_fixture, "Apply LaTeX");
    const next = base.replace("\\unsupported{Original}", draft);
    expect(writes).toHaveBeenCalledExactlyOnceWith(base, next);
    expect(parked()).toBeNull();
    expect(checkpoint()).toEqual({ source: next, baseRevision: "r1" });
    expect(disk.source).toBe(base);
    await reopen(_fixture);
    expect(message(_fixture)).toBe("Unsaved changes");
    expect(parked()?.source).toBe(next);
  });

  it("retains an accepted raw fragment until checkpoint transfer succeeds without republishing it", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    save = "waits";
    const base = tex("\\unsupported{Original}");
    const draft = "\\unsupported{Changed}";
    const next = base.replace("\\unsupported{Original}", draft);
    await mount(_fixture, base, 1);
    await act(async () =>
      _fixture.container
        .querySelector<HTMLElement>('[aria-label="Edit this block’s LaTeX"]')!
        .click(),
    );
    const field = _fixture.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Block LaTeX source"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        draft,
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    noRoomFor(_fixture, SOURCE_SLOT);
    await click(_fixture, "Apply LaTeX");
    expect(shown.source).toBe(next);
    expect(writes).toHaveBeenCalledExactlyOnceWith(base, next);
    expect(parked()?.text).toBe(draft);
    expect(checkpoint()).toBeNull();
    _fixture.storageLimit?.mockRestore();
    await click(_fixture, "Apply LaTeX");
    expect(writes).toHaveBeenCalledExactlyOnceWith(base, next);
    expect(parked()).toBeNull();
    expect(checkpoint()).toEqual({ source: next, baseRevision: "r1" });
  });

  it("sits in the footer as one line with plain actions", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, tex("Monday base"), 1);
    const footer = _fixture.container.querySelector("footer.scient-latex-reader-footer");
    expect(footer).not.toBeNull();
    expect(bar(_fixture)?.parentElement).toBe(footer);
    expect(message(_fixture)).toBe("Unsaved changes");
    expect(
      [...bar(_fixture)!.querySelectorAll(":scope > button")].map((b) => b.textContent),
    ).toEqual(["Compare", "Discard"]);
  });

  it("has a one-action form for a narrow footer, with Discard inside the comparison", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // Which form is visible is the stylesheet's choice by footer width; both behave the same.
    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    const compact = () =>
      bar(_fixture)!.querySelector<HTMLButtonElement>("button[data-compact][aria-expanded]")!;
    expect(compact().textContent).toBe("Unsaved changes");
    expect(compact().getAttribute("aria-expanded")).toBe("false");
    expect(bar(_fixture)!.querySelector(".scient-latex-visual-recovery-panel")).toBeNull();
    await act(async () => compact().click());
    expect(compact().getAttribute("aria-expanded")).toBe("true");
    expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
    const inside = bar(_fixture)!.querySelector<HTMLButtonElement>(
      ".scient-latex-visual-recovery-panel button[data-compact]",
    )!;
    expect(inside.textContent).toBe("Discard");
    await act(async () => inside.click());
    expect(bar(_fixture)).toBeNull();
    expect(parked()).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    expect(disk.source).toBe(AGENT);
  });

  it("never changes the file before the comparison is opened", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // Even when the file is still at the revision the work was based on.
    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, tex("Monday base"), 1);
    expect(button(_fixture, "Use recovered")).toBeUndefined();
    expect(button(_fixture, "Restore")).toBeUndefined();
    await acknowledged();
    expect(writes).not.toHaveBeenCalled();
    expect(disk.source).toBe(tex("Monday base"));
    expect(page(_fixture)).toContain("Monday base");
  });

  it("shows both sides and replaces the file only by the explicit choice", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const release = pausePublication();
    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    await click(_fixture, "Compare");
    expect(sides(_fixture, "current")).toEqual([
      "Monday base\n \nAgent paragraph added on Tuesday.",
    ]);
    expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
    expect(writes).not.toHaveBeenCalled();
    await click(_fixture, "Use recovered");
    expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
    expect(shown.source).toBe(MONDAY);
    expect(page(_fixture)).toContain("Monday text");
    expect(bar(_fixture)).toBeNull();
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

  it("names each side of a difference for a screen reader", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    await click(_fixture, "Compare");
    expect(_fixture.container.querySelector('pre[data-side="current"]')?.textContent).toMatch(
      /^File: /u,
    );
    expect(_fixture.container.querySelector('pre[data-side="recovered"]')?.textContent).toMatch(
      /^Recovered: /u,
    );
  });

  it("closes the comparison with the same control", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    await click(_fixture, "Compare");
    expect(_fixture.container.querySelector(".scient-latex-visual-recovery-panel")).not.toBeNull();
    await click(_fixture, "Hide");
    expect(_fixture.container.querySelector(".scient-latex-visual-recovery-panel")).toBeNull();
  });

  it("refreshes the comparison when the file changes again, and applies only against what is shown", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    await click(_fixture, "Compare");
    const again = tex(
      "Monday base\n\nAgent paragraph added on Tuesday.\n\nAnd one more on Wednesday.",
    );
    await changeOutside(again);
    await settle();
    expect(sides(_fixture, "current")[0]).toContain("And one more on Wednesday.");
    await click(_fixture, "Use recovered");
    expect(writes).toHaveBeenCalledExactlyOnceWith(again, MONDAY);
  });

  it("is refused when the file moves between the comparison and the click", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    await click(_fixture, "Compare");
    const again = tex("Monday base\n\nAgent paragraph, reworded on Wednesday.");
    await act(async () => {
      // The file moved underneath; the editor has not been told yet.
      disk = { source: again, revision: 3 };
      shown = disk;
      button(_fixture, "Use recovered")!.click();
    });
    expect(writes).not.toHaveBeenCalled();
    expect(disk.source).toBe(again);
    expect(message(_fixture)).toBe("Unsaved changes · not applied, compare again");
    // The recovered work is still parked for the next attempt.
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
  });

  it("discards only when asked, and then removes the recovered work", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    expect(parked()).not.toBeNull();
    await click(_fixture, "Discard");
    expect(bar(_fixture)).toBeNull();
    expect(parked()).toBeNull();
    expect(checkpoint()).toBeNull();
    expect(shown.source).toBe(AGENT);
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps the editor writable, and writing does not replace the recovered work", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    expect(editable(_fixture)).toBe(true);
    const published = nextWriteReceipt(_fixture);
    await type(_fixture, 12, " kept writing");
    await settle(300);
    await published();
    await settle(300);
    expect(disk.source).toContain("kept writing");
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
    await click(_fixture, "Compare");
    expect(sides(_fixture, "current")[0]).toContain("kept writing");
    expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
  });

  it("offers no way past the comparison while new writing is still unsaved", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // The file is at the revision the work was based on, and stays there while
    // the save of the new writing is pending. Only the comparison, which shows
    // that writing, can replace it.
    storeSourceDraft(MONDAY, "r1");
    save = "waits";
    await mount(_fixture, tex("Monday base"), 1);
    await type(_fixture, 12, " kept writing");
    await settle(300);
    expect(shown).toEqual({ source: tex("Monday base kept writing"), revision: 1 });
    expect(
      [...bar(_fixture)!.querySelectorAll(":scope > button")].map((b) => b.textContent),
    ).toEqual(["Compare", "Discard"]);
    await click(_fixture, "Compare");
    expect(sides(_fixture, "current")).toEqual(["Monday base kept writing"]);
    expect(writes.mock.calls.every(([, next]) => next !== MONDAY)).toBe(true);
  });

  it("keeps recovered work that equals a buffer which is not saved yet", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    save = "waits";
    await mount(_fixture, AGENT, 2);
    await editInSourceView(MONDAY);
    await settle(300);
    // The buffer matches, but nothing was saved: the stored copy must stay.
    expect(disk.source).toBe(AGENT);
    expect(parked()).toMatchObject({ source: MONDAY });
    await click(_fixture, "Compare");
    expect(
      _fixture.container.querySelector(".scient-latex-visual-recovery-panel")?.textContent,
    ).toContain("No differences from the file.");
    expect(button(_fixture, "Use recovered")).toBeUndefined();
    await click(_fixture, "Discard");
    expect(bar(_fixture)).toBeNull();
  });

  it("still reinstalls a typing snapshot over the exact source it was typed on", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base plus typed")]);
    const saved = nextConfirmation(_fixture, tex("Old base plus typed"));
    await mount(_fixture, base, 1, saved);
    await settle(400);
    expect(bar(_fixture)).toBeNull();
    expect(page(_fixture)).toContain("Old base plus typed");
    expect(disk.source).toBe(tex("Old base plus typed"));
  });

  /** Another view stores `theirs` right after this editor reads the typing
   * slot, which it does once while opening, and before it installs that read. */
  function storeAfterOpeningRead(theirs: string) {
    const read = localStorage.getItem.bind(localStorage);
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation((slot) => {
      const value = read(slot);
      if (slot === TYPING_SLOT && value !== null && value !== theirs) {
        spy.mockRestore();
        localStorage.setItem(TYPING_SLOT, theirs);
      }
      return value;
    });
    return spy;
  }

  it("owns only the snapshot it put back, not one another view stored before it was installed", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base plus typed")]);
    const theirs = JSON.stringify({
      baseSource: base,
      content: { type: "doc", content: [paragraph("Written in the other view")] },
    });
    const spy = storeAfterOpeningRead(theirs);
    const saved = nextConfirmation(_fixture, tex("Old base plus typed"));
    await mount(_fixture, base, 1, saved);
    spy.mockRestore();
    await settle(400);
    // Ours was put back, converted and published; theirs is still stored.
    expect(shown.source).toBe(tex("Old base plus typed"));
    expect(localStorage.getItem(TYPING_SLOT)).toBe(theirs);
  });

  it("keeps the snapshot it could not put back, not one another view stored meanwhile", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    storeTypingDraft(base, [
      { type: "unknownNode", content: [{ type: "text", text: "Words I typed" }] },
    ]);
    const theirs = JSON.stringify({
      baseSource: base,
      content: { type: "doc", content: [paragraph("Written in the other view")] },
    });
    const spy = storeAfterOpeningRead(theirs);
    await mount(_fixture, base, 1);
    spy.mockRestore();
    await settle(400);
    // Ours is kept for review; theirs stays in the live slot for its own view.
    expect(parked()).toMatchObject({ origin: "typing", text: "Words I typed" });
    expect(localStorage.getItem(TYPING_SLOT)).toBe(theirs);
  });

  it("does not reinstall a typing snapshot over a newer file; it shows the file and offers the writing", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    save = "waits";
    storeTypingDraft(tex("Old base"), [paragraph("Old base plus typed")]);
    const newer = tex("Old base\n\nAgent paragraph added on Tuesday.");
    await mount(_fixture, newer, 2);
    await settle(400);
    expect(page(_fixture)).toContain("Agent paragraph added on Tuesday.");
    expect(page(_fixture)).not.toContain("plus typed");
    expect(message(_fixture)).toBe("Unsaved changes");
    expect(writes).not.toHaveBeenCalled();
    // Moved out of the live slot, not lost.
    expect(readTypingDraft(KEY)).toBeNull();
    expect(parked()).toMatchObject({ origin: "typing", source: tex("Old base plus typed") });

    await click(_fixture, "Compare");
    await click(_fixture, "Use recovered");
    expect(writes).toHaveBeenCalledExactlyOnceWith(newer, tex("Old base plus typed"));
    expect(parked()).toBeNull();
    expect(checkpoint()).toEqual({ source: tex("Old base plus typed"), baseRevision: "r2" });
  });

  it("offers unconvertible writing as text to copy, without a way to apply it", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeTypingDraft("no document here", [
      { type: "unknownNode", content: [{ type: "text", text: "Words I typed" }] },
    ]);
    await mount(_fixture, AGENT, 2);
    expect(message(_fixture)).toBe("Unsaved text");
    await click(_fixture, "View");
    expect(
      _fixture.container.querySelector('pre[aria-label="Recovered writing"]')?.textContent,
    ).toBe("Words I typed");
    expect(button(_fixture, "Use recovered")).toBeUndefined();
    expect(button(_fixture, "Copy")).toBeDefined();
    expect(writes).not.toHaveBeenCalled();
    await click(_fixture, "Discard");
    expect(parked()).toBeNull();
  });

  it("shows the next recovered work after one is discarded", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeTypingDraft(tex("Old base"), [paragraph("Old base plus typed")]);
    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, AGENT, 2);
    await click(_fixture, "Compare");
    expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
    await click(_fixture, "Discard");
    await click(_fixture, "Compare");
    expect(sides(_fixture, "recovered")).toEqual(["Old base plus typed"]);
    await click(_fixture, "Discard");
    expect(bar(_fixture)).toBeNull();
  });

  it("retains immediately painted typing when its source changes before publication", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    await mount(_fixture, base, 1);
    const newer = tex("Old base\n\nAgent paragraph added on Tuesday.");
    await act(async () => {
      pm(_fixture).commands.setTextSelection(9);
      disk = { source: newer, revision: 2 };
      shown = disk;
      pm(_fixture).commands.insertContent(" typed");
      coordinator.syncConfirmedFileRevision("r2", disk.source);
      show(disk);
    });
    await settle(300);
    flushVisualDraft(KEY);
    // Publication cannot overwrite the outside revision. Exact typing survives.
    expect(disk.source).toBe(newer);
    expect(checkpoint()).toBeNull();
    expect(JSON.stringify(readTypingDraft(KEY)?.content)).toContain("Old base typed");
    await reopen(_fixture);
    await settle(300);
    expect(page(_fixture)).toContain("Agent paragraph added on Tuesday.");
    expect(parked()?.text).toContain("Old base typed");
  });

  it("discards only its own refused writing, not a snapshot another view stored since", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base typed")]);
    await mount(_fixture, tex("Old base\n\nAgent paragraph."), 2);
    await settle(300);
    expect(button(_fixture, "Discard")).toBeDefined();
    // Another view of the same document stores its own unsaved typing.
    const theirs = JSON.stringify({
      baseSource: base,
      content: { type: "doc", content: [paragraph("Written in the other view")] },
    });
    localStorage.setItem(TYPING_SLOT, theirs);
    await click(_fixture, "Discard");
    expect(localStorage.getItem(TYPING_SLOT)).toBe(theirs);
    expect(JSON.stringify(readTypingDraft(KEY)?.content)).toContain("Written in the other view");
    expect(page(_fixture)).toContain("Agent paragraph.");
  });

  it("removes its own refused writing when the user discards it", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    storeTypingDraft(base, [paragraph("Old base typed")]);
    await mount(_fixture, tex("Old base\n\nAgent paragraph."), 2);
    await settle(300);
    expect(readStoredRecovery(KEY)?.text).toContain("Old base typed");
    await click(_fixture, "Discard");
    expect(readTypingDraft(KEY)).toBeNull();
    expect(readStoredRecovery(KEY)).toBeNull();
  });

  it("keeps an admitted edit recoverable when an outside source arrives before disk acknowledgement", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    await mount(_fixture, base, 1);
    save = "fails";
    const newer = tex("Old base\n\nAgent paragraph.");
    await act(async () => {
      // Source admission is immediate; disk acknowledgement still waits.
      pm(_fixture).commands.setTextSelection(3);
      pm(_fixture).commands.setNode("heading", { level: 1 });
      disk = { source: newer, revision: 2 };
      coordinator.syncConfirmedFileRevision("r2", disk.source);
      show(disk);
    });
    await settle(300);
    expect(writes).toHaveBeenCalledTimes(1);
    flushVisualDraft(KEY);
    expect(checkpoint()?.source).toContain("\\section{Old base}");
    await reopen(_fixture);
    expect(page(_fixture)).toContain("Agent paragraph.");
    expect(message(_fixture)).toBe("Unsaved changes");
    await click(_fixture, "Compare");
    expect(sides(_fixture, "recovered").join("\n")).toContain("\\section{Old base}");
    expect(parked()).toMatchObject({ origin: "source", baseRevision: "r1" });
  });

  it("offers a document made of several files for comparing and copying only", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    singleFileDocument = false;
    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, tex("Monday base"), 1);
    expect(bar(_fixture)?.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toContain(
      "several files",
    );
    await click(_fixture, "Compare");
    expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
    expect(button(_fixture, "Use recovered")).toBeUndefined();
    expect(button(_fixture, "Copy")).toBeDefined();
    expect(writes).not.toHaveBeenCalled();
    expect(parked()).not.toBeNull();
  });

  it("does not act on recovered work that another view already resolved", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, tex("Monday base"), 1);
    await click(_fixture, "Compare");
    // Another view of the same document discards it, then parks different work.
    removeRecovery(KEY, parked()!);
    storeSourceDraft(tex("Written in the other view"), "r1");
    readStartupRecovery(KEY, { source: tex("Monday base") });
    await click(_fixture, "Use recovered");
    expect(writes).not.toHaveBeenCalled();
    // This view now shows what is actually stored.
    await click(_fixture, "Compare");
    expect(sides(_fixture, "recovered")).toEqual(["Written in the other view"]);
  });

  it("does not replace writing that has not reached the comparison yet", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    await mount(_fixture, tex("Monday base"), 1);
    await click(_fixture, "Compare");
    await act(async () => {
      pm(_fixture).commands.setTextSelection(12);
      pm(_fixture).commands.insertContent(" more");
      // Clicked before the new writing reached the source that is compared.
      button(_fixture, "Use recovered")!.click();
    });
    await settle(300);
    expect(writes.mock.calls.every(([, next]) => next !== MONDAY)).toBe(true);
    expect(disk.source).toBe(tex("Monday base more"));
    expect(parked()).toMatchObject({ source: MONDAY });
    expect(message(_fixture)).toBe("Unsaved changes · not applied, compare again");
  });

  it.for(["waits", "fails"] as const)(
    "keeps applied work recoverable when its save %s",
    async (outcome, testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      storeSourceDraft(MONDAY, "r1");
      save = outcome;
      await mount(_fixture, tex("Monday base"), 1);
      await click(_fixture, "Compare");
      await click(_fixture, "Use recovered");
      await acknowledged();
      // The host shows the applied work, but the workspace never received it.
      expect(shown.source).toBe(MONDAY);
      expect(disk.source).toBe(tex("Monday base"));
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      await reopen(_fixture);
      expect(message(_fixture)).toBe("Unsaved changes");
      expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
    },
  );

  it("keeps the parked copy when the applied work could not be journaled", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    storeSourceDraft(MONDAY, "r1");
    save = "waits";
    await mount(_fixture, AGENT, 2);
    noRoomFor(_fixture, SOURCE_SLOT);
    await click(_fixture, "Compare");
    await click(_fixture, "Use recovered");
    await settle(100);
    expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
    // Nothing else stores the applied work yet, so the parked copy stays.
    expect(checkpoint()).toBeNull();
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
    expect(message(_fixture)).toBe("Unsaved changes");
    _fixture.storageLimit?.mockRestore();
    await reopen(_fixture);
    expect(message(_fixture)).toBe("Unsaved changes");
    expect(parked()).toMatchObject({ source: MONDAY, baseRevision: "r1" });
  });

  it("keeps a typing snapshot it cannot load as text, safe from later typing", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = tex("Old base");
    storeTypingDraft(base, [{ type: "unsupportedNode", attrs: { body: "Only copy of writing" } }]);
    await mount(_fixture, base, 1);
    await settle(300);
    expect(message(_fixture)).toBe("Unsaved text");
    // Ordinary writing afterwards succeeds and does not clear it.
    const published = nextWriteReceipt(_fixture, (source) => source === tex("Old base typed"));
    const saved = nextConfirmation(_fixture, tex("Old base typed"));
    await type(_fixture, 9, " typed");
    await settle(300);
    await published();
    await acknowledged();
    await saved();
    expect(disk.source).toBe(tex("Old base typed"));
    expect(parked()).toMatchObject({ source: null, text: "Only copy of writing" });
    await click(_fixture, "View");
    expect(
      _fixture.container.querySelector('pre[aria-label="Recovered writing"]')?.textContent,
    ).toBe("Only copy of writing");
  });

  describe("when the work cannot be set aside", () => {
    it("keeps the editor read-only so writing cannot replace it, until the user chooses", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      storeSourceDraft(MONDAY, "r1");
      const full = noRoomToPark(_fixture);
      await mount(_fixture, AGENT, 2);
      expect(message(_fixture)).toBe("Unsaved changes · editing paused");
      expect(editable(_fixture)).toBe(false);
      expect(
        _fixture.container.querySelector('footer ~ [role="status"].sr-only')?.textContent,
      ).toContain("Read-only");
      // Still in its live slot, exactly as it was found.
      expect(parked()).toBeNull();
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      await click(_fixture, "Compare");
      expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
      full.mockRestore();
      await click(_fixture, "Discard");
      expect(bar(_fixture)).toBeNull();
      expect(checkpoint()).toBeNull();
      expect(editable(_fixture)).toBe(true);
      expect(writes).not.toHaveBeenCalled();
    });

    it("applies it from its slot by the same explicit choice", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const release = pausePublication();
      storeSourceDraft(MONDAY, "r1");
      noRoomToPark(_fixture);
      await mount(_fixture, AGENT, 2);
      await click(_fixture, "Compare");
      await click(_fixture, "Use recovered");
      expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
      expect(bar(_fixture)).toBeNull();
      expect(editable(_fixture)).toBe(true);
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r2" });
      release();
      await acknowledged();
      expect(disk.source).toBe(MONDAY);
      expect(checkpoint()).toBeNull();
    });

    it.for(["waits", "fails"] as const)(
      "keeps work applied from its slot recoverable when its save %s, at the same revision too",
      async (outcome, testContext) => {
        await using _fixture = _createFixture(testContext);
        _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
        await _setupFixture0(_fixture);

        // The record's base revision is the file's revision, so the checkpoint
        // written on applying is identical to the record that was offered.
        storeSourceDraft(MONDAY, "r2");
        noRoomToPark(_fixture);
        save = outcome;
        await mount(_fixture, AGENT, 2);
        await click(_fixture, "Compare");
        await click(_fixture, "Use recovered");
        await acknowledged();
        expect(bar(_fixture)).toBeNull();
        expect(editable(_fixture)).toBe(true);
        expect(disk.source).toBe(AGENT);
        expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r2" });
        await reopen(_fixture);
        expect(message(_fixture)).toBe("Unsaved changes · editing paused");
        await click(_fixture, "Compare");
        expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
      },
    );

    it("keeps the record in its slot when applying it could not rewrite the slot", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      storeSourceDraft(MONDAY, "r1");
      noRoomFor(_fixture, PARKED_LIST, SOURCE_SLOT);
      save = "waits";
      await mount(_fixture, AGENT, 2);
      await click(_fixture, "Compare");
      await click(_fixture, "Use recovered");
      await settle(100);
      expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, MONDAY);
      // The slot still holds the same recovered source; the offer is settled.
      expect(bar(_fixture)).toBeNull();
      expect(editable(_fixture)).toBe(true);
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      _fixture.storageLimit?.mockRestore();
      await reopen(_fixture);
      expect(message(_fixture)).toBe("Unsaved changes");
    });

    it("is not replaced when the read-only editor closes with an older unwritten checkpoint", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      storeSourceDraft(MONDAY, "r1");
      checkpointVisualDraft(KEY, tex("Older, never written"), "r0");
      noRoomToPark(_fixture);
      await mount(_fixture, AGENT, 2);
      expect(editable(_fixture)).toBe(false);
      _fixture.clock?.[Symbol.dispose]();
      _fixture.clock = undefined;
      await act(async () => await _fixture.root0.unmount());
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.container, router: false }),
      );
    });

    it("stays read-only when the applied work could not be journaled, until it is discarded", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      // Typing from an older file waits in its slot, and nothing else can be stored.
      storeTypingDraft(tex("Old base"), [paragraph("Old base plus typed")]);
      const stored = localStorage.getItem(TYPING_SLOT);
      noRoomFor(_fixture, PARKED_LIST, SOURCE_SLOT);
      save = "waits";
      await mount(_fixture, AGENT, 2);
      await click(_fixture, "Compare");
      await click(_fixture, "Use recovered");
      await settle(100);
      expect(writes).toHaveBeenCalledExactlyOnceWith(AGENT, tex("Old base plus typed"));
      // The snapshot is still the only stored copy, so it stays and stays protected.
      expect(localStorage.getItem(TYPING_SLOT)).toBe(stored);
      expect(editable(_fixture)).toBe(false);
      await click(_fixture, "Discard");
      await settle(100);
      expect(bar(_fixture)).toBeNull();
      expect(editable(_fixture)).toBe(true);
      expect(shown.source).toBe(tex("Old base plus typed"));
    });

    it("reinstalls waiting typing only after the work in the slot is resolved", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const base = tex("Old base");
      storeTypingDraft(base, [paragraph("Old base plus typed")]);
      storeSourceDraft(MONDAY, "r1");
      const full = noRoomToPark(_fixture);
      await mount(_fixture, base, 2);
      await settle(300);
      // Reinstalled typing would be checkpointed over the copy in the slot.
      expect(page(_fixture)).not.toContain("plus typed");
      expect(checkpoint()).toEqual({ source: MONDAY, baseRevision: "r1" });
      expect(readTypingDraft(KEY)).not.toBeNull();
      full.mockRestore();
      await click(_fixture, "Discard");
      await settle(300);
      expect(page(_fixture)).toContain("Old base plus typed");
      expect(shown.source).toBe(tex("Old base plus typed"));
    });

    it("puts back typing made on the recovered work once that work is applied", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      // The typing was made on top of the unsaved source that is being applied.
      storeTypingDraft(MONDAY, [paragraph("Monday text and more")]);
      storeSourceDraft(MONDAY, "r1");
      const full = noRoomToPark(_fixture);
      await mount(_fixture, AGENT, 2);
      expect(message(_fixture)).toBe("Unsaved changes · editing paused");
      await click(_fixture, "Compare");
      expect(sides(_fixture, "recovered")).toEqual(["Monday text"]);
      full.mockRestore();
      const published = nextWriteReceipt(
        _fixture,
        (source) => source === tex("Monday text and more"),
      );
      const saved = nextConfirmation(_fixture, tex("Monday text and more"));
      await click(_fixture, "Use recovered");
      await settle(300);
      expect(bar(_fixture)).toBeNull();
      expect(editable(_fixture)).toBe(true);
      expect(page(_fixture)).toContain("Monday text and more");
      await published();
      await acknowledged();
      await saved();
      expect(disk.source).toBe(tex("Monday text and more"));
    });

    it("says on the line that an edit it could store nowhere needs the document kept open", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const base = tex("Old base");
      await mount(_fixture, base, 1);
      // Another view's unsaved work occupies the slot, and nothing can be parked.
      const theirs = JSON.stringify({ source: tex("Another view"), baseRevision: "r1" });
      localStorage.setItem(SOURCE_SLOT, theirs);
      noRoomToPark(_fixture);
      await act(async () => {
        pm(_fixture).commands.setTextSelection(3);
        pm(_fixture).commands.setNode("heading", { level: 1 });
        disk = { source: tex("Old base\n\nAgent paragraph."), revision: 2 };
        coordinator.syncConfirmedFileRevision("r2", disk.source);
        show(disk);
      });
      await settle(300);
      expect(message(_fixture), _fixture.container.textContent ?? "").toBe(
        "Unsaved changes · keep this document open",
      );
      expect(editable(_fixture)).toBe(false);
      expect(localStorage.getItem(SOURCE_SLOT)).toBe(theirs);
      // Using it does not take the slot from the other view's work either.
      await click(_fixture, "Compare");
      await click(_fixture, "Use recovered");
      await settle(100);
      expect(localStorage.getItem(SOURCE_SLOT)).toBe(theirs);
      expect(shown.source).toContain("\\section{Old base}");
    });

    it("keeps an unloadable typing snapshot in place and the editor read-only", async (testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const base = tex("Old base");
      storeTypingDraft(base, [
        { type: "unsupportedNode", attrs: { body: "Only copy of writing" } },
      ]);
      const stored = localStorage.getItem(TYPING_SLOT);
      noRoomToPark(_fixture);
      await mount(_fixture, base, 1);
      await settle(300);
      expect(message(_fixture)).toBe("Unsaved text · editing paused");
      expect(editable(_fixture)).toBe(false);
      expect(localStorage.getItem(TYPING_SLOT)).toBe(stored);
    });
  });
});

function _createFixture(context: TestContext) {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    context,
    restoreFonts: () => {},
    storageLimit: null as { mockRestore: () => void } | null,

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    clock: undefined as Disposable | undefined,
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
