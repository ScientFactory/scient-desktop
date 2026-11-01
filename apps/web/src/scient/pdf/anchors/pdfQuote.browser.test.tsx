import type { PdfSourceResolver } from "@scientfactory/document-artifacts";
import {
  EnvironmentId,
  ThreadId,
  pdfCitationText,
  type ComposerCitation,
  type PdfCitation,
} from "@t3tools/contracts";
import { StrictMode, type RefObject } from "react";
import { describe, expect, it, vi, type TestContext } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render as renderScreen, type Screen } from "../../../../test/render";
import { waitForTestReceipt } from "../../../../test/receipt";
import { PDF_READER_SESSION_STORAGE_KEY, pdfReaderSessionStore } from "../pdfReaderSessionStore";
import "~/index.css";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { toastManager } from "~/components/ui/toast";
import { ComposerHandleContext } from "~/composerHandleContext";
import { randomUUID } from "~/lib/utils";

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

function blobResolver(bytes: Uint8Array, urls: Set<string>): PdfSourceResolver {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/pdf" }));
  urls.add(url);
  const resolution = {
    _tag: "Success" as const,
    url,
    expiresAt: Number.MAX_SAFE_INTEGER,
    refresh: () => undefined,
  };
  return { useResolve: () => resolution };
}

async function waitForText(container: HTMLElement, text: string): Promise<Text> {
  await expect.element(page.getByRole("textbox", { name: "Page number" })).toBeEnabled();
  return vi.waitFor(() => textNode(container, text));
}

