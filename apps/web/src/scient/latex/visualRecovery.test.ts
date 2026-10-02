// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  checkpointVisualDraft,
  clearVisualDraft,
  confirmVisualDraft,
  discardVisualDraft,
  flushVisualDraft,
  readPersistedVisualDraft as readVisualDraft,
} from "./visualDrafts";
import {
  canApplyRecovery,
  compareRecoveredSource,
  isRecoveryStored,
  isRecoveryUnstored,
  journalAppliedRecovery,
  parkUninstalledTypingDraft,
  parkUnpublishedSource,
  readableSnapshotText,
  readStartupRecovery,
  readStoredRecovery,
  removeRecovery,
  type LatexVisualRecovery,
} from "./visualRecovery";
import {
  clearTypingDraft,
  discardTypingDraft,
  readTypingDraft,
  typingDraftIdentity,
} from "./visualTyping";

const KEY = "recovery-unit";
const tex = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const storeTyping = (value: unknown) =>
  localStorage.setItem(`scient:latex-visual-draft:typing:${KEY}`, JSON.stringify(value));
const typing = (baseSource: string, text: string) =>
  storeTyping({
    baseSource,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  });

afterEach(() => {
  clearVisualDraft(KEY);
  clearTypingDraft(KEY);
  localStorage.clear();
});

