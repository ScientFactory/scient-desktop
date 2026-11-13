import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import {
  EnvironmentId,
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
vi.mock("../sources/sourcesCommands", () => ({ useCanChangeLibrary: () => true }));
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

/** Answers each command as the server would for a single known annotation. */
function serve(
  initial: ReadonlyArray<ScientPdfAnnotation>,
  alternatives: ReadonlyArray<ScientAnnotationAlternative> = [],
) {
  let current = [...initial];
  client.read.mockReset().mockResolvedValue({
    status: "available",
    material,
    annotations: initial,
    ...(alternatives.length > 0 ? { alternatives } : {}),
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
) {
  serve(initial, alternatives);
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
          resolver={blobResolver(
            pdfBytes([["Introduction"], [`${QUOTE} as the inverse square.`]]),
            urls,
          )}
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
    if (request.command.action !== "create") throw new Error("Expected a create");
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
});
