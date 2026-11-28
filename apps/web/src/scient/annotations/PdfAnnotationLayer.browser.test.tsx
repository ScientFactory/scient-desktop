import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import {
  EnvironmentId,
  isScientRegionAnchor,
  type ScientAnnotationAlternative,
  type ScientAnnotationMutationRequest,
  type ScientAnnotationMutationResult,
  type ScientPdfAnnotation,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";

import { act, render as renderScreen } from "../../../test/render";
import {
  blobResolver,
  pdfBytes,
  selectText,
  textNode,
  waitForText,
} from "../pdf/anchors/pdfReaderTestKit";
import {
  PDF_READER_SESSION_STORAGE_KEY,
  pdfReaderSessionStore,
} from "../pdf/pdfReaderSessionStore";
import { workspacePdfSource } from "../pdf/pdfSource";
import { ScientPdfReader } from "../pdf/ScientPdfReader";

const client = vi.hoisted(() => ({
  read: vi.fn(),
  readSource: vi.fn(),
  mutate: vi.fn(),
}));
const library = vi.hoisted(() => ({ canChange: true }));
vi.mock("../sources/sourcesCommands", () => ({ useCanChangeLibrary: () => library.canChange }));
vi.mock("./client", () => ({
  readDocumentAnnotations: client.read,
  readSourceAnnotations: client.readSource,
  mutateAnnotation: client.mutate,
}));

const environmentId = EnvironmentId.make("environment-annotations");
const QUOTE = "coupling constant scales";
const material = { sha256: "c".repeat(64), byteLength: 1_000 };

function savedNote(note: string): ScientPdfAnnotation {
  return {
    annotationId: "ann_savednote1",
    revision: 1,
    anchor: {
      extractor: { profile: PDF_TEXT_PROFILE, version: "server" },
      selector: {
        type: "text",
        pages: [
          {
            page: 2,
            viewBox: [0, 0, 612, 792],
            rotation: 0,
            userUnit: 1,
            pageTextHash: "0".repeat(64),
            start: 0,
            end: QUOTE.length,
            quote: QUOTE,
            prefix: "",
            suffix: "",
          },
        ],
      },
    },
    highlighted: true,
    note,
    createdAt: "2026-11-10T12:00:00.000Z",
    createdBy: "agent",
    updatedAt: "2026-11-10T12:00:00.000Z",
    updatedBy: "agent",
    deletedAt: null,
  };
}

type DocumentSources = ReadonlyArray<{ sourceId: string; title: string; citationKey?: string }>;

/** Answers each command as the server would for a single known annotation. */
function serve(
  initial: ReadonlyArray<ScientPdfAnnotation>,
  alternatives: ReadonlyArray<ScientAnnotationAlternative> = [],
  sources: DocumentSources = [],
) {
  let current = [...initial];
  client.read.mockReset().mockResolvedValue({
    status: "available",
    material,
    annotations: initial,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  });
  client.mutate
    .mockReset()
    .mockImplementation(async (_env: EnvironmentId, request: ScientAnnotationMutationRequest) => {
      const command = request.command;
      const existing = current.find((a) => a.annotationId === command.annotationId);
      const revise = (change: Partial<ScientPdfAnnotation>): ScientAnnotationMutationResult => {
        const next = { ...existing!, ...change, revision: existing!.revision + 1 };
        current = [...current.filter((a) => a !== existing), next];
        return {
          outcome:
            command.action === "update" || command.action === "revert"
              ? "updated"
              : command.action === "remove"
                ? "removed"
                : "restored",
          annotation: next,
        };
      };
      switch (command.action) {
        case "create": {
          const created = {
            ...savedNote(command.note),
            annotationId: command.annotationId,
            anchor: command.anchor,
            highlighted: command.highlighted,
            createdBy: "user" as const,
            updatedBy: "user" as const,
          };
          current.push(created);
          return { outcome: "created", annotation: created };
        }
        case "update":
          return revise(command.note === undefined ? {} : { note: command.note });
        case "remove":
          return revise({ deletedAt: "2026-11-10T12:01:00.000Z" });
        case "restore":
          return revise({ deletedAt: null });
        case "revert": {
          const version = alternatives.find(
            (entry) =>
              entry.revision === command.toRevision &&
              entry.note === command.toNote &&
              entry.highlighted === command.toHighlighted,
          );
          if (!version) return { outcome: "not-found", annotation: null };
          return revise({ note: version.note, highlighted: version.highlighted });
        }
      }
    });
}

function paintedText(kind: "highlight" | "note"): string {
  const prefix = kind === "highlight" ? "scient-pdf-annotation-" : "scient-pdf-annotation-note-";
  const texts: string[] = [];
  for (const [name, highlight] of CSS.highlights) {
    if (!name.startsWith(prefix) || (kind === "highlight" && name.includes("-note-"))) continue;
    for (const range of highlight) texts.push((range as Range).toString());
  }
  return texts.join("");
}

async function setup(
  initial: ReadonlyArray<ScientPdfAnnotation>,
  alternatives: ReadonlyArray<ScientAnnotationAlternative> = [],
  sources: DocumentSources = [],
  bytes: Uint8Array = pdfBytes([["Introduction"], [`${QUOTE} as the inverse square.`]]),
) {
  serve(initial, alternatives, sources);
  const stack = new AsyncDisposableStack();
  const savedStorage = localStorage.getItem(PDF_READER_SESSION_STORAGE_KEY);
  stack.defer(() => {
    pdfReaderSessionStore.flush();
    if (savedStorage === null) localStorage.removeItem(PDF_READER_SESSION_STORAGE_KEY);
    else localStorage.setItem(PDF_READER_SESSION_STORAGE_KEY, savedStorage);
    document.getSelection()?.removeAllRanges();
  });
  const urls = new Set<string>();
  stack.defer(() => {
    for (const url of urls) URL.revokeObjectURL(url);
  });
  const container = document.createElement("div");
  // One root per test, so another test's cached annotations never show here.
  const source = workspacePdfSource({
    environmentId,
    fileName: "paper.pdf",
    workspaceRoot: `/project-${randomUUID()}`,
    relativePath: "papers/paper.pdf",
  });
  stack.use(
    await renderScreen(
      <div style={{ width: "min(800px, 100vw)", height: "100dvh", display: "flex" }}>
        <ScientPdfReader
          source={source}
          resolver={blobResolver(bytes, urls)}
          readerScope={`pdf-annotation-test:${randomUUID()}`}
        />
      </div>,
      { container },
    ),
  );
  await waitForText(container, QUOTE);
  return { container, [Symbol.asyncDispose]: () => stack.disposeAsync() };
}

describe("PDF annotations in the reader", () => {
  it("highlights a selection in a project PDF that has no chat", async (context) => {
    await using fixture = await setup([]);
    await selectText(textNode(fixture.container, QUOTE), QUOTE, context.signal);
    const highlight = page.getByRole("button", { name: "Highlight", exact: true });
    await expect.element(highlight).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Note", exact: true })).toBeVisible();
    expect(document.querySelector("[aria-label='Ask in chat']")).toBeNull();

    await act(async () => (highlight.element() as HTMLButtonElement).click());
    expect(client.mutate).toHaveBeenCalledTimes(1);
    const request = client.mutate.mock.calls[0]![1] as ScientAnnotationMutationRequest;
    expect(request).toMatchObject({ relativePath: "papers/paper.pdf", material });
    expect(request.command).toMatchObject({ action: "create", highlighted: true, note: "" });
    if (request.command.action !== "create" || isScientRegionAnchor(request.command.anchor)) {
      throw new Error("Expected a text create");
    }
    expect(request.command.anchor.selector.pages.map((p) => [p.page, p.quote])).toEqual([
      [2, QUOTE],
    ]);
    await vi.waitFor(() => expect(paintedText("highlight")).toBe(QUOTE));
  });

  it("opens a saved note from its highlight, saves an edit, and undoes a removal", async () => {
    await using fixture = await setup([savedNote("Agent's reading")]);
    await vi.waitFor(() => expect(paintedText("note")).toBe(QUOTE));
    const openNote = async () => {
      const range = document.createRange();
      const node = textNode(fixture.container, QUOTE);
      range.setStart(node, node.data.indexOf(QUOTE));
      range.setEnd(node, node.data.indexOf(QUOTE) + QUOTE.length);
      const box = range.getBoundingClientRect();
      await act(async () =>
        node.parentElement!.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            button: 0,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
          }),
        ),
      );
      const field = page.getByRole("textbox", { name: "Note" });
      await expect.element(field).toBeVisible();
      return field;
    };

    const field = await openNote();
    await expect.element(field).toHaveValue("Agent's reading");
    await userEvent.clear(field);
    await userEvent.type(field, "Replicated in 2024");
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    expect(client.mutate.mock.calls.at(-1)![1].command).toEqual({
      action: "update",
      annotationId: "ann_savednote1",
      expectedRevision: 1,
      note: "Replicated in 2024",
    });

    using notices = vi.spyOn(toastManager, "add");
    await openNote();
    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(paintedText("highlight")).toBe(""));
    const removed = notices.mock.calls.find(([toast]) => toast.title === "Highlight removed");
    expect(removed).toBeDefined();
    await act(async () => removed![0].actionProps!.onClick!({} as never));
    expect(client.mutate.mock.calls.at(-1)![1].command).toMatchObject({
      action: "restore",
      expectedRevision: 3,
    });
    await vi.waitFor(() => expect(paintedText("highlight")).toBe(QUOTE));
  });

  it("shows another computer's version of a note and makes it current when chosen", async () => {
    const theirs = {
      annotationId: "ann_savednote1",
      revision: 1,
      highlighted: true,
      note: "Their reading",
      updatedAt: "2026-11-09T12:00:00.000Z",
      importedAt: "2026-11-12T12:00:00.000Z",
    };
    await using fixture = await setup([{ ...savedNote("My reading"), revision: 2 }], [theirs]);
    await vi.waitFor(() => expect(paintedText("note")).toBe(QUOTE));
    const range = document.createRange();
    const node = textNode(fixture.container, QUOTE);
    range.setStart(node, node.data.indexOf(QUOTE));
    range.setEnd(node, node.data.indexOf(QUOTE) + QUOTE.length);
    const box = range.getBoundingClientRect();
    await act(async () =>
      node.parentElement!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
        }),
      ),
    );
    await expect.element(page.getByText("Their reading")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use this version" }));
    await vi.waitFor(() =>
      expect(client.mutate.mock.calls.at(-1)![1].command).toEqual({
        action: "revert",
        annotationId: "ann_savednote1",
        expectedRevision: 2,
        toRevision: 1,
        toNote: "Their reading",
        toHighlighted: true,
      }),
    );
    // Reopened, the note is theirs and nothing else is offered.
    await act(async () =>
      node.parentElement!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
        }),
      ),
    );
    await expect.element(page.getByRole("textbox", { name: "Note" })).toHaveValue("Their reading");
    await expect
      .element(page.getByRole("button", { name: "Use this version" }))
      .not.toBeInTheDocument();
  });

  it("asks which source a quote cites when two share the PDF, then remembers it", async () => {
    await using fixture = await setup(
      [savedNote("Key passage")],
      [],
      [
        { sourceId: "src_ch1", title: "Chapter 1", citationKey: "doe2024a" },
        { sourceId: "src_ch2", title: "Chapter 2", citationKey: "doe2024b" },
      ],
    );
    await vi.waitFor(() => expect(paintedText("note")).toBe(QUOTE));
    using copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const openNote = async () => {
      const range = document.createRange();
      const node = textNode(fixture.container, QUOTE);
      range.setStart(node, node.data.indexOf(QUOTE));
      range.setEnd(node, node.data.indexOf(QUOTE) + QUOTE.length);
      const box = range.getBoundingClientRect();
      await act(async () =>
        node.parentElement!.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            button: 0,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
          }),
        ),
      );
      await expect.element(page.getByRole("textbox", { name: "Note" })).toBeVisible();
    };
    const choices = page.getByRole("group", { name: "Source to cite" });
    const quote = page.getByRole("button", { name: "Quote in my document" });

    // Nothing is cited until a source is picked; Cancel quotes nothing.
    await openNote();
    await userEvent.click(quote);
    await expect.element(choices).toBeVisible();
    await userEvent.click(choices.getByRole("button", { name: "Cancel" }));
    await expect.element(choices).not.toBeInTheDocument();
    expect(copied).not.toHaveBeenCalled();

    await userEvent.click(quote);
    await userEvent.click(choices.getByRole("button", { name: /Chapter 2/ }));
    await vi.waitFor(() => expect(copied).toHaveBeenCalledTimes(1));
    expect(copied.mock.calls[0]![0]).toContain("[@doe2024b, p. 2]");

    // The second quote from this PDF cites the same source without asking.
    await openNote();
    await expect.element(page.getByText("Quotes cite Chapter 2")).toBeVisible();
    await userEvent.click(quote);
    await vi.waitFor(() => expect(copied).toHaveBeenCalledTimes(2));
    expect(copied.mock.calls[1]![0]).toContain("[@doe2024b, p. 2]");
  });
});