const PARKED = `scient:latex-visual-draft:recovered:${KEY}`;
const SOURCE = `scient:latex-visual-draft:source:${KEY}`;
const parked = () => JSON.parse(localStorage.getItem(PARKED) ?? "[]") as unknown[];
/** Storage that has no room for the parked list. */
function withoutRoomToPark<T>(run: () => T): T {
  const original = localStorage.setItem.bind(localStorage);
  const spy = vi.spyOn(localStorage, "setItem").mockImplementation((name, value) => {
    if (name === PARKED) throw new Error("quota");
    original(name, value);
  });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

describe("recovery when a document opens", () => {
  it("reinstalls a typing snapshot only over the source it was typed on", () => {
    typing(tex("Base"), "Base and more");
    const startup = readStartupRecovery(KEY, { source: tex("Base") });
    expect(startup.typing?.baseSource).toBe(tex("Base"));
    // The identity is the stored version the content was read from.
    expect(startup.typingIdentity).toBe(typingDraftIdentity(KEY));
    expect(startup.recovery).toBeNull();
    expect(readTypingDraft(KEY)).not.toBeNull();
  });

  it("parks a typing snapshot from an older file as recovered source, never reinstalling it", () => {
    typing(tex("Base"), "Base and more");
    const startup = readStartupRecovery(KEY, { source: tex("Base\n\nAgent paragraph.") });
    expect(startup.typing).toBeNull();
    expect(startup.recovery).toMatchObject({
      origin: "typing",
      source: tex("Base and more"),
      text: tex("Base and more"),
      baseRevision: null,
    });
    // Moved, not dropped: the live slot is free and the work is in the parked list.
    expect(readTypingDraft(KEY)).toBeNull();
    expect(parked()).toHaveLength(1);
  });

  it("parks a source copy with its base revision and frees the live slot", () => {
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    const { recovery } = readStartupRecovery(KEY, { source: tex("File") });
    expect(recovery).toMatchObject({ origin: "source", source: tex("Mine"), baseRevision: "r1" });
    expect(readVisualDraft(KEY)).toBeNull();
    expect(isRecoveryStored(KEY, recovery!)).toBe(true);
  });

  it("offers the newest work first and keeps the rest", () => {
    typing(tex("Base"), "Typed later");
    checkpointVisualDraft(KEY, "", "", tex("Source copy"), "r1");
    flushVisualDraft(KEY);
    const { recovery } = readStartupRecovery(KEY, { source: tex("File") });
    expect(parked()).toHaveLength(2);
    expect(recovery).toMatchObject({ origin: "source", source: tex("Source copy") });
    removeRecovery(KEY, recovery!);
    expect(readStoredRecovery(KEY)).toMatchObject({ origin: "typing", source: tex("Typed later") });
  });

  it("considers only stored records, never this window's unwritten checkpoint", () => {
    // This window is mid-session with an unwritten checkpoint; another window
    // stored different work. Only the stored record is recovered work.
    localStorage.setItem(SOURCE, JSON.stringify({ source: tex("Theirs"), baseRevision: "r2" }));
    checkpointVisualDraft(KEY, "", "", tex("Ours, unwritten"), "r1");
    const { recovery } = readStartupRecovery(KEY, { source: tex("File") });
    expect(recovery).toMatchObject({ source: tex("Theirs"), baseRevision: "r2", parked: true });
    expect(parked()).toHaveLength(1);
    // Our checkpoint is still this session's live draft and is written as usual.
    expect(flushVisualDraft(KEY)).toBe(true);
    expect(readVisualDraft(KEY)).toEqual({ source: tex("Ours, unwritten"), baseRevision: "r1" });
  });

  it("leaves a snapshot that converts to exactly what the editor holds", () => {
    // The editor's source may be an unsaved buffer, so the snapshot is not removed.
    typing(tex("Base"), "Same as buffer");
    const startup = readStartupRecovery(KEY, { source: tex("Same as buffer") });
    expect(startup.recovery).toBeNull();
    expect(readTypingDraft(KEY)).not.toBeNull();
  });

  it("offers nothing when the stored copy equals the file, and leaves it stored", () => {
    checkpointVisualDraft(KEY, "", "", tex("Same"), "r1");
    flushVisualDraft(KEY);
    expect(readStartupRecovery(KEY, { source: tex("Same") }).recovery).toBeNull();
    expect(parked()).toHaveLength(0);
    expect(readVisualDraft(KEY)).toEqual({ source: tex("Same"), baseRevision: "r1" });
  });

  it("does not park the same work twice", () => {
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    readStartupRecovery(KEY, { source: tex("File") });
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    readStartupRecovery(KEY, { source: tex("File") });
    expect(parked()).toHaveLength(1);
  });

  it("offers the same recovered source once, whatever revision each copy was based on", () => {
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    readStartupRecovery(KEY, { source: tex("File") });
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r2");
    flushVisualDraft(KEY);
    const { recovery } = readStartupRecovery(KEY, { source: tex("File") });
    expect(parked()).toHaveLength(1);
    expect(recovery).toMatchObject({ source: tex("Mine"), baseRevision: "r1" });
    // The second copy left its slot: the parked one holds the same source.
    expect(readVisualDraft(KEY)).toBeNull();
  });

  it("ignores malformed parked data", () => {
    localStorage.setItem(PARKED, JSON.stringify([{ origin: "nope" }, 7, null]));
    expect(readStoredRecovery(KEY)).toBeNull();
    localStorage.setItem(PARKED, "{not json");
    expect(readStoredRecovery(KEY)).toBeNull();
  });
});

describe("readable text of writing that cannot be converted", () => {
  it("includes writing kept in attributes, block by block", () => {
    const text = readableSnapshotText({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before typed" }] },
        {
          type: "latexRichPreview",
          attrs: { kind: "abstract", sourceId: "latex-block-2", body: "My abstract writing" },
        },
        {
          type: "latexDisplayMath",
          attrs: { tex: "E = mc^2", environment: "equation", wrapper: "bracket" },
        },
        { type: "unknownNode", content: [{ type: "text", text: "After typed" }] },
      ],
    });
    expect(text).toBe("Before typed\n\nMy abstract writing\n\nE = mc^2\n\nAfter typed");
  });

  it("keeps repeated cells and leaves configuration out", () => {
    const text = readableSnapshotText({
      type: "doc",
      content: [
        {
          type: "latexRichPreview",
          attrs: {
            kind: "table",
            rows: [
              ["yes", "yes"],
              ["no", ""],
            ],
            caption: "Results",
            columnAlignments: ["left", "center"],
            tableStyle: "plain",
            columnIds: ["x1", "x2"],
          },
        },
      ],
    });
    expect(text.split("\n")).toEqual(["Results", "yes", "yes", "no"]);
  });

  it("keeps list items and nested blocks apart, and inline runs together", () => {
    const item = (text: string) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const text = readableSnapshotText({
      type: "doc",
      content: [
        { type: "bulletList", content: [item("First"), item("Second")] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Let " },
            { type: "latexInlineMath", attrs: { tex: "x" } },
            { type: "text", text: " be real." },
          ],
        },
      ],
    });
    expect(text).toBe("First\nSecond\n\nLet x be real.");
  });

  it("reads a raw block as its source, not its display label", () => {
    // As the editor stores it: the label is presentation, the source is the writing.
    expect(
      readableSnapshotText({
        type: "doc",
        content: [
          {
            type: "latexRawBlock",
            attrs: { raw: "\\newcommand{\\only}{Only copy}", label: "Raw LaTeX", sourceId: "b1" },
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "See " },
              {
                type: "latexInlineCommand",
                attrs: { name: "cite", argument: "knuth", raw: "\\cite{knuth}" },
              },
              { type: "text", text: "." },
            ],
          },
        ],
      }),
    ).toBe("\\newcommand{\\only}{Only copy}\n\nSee \\cite{knuth}.");
  });

  it("keeps a line break inside a paragraph", () => {
    expect(
      readableSnapshotText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "First" },
              { type: "hardBreak" },
              { type: "text", text: "Second" },
            ],
          },
        ],
      }),
    ).toBe("First\nSecond");
  });

  it("includes labels, equation tags and paths typed into fields", () => {
    const text = readableSnapshotText({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1, unnumbered: false, referenceLabel: "sec:results" },
          content: [{ type: "text", text: "Results" }],
        },
        {
          type: "latexDisplayMath",
          attrs: {
            tex: "x+y",
            environment: "equation",
            numberingSource: "x+y \\tag{A} \\label{eq:sum}",
          },
        },
        {
          type: "latexRichPreview",
          attrs: {
            kind: "figure",
            path: "figures/plot.pdf",
            caption: "Only caption",
            figureWidth: "0.8\\textwidth",
            figureAlignment: "center",
          },
        },
      ],
    });
    expect(text).toBe(
      [
        "Results\nsec:results",
        "x+y \\tag{A} \\label{eq:sum}",
        "Only caption\nfigures/plot.pdf\n0.8\\textwidth",
      ].join("\n\n"),
    );
  });

  it("uses a block's original source only when it has no other writing", () => {
    expect(
      readableSnapshotText({
        type: "doc",
        content: [
          { type: "latexRawBlock", attrs: { raw: "\\begin{tikzpicture}\\end{tikzpicture}" } },
          {
            type: "latexRichPreview",
            attrs: { raw: "\\begin{abstract}Old\\end{abstract}", body: "New" },
          },
        ],
      }),
    ).toBe("\\begin{tikzpicture}\\end{tikzpicture}\n\nNew");
  });

  it("returns the snapshot itself when nothing readable can be extracted", () => {
    const snapshot = { type: "doc", content: [{ type: "mystery", attrs: { payload: 7 } }] };
    expect(JSON.parse(readableSnapshotText(snapshot))).toEqual(snapshot);
  });

  it("never throws on malformed stored content", () => {
    for (const bad of [
      null,
      7,
      "text",
      { type: "doc", content: { bad: true } },
      { content: [null, 3] },
    ])
      expect(() => readableSnapshotText(bad)).not.toThrow();
    storeTyping({ baseSource: "A", content: { type: "doc", content: { bad: true } } });
    const { recovery } = readStartupRecovery(KEY, { source: tex("Current") });
    expect(recovery).toMatchObject({ origin: "typing", source: null });
    expect(recovery?.text).toContain("bad");
  });
});

