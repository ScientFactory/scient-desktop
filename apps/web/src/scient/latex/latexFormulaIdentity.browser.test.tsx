import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

const key = "browser-formula-identity";
const original = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Prose with \textbf{marked words} and \(\frac{x^2+1}{y+2}\), followed by several words that wrap around the formula. Here is \(\hat{z}+\sum_{k=1}^{n} k\) and more text.
\end{document}`;
let container: HTMLDivElement;
let root: Root;
let current: string;
beforeEach(async () => {
  clearVisualDraft(key);
  await page.viewport(1300, 900);
  container = document.createElement("div");
  container.style.cssText = "width:1000px;height:900px;display:flex;flex-direction:column";
  document.body.append(container);
  root = createRoot(container);
  current = original;
});
afterEach(() => {
  root.unmount();
  container.remove();
  clearVisualDraft(key);
});

async function open() {
  function Harness() {
    const [source, setSource] = useState(current);
    const owner = useLatexVisualTestOwner(source);
    return (
      <LatexVisualEditor
        draftKey={key}
        fileRevision="r1"
        source={source}
        sourceSnapshot={owner.snapshot}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === current);
          if (!outcome.accepted) return outcome;
          current = outcome.snapshot.source;
          setSource(current);
          return outcome;
        }}
      />
    );
  }
  root.render(<Harness />);
  const editor = () =>
    (
      container.querySelector(".scient-latex-visual-document") as
        | (HTMLElement & { editor?: Editor })
        | null
    )?.editor;
  await expect.poll(editor).toBeTruthy();
  await expect
    .poll(() => container.querySelectorAll('[data-math-reading-view="true"]').length)
    .toBe(2);
  return editor()!;
}

it("keeps formula views through a prose edit, source publication and undo", async () => {
  const editor = await open();
  const maths = [...container.querySelectorAll('[data-math-reading-view="true"]')];
  editor.view.dispatch(editor.state.tr.insertText("More ", 1));
  await expect.poll(() => current).toBe(original.replace("Prose with", "More Prose with"));
  expect([...container.querySelectorAll('[data-math-reading-view="true"]')]).toEqual(maths);
  expect(container.querySelector("math-field")).toBeNull();
  editor.commands.undo();
  await expect.poll(() => current).toBe(original);
  expect([...container.querySelectorAll('[data-math-reading-view="true"]')]).toEqual(maths);
});
