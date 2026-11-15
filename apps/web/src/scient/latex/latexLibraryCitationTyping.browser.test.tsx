import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { publishLibraryVersion } from "../sources/librarySourceRequest";
import { useLibraryLatexCitationSuggestions } from "../sources/useLibraryCitations";
import { installLatexTextareaCompletion } from "./latexTextCompletion";

const mocks = vi.hoisted(() => ({ readScientSources: vi.fn() }));

vi.mock("../sources/client", () => ({ readScientSources: mocks.readScientSources }));

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

/** A LaTeX source field of a document in the project, as the editors mount one. */
function Field() {
  const citations = useLibraryLatexCitationSuggestions({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
  });
  const field = useRef<HTMLTextAreaElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs completion on the field until unmount, as the editors do
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    return installLatexTextareaCompletion(
      element,
      (choice) => element.setRangeText(choice.replacement, choice.from, choice.to, "end"),
      () => ({ citations }),
    );
  }, [citations]);
  return <textarea ref={field} aria-label="LaTeX source" rows={4} cols={60} />;
}

describe("typing a LaTeX citation", () => {
  it("offers the project's Library sources and writes the chosen key", async () => {
    mocks.readScientSources.mockReset();
    mocks.readScientSources.mockResolvedValue(overview([lovelace, turing]));
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

    await userEvent.keyboard("{Enter}");
    await expect.element(field).toHaveValue("As shown \\cite{turing1950computing");
  });

  it("offers a source added to the Library while the document is open", async () => {
    mocks.readScientSources.mockReset();
    mocks.readScientSources.mockResolvedValue(overview([lovelace]));
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