describe("another window sharing the same storage", () => {
  it("never removes a source copy another window replaced", () => {
    checkpointVisualDraft(KEY, "", "", tex("A"), "r1");
    flushVisualDraft(KEY);
    expect(readVisualDraft(KEY)).toEqual({ source: tex("A"), baseRevision: "r1" });
    // Another window writes a newer copy straight to the shared storage.
    localStorage.setItem(SOURCE, JSON.stringify({ source: tex("B"), baseRevision: "r2" }));
    expect(discardVisualDraft(KEY, { source: tex("A"), baseRevision: "r1" })).toBe(false);
    expect(JSON.parse(localStorage.getItem(SOURCE)!)).toEqual({
      source: tex("B"),
      baseRevision: "r2",
    });
    // A later flush from this window has nothing stale left to write back.
    expect(flushVisualDraft(KEY)).toBe(true);
    expect(JSON.parse(localStorage.getItem(SOURCE)!).source).toBe(tex("B"));
  });

  it("parks the record that is in storage now, not one read earlier", () => {
    checkpointVisualDraft(KEY, "", "", tex("A"), "r1");
    flushVisualDraft(KEY);
    localStorage.setItem(SOURCE, JSON.stringify({ source: tex("B"), baseRevision: "r2" }));
    const { recovery } = readStartupRecovery(KEY, { source: tex("File") });
    expect(recovery).toMatchObject({ source: tex("B"), baseRevision: "r2" });
    expect(localStorage.getItem(SOURCE)).toBeNull();
  });

  it("sees parked work removed by another window before acting on it", () => {
    checkpointVisualDraft(KEY, "", "", tex("A"), "r1");
    flushVisualDraft(KEY);
    const shown = readStartupRecovery(KEY, { source: tex("File") }).recovery!;
    localStorage.removeItem(PARKED);
    expect(isRecoveryStored(KEY, shown)).toBe(false);
  });
});

