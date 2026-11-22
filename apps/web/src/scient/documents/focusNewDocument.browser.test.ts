import { expect, it } from "vite-plus/test";

import { focusNewDocumentWhenOpen } from "./focusNewDocument";

it("focuses the new document name field with a translated accessible label", async () => {
  using cleanup = new DisposableStack();
  const page = document.createElement("div");
  page.className = "scient-latex-surface";
  const editor = document.createElement("div");
  editor.className = "scient-latex-visual-document";
  editor.contentEditable = "true";
  editor.textContent = "Document body";
  const name = document.createElement("input");
  name.setAttribute("aria-label", "Dokumentname");
  name.dataset.documentName = "";
  page.append(name, editor);
  document.body.append(page);
  cleanup.defer(() => page.remove());

  focusNewDocumentWhenOpen("title", 1_000);
  await expect.poll(() => document.activeElement).toBe(name);
});
