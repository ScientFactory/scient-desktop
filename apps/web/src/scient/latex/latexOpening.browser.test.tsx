import { act, render as _fixtureRender, type Screen } from "../../../test/render";
import { lazy, useEffect, useState, type ReactNode } from "react";

import { expect, it, vi } from "vite-plus/test";
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
  LATEX_DOCUMENT_PREPARATION_LABEL,
} from "./latexOpeningPresentation";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.container?.remove();
  _fixture.root0 = undefined;
  _fixture.container = undefined;
}

it("keeps one centered message until the document is parsed, then shows it without a cover", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
  let projectMounted = false;
  function ProjectWithReceipt(props: Parameters<typeof LatexProjectVisualEditor>[0]) {
    useEffect(() => {
      projectMounted = true;
    }, []);
    return <LatexProjectVisualEditor {...props} />;
  }
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
  _fixture.container = document.createElement("div");
  _fixture.container.style.cssText = "display:flex;flex-direction:column;width:1000px;height:800px";
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  const face = new FontFace("KaTeX_OpeningPresentationFixture", 'local("Arial")');
  const load = vi.spyOn(face, "load").mockImplementation(() => new Promise<FontFace>(() => {}));
  document.fonts.add(face);
  let sampling = false;
  let samples = 0;
  const failures: string[] = [];
  let center: number | undefined;
  const observedLabels = new WeakSet<HTMLElement>();
  const sample = () => {
    if (!sampling || !_fixture.container) return;
    if (!_fixture.container.querySelector(".scient-latex-visual-document")) {
      const labels = _fixture.container.querySelectorAll<HTMLElement>(
        '.scient-latex-document-preparation span:not([aria-hidden="true"])',
      );
      if (labels.length !== 1)
        failures.push(`Expected one opening message, found ${labels.length}`);
      const label = labels[0];
      if (
        _fixture.container.querySelectorAll(
          ".scient-latex-document-preparation [data-latex-preparation-spinner]",
        ).length !== 1
      )
        failures.push("Expected one opening spinner");
      if (label) {
        if (!observedLabels.has(label)) {
          observedLabels.add(label);
          resize.observe(label);
        }
        if (label.textContent !== LATEX_DOCUMENT_PREPARATION_LABEL)
          failures.push("Message changed");
        const rect = label.getBoundingClientRect();
        const middle = rect.top + rect.height / 2;
        if (center !== undefined && Math.abs(middle - center) > 1)
          failures.push(`Message moved ${middle - center}px`);
        center ??= middle;
      }
      samples++;
    }
  };
  // Observe actual DOM commits and native geometry delivery, including each replacement
  // of the preparation label. A phase cannot advance before its own sample below.
  const resize = new ResizeObserver(sample);
  const mutations = new MutationObserver(sample);
  resize.observe(_fixture.container);
  mutations.observe(_fixture.container, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  try {
    await _fixture.root0.rerender(<Pipeline />);
    await expect
      .poll(() => _fixture.container!.textContent)
      .toContain(LATEX_DOCUMENT_PREPARATION_LABEL);
    sampling = true;
    sample();
    await act(() => change("module"));
    await expect.poll(() => resolveModule).toBeTypeOf("function");
    sample();
    await act(() => {
      resolveModule({ default: ProjectWithReceipt });
      change("root");
    });
    await vi.waitFor(() => expect(projectMounted).toBe(true));
    sample();
    expect(_fixture.container.textContent).not.toContain("Finding the document");
    await act(() => change("layout"));
    await expect
      .poll(() => _fixture.container!.querySelector(".scient-latex-visual-document"), {
        timeout: 15000,
      })
      .toBeTruthy();
    sampling = false;
    expect(samples).toBeGreaterThan(2);
    expect(failures).toEqual([]);
    // Parsed content appears directly: no cover, no busy page, even while a
    // document font is still loading.
    expect(_fixture.container.querySelector(".scient-latex-document-preparation")).toBeNull();
    expect(_fixture.container.querySelector("[aria-busy='true']")).toBeNull();
    const documentElement = _fixture.container.querySelector<HTMLElement>(
      ".scient-latex-visual-document",
    )!;
    await expect.poll(() => documentElement.textContent).toContain("Paragraph 0.");
    const scroll = _fixture.container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
    const first = [...documentElement.querySelectorAll("p")].find((paragraph) =>
      paragraph.textContent?.startsWith("Paragraph 0."),
    )!;
    expect(getComputedStyle(first).visibility).toBe("visible");
    expect(first.getBoundingClientRect().top).toBeLessThan(
      scroll.getBoundingClientRect().bottom + 2000,
    );
    expect(onEdit).not.toHaveBeenCalled();
  } finally {
    sampling = false;
    mutations.disconnect();
    resize.disconnect();
    load.mockRestore();
    document.fonts.delete(face);
    clearVisualDraft(draftKey);
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
