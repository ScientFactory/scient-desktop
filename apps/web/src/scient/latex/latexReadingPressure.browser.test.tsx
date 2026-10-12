import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
vi.mock("./latexReadingCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./latexReadingCache")>();
  return { ...actual, latexReadingCacheBudget: actual.createLatexReadingCacheBudget(64 * 1024) };
});
import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { latexReadingCacheBudget } from "./latexReadingCache";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

let root: Root | undefined;
let container: HTMLElement | undefined;
const key = "bounded-reading-pressure";
afterEach(() => {
  root?.unmount();
  container?.remove();
  clearVisualDraft(key);
});

it("pauses idle work under pressure, keeps live pages usable and resumes when space is freed", async () => {
  const source = String.raw`\documentclass{article}
\begin{document}
${Array.from(
  { length: 80 },
  (_, index) =>
    `Paragraph ${index}. ${"Prose wraps across the paper. ".repeat(8)} ` +
    String.raw`\(x_${index}^2+9137\).

\[y_${index}=\frac{x^2+9137}{2}\]`,
).join("\n\n")}
\end{document}`;
  let current = source;
  await page.viewport(1300, 900);
  container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:1000px;height:800px";
  document.body.append(container);
  function Harness() {
    const [value, setValue] = useState(source);
    const owner = useLatexVisualTestOwner(value);
    return (
      <LatexVisualEditor
        draftKey={key}
        fileRevision="r1"
        source={value}
        rootRelativePath="main.tex"
        relativePath="main.tex"
        cwd="/synthetic/pressure"
        sourceSnapshot={owner.snapshot}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === current);
          if (outcome.accepted) {
            current = outcome.snapshot.source;
            setValue(current);
          }
          return outcome;
        }}
      />
    );
  }
  root = createRoot(container);
  root.render(<Harness />);
  const getEditor = () =>
    (container!.querySelector(".scient-latex-visual-document") as HTMLElement & { editor?: Editor })
      ?.editor;
  await expect.poll(getEditor).toBeTruthy();
  const editor = getEditor()!;
  let measurements = 0;
  editor.view.dom.addEventListener("scient-latex-viewport-measure", () => measurements++);
  await expect.poll(() => editor.view.dom.dataset.latexOpening, { timeout: 30000 }).toBe("false");
  await expect
    .poll(() => latexReadingCacheBudget.statistics().capacityRejections, { timeout: 30000 })
    .toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const paused = measurements;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(measurements).toBe(paused);
  expect(Number(editor.view.dom.dataset.latexViewportPending)).toBeGreaterThan(0);
  expect(
    container.querySelector("[data-state='preparing'], [data-state='unavailable']"),
  ).toBeNull();

  // Expel reusable entries while the visible formulas remain mounted. This
  // must not turn live readiness into another preparation/measurement loop.
  const pressure = latexReadingCacheBudget.cache<number>("pressure-fixture");
  pressure.put("hold", 0, 64 * 1024 - 1024, true);
  editor.view.dom.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(measurements).toBe(paused);
  expect(editor.view.dom.dataset.latexOpening).toBe("false");
  expect(
    container.querySelector("[data-state='preparing'], [data-state='unavailable']"),
  ).toBeNull();
  pressure.delete("hold");
  const entriesAfterRelease = latexReadingCacheBudget.statistics().entries;
  await expect
    .poll(() => latexReadingCacheBudget.statistics().entries, { timeout: 15000 })
    .toBeGreaterThan(entriesAfterRelease);
  expect(latexReadingCacheBudget.statistics().peakBytes).toBeLessThanOrEqual(64 * 1024);
  expect(current).toBe(source);
}, 65000);