function textNode(container: HTMLElement, text: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (
      node.parentElement?.closest(".textLayer") &&
      !node.parentElement.closest(".scient-pdf-staging") &&
      node.data.includes(text)
    )
      return node;
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
function observeQuoteHighlight(text: string) {
  const receipt = Promise.withResolvers<void>();
  const set = CSS.highlights.set.bind(CSS.highlights);
  const observer = vi.spyOn(CSS.highlights, "set").mockImplementation((name, highlight) => {
    const result = set(name, highlight);
    if (highlightedText().join("") === text) receipt.resolve();
    return result;
  });
  return {
    receipt: receipt.promise,
    [Symbol.dispose]: () => observer.mockRestore(),
  };
}

/** Drags a selection over `text` the way a pointer would: down, select, up. */
async function selectText(node: Text, text: string, signal: AbortSignal) {
  using _clock = fakeTimers();
  const viewport = node.parentElement!.closest<HTMLElement>(".scient-pdf-viewer-container")!;
  const before = { top: viewport.scrollTop, left: viewport.scrollLeft };
  const scrolled = Promise.withResolvers<void>();
  const onScrollEnd = () => scrolled.resolve();
  viewport.addEventListener("scrollend", onScrollEnd);
  using _scroll = {
    [Symbol.dispose]: () => viewport.removeEventListener("scrollend", onScrollEnd),
  };
  node.parentElement!.scrollIntoView({ block: "center", behavior: "instant" });
  if (viewport.scrollTop !== before.top || viewport.scrollLeft !== before.left) {
    await waitForTestReceipt(signal, scrolled.promise);
  }
  // Responsive layout chains animation callbacks; finish it before the one gesture.
  const resized = Promise.withResolvers<void>();
  const onResizeScroll = () => resized.resolve();
  viewport.addEventListener("scrollend", onResizeScroll, { once: true });
  try {
    const beforeResize = { top: viewport.scrollTop, left: viewport.scrollLeft };
    await act(() => vi.runAllTimersAsync());
    if (viewport.scrollTop !== beforeResize.top || viewport.scrollLeft !== beforeResize.left) {
      await waitForTestReceipt(signal, resized.promise);
    }
  } finally {
    viewport.removeEventListener("scrollend", onResizeScroll);
  }
  // Native input flushes the newly mounted reader's passive selection owners.
  await userEvent.click(node.parentElement!);
  const target = textNode(viewport, text);
  const range = document.createRange();
  range.setStart(target, target.data.indexOf(text));
  range.setEnd(target, target.data.indexOf(text) + text.length);
  const box = range.getBoundingClientRect();
  const at = { clientX: box.right, clientY: box.bottom - 2, button: 0, isPrimary: true };
  await act(async () => {
    target.parentElement!.dispatchEvent(new PointerEvent("pointerdown", { ...at, bubbles: true }));
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    window.dispatchEvent(new PointerEvent("pointerup", at));
    window.dispatchEvent(new MouseEvent("mouseup", { ...at, detail: 1 }));
  });
  // The selection timeout schedules its animation callback; finish both before restoring the clock.
  await act(() => vi.runAllTimersAsync());
  expect(document.getSelection()?.toString()).toBe(text);
}

async function askAbout(node: Text, text: string, context: TestContext) {
  const receipt = Promise.withResolvers<void>();
  const check = () => {
    if (document.querySelector("[data-pdf-ask-in-chat]")) receipt.resolve();
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    await selectText(node, text, context.signal);
    check();
    await waitForTestReceipt(context.signal, receipt.promise);
    const button = page.getByRole("button", { name: "Ask in chat", exact: true });
    await expect.element(button).toBeVisible();
    return button.element() as HTMLButtonElement;
  } finally {
    observer.disconnect();
  }
}

function setup() {
  const stack = new AsyncDisposableStack();
  const savedStorage = localStorage.getItem(PDF_READER_SESSION_STORAGE_KEY);
  stack.defer(() => {
    pdfReaderSessionStore.flush();
    if (savedStorage === null) localStorage.removeItem(PDF_READER_SESSION_STORAGE_KEY);
    else localStorage.setItem(PDF_READER_SESSION_STORAGE_KEY, savedStorage);
    document.getSelection()?.removeAllRanges();
    resetPdfRevealRequests();
  });
  resetPdfRevealRequests();
  const urls = new Set<string>();
  stack.defer(() => {
    for (const url of urls) URL.revokeObjectURL(url);
  });
  const citeText = vi.fn<(citation: ComposerCitation) => boolean>(() => true);
  const composerRef = { current: { citeText } as unknown as ChatComposerHandle };
  const readerScope = `pdf-quote-test:${randomUUID()}`;
  const container = document.createElement("div");
  let screen: Screen | undefined;
  return {
    container,
    citeText,
    async render(bytes: Uint8Array) {
      const ui = (
        // The app's development replay must not drop a pending quote.
        <StrictMode>
          <ComposerHandleContext value={composerRef as RefObject<ChatComposerHandle | null>}>
            <div style={{ width: "min(800px, 100vw)", height: "100dvh", display: "flex" }}>
              <ScientPdfReader
                source={source}
                resolver={blobResolver(bytes, urls)}
                readerScope={readerScope}
                citeThread={threadRef}
              />
            </div>
          </ComposerHandleContext>
        </StrictMode>
      );
      if (screen) await screen.rerender(ui);
      else screen = stack.use(await renderScreen(ui, { container }));
    },
    async clear() {
      await screen?.rerender(null);
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("PDF quotes in the reader", () => {
  it("quotes selected text into the chat and shows it again from the quote", async (context) => {
    await using fixture = setup();
    const { container, citeText } = fixture;
    const bytes = pdfBytes([["Introduction"], ["Results", `The ${QUOTE} as the inverse square.`]]);
    await fixture.render(bytes);
    await waitForText(container, QUOTE);
    const button = await askAbout(textNode(container, QUOTE), QUOTE, context);
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
    using highlight = observeQuoteHighlight(QUOTE);
    await act(async () => {
      requestPdfReveal(pdfRevealDocumentKey(source), citation.target);
    });
    await waitForTestReceipt(context.signal, highlight.receipt);
    expect(highlightedText().join("")).toBe(QUOTE);
  });

  it("finds a quote again by its text after the PDF changed", async (context) => {
    await using fixture = setup();
    const { container, citeText } = fixture;
    const original = pdfBytes([
      ["Introduction"],
      ["Results", `The ${QUOTE} as the inverse square.`],
    ]);
    await fixture.render(original);
    await waitForText(container, QUOTE);
    const button = await askAbout(textNode(container, QUOTE), QUOTE, context);
    await act(async () => button.click());
    const citation = citeText.mock.calls[0]![0] as PdfCitation;

    // The rebuilt PDF gained a page before the result.
    await fixture.clear();
    await fixture.render(
      pdfBytes([
        ["Title page"],
        ["Introduction"],
        ["Results", `Now the ${QUOTE} as the inverse cube.`],
      ]),
    );
    // The reader reopens where it was read last (page 2), so wait for that page.
    await waitForText(container, "Introduction");
    using notices = vi.spyOn(toastManager, "add");
    using highlight = observeQuoteHighlight(QUOTE);
    await act(async () => {
      requestPdfReveal(pdfRevealDocumentKey(source), citation.target);
    });
    await waitForTestReceipt(context.signal, highlight.receipt);
    expect(highlightedText().join("")).toBe(QUOTE);
    // Its stored position (page 2) no longer holds it: it was found by its text, and said so.
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Quote found by its text" }),
    );
    expect(
      textNode(container, QUOTE).parentElement!.closest(".page")!.getAttribute("data-page-number"),
    ).toBe("3");
  });

  it("shows a quote asked for before its reader opened, once the PDF has loaded", async (context) => {
    await using fixture = setup();
    const { container, citeText } = fixture;
    const bytes = pdfBytes([["Introduction"], ["Results", `The ${QUOTE} as the inverse square.`]]);
    await fixture.render(bytes);
    await waitForText(container, QUOTE);
    const button = await askAbout(textNode(container, QUOTE), QUOTE, context);
    await act(async () => button.click());
    const citation = citeText.mock.calls[0]![0] as PdfCitation;
    await fixture.clear();

    // The chip files its reveal first; the reader opens afterwards and claims it.
    using highlight = observeQuoteHighlight(QUOTE);
    await act(async () => {
      requestPdfReveal(pdfRevealDocumentKey(source), citation.target);
    });
    await fixture.render(bytes);
    await waitForTestReceipt(context.signal, highlight.receipt);
    expect(highlightedText().join("")).toBe(QUOTE);
  });
});
