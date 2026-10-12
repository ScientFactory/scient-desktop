import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
const audit = vi.hoisted(() => ({
  hold: false,
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
      if (audit.hold && args[0].includes("x_{30}")) return () => {};
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
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

let root: Root | undefined;
let container: HTMLElement | undefined;
let key = "";
afterEach(() => {
  audit.hold = false;
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
  expect(audit.completions.slice(before).some((entry) => entry.source.includes("x_{30}"))).toBe(
    true,
  );
  expect(audit.completions.slice(before).every((entry) => entry.cached)).toBe(true);
  expect(getComputedStyle(target(), "::after").display).toBe("none");
  expect(container!.querySelector("[data-state='preparing']")).toBeNull();
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
  expect(container!.querySelector("[data-state='preparing']")).toBeNull();
  expect(target().querySelector("[data-math-preview-fallback]")).toBeTruthy();
  expect(
    [...target().querySelectorAll(".scient-latex-math-preview")].every(mathReadingPreviewReady),
  ).toBe(true);
  const scroll = opened.editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  const previousTop = scroll.scrollTop;
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event("scroll"));
  expect(container!.querySelector("[data-state='preparing']")).toBeNull();
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
