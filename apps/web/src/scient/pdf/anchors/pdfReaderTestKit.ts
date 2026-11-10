import type { PdfSourceResolver } from "@scientfactory/document-artifacts";
import { expect, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers } from "../../../../test/render";
import { waitForTestReceipt } from "../../../../test/receipt";

/** A minimal text PDF: one Helvetica line per entry, one page per array. */
export function pdfBytes(pages: ReadonlyArray<ReadonlyArray<string>>): Uint8Array {
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

export function blobResolver(bytes: Uint8Array, urls: Set<string>): PdfSourceResolver {
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

export async function waitForText(container: HTMLElement, text: string): Promise<Text> {
  await expect.element(page.getByRole("textbox", { name: "Page number" })).toBeEnabled();
  return vi.waitFor(() => textNode(container, text));
}

export function textNode(container: HTMLElement, text: string): Text {
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

/** Drags a selection over `text` the way a pointer would: down, select, up. */
export async function selectText(node: Text, text: string, signal: AbortSignal) {
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
