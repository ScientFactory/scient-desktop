import { lazy, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { EnvironmentId } from "@t3tools/contracts";

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/scient/keyboard/WritingShortcutsDialog", () => ({
  WritingShortcutsDialog: () => null,
}));
vi.mock("~/assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/assets/assetUrls")>()),
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
vi.mock("~/state/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/projects")>()),
  projectEnvironment: { fileChanges: () => ({}) },
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  const { AsyncResult } = await import("effect/reactivity");
  return { ...actual, useAtomValue: () => AsyncResult.initial() };
});
vi.mock("~/components/files/projectFilesQueryState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/files/projectFilesQueryState")>()),
  useProjectFileQuery: () => ({ authoritativeData: null, error: null, refresh: () => {} }),
}));
vi.mock(
  "~/scient/markdownEditor/persistence/useMarkdownPersistenceLease",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("~/scient/markdownEditor/persistence/useMarkdownPersistenceLease")
    >()),
    useMarkdownPersistenceLease: () => ({
      lease: null,
      snapshot: null,
      admissionError: null,
      retryAdmission: () => {},
    }),
  }),
);

import { ScientSurfaceSuspense } from "../fileSurfaces/scientLazyFileSurfaces";
import { LatexProjectVisualEditor } from "./LatexProjectVisualEditor";
import { createLatexEditorSourceSnapshot } from "./latexSourceEditPlan";
import {
  LatexDocumentPreparation,
  LatexOpeningPresentation,
  LATEX_DOCUMENT_PREPARATION_LABEL,
} from "./latexOpeningPresentation";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

it("hides cold preparation labels without changing their measurement boxes", async () => {
  container = document.createElement("div");
  container.style.cssText = "display:flex;height:500px;width:800px";
  document.body.append(container);
  root = createRoot(container);
  function Fixture({ opening }: { opening: boolean }) {
    return (
      <LatexOpeningPresentation opening={opening} className="scient-latex-visual-workspace">
        <div className="scient-latex-visual-scroll" style={{ height: 500, width: 800 }}>
          <div className="scient-latex-page-zoom-frame">
            <div className="scient-latex-visual-document" data-latex-opening={opening}>
              <p
                data-latex-viewport="mounted"
                data-latex-viewport-prepared="false"
                style={{ "--scient-latex-viewport-estimate": "40px" } as CSSProperties}
              >
                Hidden source
              </p>
            </div>
          </div>
        </div>
      </LatexOpeningPresentation>
    );
  }
  root.render(<Fixture opening />);
  await expect.poll(() => container!.querySelector("p")).toBeTruthy();
  const content = container.querySelector<HTMLElement>("[data-opening-content]")!;
  const block = container.querySelector<HTMLElement>("p")!;
  const before = block.getBoundingClientRect();
  expect(getComputedStyle(block, "::after").visibility).toBe("visible");
  expect(getComputedStyle(content).opacity).toBe("0");
  expect(
    getComputedStyle(container.querySelector<HTMLElement>(".scient-latex-page-zoom-frame")!)
      .opacity,
  ).toBe("0");
  expect(content.inert).toBe(true);
  expect(container.querySelectorAll(".scient-latex-document-preparation")).toHaveLength(1);
  root.render(<Fixture opening={false} />);
  await expect.poll(() => content.inert).toBe(false);
  expect(getComputedStyle(content).opacity).toBe("1");
  expect(block.getBoundingClientRect().height).toBe(before.height);
  expect(container.querySelector(".scient-latex-document-preparation")).toBeNull();
});