describe("a typing snapshot the editor cannot load", () => {
  const unloadable = () =>
    storeTyping({
      baseSource: tex("Base"),
      content: {
        type: "doc",
        content: [{ type: "unsupportedNode", attrs: { body: "Only copy of writing" } }],
      },
    });

  it("is parked as readable text and leaves the live slot", () => {
    unloadable();
    const original = typingDraftIdentity(KEY);
    const recovery = parkUninstalledTypingDraft(KEY);
    expect(recovery).toMatchObject({
      origin: "typing",
      source: null,
      text: "Only copy of writing",
      parked: true,
    });
    expect(readTypingDraft(KEY)).toBeNull();
    expect(isRecoveryStored(KEY, recovery!)).toBe(true);
    // The parked entry carries the whole snapshot, not only the text read from it.
    expect(parked()[0]).toMatchObject({ snapshot: original });
  });

  it("stays in its slot, marked as not parked, when it cannot be parked", () => {
    unloadable();
    const recovery = withoutRoomToPark(() => parkUninstalledTypingDraft(KEY));
    expect(recovery).toMatchObject({ source: null, text: "Only copy of writing", parked: false });
    expect(readTypingDraft(KEY)).not.toBeNull();
  });
});

describe("work that cannot be parked", () => {
  it("is offered from its live slot, which is left untouched", () => {
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    const { recovery, typing: reinstall } = withoutRoomToPark(() =>
      readStartupRecovery(KEY, { source: tex("File") }),
    );
    expect(recovery).toMatchObject({ source: tex("Mine"), baseRevision: "r1", parked: false });
    expect(reinstall).toBeNull();
    expect(readVisualDraft(KEY)).toEqual({ source: tex("Mine"), baseRevision: "r1" });
    expect(isRecoveryStored(KEY, recovery!)).toBe(true);
    expect(removeRecovery(KEY, recovery!)).toBe(true);
    expect(readVisualDraft(KEY)).toBeNull();
  });

  it("is not replaced by a checkpoint this window had not written yet", () => {
    // An older checkpoint of this window is still unwritten; another window
    // stored the work that is now offered from the slot.
    const theirs = { source: tex("Theirs"), baseRevision: "r2" };
    localStorage.setItem(SOURCE, JSON.stringify(theirs));
    checkpointVisualDraft(KEY, "", "", tex("Ours, unwritten"), "r1");
    const { recovery } = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    expect(recovery).toMatchObject({ source: tex("Theirs"), parked: false });
    // Closing the editor flushes; the offered record stays, ours stays unwritten.
    expect(flushVisualDraft(KEY)).toBe(false);
    expect(readVisualDraft(KEY)).toEqual(theirs);
    // Once the user has decided, the slot takes checkpoints again.
    expect(removeRecovery(KEY, recovery!)).toBe(true);
    expect(flushVisualDraft(KEY)).toBe(true);
    expect(readVisualDraft(KEY)).toEqual({ source: tex("Ours, unwritten"), baseRevision: "r1" });
  });

  it("keeps guarding the slot for another editor of the same document", () => {
    // Offered from its slot over F, with an older checkpoint of this window unwritten.
    const record = { source: tex("R"), baseRevision: "r1" };
    localStorage.setItem(SOURCE, JSON.stringify(record));
    checkpointVisualDraft(KEY, "", "", tex("Older"), "r0");
    const first = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    expect(flushVisualDraft(KEY)).toBe(false);
    // A second editor opens the document showing R, as an unsaved buffer. It
    // offers nothing, and must not end the protection the first offer relies on.
    const second = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("R") }));
    expect(second).toEqual({ typing: null, typingIdentity: null, recovery: null });
    // The first editor closes: its flush still leaves the offered record alone.
    expect(flushVisualDraft(KEY)).toBe(false);
    expect(readVisualDraft(KEY)).toEqual(record);
    expect(isRecoveryStored(KEY, first.recovery!)).toBe(true);
  });

  it("stops guarding the slot once the record's source is saved", () => {
    localStorage.setItem(SOURCE, JSON.stringify({ source: tex("R"), baseRevision: "r1" }));
    checkpointVisualDraft(KEY, "", "", tex("Older"), "r0");
    withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    // The file becomes R and is saved; the host confirms that source. The
    // stored record is cleared on its own match, whatever this window still
    // holds unwritten.
    expect(confirmVisualDraft(KEY, tex("R"))).toBe(true);
    expect(readVisualDraft(KEY)).toBeNull();
    // Checkpoints are stored again.
    checkpointVisualDraft(KEY, "", "", tex("R, then more"), "r2");
    expect(flushVisualDraft(KEY)).toBe(true);
    expect(readVisualDraft(KEY)).toEqual({ source: tex("R, then more"), baseRevision: "r2" });
  });

  it("stops guarding the slot once another window replaced the offered record", () => {
    localStorage.setItem(SOURCE, JSON.stringify({ source: tex("Theirs"), baseRevision: "r2" }));
    withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    localStorage.setItem(SOURCE, JSON.stringify({ source: tex("Newer"), baseRevision: "r3" }));
    checkpointVisualDraft(KEY, "", "", tex("Ours"), "r3");
    expect(flushVisualDraft(KEY)).toBe(true);
  });

  it("holds back a typing snapshot that would otherwise be reinstalled", () => {
    // Reinstalled typing is converted and checkpointed into the slot the
    // unparked work still occupies, so it waits until that work is resolved.
    typing(tex("File"), "File and more");
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    const first = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    expect(first.typing).toBeNull();
    expect(first.recovery).toMatchObject({ source: tex("Mine"), parked: false });
    expect(readTypingDraft(KEY)).not.toBeNull();
    removeRecovery(KEY, first.recovery!);
    const next = readStartupRecovery(KEY, { source: tex("File") });
    expect(next.typing?.baseSource).toBe(tex("File"));
    expect(next.recovery).toBeNull();
  });

  it("is not removed once another window replaced the record", () => {
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    const { recovery } = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    localStorage.setItem(SOURCE, JSON.stringify({ source: tex("Newer"), baseRevision: "r2" }));
    expect(isRecoveryStored(KEY, recovery!)).toBe(false);
    expect(removeRecovery(KEY, recovery!)).toBe(false);
    expect(readVisualDraft(KEY)).toEqual({ source: tex("Newer"), baseRevision: "r2" });
  });

  it("offers the source slot before a typing snapshot that cannot be parked either", () => {
    // Applying recovered work checkpoints into the source slot, so what that
    // slot holds has to be resolved before anything else is applied.
    typing(tex("Base"), "Base and more");
    checkpointVisualDraft(KEY, "", "", tex("Mine"), "r1");
    flushVisualDraft(KEY);
    const first = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    expect(first.recovery).toMatchObject({ origin: "source", source: tex("Mine"), parked: false });
    removeRecovery(KEY, first.recovery!);
    const next = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    expect(next.recovery).toMatchObject({ origin: "typing", parked: false });
  });

  it("covers a stale typing snapshot the same way", () => {
    typing(tex("Base"), "Base and more");
    const { recovery } = withoutRoomToPark(() => readStartupRecovery(KEY, { source: tex("File") }));
    expect(recovery).toMatchObject({
      origin: "typing",
      source: tex("Base and more"),
      parked: false,
    });
    expect(readTypingDraft(KEY)).not.toBeNull();
    typing(tex("Base"), "Rewritten by another view");
    expect(removeRecovery(KEY, recovery!)).toBe(false);
    expect(readTypingDraft(KEY)).not.toBeNull();
  });
});

