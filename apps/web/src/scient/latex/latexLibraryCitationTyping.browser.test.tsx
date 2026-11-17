import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { publishLibraryVersion } from "../sources/librarySourceRequest";
import { bibliographyPaths } from "./latexAuthoringModel";
import { installLatexTextareaCompletion } from "./latexTextCompletion";
import { useLatexCitationSuggestions } from "./useLatexCitationSuggestions";

const mocks = vi.hoisted(() => ({ readScientSources: vi.fn(), readFile: vi.fn() }));

vi.mock("../sources/client", () => ({ readScientSources: mocks.readScientSources }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.readFile }));

function overview(
  sources: ReadonlyArray<{ key: string; family: string; year: number; title: string }>,
): ScientSourcesOverviewResult {
  return {
    projectState: "initialized",
    issues: [],
    recordDiagnostics: [],
    activeOperation: null,
    records: sources.map((source, index) => ({
      sourceId: `source_${index}`,
      revision: 1,
      citationKey: source.key,
      type: "article",
      title: source.title,
      creators: [
        { creatorType: "author", givenName: null, familyName: source.family, literalName: null },
      ],
      issuedYear: source.year,
      identifiers: [],
      containerTitle: null,
      url: null,
      externalReferences: [],
      attachments: [],
      importedAt: "2026-08-13T00:00:00.000Z",
    })),
  };
}

const lovelace = {
  key: "lovelace1843notes",
  family: "Lovelace",
  year: 1843,
  title: "Notes on the analytical engine",
};
const turing = {
  key: "turing1950computing",
  family: "Turing",
  year: 1950,
  title: "Computing machinery and intelligence",
};

const REFS = `@article{hopper1952education,
  author = {Grace Hopper},
  title = {The education of a computer},
  year = {1952},
}
`;

/** A LaTeX source field of a document in the project, as the editors mount one. */
function Field(props: { readonly initial?: string }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const citations = useLatexCitationSuggestions({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    bibliography: () => ({
      paths: bibliographyPaths(field.current?.value ?? "", "paper/main.tex"),
      wholeDocument: true,
    }),
  });
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    return installLatexTextareaCompletion(
      element,
      (choice) => element.setRangeText(choice.replacement, choice.from, choice.to, "end"),
      () => ({ citations }),
    );
  }, [citations]);
  return (
    <textarea
      ref={field}
      aria-label="LaTeX source"
      rows={4}
      cols={60}
      defaultValue={props.initial ?? ""}
    />
  );
}

function setup(sources: Parameters<typeof overview>[0]) {
  mocks.readScientSources.mockReset();
  mocks.readScientSources.mockResolvedValue(overview(sources));
  mocks.readFile.mockReset();
  mocks.readFile.mockImplementation(async ({ input }: { input: { relativePath: string } }) =>
    input.relativePath === "paper/refs.bib"
      ? { _tag: "Success", value: { contents: REFS, truncated: false } }
      : { _tag: "Failure" },
  );
}

describe("typing a LaTeX citation", () => {
  it("offers the project's Library sources and writes the chosen key", async () => {
    setup([lovelace, turing]);
    await using _screen = await render(<Field />);
    await vi.waitFor(() =>
      expect(mocks.readScientSources).toHaveBeenCalledWith("environment-1", "/project"),
    );

    const field = page.getByLabelText("LaTeX source");
    await userEvent.click(field);
    await userEvent.keyboard("As shown \\cite{{machin");
    const option = page.getByRole("option", {
      name: "turing1950computing · Turing 1950 · Computing machinery and intelligence",
    });
    await expect.element(option).toBeVisible();
    await expect.element(page.getByRole("option", { name: /lovelace/u })).not.toBeInTheDocument();

    // The document does not load the managed bibliography yet, and the list says so.
    await expect
      .element(page.getByRole("note"))
      .toHaveTextContent(
        "Add \\bibliography{references} to this document so LaTeX finds Library sources.",
      );

    await userEvent.keyboard("{Enter}");
    await expect.element(field).toHaveValue("As shown \\cite{turing1950computing");
  });

  it("offers the entries of the document's own .bib files first, and no note once it loads the Library's", async () => {
    setup([lovelace]);
    const linked = "\\bibliography{refs,../references}\n";
    await using _screen = await render(<Field initial={linked} />);
    // The linked files are read when the document opens.
    await vi.waitFor(() =>
      expect(mocks.readFile).toHaveBeenCalledWith({
        environmentId: "environment-1",
        input: { cwd: "/project", relativePath: "paper/refs.bib" },
      }),
    );
    const field = page.getByLabelText("LaTeX source");
    await userEvent.click(field);
    await userEvent.keyboard("{Control>}{End}{/Control}\\cite{{");
    await expect
      .element(page.getByRole("option").first())
      .toHaveTextContent(
        "hopper1952education · Grace Hopper · 1952 · paper/refs.bib · The education of a computer",
      );
    await expect.element(page.getByRole("option", { name: /^lovelace1843notes/u })).toBeVisible();
    await expect.element(page.getByRole("note")).not.toBeInTheDocument();
  });

  it("shows a .bib file's entries when its read finishes, without another key", async () => {
    setup([lovelace]);
    let finish: (result: unknown) => void = () => undefined;
    mocks.readFile.mockImplementation(({ input }: { input: { relativePath: string } }) =>
      input.relativePath === "paper/refs.bib"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ _tag: "Failure" }),
    );
    await using _screen = await render(<Field initial={"\\bibliography{refs}\n"} />);
    await userEvent.click(page.getByLabelText("LaTeX source"));
    await userEvent.keyboard("{Control>}{End}{/Control}\\cite{{");
    await expect
      .element(page.getByRole("option"))
      .toHaveTextContent("lovelace1843notes · Lovelace 1843 · Notes on the analytical engine");

    finish({ _tag: "Success", value: { contents: REFS, truncated: false } });
    await expect
      .element(page.getByRole("option").first())
      .toHaveTextContent(
        "hopper1952education · Grace Hopper · 1952 · paper/refs.bib · The education of a computer",
      );
  });

  it("offers a source added to the Library while the document is open", async () => {
    setup([lovelace]);
    await using _screen = await render(<Field />);
    await vi.waitFor(() => expect(mocks.readScientSources).toHaveBeenCalledTimes(1));

    mocks.readScientSources.mockResolvedValue(overview([lovelace, turing]));
    publishLibraryVersion("/project", "after-import");
    await vi.waitFor(() => expect(mocks.readScientSources).toHaveBeenCalledTimes(2));

    await userEvent.click(page.getByLabelText("LaTeX source"));
    await userEvent.keyboard("\\citep{{tur");
    await expect.element(page.getByRole("option", { name: /^turing1950computing/u })).toBeVisible();
  });
});
