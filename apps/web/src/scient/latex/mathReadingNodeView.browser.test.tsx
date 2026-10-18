import { useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import type { Editor } from "@tiptap/core";
import type { MathfieldElement } from "mathlive";
import { NodeSelection } from "@tiptap/pm/state";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
const readiness = vi.hoisted(() => ({ hold: false }));
vi.mock("./mathFieldReadiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mathFieldReadiness")>();
  return {
    observeMathFieldReadiness: (...args: Parameters<typeof actual.observeMathFieldReadiness>) =>
      readiness.hold ? () => {} : actual.observeMathFieldReadiness(...args),
  };
});

import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { isMacKeyboard } from "../keyboard/keys";
import { clearVisualDraft } from "./visualDrafts";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { refreshMathReadingContext, type MathReadingNodeOptions } from "./mathReadingNodeView";
import "./scient-latex.css";

let host: HTMLDivElement;
let root: Root;
let source: string;
let replace: (source: string) => void;
let setDisabled: (disabled: boolean) => void;
const draftKey = "synthetic-math-reading-node-qualification";
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
const readers = () => [...host.querySelectorAll<HTMLElement>("[data-math-reading-view]")];
const editor = () => (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
const markup = (element: Element) =>
  element
    .querySelector(".scient-latex-math-preview")
    ?.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent;

afterEach(async () => {
  readiness.hold = false;
  root?.unmount();
  host?.remove();
  clearVisualDraft(draftKey);
  await frame();
});

it.each([
  String.raw`Before $\frac{1}{\frac{x}{y}}$ after.`,
  String.raw`\begin{align}x&=y\\z&=w\end{align}`,
])(
  "keeps the original formula and page geometry visible through held editor readiness: %s",
  async (body) => {
    await mount(body);
    const original = source;
    const reading = readers()[0]!;
    const preview = reading.querySelector<HTMLElement>(".scient-latex-math-preview")!;
    const ink = markup(reading);
    const before = reading.getBoundingClientRect();
    const rows = [...reading.querySelectorAll("[data-latex-equation-row]")];
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await expect.poll(() => reading.dataset.mathEditorAdmission).toBe("pending");
    await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
    for (let paint = 0; paint < 8; paint++) {
      await frame();
      expect(preview.isConnected && !preview.hidden).toBe(true);
      expect(markup(reading)).toBe(ink);
      expect(Math.abs(reading.getBoundingClientRect().height - before.height)).toBeLessThan(1);
      expect(Math.abs(reading.getBoundingClientRect().width - before.width)).toBeLessThan(1);
      expect(rows.every((row) => row.isConnected)).toBe(true);
    }
    const field = reading.querySelector<MathfieldElement>("math-field")!;
    field.dataset.scientMathReady = "true";
    await expect.poll(() => reading.dataset.mathEditorAdmission).toBeUndefined();
    await expect.poll(() => field.hasFocus()).toBe(true);
    expect(preview.isConnected).toBe(false);
    expect(Math.abs(reading.getBoundingClientRect().height - before.height)).toBeLessThan(1);
    expect(source).toBe(original);
    await frame();
    expect(document.activeElement).toBe(field);
    field.position = body.includes("align") ? 2 : field.lastOffset;
    await userEvent.keyboard("+q");
    expect(field.getValue()).toContain("q");
    await expect.poll(() => source).not.toBe(original);
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.poll(() => source).toBe(original);
  },
);

it("cancels held admission on a newer outside focus intent and leaves the reading ink intact", async () => {
  await mount("Before $x+y$ after.");
  const original = source;
  const reading = readers()[0]!;
  const ink = markup(reading);
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
  const outside = document.createElement("button");
  outside.textContent = "Other action";
  outside.style.cssText = "position:fixed;right:8px;top:8px;z-index:99999";
  document.body.append(outside);
  try {
    await userEvent.click(outside);
    await frame();
    expect(reading.querySelector("math-field")).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(markup(reading)).toBe(ink);
    expect(source).toBe(original);
  } finally {
    outside.remove();
  }
});

it("protects the pending equation from typing, IME, paste and drop without changing source", async () => {
  await mount("Before $x+y$ after.");
  const original = source;
  const model = editor().state.doc;
  const reading = readers()[0]!;
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
  expect(document.activeElement).toBe(reading.querySelector("[data-node-view-wrapper]"));
  expect((document.activeElement as HTMLElement).isContentEditable).toBe(false);
  const data = new DataTransfer();
  data.setData("text/plain", "replacement");
  const events = [
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
    new CompositionEvent("compositionstart", { data: "字", bubbles: true, cancelable: true }),
    new InputEvent("beforeinput", {
      data: "字",
      inputType: "insertCompositionText",
      bubbles: true,
      cancelable: true,
    }),
  ];
  for (const event of events) {
    editor().view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  await userEvent.keyboard("q");
  await frame();
  expect(source).toBe(original);
  expect(editor().state.doc).toBe(model);
  document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
  editor().commands.setTextSelection(2);
  await frame();
  expect(reading.querySelector("math-field")).toBeNull();
});

it("preserves an outside focus change immediately after publication through MathLive's delayed focus", async () => {
  await mount("Before $x+y$ after.");
  const original = source;
  const reading = readers()[0]!;
  const outside = document.createElement("button");
  outside.textContent = "New focus";
  document.body.append(outside);
  try {
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
    reading.querySelector<HTMLElement>("math-field")!.dataset.scientMathReady = "true";
    await new Promise<void>((resolve) => {
      const check = () => {
        if (reading.dataset.mathEditorAdmission === "pending") requestAnimationFrame(check);
        else {
          outside.focus();
          resolve();
        }
      };
      requestAnimationFrame(check);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(document.activeElement).toBe(outside);
    expect(source).toBe(original);
  } finally {
    outside.remove();
  }
});

it("lets a new user click return to math during the initial outside-focus guard", async () => {
  await mount("Before $x+y$ after.");
  const original = source;
  const reading = readers()[0]!;
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
    const math = reading.querySelector<MathfieldElement>("math-field")!;
    math.dataset.scientMathReady = "true";
    await new Promise<void>((resolve) => {
      const check = () => {
        if (reading.dataset.mathEditorAdmission === "pending") requestAnimationFrame(check);
        else {
          outside.focus();
          resolve();
        }
      };
      requestAnimationFrame(check);
    });
    await userEvent.click(math);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(document.activeElement).toBe(math);
    expect(source).toBe(original);
  } finally {
    outside.remove();
  }
});

it.each(["selection", "readonly", "source"])(
  "cancels delayed publication after a newer %s change",
  async (change) => {
    await mount("Before $x+y$ after.");
    const original = source;
    const reading = readers()[0]!;
    readiness.hold = true;
    await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
    await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
    if (change === "selection") editor().commands.setTextSelection(2);
    else if (change === "readonly") setDisabled(true);
    else replace(original.replace("x+y", "z+w"));
    await expect.poll(() => host.querySelector("[data-math-editor-staging]")).toBeNull();
    expect(host.querySelector("math-field")).toBeNull();
    expect(source).toBe(change === "source" ? original.replace("x+y", "z+w") : original);
  },
);

it("leaves readable ink and Retry when an editor never becomes ready", async () => {
  await mount("Before $x+y$ after.");
  const original = source;
  const reading = readers()[0]!;
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect
    .poll(() => reading.querySelector("button")?.textContent, { timeout: 6000 })
    .toBe("Retry");
  expect(reading.querySelector("math-field")).toBeNull();
  expect(markup(reading)).toContain("x");
  expect(source).toBe(original);
});

it("refreshes passive ink after context cancellation and retries a failed editor without a stale hint", async () => {
  await mount(String.raw`Before $\foo$ after.`, String.raw`\newcommand{\foo}{x}`);
  const original = source;
  const reading = readers()[0]!;
  readiness.hold = true;
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
  const extension = editor().extensionManager.extensions.find(
    (extension) => extension.name === "latexInlineMath",
  )!;
  const context = (extension.options as MathReadingNodeOptions).readingContext!();
  const previous = context.macros;
  try {
    Object.assign(context, { macros: { ...previous, foo: "z" } });
    refreshMathReadingContext(editor());
    await expect.poll(() => markup(reading)).toContain("z");
    expect(reading.querySelector("math-field")).toBeNull();
  } finally {
    Object.assign(context, { macros: previous });
    refreshMathReadingContext(editor());
  }
  await userEvent.click(reading.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect.poll(() => reading.querySelector("math-field")).toBeTruthy();
  reading.querySelector<HTMLElement>("math-field")!.dataset.scientMathReady = "failed";
  await expect.poll(() => reading.querySelector("button")?.textContent).toBe("Retry");
  expect(markup(reading)).toContain("x");
  expect(source).toBe(original);
  readiness.hold = false;
  await userEvent.click(reading.querySelector<HTMLButtonElement>("button")!);
  await expect
    .poll(() => reading.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  expect(reading.querySelector(".scient-latex-math-admission-hint")).toBeNull();
  expect(source).toBe(original);
});

async function mount(body: string, preamble = "") {
  await page.viewport(1400, 900);
  source = `\\documentclass{article}\n\\usepackage{amsmath}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}`;
  clearVisualDraft(draftKey);
  host = document.createElement("div");
  host.style.cssText = "width:1200px;height:850px;position:relative;background:white;color:black";
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const [text, setText] = useState(source);
    const owner = useLatexVisualTestOwner(text);
    const [disabled, updateDisabled] = useState(false);
    useLayoutEffect(() => {
      replace = (next) => {
        source = next;
        setText(next);
      };
      setDisabled = updateDisabled;
    }, []);
    return (
      <LatexVisualEditor
        draftKey={draftKey}
        fileRevision="synthetic-r1"
        source={text}
        sourceSnapshot={owner.snapshot}
        disabled={disabled}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onEdit={(request) => {
          const outcome = owner.edit(request, request.edit.source === source);
          if (outcome.accepted) replace(outcome.snapshot.source);
          return outcome;
        }}
      />
    );
  }
  root.render(<Harness />);
  await expect.poll(() => readers().length).toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        readers().every((element) =>
          mathReadingPreviewReady(element.querySelector(".scient-latex-math-preview")!),
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await document.fonts.ready;
  await frame();
}

it("reads many formulas without live editors and retains document selection", async () => {
  await mount(Array.from({ length: 64 }, (_, i) => `Paragraph ${i}: $x_${i}+y$.`).join("\n\n"));
  const original = source;
  expect(readers()).toHaveLength(64);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  expect(readers().every((element) => markup(element)?.includes("x"))).toBe(true);
  editor().commands.selectAll();
  await frame();
  expect(host.querySelectorAll("[data-document-selected]")).toHaveLength(64);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  expect(source).toBe(original);
});

it("the first click enters only its formula and native typing can be undone", async () => {
  await mount("Before $a+b+c+d+e+f+g+h$ after.\n\n\\[u+v\\]");
  const original = source;
  const field = readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!;
  await userEvent.click(field);
  await expect
    .poll(() => host.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  const math = host.querySelector<MathfieldElement>("math-field")!;
  await frame();
  expect(readers()).toHaveLength(1);
  expect(host.querySelectorAll("math-field")).toHaveLength(1);
  expect(
    [...host.querySelectorAll(".scient-latex-math-preview")].every(
      (preview) => preview.shadowRoot?.querySelector("[data-math-preview-content]")?.textContent,
    ),
  ).toBe(true);
  // A click in the middle must place the caret there rather than at the end.
  expect(math.position).toBeLessThan(math.lastOffset);
  expect(editor().state.selection).toBeInstanceOf(NodeSelection);
  await userEvent.keyboard("q");
  await expect.poll(() => source).toContain("q");
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.poll(() => source).toBe(original);
  expect(math.hasFocus()).toBe(true);
});

it("macro-only changes and numbering refresh passive views without rewriting source", async () => {
  await mount(
    "Before.\n\n\\begin{equation}\\readingmacro+y\\end{equation}\n\n\\begin{equation}z\\end{equation}",
    "\\newcommand{\\readingmacro}{x}",
  );
  expect(readers().map(markup)[0]).toContain("x");
  expect(
    [...host.querySelectorAll("[data-latex-equation-row]")].map((element) => element.textContent),
  ).toEqual(["(1)", "(2)"]);
  const next = source.replace("{\\readingmacro}{x}", "{\\readingmacro}{w}");
  replace(next);
  await expect.poll(() => readers().map(markup)[0]).toContain("w");
  expect(source).toBe(next);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  const current = editor();
  let first = -1;
  current.state.doc.forEach((node, position) => {
    if (first < 0 && node.type.name === "latexDisplayMath") first = position;
  });
  current.view.dispatch(
    current.state.tr.delete(first, first + current.state.doc.nodeAt(first)!.nodeSize),
  );
  await expect
    .poll(() =>
      [...host.querySelectorAll("[data-latex-equation-row]")].map((element) => element.textContent),
    )
    .toEqual(["(1)"]);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
});

it("read-only formulas stay readable and become editable when enabled", async () => {
  await mount("Before $x+y$ after.\n\n\\[z^2\\]");
  const original = source;
  setDisabled(true);
  await expect.poll(() => editor().isEditable).toBe(false);
  await userEvent.click(readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await frame();
  expect(readers()).toHaveLength(2);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  expect(source).toBe(original);
  setDisabled(false);
  await expect.poll(() => editor().isEditable).toBe(true);
  await userEvent.click(readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect
    .poll(() => host.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  expect(source).toBe(original);
});

it("clicking beside a display returns to prose without initializing math", async () => {
  await mount("Before.\n\n\\[x+y\\]\n\nAfter.");
  const original = source;
  const wrapper = readers()[0]!.querySelector<HTMLElement>(".scient-latex-visual-display-math")!;
  const bounds = wrapper.getBoundingClientRect();
  wrapper.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      composed: true,
      button: 0,
      clientX: bounds.right - 2,
      clientY: (bounds.top + bounds.bottom) / 2,
    }),
  );
  await frame();
  expect(editor().state.selection).not.toBeInstanceOf(NodeSelection);
  expect(host.querySelectorAll("math-field")).toHaveLength(0);
  await userEvent.keyboard("q");
  await expect.poll(() => source).toContain("qAfter.");
  await userEvent.keyboard(isMacKeyboard() ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}");
  await expect.poll(() => source).toBe(original);
});

it("equation tags return to the single-row CSS position after an external row change", async () => {
  const aligned = String.raw`\begin{align}x&=y\\z&=w\end{align}`;
  await mount(`Before.\n\n${aligned}`);
  await expect.poll(() => host.querySelectorAll("[data-latex-equation-row]").length).toBe(2);
  await userEvent.click(readers()[0]!.querySelector<HTMLElement>(".scient-latex-mathfield")!);
  await expect
    .poll(() => host.querySelector<MathfieldElement>("math-field")?.hasFocus())
    .toBe(true);
  await expect
    .poll(() => host.querySelector<HTMLElement>("[data-latex-equation-row]")?.style.top)
    .not.toBe("");
  const next = source.replace(aligned, String.raw`\begin{equation}u=v\end{equation}`);
  replace(next);
  await expect.poll(() => host.querySelectorAll("[data-latex-equation-row]").length).toBe(1);
  await expect
    .poll(() => host.querySelector<HTMLElement>("[data-latex-equation-row]")?.style.top)
    .toBe("");
  const row = host.querySelector<HTMLElement>("[data-latex-equation-row]")!;
  const formula = row.closest<HTMLElement>(".scient-latex-visual-display-math")!;
  const labelBounds = row.getBoundingClientRect();
  const formulaBounds = formula.getBoundingClientRect();
  expect(
    Math.abs(
      labelBounds.top + labelBounds.height / 2 - formulaBounds.top - formulaBounds.height / 2,
    ),
  ).toBeLessThan(1);
  expect(source).toBe(next);
});
