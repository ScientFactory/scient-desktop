import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { latexPagedKey, pagedPositionAtPoint, pagedLayoutSettled } from "./latexPagedGeometry";
import { measureNatural } from "./latexNaturalMeasurement";
import { clearVisualDraft } from "./visualDrafts";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import template15 from "./fixtures/paging-long-table.tex?raw";
import template26 from "./fixtures/paging-hebrew.tex?raw";
import template28 from "./fixtures/paging-medical-article.tex?raw";
import "~/index.css";
import "./scient-latex.css";

let root: Root,
  host: HTMLElement,
  published: string,
  key = "";
afterEach(() => {
  root?.unmount();
  host?.remove();
  clearVisualDraft(key);
});
const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
async function mount(source: string, name: string) {
  await page.viewport(1250, 950);
  key = `paging-${name}`;
  clearVisualDraft(key);
  published = source;
  host = document.createElement("div");
  host.style.cssText = "width:1000px;height:900px;display:flex;flex-direction:column";
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const [value, setValue] = useState(source);
    const owner = useLatexVisualTestOwner(value);
    return (
      <LatexVisualEditor
        draftKey={key}
        fileRevision="r1"
        source={value}
        sourceSnapshot={owner.snapshot}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === published);
          if (outcome.accepted) {
            published = outcome.snapshot.source;
            setValue(published);
          }
          return outcome;
        }}
      />
    );
  }
  root.render(<Harness />);
  const editor = () =>
    (
      host.querySelector(".scient-latex-visual-document") as
        | (HTMLElement & { editor?: Editor })
        | null
    )?.editor;
  await expect
    .poll(
      () => ({
        editor: !!editor(),
        loading: editor()?.view.dom.hasAttribute("data-latex-loading"),
        plan: !!editor() && !!latexPagedKey.getState(editor()!.state)?.plan,
      }),
      { timeout: 25000 },
    )
    .toMatchObject({ editor: true, loading: false, plan: true });
  await document.fonts.ready;
  await expect
    .poll(
      () => [...host.querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady),
      { timeout: 25000 },
    )
    .toBe(true);
  await frames();
  await expect.poll(() => pagedLayoutSettled(editor()!.view), { timeout: 25000 }).toBe(true);
  return editor()!;
}

it.each([
  ["15", template15, 2],
  ["26", template26, 4],
  ["28", template28, 3],
] as const)(
  "template %s has the compiled PDF's page count and opens without source or undo changes",
  async (name, source, pages) => {
    const editor = await mount(source, name);
    await expect
      .poll(() => latexPagedKey.getState(editor.state)?.plan?.pages, { timeout: 15000 })
      .toBe(pages);
    expect(published).toBe(source);
    expect(undoDepth(editor.state)).toBe(0);
    expect(host.querySelectorAll(".scient-latex-page-sheet")).toHaveLength(pages);
    const screenshotDirectory = import.meta.env.VITE_SCIENT_PAGING_SCREENSHOTS;
    if (screenshotDirectory) {
      await page.viewport(1250, 1700);
      host.style.height = "1650px";
      const scroll = host.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
      scroll.style.flex = "none";
      scroll.style.height = `${host.querySelector(".scient-latex-page-sheet")!.getBoundingClientRect().height + 20}px`;
      const spacer = document.createElement("div");
      spacer.style.height = "700px";
      scroll.append(spacer);
      await frames();
      for (let number = 1; number <= pages; number++) {
        const sheet = host.querySelector<HTMLElement>(
          `.scient-latex-page-sheet[data-page="${number}"]`,
        )!;
        scroll.scrollTop +=
          sheet.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 10;
        await frames();
        await page.screenshot({
          path: `${screenshotDirectory}/${name}-visual-${number}.png`,
          element: scroll,
        });
      }
      spacer.remove();
    }
  },
);

it("template 15 repeats furniture at the next printable origin and preserves every editable row", async () => {
  const editor = await mount(template15, "longtable");
  await expect
    .poll(() => host.querySelectorAll('[data-paged-repeat="true"]').length)
    .toBeGreaterThan(0);
  expect(host.querySelectorAll("tr[data-latex-table-row]")).toHaveLength(41);
  const dimensions = latexPagedKey.getState(editor.state)!.plan!.dimensions;
  const paper = editor.view.dom.getBoundingClientRect();
  const scale = paper.width / editor.view.dom.offsetWidth;
  const head = host.querySelector<HTMLElement>(
    '[data-paged-repeat="true"][data-latex-longtable-band="head"]',
  )!;
  expect(
    Math.abs(
      (head.getBoundingClientRect().top - paper.top) / scale -
        dimensions.height -
        dimensions.gap -
        dimensions.top,
    ),
  ).toBeLessThan(2);
  expect(published).toBe(template15);
});
it("mirrors body margins on facing pages while retaining authored paragraph positions", async () => {
  const source = String.raw`\documentclass[twoside,a5paper]{article}
\usepackage[inner=20mm,outer=30mm,top=18mm,bottom=18mm,bindingoffset=5mm]{geometry}
\begin{document}
First page text.
\newpage
Second page text.
\end{document}`;
  const editor = await mount(source, "facing-pages");
  const paragraphs = [...editor.view.dom.querySelectorAll("p")];
  const scale = editor.view.dom.getBoundingClientRect().width / editor.view.dom.offsetWidth;
  expect(
    (paragraphs[1]!.getBoundingClientRect().left - paragraphs[0]!.getBoundingClientRect().left) /
      scale,
  ).toBeCloseTo((5 * 96) / 25.4, 0);
  expect(published).toBe(source);
});

