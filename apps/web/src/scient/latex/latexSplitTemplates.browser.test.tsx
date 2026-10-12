import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor as ProseEditor } from "@tiptap/core";
import type { Editor } from "@pierre/diffs/edit";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/assets/assetUrls")>()),
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { EditableFileEditor, useFileLineReveal } from "~/components/files/FilePreviewPanel";
import { sourcePosition } from "../math/input/sourceAdapter";
import { latexTextSelectionRects } from "./latexTextSelectionRects";
import type { MathfieldElement } from "mathlive";
import template26 from "./fixtures/hebrew-math-and-tables.tex?raw";
import template28 from "./fixtures/mock-medical-article.tex?raw";
import "~/index.css";
import "./scient-latex.css";

let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  root?.unmount();
  host?.remove();
});
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
async function settleRect(measure: () => DOMRect) {
  let previous = "",
    since = 0;
  await expect
    .poll(
      () => {
        const rect = measure();
        const key = [rect.left, rect.top, rect.width, rect.height]
          .map((value) => value.toFixed(1))
          .join(",");
        if (key !== previous) {
          previous = key;
          since = performance.now();
        }
        return performance.now() - since >= 300;
      },
      { timeout: 15_000, interval: 50 },
    )
    .toBe(true);
}
async function mount(input: string, name: string) {
  await page.viewport(1300, 900);
  host = document.createElement("div");
  host.style.cssText = "width:1250px;height:840px;display:flex";
  host.dataset.testid = "split-browser-host";
  host.setAttribute("data-latex-split", "true");
  document.body.append(host);
  root = createRoot(host);
  let sourceEditor: Editor<"file", unknown, undefined> | undefined;
  let current = input;
  const reveals: { from: number; to: number; precise?: boolean }[] = [];
  function Harness() {
    const [source, setSource] = useState(input);
    const [reveal, setReveal] = useState<{
      source: string;
      from: number;
      to: number;
      requestId: number;
    }>();
    const { onPostRender } = useFileLineReveal(
      `${name}.txt`,
      reveal ? source.slice(0, reveal.from).split("\n").length : null,
      reveal?.requestId ?? -1,
      false,
    );
    return (
      <>
        <div className="scient-latex-pane" style={{ width: 500, height: 840, display: "flex" }}>
          <EditableFileEditor
            environmentId={"split-browser" as never}
            cwd="/debug"
            relativePath={`${name}.txt`}
            composerDraftTarget={"draft:split" as never}
            contents={source}
            revision="1"
            resolvedTheme="light"
            revealRequestId={reveal?.requestId ?? -1}
            wordWrap
            retainSelectionOnBlur
            sourceSelectionReveal={reveal}
            onPostRender={(container, instance, context) => {
              sourceEditor = (instance as unknown as { editor: typeof sourceEditor }).editor;
              onPostRender(container, instance, context);
            }}
            onContentsChange={(value) => {
              current = value;
              setSource(value);
            }}
            enableFileComments={false}
          />
        </div>
        <div style={{ width: 710, height: 840, display: "flex" }}>
          <LatexVisualEditor
            source={source}
            draftKey={`split-browser-${name}`}
            fileRevision="1"
            disabled={false}
            onEdit={(expected, next) => {
              if (expected !== current) return false;
              current = next;
              setSource(next);
              return true;
            }}
            onEditingChange={() => {}}
            onOpenSource={() => {}}
            resolveSourceOwner={(source, from, to) => ({
              path: name,
              rootRelativePath: name,
              source,
              baselineSource: source,
              from,
              to,
            })}
            onRevealSource={(owner) => {
              reveals.push(owner);
              setReveal({
                source: owner.source,
                from: owner.from,
                to: owner.to,
                requestId: reveals.length,
              });
            }}
          />
        </div>
      </>
    );
  }
  root.render(<Harness />);
  await expect
    .poll(
      () =>
        host.querySelector<HTMLElement & { editor: ProseEditor }>(".scient-latex-visual-document")
          ?.editor,
    )
    .toBeTruthy();
  await expect
    .poll(
      () => host.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-content]"),
      { timeout: 15_000 },
    )
    .toBeTruthy();
  await userEvent.click(
    host
      .querySelector("diffs-container")!
      .shadowRoot!.querySelector<HTMLElement>("[data-content]")!,
    { position: { x: 100, y: 10 } },
  );
  await expect.poll(() => sourceEditor?.getFile(), { timeout: 15_000 }).toBeTruthy();
  const visual = host.querySelector<HTMLElement & { editor: ProseEditor }>(
    ".scient-latex-visual-document",
  )!.editor;
  return { visual, source: () => sourceEditor!, reveals, text: () => current };
}
function wordPosition(root: HTMLElement | ShadowRoot, word: string, scroll = true) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const field =
      node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? node : null;
    if (!field && node.nodeType !== Node.TEXT_NODE) continue;
    const index = (field?.value ?? node.textContent)?.indexOf(word) ?? -1;
    if (index < 0) continue;
    const element = field ?? node.parentElement!;
    if (element.closest("button,[role=button]") || (!field && element.closest("textarea,input")))
      continue;
    if (scroll) element.scrollIntoView({ block: "center" });
    let box: DOMRect | undefined;
    if (field) box = latexTextSelectionRects(field, index, index + word.length)[0];
    else {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + word.length);
      box = range.getBoundingClientRect();
    }
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const bounds = element.getBoundingClientRect();
    return {
      element,
      position: {
        x: box.left + box.width / 2 - bounds.left,
        y: box.top + box.height / 2 - bounds.top,
      },
    };
  }
  throw new Error(`Missing word: ${word}`);
}
it.each([
  ["26", template26, "פסקה"],
  ["26-abstract", template26, "מסמך"],
  ["26-abstract-line-end", template26, "ניסוי"],
  ["26-rtl-line-start", template26, "זו"],
  ["26-rtl-line-end", template26, "לתצוגה"],
  ["26-bold", template26, "מודגש"],
  ["26-italic", template26, "נטוי"],
  ["26-vowels", template26, "שָׁלוֹם"],
  ["26-mixed-english", template26, "Mixed"],
  ["26-nested-list", template26, "הזחה"],
  ["26-heading", template26, "ומשפטים"],
  ["26-table", template26, "ראשונה"],
  ["26-caption", template26, "וחצים"],
  ["26-title", template26, "נוספים"],
  ["26-author", template26, "מחבר"],
  ["26-date", template26, "אוקטובר"],
  ["26-proof", template26, "הוספת"],
  ["26-theorem", template26, "מתקיים"],
  ["26-description", template26, "ונוסחאות"],
  ["26-figure-body", template26, "חיצוני"],
  ["26-footnote", template26, "ובה"],
  ["26-code", template26, "return"],
  ["28", template28, "Early"],
] as const)(
  "template %s: native word selection updates Source without jumping, then survives pane handoff",
  async (name, source, word) => {
    const state = await mount(source, name);
    if (name === "26-footnote") {
      await page
        .getByRole("button", { name: "Return to footnote 1 marker", exact: true })
        .nth(0)
        .click();
      await page.getByRole("button", { name: "Edit text", exact: true }).click();
      await expect.poll(() => host.querySelector('[aria-label="Footnote text"]')).toBeTruthy();
    }
    const scroll = host.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
    wordPosition(state.visual.view.dom, word);
    await frame();
    await settleRect(() =>
      wordPosition(state.visual.view.dom, word, false).element.getBoundingClientRect(),
    );
    const hit = wordPosition(state.visual.view.dom, word, false);
    state.visual.view.dom.dataset.testid = "active-visual-editor";
    let before = scroll.scrollTop;
    const pointer = () => {
      before = scroll.scrollTop;
      host.removeEventListener("pointerdown", pointer, true);
    };
    host.addEventListener("pointerdown", pointer, true);
    const cell = hit.element.closest<HTMLElement>("[data-table-cell]");
    if (cell) {
      const bounds = hit.element.getBoundingClientRect(),
        cellBounds = cell.getBoundingClientRect();
      await page
        .getByRole("textbox", { name: cell.getAttribute("aria-label")!, exact: true })
        .nth(0)
        .dblClick({
          position: {
            x: bounds.left + hit.position.x - cellBounds.left,
            y: bounds.top + hit.position.y - cellBounds.top,
          },
        });
    } else if (name === "26-code") {
      const field = state.visual.view.dom.querySelector<HTMLElement>(
        '[aria-label="Literal text"]',
      )!;
      const bounds = hit.element.getBoundingClientRect(),
        fieldBounds = field.getBoundingClientRect();
      await page
        .getByRole("textbox", { name: "Literal text", exact: true })
        .nth(0)
        .dblClick({
          position: {
            x: bounds.left + hit.position.x - fieldBounds.left,
            y: bounds.top + hit.position.y - fieldBounds.top,
          },
        });
    } else if (
      hit.element instanceof HTMLTextAreaElement ||
      hit.element instanceof HTMLInputElement
    ) {
      await page
        .getByRole("textbox", { name: hit.element.getAttribute("aria-label")!, exact: true })
        .nth(0)
        .dblClick({ position: hit.position });
    } else if (hit.element.closest("h1,h2,h3,h4,h5,h6")) {
      await page
        .getByRole("heading", { name: new RegExp(word) })
        .nth(0)
        .dblClick({ position: hit.position });
    } else {
      await page
        .getByTestId("active-visual-editor")
        .nth(0)
        .getByText(word, { exact: false })
        .nth(0)
        .dblClick({ position: hit.position });
    }
    await expect.poll(() => state.reveals.length).toBe(1);
    const mapped = state.reveals[0]!;
    expect(source.slice(mapped.from, mapped.to).trim()).toBe(word);
    const field = document.activeElement;
    expect(
      field instanceof HTMLTextAreaElement
        ? field.value.slice(field.selectionStart, field.selectionEnd).trim()
        : document.getSelection()?.toString().trim(),
    ).toBe(word);
    expect(Math.abs(scroll.scrollTop - before)).toBeLessThanOrEqual(2);
    await expect
      .poll(() => state.source().getViewState().selections?.[0]?.start)
      .toEqual(sourcePosition(source, mapped.from));
    expect(state.source().getViewState().selections?.[0]?.end).toEqual(
      sourcePosition(source, mapped.to),
    );
    expect(state.visual.view.dom.contains(document.activeElement)).toBe(true);
    const selection = state.source().getViewState().selections;
    state.visual.view.dom.dataset.testid = "active-visual-split";
    await page
      .getByTestId("active-visual-split")
      .nth(0)
      .click({ position: { x: 100, y: 100 } });
    expect(state.source().getViewState().selections).toEqual(selection);
    const container = host.querySelector("diffs-container")!;
    await expect
      .poll(
        () =>
          getComputedStyle(container.shadowRoot!.querySelector<HTMLElement>("[data-caret]")!)
            .visibility,
      )
      .toBe("visible");
    const sourceHit = wordPosition(container.shadowRoot!, word);
    await userEvent.dblClick(sourceHit.element, { position: sourceHit.position });
    await frame();
    const manuallySelected = state.source().getViewState().selections;
    await page
      .getByTestId("active-visual-split")
      .nth(0)
      .click({ position: { x: 100, y: 100 } });
    expect(state.source().getViewState().selections).toEqual(manuallySelected);
    expect(state.text()).toBe(source);
  },
  30_000,
);