describe("an edit that was never published", () => {
  const edit = tex("Heading made but not published");

  it("is parked like work found on opening", () => {
    const recovery = parkUnpublishedSource(KEY, edit, "r1");
    expect(recovery).toMatchObject({
      origin: "source",
      source: edit,
      baseRevision: "r1",
      parked: true,
    });
    expect(readVisualDraft(KEY)).toBeNull();
  });

  it("uses the live slot when it cannot be parked and the slot is free", () => {
    const recovery = withoutRoomToPark(() => parkUnpublishedSource(KEY, edit, "r1"));
    expect(recovery).toMatchObject({ source: edit, parked: false });
    expect(readVisualDraft(KEY)).toEqual({ source: edit, baseRevision: "r1" });
    expect(isRecoveryStored(KEY, recovery!)).toBe(true);
    // This window's later checkpoints stay out of the slot until it is resolved.
    checkpointVisualDraft(KEY, "", "", tex("Typed afterwards"), "r2");
    expect(flushVisualDraft(KEY)).toBe(false);
    expect(removeRecovery(KEY, recovery!)).toBe(true);
    expect(flushVisualDraft(KEY)).toBe(true);
  });

  it("never takes a slot that holds other unsaved work", () => {
    const theirs = { source: tex("Another view's unsaved work"), baseRevision: "r3" };
    localStorage.setItem(SOURCE, JSON.stringify(theirs));
    const failed = vi.fn();
    window.addEventListener("scient-latex-recovery-error", failed);
    try {
      const recovery = withoutRoomToPark(() => parkUnpublishedSource(KEY, edit, "r1"));
      // Their record is untouched; ours is offered from memory and the user is told.
      expect(readVisualDraft(KEY)).toEqual(theirs);
      expect(recovery).toMatchObject({ source: edit, parked: false });
      expect(failed).toHaveBeenCalledOnce();
      expect(isRecoveryStored(KEY, recovery!)).toBe(true);
      expect(removeRecovery(KEY, recovery!)).toBe(true);
      expect(readVisualDraft(KEY)).toEqual(theirs);
      // Nothing of ours is left to be written over theirs later.
      expect(flushVisualDraft(KEY)).toBe(true);
      expect(readVisualDraft(KEY)).toEqual(theirs);
    } finally {
      window.removeEventListener("scient-latex-recovery-error", failed);
    }
  });
});

