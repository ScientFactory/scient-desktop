import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";

import { act, render } from "../../../../test/render";
import { workspacePdfSource } from "../pdfSource";
import { ScientPdfReader } from "../ScientPdfReader";
import { blobResolver, pdfBytes } from "./pdfReaderTestKit";
import { clearPdfReveals, pdfRevealDocumentKey, requestPdfPageReveal } from "./pdfRevealRequests";

const PAGES = [["Cover"], ["Preface"], ["Chapter one"], ["Chapter one, continued"], ["Notes"]];
// Pages 1 and 2 are numbered i and ii; from page 3 on, 1, 2, 3.
const LABELS = "/PageLabels << /Nums [0 << /S /r >> 2 << /S /D >>] >>";

function setup() {
  const stack = new DisposableStack();
  clearPdfReveals();
  stack.defer(() => clearPdfReveals());
  const urls = new Set<string>();
  stack.defer(() => {
    for (const url of urls) URL.revokeObjectURL(url);
  });
  const source = workspacePdfSource({
    environmentId: EnvironmentId.make("environment-1"),
    fileName: "book.pdf",
    workspaceRoot: "/project",
    relativePath: `books/${randomUUID()}.pdf`,
  });
  const reader = (labels: string) => (
    <div style={{ width: "min(800px, 100vw)", height: "100dvh", display: "flex" }}>
      <ScientPdfReader source={source} resolver={blobResolver(pdfBytes(PAGES, labels), urls)} />
    </div>
  );
  return { source, reader, [Symbol.dispose]: () => stack.dispose() };
}

const pageNumber = () => page.getByRole("textbox", { name: "Page number" });

describe("Showing a cited page", () => {
  it("goes to the page printed with the cited number, not the page with that number", async () => {
    using fixture = setup();
    requestPdfPageReveal(pdfRevealDocumentKey(fixture.source), "2");
    await using _screen = await render(fixture.reader(LABELS));
    await expect.element(pageNumber()).toHaveValue("4");
  });

  it("goes to the page with that number when the PDF prints none, and says when there is none", async () => {
    using fixture = setup();
    using notices = vi.spyOn(toastManager, "add");
    requestPdfPageReveal(pdfRevealDocumentKey(fixture.source), "3");
    await using _screen = await render(fixture.reader(""));
    await expect.element(pageNumber()).toHaveValue("3");

    await act(async () => {
      requestPdfPageReveal(pdfRevealDocumentKey(fixture.source), "xii");
    });
    await vi.waitFor(() =>
      expect(notices).toHaveBeenCalledWith(
        expect.objectContaining({ title: "This PDF has no page xii" }),
      ),
    );
    await expect.element(pageNumber()).toHaveValue("3");
  });
});