it("a Source interaction cancels a queued Visual reveal before it can replace Source selection", async () => {
  const state = await mount(template26, "cancel-source");
  const hit = wordPosition(state.visual.view.dom, "פסקה");
  const bounds = hit.element.getBoundingClientRect();
  const before = state.source().getViewState().selections;
  hit.element.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      clientX: bounds.left + hit.position.x,
      clientY: bounds.top + hit.position.y,
    }),
  );
  host.dispatchEvent(new CustomEvent("scient-latex-source-interaction"));
  await frame();
  expect(state.reveals).toHaveLength(0);
  expect(state.source().getViewState().selections).toEqual(before);
}, 30_000);

it.each([
  ["matrix", "pmatrix", "4", "4"],
  ["cases", "cases", "0", "x\\geq0,"],
  ["aligned", "x-y", "−", null],
] as const)(
  "template 26: clicking inside %s reveals its authored cell",
  async (name, match, word, expected) => {
    const state = await mount(template26, `26-math-${name}`);
    let mathNode: HTMLElement | null = null;
    state.visual.state.doc.descendants((node, at) => {
      if (
        !mathNode &&
        node.type.name === "latexDisplayMath" &&
        String(node.attrs.tex).includes(match)
      )
        mathNode = state.visual.view.nodeDOM(at) as HTMLElement;
    });
    expect(mathNode).toBeTruthy();
    const shell = mathNode as unknown as HTMLElement;
    shell.scrollIntoView({ block: "center" });
    await frame();
    await settleRect(() => shell.getBoundingClientRect());
    shell.dataset.testid = "active-math-shell";
    await page.getByTestId("active-math-shell").nth(0).click();
    const field = () =>
      [...state.visual.view.dom.querySelectorAll<MathfieldElement>("math-field")].find((field) =>
        field.value.replace(/\s+/gu, "").includes(match),
      )!;
    await expect
      .poll(() => field()?.shadowRoot?.querySelector(".ML__latex"), { timeout: 15_000 })
      .toBeTruthy();
    field().scrollIntoView({ block: "center" });
    await frame();
    const glyph = () => {
      const math = field();
      for (let at = 1; at <= math.lastOffset; at++) {
        const info = math.getElementInfo(at);
        if (info?.latex === word.replace("−", "-") && info.bounds && info.bounds.width > 0)
          return info.bounds;
      }
      return null;
    };
    await expect.poll(glyph).toBeTruthy();
    const bounds = glyph()!,
      rootBounds = field().getBoundingClientRect();
    field().dataset.testid = "active-math-field";
    await page
      .getByTestId("active-math-field")
      .nth(0)
      .dblClick({
        position: {
          x: bounds.left + bounds.width / 2 - rootBounds.left,
          y: bounds.top + bounds.height / 2 - rootBounds.top,
        },
      });
    await expect.poll(() => state.reveals.length).toBe(1);
    const range = state.reveals[0]!;
    const selected = template26.slice(range.from, range.to).trim();
    if (expected) expect(selected).toBe(expected);
    else {
      const start = template26.indexOf("(x-y)^2");
      expect(range.from).toBeGreaterThanOrEqual(start);
      expect(range.to).toBeLessThanOrEqual(template26.indexOf("\\end{align}", start));
      expect(selected).toContain("-");
    }
    await expect
      .poll(() => state.source().getViewState().selections?.[0]?.start)
      .toEqual(sourcePosition(template26, range.from));
    expect(state.text()).toBe(template26);
  },
  30_000,
);