describe("an occupied slot while unstored work is offered", () => {
  const edit = tex("Heading made but not published");
  const theirs = { source: tex("Another view's unsaved work"), baseRevision: "r3" };
  const offerUnstored = () => {
    localStorage.setItem(SOURCE, JSON.stringify(theirs));
    const recovery = withoutRoomToPark(() => parkUnpublishedSource(KEY, edit, "r1"))!;
    expect(isRecoveryUnstored(recovery)).toBe(true);
    return recovery;
  };

  it("is not replaced by an older checkpoint this window still holds", () => {
    checkpointVisualDraft(KEY, "", "", tex("Older, unwritten"), "r0");
    offerUnstored();
    expect(flushVisualDraft(KEY)).toBe(false);
    expect(readVisualDraft(KEY)).toEqual(theirs);
  });

  it("is not replaced when the unstored work is applied", () => {
    const recovery = offerUnstored();
    expect(
      journalAppliedRecovery(
        KEY,
        { ...recovery, source: edit },
        { source: tex("File"), revision: "r4" },
      ),
    ).toBe(true);
    expect(readVisualDraft(KEY)).toEqual(theirs);
  });
});

describe("acting only on the entry that was shown", () => {
  it("removes one parked entry and leaves the others", () => {
    checkpointVisualDraft(KEY, "", "", tex("A"), "r1");
    flushVisualDraft(KEY);
    const first = readStartupRecovery(KEY, { source: tex("File") }).recovery!;
    checkpointVisualDraft(KEY, "", "", tex("B"), "r2");
    flushVisualDraft(KEY);
    const second = readStartupRecovery(KEY, { source: tex("File") }).recovery!;
    expect(second.source).toBe(tex("B"));
    removeRecovery(KEY, first);
    expect(isRecoveryStored(KEY, first)).toBe(false);
    expect(isRecoveryStored(KEY, second)).toBe(true);
    // Removing something that is no longer there changes nothing.
    removeRecovery(KEY, first);
    expect(parked()).toHaveLength(1);
  });

  it("removes a typing snapshot only if it is still the version read", () => {
    typing(tex("Base"), "First");
    const identity = typingDraftIdentity(KEY)!;
    typing(tex("Base"), "Second, written by another view");
    expect(discardTypingDraft(KEY, identity)).toBe(false);
    expect(readTypingDraft(KEY)).not.toBeNull();
  });
});