it("a paragraph can cross both columns and pages while every visible text fragment maps to its original position", async () => {
  const source = String.raw`\documentclass[twocolumn,a5paper]{article}
\usepackage[margin=18mm]{geometry}
\begin{document}
${Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ")}
\end{document}`;
  const editor = await mount(source, "long-paragraph");
  const state = latexPagedKey.getState(editor.state)!;
  expect(state.geometry.some((part) => part.column === 1)).toBe(true);
  expect(state.geometry.some((part) => part.page === 1)).toBe(true);
  const scroll = editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  for (const part of state.geometry.filter((part) => part.column === 1).slice(0, 3)) {
    const rect = editor.view.coordsAtPos(part.from + 1);
    scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - 100;
    await frames();
    const visible = editor.view.coordsAtPos(part.from + 1);
    const position = pagedPositionAtPoint(
      editor.view,
      visible.left + 1,
      (visible.top + visible.bottom) / 2,
    );
    expect(position).toBeGreaterThanOrEqual(part.from);
    expect(position).toBeLessThan(part.to);
  }
  expect(published).toBe(source);
  const target = state.geometry.find((part) => part.column === 1)!;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target.from + 2)),
  );
  editor.view.focus();
  await userEvent.keyboard("Z");
  await expect.poll(() => published).toContain("Z");
  editor.commands.undo();
  await expect.poll(() => published).toBe(source);
});

it("template 28 keeps its title full width, restores two columns and renders running furniture as text", async () => {
  const editor = await mount(template28, "article");
  const paper = editor.view.dom.getBoundingClientRect();
  const scale = paper.width / editor.view.dom.offsetWidth;
  const dimensions = latexPagedKey.getState(editor.state)!.plan!.dimensions;
  for (const [text, pageNumber] of [
    ["Methods", 2],
    ["Discussion", 3],
  ] as const) {
    const heading = [...host.querySelectorAll<HTMLElement>('[data-layout="macroHeading"]')].find(
      (element) => element.textContent?.trim() === text,
    )!;
    const expected =
      paper.top +
      ((pageNumber - 1) * (dimensions.height + dimensions.gap) + dimensions.top) * scale;
    const offset = (heading.getBoundingClientRect().top - expected) / scale;
    // The source adds heading skips; both headings must begin in their page's first lines.
    expect(offset).toBeGreaterThanOrEqual(-1);
    expect(offset).toBeLessThan(3 * parseFloat(getComputedStyle(editor.view.dom).lineHeight));
  }
  const tables = [...host.querySelectorAll("table")];
  expect(tables).toHaveLength(2);
  expect(parseFloat(getComputedStyle(tables[1]!).fontSize)).toBeCloseTo(
    parseFloat(getComputedStyle(tables[0]!).fontSize),
    2,
  );
  const title = host.querySelector<HTMLElement>('[data-layout="fullWidthTitle"]')!;
  const paragraph = host.querySelector<HTMLElement>('[data-layout="sourceColumns"] p')!;
  expect(title.getBoundingClientRect().width).toBeGreaterThan(
    paragraph.getBoundingClientRect().width * 1.8,
  );
  expect(host.querySelector(".scient-latex-running-header")!.textContent).toContain(
    "Northbridge Journal",
  );
  expect(host.querySelector(".scient-latex-running-header")!.textContent).not.toContain(
    "\\scriptsize",
  );
  expect(latexPagedKey.getState(editor.state)?.geometry.some((part) => part.column === 1)).toBe(
    true,
  );
});

it("detached measurements preserve mixed-script paragraph line heights", async () => {
  const editor = await mount(template26, "natural-parity");
  const scale = editor.view.dom.getBoundingClientRect().width / editor.view.dom.offsetWidth;
  let checked = 0;
  for (const element of editor.view.dom.querySelectorAll<HTMLElement>(":scope > p")) {
    if (element.querySelector(".scient-latex-pagination-gap,.scient-paged-line,math-field"))
      continue;
    const height = measureNatural(
      editor.view,
      element,
      (copy) => copy.getBoundingClientRect().height,
    );
    const live = measureNatural(
      editor.view,
      element,
      (copy) => copy.getBoundingClientRect().height / scale,
      true,
    );
    expect(height, element.textContent ?? "paragraph").toBeCloseTo(live, 0);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
});
