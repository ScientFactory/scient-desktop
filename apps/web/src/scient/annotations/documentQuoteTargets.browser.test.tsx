import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { toastManager } from "~/components/ui/toast";

import { render } from "../../../test/render";
import { quoteInDocument, useDocumentQuoteTarget } from "./documentQuoteTargets";
import type { DocumentQuote } from "./quoteFormat";

const quote: DocumentQuote = {
  quote: "Deep sleep doubled recall.",
  pages: [4],
  citationKey: "smith2024sleep",
  fileName: "sleep.pdf",
};

function Editor(props: {
  readonly name: string;
  readonly root: string;
  readonly insert: (quote: DocumentQuote) => boolean;
}) {
  useDocumentQuoteTarget({
    root: props.root,
    label: props.name,
    element: () => document.querySelector<HTMLElement>(`[aria-label="${props.name}"]`),
    insert: props.insert,
  });
  return <textarea aria-label={props.name} />;
}

describe("Quote in my document", () => {
  it("goes to the document of this project that was focused last", async () => {
    const draft = vi.fn(() => true);
    const notes = vi.fn(() => true);
    const elsewhere = vi.fn(() => true);
    await using _screen = await render(
      <>
        <Editor name="draft.md" root="/project" insert={draft} />
        <Editor name="notes.tex" root="/project/" insert={notes} />
        <Editor name="other.md" root="/other" insert={elsewhere} />
      </>,
    );
    using notices = vi.spyOn(toastManager, "add");
    (page.getByRole("textbox", { name: "draft.md" }).element() as HTMLElement).focus();
    (page.getByRole("textbox", { name: "other.md" }).element() as HTMLElement).focus();
    await quoteInDocument("/project", quote);
    expect(draft).toHaveBeenCalledWith(quote);
    expect(notes).not.toHaveBeenCalled();
    expect(elsewhere).not.toHaveBeenCalled();
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ title: "Quoted in draft.md" }));
  });

  it("copies the quote when no document of this project can take it", async () => {
    const readOnly = vi.fn(() => false);
    await using _screen = await render(
      <Editor name="draft.md" root="/project" insert={readOnly} />,
    );
    using copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    using notices = vi.spyOn(toastManager, "add");
    await quoteInDocument("/project", quote);
    expect(copy).toHaveBeenCalledWith("> Deep sleep doubled recall. [@smith2024sleep, p. 4]");
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ title: "Quote copied" }));
  });
});
