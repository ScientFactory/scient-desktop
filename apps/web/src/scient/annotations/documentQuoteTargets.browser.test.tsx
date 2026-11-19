import { EnvironmentId } from "@t3tools/contracts";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { toastManager } from "~/components/ui/toast";

import { render } from "../../../test/render";
import { quoteInDocument, useDocumentQuoteTarget } from "./documentQuoteTargets";
import { markdownQuote, type DocumentQuote } from "./quoteFormat";

const quote: DocumentQuote = {
  quote: "Deep sleep doubled recall.",
  pages: [4],
  citationKey: "smith2024sleep",
  fileName: "sleep.pdf",
};

const environmentId = EnvironmentId.make("remote-a");
const otherEnvironmentId = EnvironmentId.make("remote-b");

function Editor(props: {
  readonly name: string;
  readonly root: string;
  readonly environmentId: EnvironmentId;
  readonly insert?: (quote: DocumentQuote) => boolean;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useDocumentQuoteTarget({
    environmentId: props.environmentId,
    root: props.root,
    label: props.name,
    element: () => editorRef.current,
    insert: (passage) => {
      if (props.insert) return props.insert(passage);
      const editor = editorRef.current;
      if (!editor) return false;
      editor.setRangeText(markdownQuote(passage).markdown);
      return true;
    },
  });
  return <textarea ref={editorRef} aria-label={props.name} />;
}

describe("Quote in my document", () => {
  it("goes to the document of this project that was focused last", async () => {
    const draft = vi.fn(() => true);
    const notes = vi.fn(() => true);
    const elsewhere = vi.fn(() => true);
    await using _screen = await render(
      <>
        <Editor name="draft.md" environmentId={environmentId} root="/project" insert={draft} />
        <Editor name="notes.tex" environmentId={environmentId} root="/project/" insert={notes} />
        <Editor name="other.md" environmentId={environmentId} root="/other" insert={elsewhere} />
      </>,
    );
    using notices = vi.spyOn(toastManager, "add");
    (page.getByRole("textbox", { name: "draft.md" }).element() as HTMLElement).focus();
    (page.getByRole("textbox", { name: "other.md" }).element() as HTMLElement).focus();
    await quoteInDocument(environmentId, "/project", quote);
    expect(draft).toHaveBeenCalledWith(quote);
    expect(notes).not.toHaveBeenCalled();
    expect(elsewhere).not.toHaveBeenCalled();
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ title: "Quoted in draft.md" }));
  });

  it("copies the quote when no document of this project can take it", async () => {
    const readOnly = vi.fn(() => false);
    await using _screen = await render(
      <Editor name="draft.md" environmentId={environmentId} root="/project" insert={readOnly} />,
    );
    using copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    using notices = vi.spyOn(toastManager, "add");
    await quoteInDocument(environmentId, "/project", quote);
    expect(copy).toHaveBeenCalledWith("> Deep sleep doubled recall. [@smith2024sleep, p. 4]");
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ title: "Quote copied" }));
  });

  it("isolates same-root remote editors regardless of focus and copies for an absent environment", async () => {
    await using _screen = await render(
      <>
        <Editor name="remote-a.md" environmentId={environmentId} root="/workspace/project" />
        <Editor name="remote-b.md" environmentId={otherEnvironmentId} root="/workspace/project" />
      </>,
    );
    using copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const first = page.getByRole("textbox", { name: "remote-a.md" });
    const second = page.getByRole("textbox", { name: "remote-b.md" });
    (second.element() as HTMLElement).focus();

    await quoteInDocument(environmentId, "/workspace/project", quote);
    await expect.element(first).toHaveValue(markdownQuote(quote).markdown);
    await expect.element(second).toHaveValue("");
    expect(copy).not.toHaveBeenCalled();

    (first.element() as HTMLElement).focus();
    await quoteInDocument(otherEnvironmentId, "/workspace/project", quote);
    await expect.element(first).toHaveValue(markdownQuote(quote).markdown);
    await expect.element(second).toHaveValue(markdownQuote(quote).markdown);
    expect(copy).not.toHaveBeenCalled();

    await quoteInDocument(EnvironmentId.make("remote-without-editor"), "/workspace/project", quote);
    expect(copy).toHaveBeenCalledExactlyOnceWith(markdownQuote(quote).markdown);
    await expect.element(first).toHaveValue(markdownQuote(quote).markdown);
    await expect.element(second).toHaveValue(markdownQuote(quote).markdown);
  });
});
