import {
  EnvironmentId,
  ThreadId,
  type ComposerCitation,
  type OfficeCitation,
} from "@t3tools/contracts";
import { createRef, type RefObject } from "react";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { ComposerHandleContext } from "~/composerHandleContext";
import { act, render } from "../../../test/render";
import { OfficeFileContext, openOfficeCitation } from "./officeQuote";
import { ScientOfficeReader, type OfficeReaderDocument } from "./ScientOfficeReader";
import "~/index.css";

const texts = ["Cover letter", "The study and the study design", "Results of the study"];

function fakeDocument(): OfficeReaderDocument {
  return {
    kind: "document",
    pages: texts.map(() => ({ width: 400, height: 520 })),
    paint: async () => {},
    thumbnail: async () => {},
    find: async (query) =>
      texts.flatMap((text, index) => {
        const count = text.toLowerCase().split(query.toLowerCase()).length - 1;
        return count ? [{ index, count }] : [];
      }),
  };
}

it("finds across pages, marks each match and moves to the next page that has one", async () => {
  const scrollRef = createRef<(index: number, y?: number) => void>();
  await using _screen = await render(
    <div style={{ display: "flex", height: 600, width: 700 }}>
      <ScientOfficeReader
        document={fakeDocument()}
        scrollRef={scrollRef}
        overlay={(index) => (
          <div className="absolute inset-0 text-[20px]">
            {/* A header Word's find does not count: marked, but never the match find stands on. */}
            <span data-office-aside>Study header</span>
            <br />
            <span>{texts[index]}</span>
          </div>
        )}
        onError={(error) => {
          throw error;
        }}
      />
    </div>,
    { router: false },
  );
  await page.getByRole("textbox", { name: "Search document" }).fill("study");
  await expect.element(page.getByText("1/3")).toBeVisible();
  // Page 2's two body matches and its header's are marked; find stands on the first body one.
  await vi.waitFor(() => {
    const marks = document.querySelectorAll('[aria-label="Page 2"] [aria-hidden] > div');
    expect([...marks].map((mark) => mark.hasAttribute("data-active"))).toEqual([
      false,
      true,
      false,
    ]);
  });
  await expect.element(page.getByLabelText("Page number")).toHaveValue("2");
  await page.getByRole("button", { name: "Next result" }).click();
  await page.getByRole("button", { name: "Next result" }).click();
  await expect.element(page.getByText("3/3")).toBeVisible();
  await expect.element(page.getByLabelText("Page number")).toHaveValue("3");
});

it("zooms by steps, fits the width and shows a sidebar of pages", async () => {
  await using _screen = await render(
    <div style={{ display: "flex", height: 600, width: 700 }}>
      <ScientOfficeReader
        document={fakeDocument()}
        scrollRef={createRef()}
        onError={(error) => {
          throw error;
        }}
      />
    </div>,
    { router: false },
  );
  // A page narrower than the view shows at its own size until the reader zooms.
  await expect.element(page.getByRole("button", { name: /^Fit width, zoom 100%/ })).toBeVisible();
  await page.getByRole("button", { name: /^Zoom in/ }).click();
  await expect.element(page.getByRole("button", { name: /^Fit width, zoom 105%/ })).toBeVisible();
  // Fit width fills the 700px view less its margins (and a scrollbar, where one takes room).
  await page.getByRole("button", { name: /^Fit width/ }).click();
  await expect
    .element(page.getByRole("button", { name: /^Fit width, zoom 1[56]\d%/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Show document sidebar" }).click();
  await expect.element(page.getByRole("button", { name: "Go to page 3" })).toBeVisible();
});

it("quotes selected text with its page, and shows a quote opened from the chat on its page", async () => {
  const citeText = vi.fn<(citation: ComposerCitation) => boolean>(() => true);
  const composerRef = { current: { citeText } as unknown as ChatComposerHandle };
  const thread = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread") };
  await using _screen = await render(
    <ComposerHandleContext value={composerRef as RefObject<ChatComposerHandle | null>}>
      <OfficeFileContext value={{ citeThread: thread, cwd: "/project", path: "notes/study.docx" }}>
        <div style={{ display: "flex", height: 600, width: 700 }}>
          <ScientOfficeReader
            document={fakeDocument()}
            scrollRef={createRef()}
            overlay={(index) => (
              <div className="absolute inset-0 select-text text-[20px]">
                <span>{texts[index]}</span>
              </div>
            )}
            onError={(error) => {
              throw error;
            }}
          />
        </div>
      </OfficeFileContext>
    </ComposerHandleContext>,
    { router: false },
  );
  const span = await vi.waitFor(() => {
    const found = [...document.querySelectorAll("span")].find(
      (node) => node.textContent === texts[1],
    );
    expect(found).toBeDefined();
    return found!;
  });
  const text = span.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 4);
  range.setEnd(text, 9);
  const box = range.getBoundingClientRect();
  const at = { clientX: box.right, clientY: box.bottom - 2, button: 0, isPrimary: true };
  await act(async () => {
    span.dispatchEvent(new PointerEvent("pointerdown", { ...at, bubbles: true }));
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    window.dispatchEvent(new PointerEvent("pointerup", at));
    window.dispatchEvent(new MouseEvent("mouseup", { ...at, detail: 1 }));
  });
  await page.getByRole("button", { name: "Ask in chat", exact: true }).click();
  expect(citeText).toHaveBeenCalledOnce();
  expect(citeText.mock.calls[0]![0]).toMatchObject({
    kind: "office",
    cwd: "/project",
    path: "notes/study.docx",
    unit: "page",
    page: 2,
    text: "study",
  });

  const quote = { ...(citeText.mock.calls[0]![0] as OfficeCitation), page: 3, text: "Results" };
  await act(() => openOfficeCitation(quote, "/project", (_surface, run) => run()));
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[data-office-page="3"] [data-active]')).toHaveLength(1),
  );
  await expect.element(page.getByLabelText("Page number")).toHaveValue("3");
});
