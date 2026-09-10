// @vitest-environment happy-dom
import type { ScientSavedPassage } from "@scientfactory/scient-sources";
import type { EnvironmentId, ScientSourceDetailResult } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  capture: vi.fn(),
  selection: vi.fn(),
  material: vi.fn(),
  show: vi.fn(),
  clipboard: vi.fn(),
  observe: vi.fn(),
  ask: vi.fn(),
}));
vi.mock("../../lib/selectionActions", () => ({ observeSelectionActions: mocks.observe }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.clipboard }));
vi.mock("@scientfactory/scient-citations", () => ({
  formatSourceReference: () => "Test paper. 2026.",
}));
vi.mock("./client", () => ({
  readScientSource: mocks.read,
  mutateScientSourcePassage: mocks.mutate,
}));
vi.mock("../pdf/passages/pdfPassageCapture", () => ({
  captureSelectedPdfPassage: mocks.capture,
  readPdfPassageSelection: mocks.selection,
  readPassageMaterial: mocks.material,
  showCapturedPdfPassage: mocks.show,
  verifyCapturedPdfPassage: vi.fn(),
}));
import { SourcePassages } from "./SourcePassages";
import type { ScientPdfRuntime } from "../pdf/pdfRuntime";

function passage(id: string): ScientSavedPassage {
  return {
    formatVersion: 1,
    passageId: id,
    attachmentId: "pdf_1",
    revision: 1,
    actor: "user",
    createdAt: "2026-09-08T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    deletedAt: null,
    note: `Note ${id}`,
    capture: {
      material: { sha256: "a".repeat(64), byteLength: 100 },
      extractorVersion: "6",
      profile: "pdfjs-text-layer-utf16-eol-v1",
      pages: [
        {
          page: 1,
          pageTextHash: "b".repeat(64),
          viewBox: [0, 0, 600, 800],
          rotation: 0,
          userUnit: 1,
          start: 0,
          end: 5,
          quote: "Quote",
          prefix: "",
          suffix: "",
          rectangles: [[10, 10, 50, 30]],
        },
      ],
    },
  };
}
let root: Root;
let container: HTMLDivElement;
let record: ScientSourceDetailResult;
const changed = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal("ClipboardItem", undefined);
  record = {
    formatVersion: 2,
    sourceId: "source_1",
    projectId: "project_1",
    revision: 3,
    type: "article",
    title: "Test paper",
    creators: [],
    issuedRaw: null,
    issuedYear: null,
    identifiers: [],
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-09-08T00:00:00Z",
    savedPassages: [passage("a"), passage("b")],
  };
  mocks.read.mockImplementation(async () => record);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(reader = false) {
  await act(() =>
    root.render(
      <SourcePassages
        environmentId={"local" as EnvironmentId}
        root="/project"
        sourceId="source_1"
        runtime={reader ? ({ viewer: { container } } as unknown as ScientPdfRuntime) : null}
        {...(reader ? { attachmentId: "pdf_1", onAskScient: mocks.ask } : {})}
        onRecordChange={changed}
      />,
    ),
  );
  if (!reader) await click("Annotations (2)");
}
async function click(label: string, scope: ParentNode = document.body) {
  const button = [...scope.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  expect(button).toBeTruthy();
  await act(() => button!.click());
}
async function draft(value: string) {
  const textarea = container.querySelector("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("saved passage interactions", () => {
  it("keeps a draft on passage A when B is removed and refreshes the parent revision", async () => {
    await render();
    await click("Edit note", container.querySelectorAll("article")[0]);
    await draft("Unsaved interpretation");
    const removed = { ...passage("b"), revision: 2, deletedAt: "2026-09-08T01:00:00Z" };
    mocks.mutate.mockImplementation(async () => {
      record = { ...record, revision: 4, savedPassages: [passage("a"), removed] };
      return { outcome: "removed", passage: removed };
    });
    await click("Remove", container.querySelectorAll("article")[1]);
    await click("Remove passage");
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector("textarea")?.value).toBe("Unsaved interpretation");
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        command: { action: "remove", passageId: "b", expectedRevision: 1 },
      }),
    );
  });

  it("keeps a conflicting draft, then loads the latest note after explicit cancel", async () => {
    await render();
    await click("Edit note", container.querySelectorAll("article")[0]);
    await draft("My local interpretation");
    const concurrent = { ...passage("a"), revision: 2, note: "Changed elsewhere" };
    record = { ...record, savedPassages: [concurrent, passage("b")] };
    mocks.mutate.mockResolvedValue({ outcome: "stale", passage: concurrent });
    await click("Save note");
    expect(container.querySelector("textarea")?.value).toBe("My local interpretation");
    expect(container.textContent).toContain("Your draft is kept");
    await click("Cancel");
    await click("Edit note", container.querySelectorAll("article")[0]);
    expect(container.querySelector("textarea")?.value).toBe("Changed elsewhere");
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps an unsaved note after a failed request", async () => {
    await render();
    await click("Edit note", container.querySelectorAll("article")[0]);
    await draft("Keep this draft");
    mocks.mutate.mockRejectedValue(new Error("offline"));
    await click("Save note");
    expect(container.querySelector("textarea")?.value).toBe("Keep this draft");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  });

  it("does not publish a delayed source refresh after the detail panel unmounts", async () => {
    await render();
    await click("Edit note", container.querySelectorAll("article")[0]);
    await draft("Saved locally");
    const saved = { ...passage("a"), revision: 2, note: "Saved locally" };
    mocks.mutate.mockResolvedValue({ outcome: "updated", passage: saved });
    let resolve!: (value: ScientSourceDetailResult) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<ScientSourceDetailResult>((done) => {
          resolve = done;
        }),
    );
    await click("Save note");
    expect(resolve).toBeTypeOf("function");
    await act(() => root.render(null));
    await act(() => resolve({ ...record, revision: 4, savedPassages: [saved, passage("b")] }));
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("selection-first annotations", () => {
  beforeEach(() => {
    record = { ...record, savedPassages: [] };
    mocks.observe.mockReturnValue({ selectionChanged: vi.fn(), dispose: vi.fn() });
    mocks.selection.mockReturnValue({
      _tag: "Ready",
      pages: [
        {
          ...passage("a").capture.pages[0],
          text: "Quote",
          start: 0,
          end: 5,
        },
      ],
    });
    mocks.capture.mockResolvedValue({ _tag: "Captured", capture: passage("a").capture });
    mocks.material.mockResolvedValue(passage("a").capture.material);
    mocks.show.mockReturnValue(vi.fn());
    mocks.clipboard.mockResolvedValue(undefined);
    mocks.ask.mockReturnValue(true);
    mocks.mutate.mockImplementation(async (_environment, input) => {
      const saved = { ...passage(input.command.passageId), note: input.command.note };
      record = { ...record, savedPassages: [saved] };
      return { outcome: "saved", passage: saved };
    });
  });

  async function select() {
    await act(() => mocks.observe.mock.calls.at(-1)![0].onSelection({ x: 100, y: 100 }));
  }
  async function writeNote(text: string) {
    const textarea = document.querySelector("textarea")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        text,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("keeps the list closed and does not hash or save merely by selecting", async () => {
    await render(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await select();
    expect(document.querySelector('[aria-label="Selected text actions"]')).not.toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it.each(["Copy", "Copy with citation"])("%s does not create an annotation", async (label) => {
    await render(true);
    await select();
    if (label !== "Copy") await click("More copy options");
    await click(label);
    expect(mocks.clipboard).toHaveBeenCalledWith(
      label === "Copy" ? "Quote" : "> Quote\n\nTest paper · PDF page 1",
      label === "Copy" ? "selection" : "cited excerpt",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("adds context to the existing composer without saving an annotation", async () => {
    await render(true);
    await select();
    await click("Add to chat");
    expect(mocks.ask).toHaveBeenCalledWith("PDF excerpt:\n> Quote\n\nTest paper · PDF page 1\n\n");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("opens a note directly, preserves it through Escape, and saves once", async () => {
    await render(true);
    await select();
    await click("Add note");
    await writeNote("My interpretation");
    expect(document.querySelector("blockquote")).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Quote");
    await click("Save note");
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        command: expect.objectContaining({
          action: "save",
          note: "My interpretation",
          highlighted: false,
        }),
      }),
    );
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("highlights directly and draws marks without moving the page", async () => {
    await render(true);
    await select();
    await click("Highlight");
    expect(mocks.mutate).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ command: expect.objectContaining({ action: "save", note: "" }) }),
    );
    expect(mocks.show).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ navigate: false }),
    );
  });

  it("autosaves without replacing or enlarging the focused editor", async () => {
    vi.useFakeTimers();
    try {
      await render(true);
      await select();
      await click("Add note");
      const editor = document.querySelector("textarea");
      await writeNote("Autosaved quietly");
      await act(() => vi.advanceTimersByTimeAsync(900));
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
      expect(document.querySelector("textarea")).toBe(editor);
      expect(document.querySelector("blockquote")).toBeNull();
      await writeNote("Second thought");
      await act(() => vi.advanceTimersByTimeAsync(900));
      expect(mocks.mutate.mock.calls[1]![1].command).toMatchObject({
        action: "update",
        note: "Second thought",
        expectedRevision: 1,
      });
      await click("Cancel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves and closes when the user clicks outside the note", async () => {
    await render(true);
    await select();
    await click("Add note");
    await writeNote("Save when I leave");
    await act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(document.querySelector("textarea")).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("flushes a note when its PDF view unmounts", async () => {
    await render(true);
    await select();
    await click("Add note");
    await writeNote("Keep after closing the PDF");
    await act(() => root.render(null));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0]![1].command.note).toBe("Keep after closing the PDF");
    expect(localStorage.length).toBe(0);
  });

  it("keeps a failed note and retries exactly the same command", async () => {
    await render(true);
    await select();
    await click("Add note");
    await writeNote("Keep this");
    mocks.mutate.mockRejectedValueOnce(new Error("offline"));
    await click("Save note");
    expect(document.querySelector("textarea")?.value).toBe("Keep this");
    expect(document.querySelector("textarea")?.disabled).toBe(false);
    await click("Save note");
    expect(mocks.mutate.mock.calls[0]![1].command).toEqual(mocks.mutate.mock.calls[1]![1].command);
  });

  it("does not paint marks onto different PDF bytes", async () => {
    record = { ...record, savedPassages: [passage("a")] };
    mocks.material.mockResolvedValue({ sha256: "c".repeat(64), byteLength: 100 });
    await render(true);
    expect(mocks.show).not.toHaveBeenCalled();
  });
});