it("keeps one centered message across admission, lazy loading, root resolution and real worker/layout preparation", async () => {
  await page.viewport(1200, 900);
  const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Opening presentation fixture}
\begin{document}
\maketitle
\clearpage
${Array.from({ length: 90 }, (_, index) => `Paragraph ${index}. ${"Source-backed scientific prose that wraps across the page. ".repeat(5)} ` + String.raw`\(x_{${index}}^2+1\)`).join("\n\n")}
\end{document}`;
  const sourceSnapshot = createLatexEditorSourceSnapshot(source);
  const draftKey = "opening-presentation-pipeline";
  const onEdit = vi.fn(() => ({
    accepted: false as const,
    reason: "No writes in opening fixture.",
  }));
  let resolveModule!: (value: { default: typeof LatexProjectVisualEditor }) => void;
  const LazyProject = lazy(
    () =>
      new Promise<{ default: typeof LatexProjectVisualEditor }>((done) => {
        resolveModule = done;
      }),
  );
  let change!: (phase: "file" | "module" | "root" | "layout") => void;
  function Pipeline() {
    const [phase, setPhase] = useState<"file" | "module" | "root" | "layout">("file");
    useEffect(() => {
      change = setPhase;
    }, []);
    if (phase === "file") return <LatexDocumentPreparation />;
    return (
      <ScientSurfaceSuspense fallback={<LatexDocumentPreparation />}>
        <LazyProject
          environmentId={EnvironmentId.make("opening-presentation-fixture")}
          cwd="/synthetic/reading-fixture"
          relativePath="main.tex"
          rootRelativePath={phase === "layout" ? "main.tex" : null}
          rootResolutionPending={phase !== "layout"}
          rootResolutionMessage="Finding the document…"
          selectedPending={false}
          fileTruncated={false}
          source={source}
          sourceSnapshot={sourceSnapshot}
          fileRevision="opening-fixture-r1"
          draftKey={draftKey}
          disabled={false}
          onEdit={onEdit}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onOpenFileSource={() => {}}
          onSaved={() => {}}
          onProjectStateChange={() => {}}
        />
      </ScientSurfaceSuspense>
    );
  }
  container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:1000px;height:800px";
  document.body.append(container);
  root = createRoot(container);
  const face = new FontFace("KaTeX_OpeningPresentationFixture", 'local("Arial")');
  const load = vi.spyOn(face, "load").mockImplementation(() => new Promise<FontFace>(() => {}));
  document.fonts.add(face);
  let sampling = true;
  let samples = 0;
  const failures: string[] = [];
  let center: number | undefined;
  const sample = () => {
    if (!sampling || !container) return;
    const shell = container.querySelector<HTMLElement>(".scient-latex-opening-shell");
    if (shell?.dataset.opening !== "false") {
      const labels = container.querySelectorAll<HTMLElement>(
        '.scient-latex-document-preparation span:not([aria-hidden="true"])',
      );
      if (labels.length !== 1)
        failures.push(`Expected one opening message, found ${labels.length}`);
      const label = labels[0];
      if (
        container.querySelectorAll(
          ".scient-latex-document-preparation [data-latex-preparation-spinner]",
        ).length !== 1
      )
        failures.push("Expected one opening spinner");
      if (label) {
        if (label.textContent !== LATEX_DOCUMENT_PREPARATION_LABEL)
          failures.push("Message changed");
        const rect = label.getBoundingClientRect();
        const middle = rect.top + rect.height / 2;
        if (center !== undefined && Math.abs(middle - center) > 1)
          failures.push(`Message moved ${middle - center}px`);
        center ??= middle;
      }
      const content = container.querySelector<HTMLElement>("[data-opening-content]");
      if (content && (getComputedStyle(content).opacity !== "0" || !content.inert))
        failures.push("Intermediate content exposed");
      const status = container.querySelector<HTMLElement>(".scient-latex-viewport-status");
      if (status && !status.hidden) failures.push("Opening corner badge exposed");
      samples++;
    }
    requestAnimationFrame(sample);
  };
  try {
    root.render(<Pipeline />);
    await expect.poll(() => container!.textContent).toContain(LATEX_DOCUMENT_PREPARATION_LABEL);
    requestAnimationFrame(sample);
    change("module");
    await expect.poll(() => resolveModule).toBeTypeOf("function");
    await new Promise((done) => requestAnimationFrame(done));
    resolveModule({ default: LatexProjectVisualEditor });
    change("root");
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    expect(container.textContent).not.toContain("Finding the document");
    change("layout");
    await expect
      .poll(() => container!.querySelector(".scient-latex-visual-document"), { timeout: 15000 })
      .toBeTruthy();
    await expect
      .poll(
        () => container!.querySelector<HTMLElement>(".scient-latex-opening-shell")?.dataset.opening,
        { timeout: 15000 },
      )
      .toBe("false");
    sampling = false;
    expect(samples).toBeGreaterThan(2);
    expect(failures).toEqual([]);
    expect(container.querySelector(".scient-latex-document-preparation")).toBeNull();
    expect(container.querySelector<HTMLElement>("[data-opening-content]")!.inert).toBe(false);
    expect(
      container.querySelector<HTMLElement>(".scient-latex-visual-document")!.dataset.latexOpening,
    ).toBe("false");
    const documentElement = container.querySelector<HTMLElement>(".scient-latex-visual-document")!;
    const scroll = container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
    const style = getComputedStyle(documentElement);
    const scale = documentElement.getBoundingClientRect().width / Number.parseFloat(style.width);
    const paperHeight =
      Number.parseFloat(style.getPropertyValue("--scient-latex-paper-height")) * scale;
    const box = scroll.getBoundingClientRect();
    const preparedBottom =
      box.top +
      Math.max(box.height, paperHeight) +
      paperHeight +
      Number.parseFloat(style.getPropertyValue("--scient-latex-page-gap")) * scale +
      200;
    const coldNearby = [
      ...documentElement.querySelectorAll<HTMLElement>("[data-latex-viewport-prepared='false']"),
    ].filter((block) => {
      const rect = block.getBoundingClientRect();
      return rect.bottom > box.top && rect.top < preparedBottom;
    });
    expect(coldNearby).toEqual([]);
    expect(onEdit).not.toHaveBeenCalled();
  } finally {
    sampling = false;
    load.mockRestore();
    document.fonts.delete(face);
    clearVisualDraft(draftKey);
  }
}, 30000);
