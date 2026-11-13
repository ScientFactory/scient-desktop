import "../../index.css";
import type { EnvironmentId, ScientSourcesOrganizeResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SourcesHeaderMenu } from "./SourcesHeaderMenu";

const mocks = vi.hoisted(() => ({ organize: vi.fn() }));
vi.mock("./client", () => ({
  organizeScientSources: mocks.organize,
  readCitationStyles: vi.fn(),
  setCitationStyle: vi.fn(),
  exportScientSources: vi.fn(),
  readScientSourceTrash: vi.fn(),
  restoreScientSource: vi.fn(),
  deleteScientSourcesPermanently: vi.fn(),
}));
vi.mock("./sourcesCommands", () => ({
  sourcesCommands: { organize: {} },
  runSourcesCommand: vi.fn(),
  useCanRunSourcesCommand: () => true,
  useCanChangeLibrary: () => true,
}));

type Entry = NonNullable<ScientSourcesOrganizeResult["packageImports"]>[number];

it("reopens Package imports through Recover, undoes an import and revisits everything that stayed", async () => {
  let undone = false;
  const entry = (): Entry => ({
    importId: "import_123",
    packageTitle: "Thesis handoff",
    importedAt: "2026-11-13T10:00:00.000Z",
    undoneAt: undone ? "2026-11-13T11:00:00.000Z" : null,
    canUndo: !undone,
    added: { sources: 1, pdfs: 1, pins: 1, collections: 0, reviews: 0 },
    sourcesMatched: 1,
    failed: [],
    kept: undone ? ["pin edited2026"] : [],
    left: ["PDF methods.pdf on existing paper", "highlights annotations/paper.json"],
    retainedSourceIds: ["new-paper"],
  });
  mocks.organize.mockReset();
  mocks.organize.mockImplementation(async (_environment, input) => {
    if (input.change.action === "undo-import") {
      undone = true;
      return { outcome: "undone" };
    }
    return {
      outcome: "listed",
      packageImports: [entry()],
      packageImportDiagnostics: ["Skipped unreadable import receipt import_broken.json."],
    };
  });
  const changed = vi.fn(async () => undefined);
  await using _screen = await render(
    <SourcesHeaderMenu
      environmentId={"environment-1" as EnvironmentId}
      root="/project"
      totalCount={0}
      exportScope={null}
      trashedCount={0}
      onTrashChanged={changed}
      missingPdfCount={0}
      onGetMissingPdfs={() => undefined}
      onOpenReviews={() => undefined}
      onOpenSource={() => undefined}
      onPackageImported={changed}
    />,
    { router: false },
  );
  const openImports = async () => {
    await userEvent.click(page.getByRole("button", { name: "More Library actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Recover", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Package imports", exact: true }));
    await expect.element(page.getByRole("dialog", { name: "Package imports" })).toBeVisible();
  };
  await openImports();
  await expect.element(page.getByText("Thesis handoff", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Skipped unreadable import receipt import_broken.json."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Undo", exact: true }));
  await expect.element(page.getByText("What stayed")).toBeVisible();
  expect(changed).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await openImports();
  await expect
    .element(page.getByRole("button", { name: "Undo", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByText("What stayed"));
  await expect
    .element(page.getByText("Changed or used elsewhere: Project source edited2026"))
    .toBeVisible();
  await expect.element(page.getByText("PDF methods.pdf on existing paper")).toBeVisible();
  await expect.element(page.getByText("highlights annotations/paper.json")).toBeVisible();
});
