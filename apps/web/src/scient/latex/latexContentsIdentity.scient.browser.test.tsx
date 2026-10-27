import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { LatexVisualEditor } from "./LatexVisualEditor";
import { createLatexVisualTestOwner } from "./latexVisualTestOwner";
import { waitForLatexVisualTestReadiness } from "./latexVisualTestReadiness";
import "./scient-latex.css";

const source = String.raw`\documentclass{article}
\begin{document}
\tableofcontents
\section{Results}
\addcontentsline{toc}{section}{Supplement}
\addcontentsline{toc}{subsection}{Detail}
\end{document}
`;

it("retains contents entries sharing a source position through manual-entry removal", async (context) => {
  using resources = new DisposableStack();
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;inset:0;width:1000px;height:700px;display:flex;flex-direction:column";
  document.body.append(container);
  resources.defer(() => container.remove());
  using errors = vi.spyOn(console, "error");
  const onEdit = vi.fn();
  const view = (text: string, revision: string) => {
    const owner = createLatexVisualTestOwner(text);
    return (
      <LatexVisualEditor
        source={text}
        sourceSnapshot={owner.snapshot}
        draftKey="contents-shared-position"
        fileRevision={revision}
        disabled={false}
        onEdit={(request) => {
          onEdit(request);
          return owner.edit(request);
        }}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
      />
    );
  };
  // The actual editor and source owner are exercised without route behavior.
  await using screen = await render(view(source, "r1"), { container, router: false });
  await waitForLatexVisualTestReadiness(container, context, "contents initial opening");
  const titles = () =>
    [...container.querySelectorAll("[data-latex-toc-entry] .scient-latex-toc-title")].map(
      (row) => row.textContent,
    );
  await expect.poll(titles).toEqual(["Results", "Supplement", "Detail"]);

  const withoutSupplement = source.replace("\\addcontentsline{toc}{section}{Supplement}\n", "");
  await screen.rerender(view(withoutSupplement, "r2"));
  await waitForLatexVisualTestReadiness(container, context, "contents after manual-entry removal");
  await expect.poll(titles).toEqual(["Results", "Detail"]);
  expect(onEdit).not.toHaveBeenCalled();
  expect(
    errors.mock.calls.filter((args) => args.some((arg) => String(arg).includes("same key"))),
  ).toEqual([]);
});
