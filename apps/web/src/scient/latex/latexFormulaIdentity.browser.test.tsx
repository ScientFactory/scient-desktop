import { render as _fixtureRender, type Screen } from "../../../test/render";
import { useState, type ReactNode } from "react";

import type { Editor } from "@tiptap/core";
import { expect, it, vi } from "vite-plus/test";
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

let current: string;
let publication = Promise.withResolvers<string>();
async function _setupFixture0(_fixture: _Fixture) {
  clearVisualDraft(key);
  await page.viewport(1300, 900);
  _fixture.container = document.createElement("div");
  _fixture.container.style.cssText = "width:1000px;height:900px;display:flex;flex-direction:column";
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  current = original;
  publication = Promise.withResolvers<string>();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0.unmount();
  _fixture.container.remove();
  clearVisualDraft(key);
}

async function open(_fixture: _Fixture) {
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
          publication.resolve(current);
          return outcome;
        }}
      />
    );
  }
  await _fixture.root0.rerender(<Harness />);
  const editor = () =>
    (
      _fixture.container.querySelector(".scient-latex-visual-document") as
        | (HTMLElement & { editor?: Editor })
        | null
    )?.editor;
  await expect.poll(editor).toBeTruthy();
  await expect
    .poll(() => _fixture.container.querySelectorAll('[data-math-reading-view="true"]').length)
    .toBe(2);
  return editor()!;
}

it("keeps formula views through a prose edit, source publication and undo", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const editor = await open(_fixture);
  const maths = [..._fixture.container.querySelectorAll('[data-math-reading-view="true"]')];
  editor.view.dispatch(editor.state.tr.insertText("More ", 1));
  await expect(publication.promise).resolves.toBe(
    original.replace("Prose with", "More Prose with"),
  );
  expect([..._fixture.container.querySelectorAll('[data-math-reading-view="true"]')]).toEqual(
    maths,
  );
  expect(_fixture.container.querySelector("math-field")).toBeNull();
  publication = Promise.withResolvers<string>();
  editor.commands.undo();
  await expect(publication.promise).resolves.toBe(original);
  expect([..._fixture.container.querySelectorAll('[data-math-reading-view="true"]')]).toEqual(
    maths,
  );
}, 15_000);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