describe("the check made when recovered work is applied", () => {
  const recovery: LatexVisualRecovery = {
    origin: "source",
    source: tex("Mine"),
    text: tex("Mine"),
    baseRevision: "r1",
    parked: true,
    identity: "x",
  };
  const file = (source: string, singleFile = true) => ({ source, singleFile });

  it("applies only against the exact source the user compared", () => {
    expect(canApplyRecovery(recovery, tex("Agent"), file(tex("Agent")))).toBe(true);
    // The file, or the unsaved writing in it, changed after the comparison.
    expect(canApplyRecovery(recovery, tex("Agent"), file(tex("Agent 2")))).toBe(false);
  });

  it("never applies to a document assembled from several files", () => {
    expect(canApplyRecovery(recovery, tex("Base"), file(tex("Base"), false))).toBe(false);
  });

  it("never applies writing that has no source form", () => {
    expect(canApplyRecovery({ ...recovery, source: null, text: "words" }, "x", file("x"))).toBe(
      false,
    );
  });
});

describe("comparison for display", () => {
  it("is empty for identical text", () => {
    expect(compareRecoveredSource("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("reports separate changes separately, with the line in the current file", () => {
    const current = ["one", "two", "three", "four", "five", "six"].join("\n");
    const recovered = ["one", "TWO", "three", "four", "six", "seven"].join("\n");
    expect(compareRecoveredSource(current, recovered)).toEqual([
      { line: 2, current: ["two"], recovered: ["TWO"] },
      { line: 5, current: ["five"], recovered: [] },
      { line: 7, current: [], recovered: ["seven"] },
    ]);
  });

  it("shows both sides of a change to the same region", () => {
    expect(compareRecoveredSource(tex("Base\n\nAgent paragraph."), tex("Monday text"))).toEqual([
      { line: 3, current: ["Base", "", "Agent paragraph."], recovered: ["Monday text"] },
    ]);
  });

  it("stays bounded on very large differences", () => {
    const current = Array.from({ length: 900 }, (_, index) => `c${index}`).join("\n");
    const recovered = Array.from({ length: 900 }, (_, index) => `r${index}`).join("\n");
    const result = compareRecoveredSource(current, recovered);
    expect(result).toHaveLength(1);
    expect(result[0]!.current).toHaveLength(900);
    expect(result[0]!.recovered).toHaveLength(900);
  });
});
