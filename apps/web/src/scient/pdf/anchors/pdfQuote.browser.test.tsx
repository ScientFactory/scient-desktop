import type { PdfSourceResolver } from "@scientfactory/document-artifacts";
import {
  EnvironmentId,
  ThreadId,
  pdfCitationText,
  type ComposerCitation,
  type PdfCitation,
} from "@t3tools/contracts";
import { act, StrictMode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { toastManager } from "~/components/ui/toast";
import { ComposerHandleContext } from "~/composerHandleContext";

import { workspacePdfSource } from "../pdfSource";
import { ScientPdfReader } from "../ScientPdfReader";
import {
  pdfRevealDocumentKey,
  requestPdfReveal,
  resetPdfRevealRequests,
} from "./pdfRevealRequests";

/** A minimal text PDF: one Helvetica line per entry, one page per array. */
function pdfBytes(pages: ReadonlyArray<ReadonlyArray<string>>): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesIndex = objects.length + 1;
  add("PAGES");
  const pageIds: number[] = [];
  for (const lines of pages) {
    const text = lines
      .map((line, index) => `BT /F1 14 Tf 72 ${700 - index * 24} Td (${line}) Tj ET`)
      .join("\n");
    add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    const contents = objects.length;
    add(
      `<< /Type /Page /Parent ${pagesIndex} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 1 0 R >> >> >>`,
    );
    pageIds.push(objects.length);
  }
  objects[pagesIndex - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  add(`<< /Type /Catalog /Pages ${pagesIndex} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const environmentId = EnvironmentId.make("environment-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const source = workspacePdfSource({
  environmentId,
  fileName: "paper.pdf",
  workspaceRoot: "/project",
  relativePath: "papers/paper.pdf",
});
const QUOTE = "coupling constant scales";

function blobResolver(bytes: Uint8Array): PdfSourceResolver {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/pdf" }));
  const resolution = {
    _tag: "Success" as const,
    url,
    expiresAt: Number.MAX_SAFE_INTEGER,
    refresh: () => undefined,
  };
  return { useResolve: () => resolution };
}

async function waitForText(container: HTMLElement, text: string): Promise<Text> {
  let found: Text | null = null;
  await vi.waitFor(
    () => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (node.parentElement?.closest(".textLayer") && node.data.includes(text)) {
          found = node;
          return;
        }
      }
      throw new Error(`text layer does not show "${text}" yet`);
    },
    { timeout: 15_000, interval: 50 },
  );
  return found!;
}

function textNode(container: HTMLElement, text: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest(".textLayer") && node.data.includes(text)) return node;
  }
  throw new Error(`no "${text}" in the text layer`);
}

function highlightedText(): string[] {
  const texts: string[] = [];
  for (const [name, highlight] of CSS.highlights) {
    if (!name.startsWith("scient-pdf-citation-")) continue;
    for (const range of highlight) texts.push((range as Range).toString());
  }
  return texts;
}

/** Drags a selection over `text` the way a pointer would: down, select, up. */
async function selectText(node: Text, text: string) {
  node.parentElement!.scrollIntoView({ block: "center" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const range = document.createRange();
  range.setStart(node, node.data.indexOf(text));
  range.setEnd(node, node.data.indexOf(text) + text.length);
  const box = range.getBoundingClientRect();
  const at = { clientX: box.right, clientY: box.bottom - 2, button: 0, isPrimary: true };
  await act(async () => {
    node.parentElement!.dispatchEvent(new PointerEvent("pointerdown", { ...at, bubbles: true }));
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    window.dispatchEvent(new PointerEvent("pointerup", at));
    window.dispatchEvent(new MouseEvent("mouseup", { ...at, detail: 1 }));
  });
}

/**
 * Selects `text` and returns the Ask in chat button. Layout can still scroll
 * while pdf.js settles, which dismisses a pending action exactly as it would
 * for a person, so the gesture is repeated until the reader is still.
 */
async function askAbout(node: () => Text, text: string): Promise<HTMLButtonElement> {
  return vi.waitFor(
    async () => {
      await selectText(node(), text);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const element = document.querySelector<HTMLButtonElement>("[data-pdf-ask-in-chat]");
      if (!element || element.getAttribute("aria-label") !== "Ask in chat") {
        throw new Error(`no Ask in chat yet (${element?.getAttribute("aria-label") ?? "none"})`);
      }
      return element;
    },
    { timeout: 10_000, interval: 100 },
  );
}

describe("PDF quotes in the reader", () => {
  let root: Root;
  let container: HTMLDivElement;
  const citeText = vi.fn<(citation: ComposerCitation) => boolean>(() => true);
  const composerRef = { current: { citeText } as unknown as ChatComposerHandle };

  const render = async (bytes: Uint8Array) => {
    await act(async () => {
      root.render(
        // The app renders in StrictMode; its development replay must not drop a pending quote.
        <StrictMode>
          <ComposerHandleContext value={composerRef as RefObject<ChatComposerHandle | null>}>
            <div style={{ width: 800, height: 900, display: "flex" }}>
              <ScientPdfReader
                source={source}
                resolver={blobResolver(bytes)}
                readerScope="thread-1"
                citeThread={threadRef}
              />
            </div>
          </ComposerHandleContext>
        </StrictMode>,
      );
    });
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    citeText.mockClear();
    resetPdfRevealRequests();
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it(
    "quotes selected text into the chat and shows it again from the quote",
    { timeout: 40_000 },
    async () => {
      const bytes = pdfBytes([
        ["Introduction"],
        ["Results", `The ${QUOTE} as the inverse square.`],
      ]);
      await render(bytes);
      await waitForText(container, QUOTE);
      const button = await askAbout(() => textNode(container, QUOTE), QUOTE);
      await act(async () => button.click());

      expect(citeText).toHaveBeenCalledTimes(1);
      const citation = citeText.mock.calls[0]![0] as PdfCitation;
      expect(citation.kind).toBe("pdf");
      expect(citation.threadId).toBe("thread-1");
      expect(pdfCitationText(citation)).toBe(QUOTE);
      expect(citation.target.selector.pages.map((page) => page.page)).toEqual([2]);
      expect(citation.target.document.locator).toEqual({
        _tag: "workspace",
        workspaceRoot: "/project",
        relativePath: "papers/paper.pdf",
      });

      // A chip click files a reveal for this document; the open reader shows it.
      await act(async () => {
        requestPdfReveal(pdfRevealDocumentKey(source), citation.target);
      });
      await vi.waitFor(() => expect(highlightedText().join("")).toBe(QUOTE), { timeout: 10_000 });
    },
  );

  it("finds a quote again by its text after the PDF changed", async () => {
    const original = pdfBytes([
      ["Introduction"],
      ["Results", `The ${QUOTE} as the inverse square.`],
    ]);
    await render(original);
    await waitForText(container, QUOTE);
    const button = await askAbout(() => textNode(container, QUOTE), QUOTE);
    await act(async () => button.click());
    const citation = citeText.mock.calls[0]![0] as PdfCitation;

    // The rebuilt PDF gained a page before the result.
    await act(async () => root.render(null));
    await render(
      pdfBytes([
        ["Title page"],
        ["Introduction"],
        ["Results", `Now the ${QUOTE} as the inverse cube.`],
      ]),
    );
    // The reader reopens where it was read last (page 2), so wait for that page.
    await waitForText(container, "Introduction");
    const notices = vi.spyOn(toastManager, "add");
    await act(async () => {
      requestPdfReveal(pdfRevealDocumentKey(source), citation.target);
    });
    await vi.waitFor(() => expect(highlightedText().join("")).toBe(QUOTE), { timeout: 10_000 });
    // Its stored position (page 2) no longer holds it: it was found by its text, and said so.
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Quote found by its text" }),
    );
    expect(
      textNode(container, QUOTE).parentElement!.closest(".page")!.getAttribute("data-page-number"),
    ).toBe("3");
  }, 40_000);

  it("shows a quote asked for before its reader opened, once the PDF has loaded", async () => {
    const bytes = pdfBytes([["Introduction"], ["Results", `The ${QUOTE} as the inverse square.`]]);
    await render(bytes);
    await waitForText(container, QUOTE);
    const button = await askAbout(() => textNode(container, QUOTE), QUOTE);
    await act(async () => button.click());
    const citation = citeText.mock.calls[0]![0] as PdfCitation;
    await act(async () => root.render(null));

    // The chip files its reveal first; the reader opens afterwards and claims it.
    await act(async () => {
      requestPdfReveal(pdfRevealDocumentKey(source), citation.target);
    });
    await render(bytes);
    await vi.waitFor(() => expect(highlightedText().join("")).toBe(QUOTE), { timeout: 15_000 });
  }, 40_000);
});
