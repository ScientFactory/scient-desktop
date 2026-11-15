import "../../index.css";
import type { EnvironmentId, ScientSourcesOrganizeResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RecentChangesDialog } from "./RecentChanges";

const mocks = vi.hoisted(() => ({ organize: vi.fn(), read: vi.fn() }));
vi.mock("./client", () => ({
  organizeScientSources: mocks.organize,
  readScientSourceRecentChanges: mocks.read,
  restoreScientSource: vi.fn(),
}));

type Entry = NonNullable<ScientSourcesOrganizeResult["packageImports"]>[number];

function setup() {
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
  mocks.read.mockReset().mockResolvedValue({ changes: [], more: false });
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
}

function dialog(props: { readonly canChange: boolean; readonly onChanged?: () => Promise<void> }) {
  return (
    <RecentChangesDialog
      environmentId={"environment-1" as EnvironmentId}
      root="/project"
      canChange={props.canChange}
      onUndoBulkEdit={async () => undefined}
      onShowSources={() => undefined}
      onChanged={props.onChanged ?? (async () => undefined)}
      onImportRest={async () => undefined}
      onAddFromLibrary={async () => undefined}
      onPutBackLibrary={async () => undefined}
      onShowDifferences={() => undefined}
      onClose={() => undefined}
    />
  );
}

const openImports = async () => {
  await userEvent.click(page.getByRole("button", { name: "Show package imports" }));
  await expect.element(page.getByRole("dialog", { name: "Package imports" })).toBeVisible();
};

it("reopens Package imports from Recent changes, undoes an import and revisits everything that stayed", async () => {
  setup();
  const changed = vi.fn(async () => undefined);
  await using _screen = await render(dialog({ canChange: true, onChanged: changed }), {
    router: false,
  });
  await openImports();
  await expect.element(page.getByText("Thesis handoff", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Skipped unreadable import receipt import_broken.json."))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Undo", exact: true }));
  await expect.element(page.getByText("What stayed")).toBeVisible();
  expect(changed).toHaveBeenCalledTimes(1);
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Package imports" }))
    .not.toBeInTheDocument();
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

it("shows package imports without Undo to a session that may only read", async () => {
  setup();
  await using _screen = await render(dialog({ canChange: false }), { router: false });
  await openImports();
  await expect.element(page.getByText("Thesis handoff", { exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "Undo", exact: true }).elements()).toHaveLength(0);
});