function savedArea(rect: readonly [number, number, number, number]): ScientPdfAnnotation {
  return {
    ...savedNote("Axes swapped"),
    annotationId: "ann_savedarea1",
    anchor: {
      selector: {
        type: "region",
        pages: [{ page: 1, viewBox: [0, 0, 612, 792], rotation: 90, userUnit: 1, rect }],
      },
    },
  };
}

/** A first page the PDF itself turns a quarter, with no text, before the quoted page. */
async function turnedFirstPage(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([612, 792]).setRotation(degrees(90));
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([612, 792]).drawText(`${QUOTE} as the inverse square.`, { x: 72, y: 700, font });
  return document.save();
}

function pageElement(container: HTMLElement, page: number): HTMLElement {
  return container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`)!;
}

/** Where an element sits on its page, in fractions of the page's content box. */
function placeOnPage(page: HTMLElement, element: Element) {
  const pageBox = page.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const left = pageBox.left + page.clientLeft;
  const top = pageBox.top + page.clientTop;
  return {
    left: (box.left - left) / page.clientWidth,
    top: (box.top - top) / page.clientHeight,
    width: box.width / page.clientWidth,
    height: box.height / page.clientHeight,
  };
}

function expectPlace(actual: ReturnType<typeof placeOnPage>, expected: typeof actual) {
  for (const key of ["left", "top", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThan(0.01);
  }
}

function drag(page: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  const box = page.getBoundingClientRect();
  const at = (point: { x: number; y: number }) => ({
    clientX: box.left + page.clientLeft + point.x * page.clientWidth,
    clientY: box.top + page.clientTop + point.y * page.clientHeight,
  });
  const init = { bubbles: true, cancelable: true, button: 0, pointerId: 7, isPrimary: true };
  page.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...at(from) }));
  page.dispatchEvent(new PointerEvent("pointermove", { ...init, ...at(to) }));
  page.dispatchEvent(new PointerEvent("pointerup", { ...init, ...at(to) }));
  page.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, ...at(to) }));
}

async function openMoreMenu() {
  await userEvent.click(page.getByRole("button", { name: "More PDF actions" }));
}

describe("Marked areas in the reader", () => {
  it("marks an area on a page with no text and saves its note", async () => {
    await using fixture = await setup(
      [],
      [],
      [],
      pdfBytes([[], [`${QUOTE} as the inverse square.`]]),
    );
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});
    const hint = page.getByText("Drag across a page to mark an area.");

    // Escape leaves drawing without marking anything.
    await openMoreMenu();
    await userEvent.click(page.getByRole("menuitem", { name: "Mark an area" }));
    await expect.element(hint).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(hint).not.toBeInTheDocument();

    await openMoreMenu();
    await userEvent.click(page.getByRole("menuitem", { name: "Mark an area" }));
    await expect.element(hint).toBeVisible();
    const first = pageElement(fixture.container, 1);
    await act(async () => drag(first, { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.5 }));
    await expect.element(hint).not.toBeInTheDocument();
    expect(document.getSelection()?.isCollapsed ?? true).toBe(true);

    const field = page.getByRole("textbox", { name: "Note" });
    await expect.element(field).toBeVisible();
    await userEvent.type(field, "Figure 1 axes are swapped");
    await userEvent.click(page.getByRole("button", { name: "Done" }));

    expect(client.mutate).toHaveBeenCalledTimes(1);
    const { command } = client.mutate.mock.calls[0]![1] as ScientAnnotationMutationRequest;
    if (command.action !== "create" || !isScientRegionAnchor(command.anchor)) {
      throw new Error("Expected an area to be created");
    }
    expect(command).toMatchObject({ highlighted: false, note: "Figure 1 axes are swapped" });
    const [selected] = command.anchor.selector.pages;
    expect(selected).toMatchObject({ page: 1, viewBox: [0, 0, 612, 792], rotation: 0 });
    // A quarter of the way in from the left and top, to three quarters across and half way down.
    [153, 396, 459, 594].forEach((value, index) =>
      expect(Math.abs(selected.rect[index]! - value)).toBeLessThan(2),
    );

    await vi.waitFor(() => {
      const box = first.querySelector(".scient-pdf-region[data-annotation-id]");
      expect(box?.getAttribute("data-look")).toBe("note");
      expectPlace(placeOnPage(first, box!), { left: 0.25, top: 0.25, width: 0.5, height: 0.25 });
    });
  });

  it("shows a saved area where it was drawn on a turned page, through zoom, and read-only", async () => {
    library.canChange = false;
    using _restore = { [Symbol.dispose]: () => (library.canChange = true) };
    const area = savedArea([100, 200, 300, 500]);
    await using fixture = await setup([area], [], [], await turnedFirstPage());
    const first = pageElement(fixture.container, 1);
    // The page is turned, so its PDF y runs left to right and its x top to bottom.
    const expected = { left: 200 / 792, top: 100 / 612, width: 300 / 792, height: 200 / 612 };
    const box = () =>
      first.querySelector(`.scient-pdf-region[data-annotation-id="${area.annotationId}"]`);
    await vi.waitFor(() => expectPlace(placeOnPage(first, box()!), expected));

    const width = first.clientWidth;
    await userEvent.click(page.getByRole("button", { name: /^Zoom in/ }));
    await vi.waitFor(() => {
      expect(first.clientWidth).toBeGreaterThan(width);
      expectPlace(placeOnPage(first, box()!), expected);
    });

    const center = box()!.getBoundingClientRect();
    await act(async () =>
      first.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          clientX: center.left + center.width / 2,
          clientY: center.top + center.height / 2,
        }),
      ),
    );
    const field = page.getByRole("textbox", { name: "Note" });
    await expect.element(field).toHaveValue("Axes swapped");
    await expect.element(field).toHaveAttribute("readonly");
    await expect.element(page.getByRole("button", { name: "Remove" })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Quote in my document" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await openMoreMenu();
    await expect.element(page.getByRole("menu")).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Mark an area" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(client.mutate).not.toHaveBeenCalled();
  });
});
