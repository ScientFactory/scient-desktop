import { render as _fixtureRender, act } from "../../../test/render";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { isMacPlatform } from "~/lib/utils";

const mocks = vi.hoisted(() => ({ readScientSources: vi.fn(), openCitation: vi.fn() }));

vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => import("./latexAssetUrls.testkit"));
vi.mock("../sources/client", () => ({ readScientSources: mocks.readScientSources }));
vi.mock("../sources/citationNavigation", () => ({ openCitation: mocks.openCitation }));

import { LatexVisualEditor } from "./LatexVisualEditor";
import { useLatexVisualTestOwner } from "./latexVisualTestOwner";
import { clearVisualDraft } from "./visualDrafts";
import "./scient-latex.css";

const environmentId = EnvironmentId.make("latex-visual-citation");
const threadId = ThreadId.make("latex-visual-citation");
const SOURCE = String.raw`\documentclass{article}
\begin{document}
As written, “A fine passage” \cite[p.~4]{lovelace1843notes} and more.
\end{document}
`;

const overview: ScientSourcesOverviewResult = {
  projectState: "initialized",
  issues: [],
  recordDiagnostics: [],
  activeOperation: null,
  records: [
    {
      sourceId: "source_0",
      revision: 1,
      citationKey: "lovelace1843notes",
      type: "article",
      title: "Notes",
      creators: [
        { creatorType: "author", givenName: null, familyName: "Lovelace", literalName: null },
      ],
      issuedYear: 1843,
      identifiers: [],
      containerTitle: null,
      url: null,
      externalReferences: [],
      attachments: [],
      importedAt: "2026-08-13T00:00:00.000Z",
    },
  ],
};

function Harness(props: { readonly disabled?: boolean }) {
  const [source, setSource] = useState(SOURCE);
  const owner = useLatexVisualTestOwner(source);
  return (
    <LatexVisualEditor
      sourceSnapshot={owner.snapshot}
      draftKey="browser-citation-open"
      fileRevision="r1"
      source={source}
      disabled={props.disabled ?? false}
      environmentId={environmentId}
      cwd="/project"
      citationSource={{ environmentId, threadId, cwd: "/project" }}
      onEditingChange={() => {}}
      onOpenSource={() => {}}
      onEdit={(request) => {
        const result = owner.edit(request);
        if (result.accepted) setSource(result.snapshot.source);
        return result;
      }}
    />
  );
}

async function renderHarness(stack: AsyncDisposableStack, disabled = false) {
  mocks.readScientSources.mockReset().mockResolvedValue(overview);
  mocks.openCitation.mockReset().mockReturnValue(true);
  clearVisualDraft("browser-citation-open");
  await page.viewport(1400, 900);
  const container = document.createElement("div");
  Object.assign(container.style, { width: "1200px", height: "900px" });
  document.body.append(container);
  stack.defer(() => container.remove());
  stack.use(await _fixtureRender(<Harness disabled={disabled} />, { container, router: false }));
  await vi.waitFor(() =>
    expect(mocks.readScientSources).toHaveBeenCalledWith(environmentId, "/project"),
  );
  return container;
}

it("opens the cited source on Command-click (Control-click) without selecting the citation", async () => {
  await using stack = new AsyncDisposableStack();
  const container = await renderHarness(stack);
  const citation = page.getByRole("button", { name: "Edit cite" });
  await expect.element(citation).toBeVisible();
  const editor = (
    container.querySelector(".scient-latex-visual-document") as HTMLElement & { editor: Editor }
  ).editor;
  // The Library reads settle before a click can open a source.
  await act(() => Promise.all(mocks.readScientSources.mock.results.map((read) => read.value)));
  await userEvent.click(citation, {
    modifiers: [isMacPlatform(navigator.platform) ? "Meta" : "Control"],
  });
  expect(mocks.openCitation).toHaveBeenCalledOnce();
  expect(mocks.openCitation.mock.lastCall![0]).toMatchObject({
    environmentId,
    threadRef: { environmentId, threadId },
    root: "/project",
    items: [{ key: "lovelace1843notes", locator: "p.~4" }],
    quote: "A fine passage",
  });
  expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);

  mocks.openCitation.mockClear();
  await userEvent.click(citation);
  expect(mocks.openCitation).not.toHaveBeenCalled();
  expect(editor.state.selection).toBeInstanceOf(NodeSelection);
});

it("opens the cited source with Enter while the editor cannot be edited", async () => {
  await using stack = new AsyncDisposableStack();
  await renderHarness(stack, true);
  await act(() => Promise.all(mocks.readScientSources.mock.results.map((read) => read.value)));
  const citation = page.getByRole("button", { name: "Edit cite" });
  await expect.element(citation).toBeEnabled();
  (citation.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(mocks.openCitation).toHaveBeenCalledOnce();
  expect(mocks.openCitation.mock.lastCall![0]).toMatchObject({
    items: [{ key: "lovelace1843notes", locator: "p.~4" }],
  });
});
