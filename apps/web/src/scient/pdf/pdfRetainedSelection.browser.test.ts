import { afterEach, expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { installPdfRetainedSelection } from "./pdfRetainedSelection";

let root: HTMLElement;
let stop: () => void;
afterEach(() => {
  stop?.();
  root?.remove();
  document.getSelection()?.removeAllRanges();
});

it("retains the selected PDF word while Source has its own native selection", async () => {
  root = document.createElement("div");
  root.dataset.latexSplit = "true";
  const pdf = document.createElement("div"),
    layer = document.createElement("div"),
    word = document.createElement("span");
  layer.className = "textLayer";
  word.textContent = "chosen";
  layer.append(word);
  pdf.append(layer);
  const source = document.createElement("div");
  source.contentEditable = "true";
  source.textContent = "different";
  root.append(pdf, source);
  document.body.append(root);
  stop = installPdfRetainedSelection(pdf);
  await userEvent.dblClick(word);
  expect(document.getSelection()?.toString()).toBe("chosen");
  await userEvent.dblClick(source);
  expect(document.getSelection()?.toString()).toBe("different");
  const highlight = [...CSS.highlights.entries()].find(([name]) =>
    name.startsWith("scient-pdf-retained-"),
  );
  expect(highlight).toBeTruthy();
  expect([...highlight![1]][0]!.toString()).toBe("chosen");
  await userEvent.click(word);
  expect(CSS.highlights.has(highlight![0])).toBe(false);
});
