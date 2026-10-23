import { fakeTimers, render as _fixtureRender } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";
import {
  LatexReferencesPanel,
  type BibliographyDetails,
  type BibliographyDocument,
} from "./LatexReferencesPanel";

it("prose acknowledgements preserve the reference catalog while bibliography changes and new listeners receive it", async () => {
  await using _fixture = _createFixture();

  const host = document.createElement("div");
  document.body.append(host);
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  const reports: BibliographyDetails[][] = [];
  const report = (entries: BibliographyDetails[]) => reports.push(entries);
  const source = (body: string, key = "alpha", title = "Original reference") =>
    `${body}\n\\begin{thebibliography}{9}\n\\bibitem{${key}} ${title}.\n\\end{thebibliography}`;
  const render = async (text: string, listener = report, path = "main.tex") => {
    const document: BibliographyDocument = {
      id: "document",
      path,
      source: text,
      kind: "bibitem",
      readOnly: false,
      apply: () => true,
    };
    await root.rerender(
      <LatexReferencesPanel
        open={false}
        request={{ sequence: 0 }}
        onClose={() => {}}
        documents={[document]}
        setupSource={text}
        rootRelativePath={path}
        disabled={false}
        onSetup={() => true}
        onDraftChange={() => {}}
        onSaved={() => {}}
        loadDetails={false}
        onCatalogChange={listener}
        draftKey="synthetic-reference-catalog-subscription"
        canOpenFiles={false}
        onOpenSource={() => {}}
      />,
    );
  };
  try {
    using _timers = fakeTimers();
    await render(source("First paragraph."));
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).toEqual([{ key: "alpha", title: "Original reference.", path: "main.tex" }]);
    for (const body of ["Typing more.", "Typing more words.", "Typing more words again."]) {
      await render(source(body));
      await vi.advanceTimersByTimeAsync(32);
    }
    expect(reports).toHaveLength(1);
    await render(source("Same prose.", "renamed", "Updated reference"));
    await expect.poll(() => reports.length).toBe(2);
    expect(reports[1]?.[0]).toMatchObject({ key: "renamed", title: "Updated reference." });
    await render(source("Same prose.", "renamed", "Updated reference"), report, "other.tex");
    await expect.poll(() => reports.length).toBe(3);
    expect(reports[2]?.[0]?.path).toBe("other.tex");
    const replacement: BibliographyDetails[][] = [];
    await render(
      source("Same prose.", "renamed", "Updated reference"),
      (entries) => replacement.push(entries),
      "other.tex",
    );
    await expect.poll(() => replacement.length).toBe(1);
    expect(replacement[0]).toEqual(reports[2]);
    await render("No bibliography.");
    await expect.poll(() => reports.at(-1)).toEqual([]);
  } finally {
    await root.unmount();
    host.remove();
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
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
