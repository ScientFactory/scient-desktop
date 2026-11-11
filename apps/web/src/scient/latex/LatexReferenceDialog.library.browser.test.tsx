import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { LatexReferenceDialog } from "./LatexReferenceDialog";

const mocks = vi.hoisted(() => ({ readScientSources: vi.fn() }));

vi.mock("../sources/client", () => ({ readScientSources: mocks.readScientSources }));

function overview(): ScientSourcesOverviewResult {
  return {
    projectState: "initialized",
    issues: [],
    recordDiagnostics: [],
    activeOperation: null,
    records: [
      {
        sourceId: "source_a",
        revision: 1,
        citationKey: "lovelace1843notes",
        type: "article",
        title: "Notes on the analytical engine",
        creators: [
          { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
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
}

function setup() {
  mocks.readScientSources.mockReset();
  mocks.readScientSources.mockResolvedValue(overview());
}

describe("LaTeX citation dialog", () => {
  it("lists Library sources and inserts the chosen key", async () => {
    setup();
    const onInsert = vi.fn();
    const dialog = (
      <LatexReferenceDialog
        open
        onOpenChange={() => undefined}
        mode="citation"
        source={"\\documentclass{article}\n\\begin{document}\n\\end{document}\n"}
        environmentId={"environment-1" as EnvironmentId}
        cwd="/project"
        relativePath="main.tex"
        onInsert={onInsert}
      />
    );
    await using screen = await render(dialog);

    await expect.element(page.getByText("Notes on the analytical engine")).toBeVisible();
    expect(mocks.readScientSources).toHaveBeenCalledWith("environment-1", "/project");
    await userEvent.click(page.getByText("Notes on the analytical engine"));
    await expect
      .element(page.getByText("Add \\bibliography{references} to this document", { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Insert citation" }));
    await screen.rerender(
      <LatexReferenceDialog
        open={false}
        onOpenChange={() => undefined}
        mode="citation"
        source=""
        environmentId={"environment-1" as EnvironmentId}
        cwd="/project"
        relativePath="main.tex"
        onInsert={onInsert}
      />,
    );
    await vi.waitFor(() => expect(onInsert).toHaveBeenCalledWith("cite", "lovelace1843notes"));
  });
});
