import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { latexPaginationKey } from "./latexVisualPaginationExtension";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
const audit = vi.hoisted(() => ({
  hold: false,
  holdContext: false,
  assetMode: "failure" as "failure" | "pending" | "ready",
  assetListeners: new Set<() => void>(),
  completions: [] as Array<{ source: string; cached: boolean }>,
}));
vi.mock("~/assets/assetUrls", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAssetUrlState: () => {
      const mode = useSyncExternalStore(
        (notify) => {
          audit.assetListeners.add(notify);
          return () => {
            audit.assetListeners.delete(notify);
          };
        },
        () => audit.assetMode,
      );
      const refresh = () => {
        audit.assetMode = "ready";
        for (const notify of audit.assetListeners) notify();
      };
      return mode === "ready"
        ? {
            _tag: "Success",
            refresh,
            url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="blue"/%3E%3C/svg%3E',
          }
        : { _tag: mode === "failure" ? "Failure" : "Pending", refresh };
    },
  };
});
vi.mock("./mathReadingPreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mathReadingPreview")>();
  return {
    ...actual,
    mathReadingPreview: (...args: Parameters<typeof actual.mathReadingPreview>) => {
      if (audit.holdContext || (audit.hold && args[0].includes("x_{30}"))) return () => {};
      const complete = args[4];
      args[4] = (markup, cached) => {
        audit.completions.push({ source: args[0], cached: cached === true });
        complete(markup, cached);
      };
      return actual.mathReadingPreview(...args);
    },
  };
});
import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { refreshMathReadingContext, type MathReadingNodeOptions } from "./mathReadingNodeView";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

