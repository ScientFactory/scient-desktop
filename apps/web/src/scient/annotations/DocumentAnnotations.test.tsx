// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { AnnotationRecord } from "@scientfactory/annotations";
import type { AnnotationDocumentResult, EnvironmentId } from "@t3tools/contracts";
import type { ScientPdfRuntime } from "../pdf/pdfRuntime";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  prepare: vi.fn(),
  open: vi.fn(),
  material: vi.fn(),
  capture: vi.fn(),
  selection: vi.fn(),
  show: vi.fn(),
  verify: vi.fn(),
  bytes: vi.fn(),
  observe: vi.fn(),
  clipboard: vi.fn(),
  cite: vi.fn(),
  area: vi.fn(),
  ask: vi.fn(),
}));
vi.mock("../../lib/selectionActions", () => ({ observeSelectionActions: mocks.observe }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.clipboard }));
vi.mock("./client", () => ({
  mutateAnnotation: mocks.mutate,
  prepareAnnotations: mocks.prepare,
  openAnnotations: mocks.open,
  annotationMaterial: mocks.material,
}));
vi.mock("../sources/client", () => ({ readScientSource: vi.fn(async () => null) }));
vi.mock("../sources/sourceExcerptCopy", () => ({
  sourceExcerptCopy: (_: unknown, pages: { quote: string }[]) => ({
    markdown: pages.map((p) => p.quote).join("\n"),
  }),
  copySourceExcerpt: mocks.cite,
}));
vi.mock("../pdf/passages/pdfPassageCapture", () => ({
  captureSelectedPdfPassage: mocks.capture,
  readPdfPassageSelection: mocks.selection,
  readPassageMaterial: mocks.bytes,
  showCapturedPdfPassage: mocks.show,
  verifyCapturedPdfPassage: mocks.verify,
  beginPdfAreaSelection: mocks.area,
}));
import { AnnotationReader } from "./DocumentAnnotations";