let root: Root | undefined;
let container: HTMLElement | undefined;
let key = "";
afterEach(() => {
  audit.hold = false;
  audit.holdContext = false;
  audit.assetMode = "failure";
  audit.completions.length = 0;
  root?.unmount();
  container?.remove();
  clearVisualDraft(key);
});
const fixture = (count: number, generation: number) => String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
${Array.from(
  { length: count },
  (_, index) =>
    `Paragraph ${index}. ${"Scientific prose which wraps across the paper and remains source backed. ".repeat(5)} ` +
    String.raw`Inline \(x_{${index}}^2+${generation}\).

\[y_{${index}}=\frac{x^2+${generation}}{2}\]`,
).join("\n\n")}
\end{document}`;
async function mount(source: string, draftKey: string, waitForOpening = true) {
  key = draftKey;
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
        rootRelativePath="main.tex"
        relativePath="main.tex"
        cwd="/synthetic/reading-fixture"
        source={value}
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
  const editor = () =>
    (container!.querySelector(".scient-latex-visual-document") as HTMLElement & { editor?: Editor })
      ?.editor;
  await expect.poll(editor).toBeTruthy();
  if (waitForOpening)
    await expect
      .poll(() => editor()!.view.dom.dataset.latexOpening, { timeout: 20000 })
      .toBe("false");
  await expect.poll(() => container!.querySelector("[data-latex-page-presentation]")).toBeTruthy();
  return { editor: editor()!, source: () => current };
}
function jump(editor: Editor, paragraph: number) {
  let position = -1;
  editor.state.doc.descendants((node, offset) => {
    if (node.type.name === "paragraph" && node.textContent.startsWith(`Paragraph ${paragraph}.`))
      position = offset;
  });
  const target = editor.view.nodeDOM(position) as HTMLElement;
  const scroll = editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 60;
  scroll.dispatchEvent(new Event("scroll"));
  return () => editor.view.nodeDOM(position) as HTMLElement;
}

it("covers a newly pending dependency before the next paint", async () => {
  const source = fixture(8, 7201);
  const opened = await mount(source, "page-before-paint");
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  const preview = opened.editor.view.dom.querySelector<HTMLElement>(".scient-latex-math-preview")!;
  const content = preview.shadowRoot!.querySelector<HTMLElement>("[data-math-preview-content]")!;
  content.removeAttribute("data-math-preview-ready");
  preview.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
  const coveredAtPaint = await new Promise<boolean>((resolve) =>
    requestAnimationFrame(() => resolve(!!container!.querySelector("[data-state='preparing']"))),
  );
  expect(coveredAtPaint).toBe(true);
  const mask = container!.querySelector<HTMLElement>("[data-state='preparing']")!;
  const spinner = mask.querySelector<HTMLElement>("[data-latex-preparation-spinner]")!;
  expect(mask.querySelectorAll("[data-latex-preparation-spinner]")).toHaveLength(1);
  expect(spinner.getAttribute("aria-hidden")).toBe("true");
  expect(getComputedStyle(spinner).animationTimingFunction).toBe("steps(12)");
  expect(CSS.supports("clip-path", opened.editor.view.dom.style.clipPath)).toBe(true);
  const sheet = container!.querySelector<HTMLElement>(".scient-latex-page-sheet")!;
  const footer = sheet.querySelector<HTMLElement>(".scient-latex-running-footer")!;
  const footerBox = footer.getBoundingClientRect();
  const maskBox = mask.getBoundingClientRect();
  expect(maskBox.bottom).toBeLessThanOrEqual(footerBox.top);
  content.dataset.mathPreviewReady = "true";
  preview.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
  expect(container!.querySelector("[data-state='preparing']")).toBeTruthy();
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  expect(opened.source()).toBe(source);
}, 30000);

it("coalesces preview event bursts without synchronous whole-editor searches", async () => {
  const opened = await mount(fixture(8, 7301), "page-event-burst");
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  const dom = opened.editor.view.dom;
  const preview = dom.querySelector<HTMLElement>(".scient-latex-math-preview")!;
  const queries = vi.spyOn(dom, "querySelectorAll");
  const boxes = vi.spyOn(preview, "getBoundingClientRect");
  for (let index = 0; index < 40; index++)
    preview.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
  expect(queries.mock.calls).toHaveLength(0);
  expect(boxes.mock.calls).toHaveLength(0);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(queries.mock.calls.length).toBeLessThan(12);
  queries.mockRestore();
  boxes.mockRestore();
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
}, 30000);

it("keeps a newly focused math editor visible through synchronous layout fencing", async () => {
  const source = fixture(8, 7302);
  const opened = await mount(source, "page-active-object-fence");
  const dom = opened.editor.view.dom;
  await userEvent.click(dom.querySelector<HTMLElement>(".scient-latex-math-preview")!);
  await expect.poll(() => dom.querySelector("math-field")).toBeTruthy();
  const field = dom.querySelector<HTMLElement>("math-field")!;
  field.focus();
  const pagination = latexPaginationKey.getState(opened.editor.state)!;
  opened.editor.view.dispatch(
    opened.editor.state.tr
      .setMeta(latexPaginationKey, {
        pages: [...pagination.pages],
        decorations: pagination.decorations,
      })
      .setMeta("addToHistory", false),
  );
  expect(
    container!.querySelector('[data-latex-preparing-page="1"][data-state="preparing"]'),
  ).toBeNull();
  expect(dom.style.clipPath).not.toBe("inset(100%)");
  expect(opened.source()).toBe(source);
}, 30000);

it("admits compatible idle-prepared content without a preparation flash", async () => {
  const source = fixture(80, 7202);
  const opened = await mount(source, "page-cached-admission");
  await expect
    .poll(() => opened.editor.view.dom.dataset.latexViewportPending, { timeout: 60000 })
    .toBe("0");
  let position = -1;
  opened.editor.state.doc.descendants((node, offset) => {
    if (node.type.name === "paragraph" && node.textContent.startsWith("Paragraph 30."))
      position = offset;
  });
  expect(
    (opened.editor.view.nodeDOM(position) as HTMLElement).hasAttribute(
      "data-latex-viewport-closed",
    ),
  ).toBe(false);
  const target = jump(opened.editor, 30);
  expect(container!.querySelector("[data-state='preparing']")).toBeNull();
  for (let frame = 0; frame < 5; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(container!.querySelector("[data-state='preparing']")).toBeNull();
  }
  await expect.poll(() => target().hasAttribute("data-latex-viewport-closed")).toBe(false);
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  expect(opened.source()).toBe(source);
}, 80000);

it("leaves the ready viewport visible when a distant background preview completes", async () => {
  const opened = await mount(fixture(80, 7303), "page-background-membership");
  const dom = opened.editor.view.dom;
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  const scroll = dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  await expect
    .poll(() =>
      [...dom.querySelectorAll<HTMLElement>(".scient-latex-math-preview")].find(
        (element) =>
          element.getBoundingClientRect().top > scroll.getBoundingClientRect().bottom + 100,
      ),
    )
    .toBeTruthy();
  const distant = [...dom.querySelectorAll<HTMLElement>(".scient-latex-math-preview")].find(
    (element) => element.getBoundingClientRect().top > scroll.getBoundingClientRect().bottom + 100,
  )!;
  distant.dispatchEvent(new CustomEvent("scient-latex-math-preview", { bubbles: true }));
  expect(container!.querySelector("[data-state='preparing']")).toBeNull();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(container!.querySelector("[data-state='preparing']")).toBeNull();
}, 30000);

it("retains completed idle preparation beyond 512 formulas and paints an earlier page from cache", async () => {
  const source = fixture(304, 7101);
  const opened = await mount(source, "page-cache-idle");
  const dom = opened.editor.view.dom;
  await expect.poll(() => dom.dataset.latexViewportPending, { timeout: 120000 }).toBe("0");
  expect(new Set(audit.completions.map((entry) => entry.source)).size).toBe(608);
  // Cross the converter's idle retirement boundary: releasing its worker must
  // not discard page preparation or force formulas through conversion again.
  const completed = audit.completions.length;
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  expect(audit.completions).toHaveLength(completed);
  const before = audit.completions.length;
  const target = jump(opened.editor, 30);
  await expect.poll(() => target().hasAttribute("data-latex-viewport-closed")).toBe(false);
  await expect
    .poll(() =>
      [...target().querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady),
    )
    .toBe(true);
  expect(audit.completions).toHaveLength(before);
  expect(audit.completions.slice(before).every((entry) => entry.cached)).toBe(true);
  expect(getComputedStyle(target(), "::after").display).toBe("none");
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  expect(opened.source()).toBe(source);
}, 150000);

it("shows one message per cold page, releases a stalled formula, and retries without changing source", async () => {
  audit.hold = true;
  const source = fixture(80, 7102);
  const opened = await mount(source, "page-stalled-preview");
  const target = jump(opened.editor, 30);
  await expect
    .poll(
      () =>
        container!.querySelectorAll("[data-latex-preparing-page][data-state='preparing']").length,
    )
    .toBeGreaterThan(0);
  const masks = [
    ...container!.querySelectorAll<HTMLElement>(
      "[data-latex-preparing-page][data-state='preparing']",
    ),
  ];
  expect(new Set(masks.map((mask) => mask.dataset.latexPreparingPage)).size).toBe(masks.length);
  expect(masks.every((mask) => mask.textContent === "Preparing page…")).toBe(true);
  const overlay = container!.querySelector<HTMLElement>(
    ".scient-latex-page-preparation[data-state='preparing']",
  )!;
  const rect = overlay.getBoundingClientRect();
  expect(rect.height).toBeGreaterThan(500);
  expect(getComputedStyle(overlay).backgroundColor).toBe("rgb(255, 255, 255)");
  expect(getComputedStyle(target(), "::after").display).toBe("none");
  await expect
    .poll(() => container!.querySelector("[data-state='unavailable'] button"), { timeout: 10000 })
    .toBeTruthy();
  // Neighboring pages own independent deadlines and geometry settlement.
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  expect(target().querySelector("[data-math-preview-fallback]")).toBeTruthy();
  expect(
    [...target().querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady),
  ).toBe(true);
  const scroll = opened.editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  const previousTop = scroll.scrollTop;
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll"));
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  scroll.scrollTop = previousTop;
  scroll.dispatchEvent(new Event("scroll"));
  await expect
    .poll(() => container!.querySelector("[data-state='unavailable'] button"))
    .toBeTruthy();
  audit.hold = false;
  container!.querySelector<HTMLButtonElement>("[data-state='unavailable'] button")!.click();
  await expect
    .poll(() => target().querySelector("[data-math-preview-fallback]"), { timeout: 10000 })
    .toBeNull();
  await expect
    .poll(() => container!.querySelector(".scient-latex-page-preparation"), { timeout: 10000 })
    .toBeNull();
  expect(opened.source()).toBe(source);
}, 40000);

it("releases a stalled image into a localized fallback and retries its asset request", async () => {
  audit.assetMode = "pending";
  const source = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
Visible prose before the image.
\begin{figure}
\includegraphics[width=.5\textwidth]{fixture.png}
\caption{Synthetic page image}
\end{figure}
Visible prose after the image.
\end{document}`;
  const opened = await mount(source, "page-stalled-image", false);
  await expect
    .poll(() => container!.querySelector("[data-latex-preview-state='pending']"))
    .toBeTruthy();
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeTruthy();
  const openingSpinner = container!.querySelector(
    ".scient-latex-document-preparation [data-latex-preparation-spinner]",
  );
  expect(openingSpinner).toBeTruthy();
  await expect
    .poll(() => container!.querySelector("[data-state='unavailable'] button"), { timeout: 10000 })
    .toBeTruthy();
  await expect
    .poll(() => opened.editor.view.dom.dataset.latexOpening, { timeout: 10000 })
    .toBe("false");
  expect(container!.textContent).toContain("Image preview unavailable");
  container!.querySelector<HTMLButtonElement>("[data-state='unavailable'] button")!.click();
  await expect
    .poll(() => container!.querySelector<HTMLImageElement>("img")?.naturalWidth, { timeout: 10000 })
    .toBe(20);
  await expect
    .poll(() => container!.querySelector(".scient-latex-page-preparation"), { timeout: 10000 })
    .toBeNull();
  expect(opened.source()).toBe(source);
}, 25000);

it("fences a context-only formula refresh before its first pending paint", async () => {
  const source = fixture(8, 7401);
  const opened = await mount(source, "page-context-pending");
  await expect.poll(() => container!.querySelector("[data-state='preparing']")).toBeNull();
  const doc = opened.editor.state.doc;
  const extension = opened.editor.extensionManager.extensions.find(
    (item) => item.name === "latexInlineMath",
  )!;
  const context = (extension.options as MathReadingNodeOptions).readingContext!();
  const colors = context.colors;
  audit.holdContext = true;
  try {
    Reflect.set(context, "colors", { ...colors, refreshProbe: "#123456" });
    refreshMathReadingContext(opened.editor);
    expect(container!.querySelector("[data-state='preparing']")).toBeTruthy();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(container!.querySelector("[data-state='preparing']")).toBeTruthy();
    expect(opened.editor.state.doc).toBe(doc);
  } finally {
    audit.holdContext = false;
    Reflect.set(context, "colors", colors);
    refreshMathReadingContext(opened.editor);
  }
  await expect
    .poll(() => container!.querySelector("[data-state='preparing']"), { timeout: 10000 })
    .toBeNull();
  expect(opened.source()).toBe(source);
}, 30000);