function annotation(): AnnotationRecord {
  return {
    formatVersion: 1,
    annotationId: "note-a",
    revision: 1,
    owner: { kind: "project", projectId: "project" },
    bodyFormat: "plain-text",
    note: "Original note",
    highlighted: false,
    correctedText: null,
    authorship: { kind: "user", principal: "user" },
    review: { state: "accepted", principal: "user" },
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    deletedAt: null,
    region: {
      regionId: "region",
      resourceId: "resource",
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
    },
  };
}
const target = { kind: "file" as const, relativePath: "paper.pdf" };
let root: Root;
let container: HTMLDivElement;
let state: AnnotationDocumentResult;
let onSelection: () => void;
let unmounted: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  unmounted = false;
  state = {
    enabled: true,
    needsMigration: false,
    binding: { workspaceBinding: "a".repeat(64), generation: "b".repeat(64) },
    resource: {
      formatVersion: 1,
      resourceId: "resource",
      owner: { kind: "project", projectId: "project" },
      locator: "paper.pdf",
    },
    annotations: [annotation()],
  };
  mocks.prepare.mockImplementation(async () => state);
  mocks.bytes.mockResolvedValue(annotation().region.capture.material);
  mocks.show.mockReturnValue(() => {});
  mocks.verify.mockResolvedValue({ _tag: "Exact" });
  mocks.observe.mockImplementation((input: { onSelection: () => void }) => {
    onSelection = input.onSelection;
    return { dispose() {}, selectionChanged() {} };
  });
  mocks.selection.mockReturnValue({
    _tag: "Ready",
    pages: [{ page: 1, text: "Quote", start: 0, end: 5 }],
  });
  mocks.capture.mockResolvedValue({ _tag: "Captured", capture: annotation().region.capture });
  mocks.mutate.mockImplementation(async (_env, { command }) => ({
    outcome: "committed",
    record: {
      ...annotation(),
      ...command,
      annotationId: command.annotationId,
      revision: (command.expectedRevision ?? 0) + 1,
      deletedAt: command.action === "remove" ? "2026-09-10T01:00:00Z" : null,
    },
  }));
});
afterEach(async () => {
  if (!unmounted) await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(options?: { empty?: boolean; retained?: (input: unknown) => void }) {
  if (options?.empty) state = { ...state, annotations: [] };
  await act(() =>
    root.render(
      <AnnotationReader
        environmentId={"local" as EnvironmentId}
        root="/project"
        target={target}
        title="Test PDF"
        initial={state}
        runtime={{ viewer: { container } } as unknown as ScientPdfRuntime}
        onAskScient={mocks.ask}
        {...(options?.retained ? { onOpenAnnotatedVersion: options.retained } : {})}
      />,
    ),
  );
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label,
  );
  expect(button, label).toBeTruthy();
  await act(() => button!.click());
}
async function edit(value: string) {
  const input = document.querySelector("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function savedNote() {
  await click("Annotations");
  await click("Page 1Original note");
}
it("keeps the list closed and does not hash or mutate an unannotated PDF on selection", async () => {
  await render({ empty: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(() => onSelection());
  expect(document.querySelector('[aria-label="Selected text actions"]')).toBeTruthy();
  expect(mocks.bytes).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("Copy, Cite and Add to chat are stateless actions and never save a highlight", async () => {
  await render({ empty: true });
  for (const action of ["Copy", "Cite", "Add to chat"]) {
    await act(() => onSelection());
    await click(action);
  }
  expect(mocks.clipboard).toHaveBeenCalledWith("Quote", "PDF excerpt");
  expect(mocks.cite).toHaveBeenCalled();
  expect(mocks.ask).toHaveBeenCalledWith(expect.stringContaining("Quote"));
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it("opens only a small note editor, autosaves without highlighting, and preserves the textarea", async () => {
  vi.useFakeTimers();
  await render({ empty: true });
  await act(() => onSelection());
  await click("Note");
  const input = document.querySelector("textarea")!;
  expect(input.getAttribute("rows")).toBe("2");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Quote");
  await edit("My note");
  await act(() => vi.advanceTimersByTimeAsync(900));
  expect(mocks.mutate).toHaveBeenCalledWith(
    "local",
    expect.objectContaining({
      binding: state.binding,
      command: expect.objectContaining({ action: "create", note: "My note", highlighted: false }),
    }),
  );
  expect(document.querySelector("textarea")).toBe(input);
  expect(localStorage.length).toBe(0);
});
it("keeps a conflicting draft and opens the latest version after explicit cancel", async () => {
  await render();
  await savedNote();
  await click("Edit note");
  await edit("My interpretation");
  mocks.mutate.mockResolvedValue({
    outcome: "conflict",
    record: { ...annotation(), revision: 2, note: "Changed elsewhere" },
  });
  await click("Save");
  expect(document.querySelector("textarea")?.value).toBe("My interpretation");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
  await click("Cancel");
  await click("Annotations");
  await click("Page 1Changed elsewhere");
  await click("Edit note");
  expect(document.querySelector("textarea")?.value).toBe("Changed elsewhere");
});
it("retries an uncertain highlight with the same annotation and operation IDs", async () => {
  await render({ empty: true });
  await act(() => onSelection());
  mocks.mutate.mockRejectedValueOnce(new Error("lost reply"));
  await click("Highlight");
  await click("Highlight");
  expect(mocks.mutate.mock.calls[0]).toEqual(mocks.mutate.mock.calls[1]);
});
it("removes immediately and Undo restores the same identity at the new revision", async () => {
  await render();
  await savedNote();
  await click("Remove");
  expect(document.body.textContent).not.toContain("Original note");
  await click("Undo removal");
  expect(mocks.mutate.mock.calls[1]?.[1].command).toMatchObject({
    action: "restore",
    annotationId: "note-a",
    expectedRevision: 2,
  });
});
it("clearing a note on an independent highlight retains the highlight", async () => {
  state = { ...state, annotations: [{ ...annotation(), highlighted: true }] };
  await render();
  await savedNote();
  await click("Edit note");
  await edit("");
  await click("Save");
  expect(mocks.mutate.mock.calls[0]?.[1].command).toMatchObject({
    action: "edit",
    note: "",
    highlighted: true,
  });
});
it("flushes a pending capture and draft when the reader unmounts", async () => {
  let finish!: (value: unknown) => void;
  mocks.capture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render({ empty: true });
  await act(() => onSelection());
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Note")!;
  await act(() => {
    button.click();
  });
  await edit("Pending capture note");
  await act(() => root.unmount());
  unmounted = true;
  await act(async () => {
    finish({ _tag: "Captured", capture: annotation().region.capture });
  });
  expect(mocks.mutate.mock.calls[0]?.[1].command).toMatchObject({
    note: "Pending capture note",
    highlighted: false,
  });
});
it("recovery clears the old journal only after successful save", async () => {
  const key =
    JSON.stringify(["scient-document-note-v1", "local", "/project", target, state.binding]) +
    ":old-editor";
  localStorage.setItem(
    key,
    JSON.stringify({
      note: "Recovered",
      command: {
        action: "edit",
        operationId: "op",
        annotationId: "note-a",
        expectedRevision: 1,
        note: "Recovered",
        highlighted: false,
      },
    }),
  );
  await render();
  expect(document.querySelector("textarea")?.value).toBe("Recovered");
  expect(mocks.mutate).not.toHaveBeenCalled();
  await click("Save");
  expect(localStorage.length).toBe(0);
});
it("opens the verified retained resource through the host instead of deriving a path in the UI", async () => {
  const retained = vi.fn();
  mocks.material.mockResolvedValue({
    workspaceRoot: "/project",
    relativePath: "host/retained.pdf",
    resourceId: "resource",
  });
  await render({ retained });
  await savedNote();
  await click("Open annotated version");
  expect(retained).toHaveBeenCalledWith({
    workspaceRoot: "/project",
    relativePath: "host/retained.pdf",
    resourceId: "resource",
    annotationId: "note-a",
  });
});
it("does not replace a known newer revision with an old replay receipt", async () => {
  state = { ...state, annotations: [{ ...annotation(), revision: 3 }] };
  await render();
  await savedNote();
  await click("Edit note");
  await edit("Replayed note");
  mocks.mutate.mockResolvedValue({
    outcome: "replayed",
    record: { ...annotation(), revision: 2, note: "Replayed note" },
  });
  await click("Save");
  await click("Annotations");
  expect(document.body.textContent).toContain("Original note");
  expect(document.body.textContent).not.toContain("Replayed note");
});
it("offers an area fallback when text selection cannot be trusted", async () => {
  await render({ empty: true });
  mocks.selection.mockReturnValue({ _tag: "Refused", reason: "text-unavailable" });
  await act(() => onSelection());
  await click("Select area instead");
  expect(mocks.area).toHaveBeenCalled();
  expect(mocks.mutate).not.toHaveBeenCalled();
});
