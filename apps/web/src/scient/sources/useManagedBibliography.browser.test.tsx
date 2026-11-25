import { render } from "../../../test/render";

import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useLibraryVersionStore } from "./librarySourceRequest";
import { useManagedBibliography } from "./useManagedBibliography";

const mocks = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("./client", () => ({ syncScientBibliography: mocks.sync }));
vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));

type SourceRecord = ScientSourcesOverviewResult["records"][number];

const paper = (sourceId: string, importedAt: string): SourceRecord => ({
  sourceId,
  revision: 1,
  type: "article",
  title: sourceId,
  creators: [],
  issuedYear: 2024,
  identifiers: [],
  containerTitle: null,
  url: null,
  externalReferences: [],
  attachments: [],
  importedAt,
});

const project = [paper("a", "2026-11-01T00:00:00.000Z")];
const library = [...project, paper("b", "2026-11-02T00:00:00.000Z")];

function Harness() {
  const [shown, setShown] = useState({ scope: "project", records: project });
  useManagedBibliography({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    records: shown.records,
    scope: shown.scope,
  });
  return (
    <>
      <button type="button" onClick={() => setShown({ scope: "library", records: library })}>
        My Library
      </button>
      <button
        type="button"
        onClick={() =>
          setShown((current) => ({
            ...current,
            records: [...current.records, paper("c", "2026-11-03T00:00:00.000Z")],
          }))
        }
      >
        Add
      </button>
    </>
  );
}

it("reads the bibliography again when the Library changes, not when another scope is listed", async () => {
  mocks.sync.mockReset().mockResolvedValue({ files: [] });
  useLibraryVersionStore.setState({ byRoot: {} });
  await using screen = await render(<Harness />, { router: false });
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
  const first = useLibraryVersionStore.getState().byRoot["/project"];
  expect(first).toBeDefined();

  await userEvent.click(screen.getByRole("button", { name: "My Library" }));
  await userEvent.click(screen.getByRole("button", { name: "My Library" }));
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(useLibraryVersionStore.getState().byRoot["/project"]).toBe(first);

  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
  expect(useLibraryVersionStore.getState().byRoot["/project"]).not.toBe(first);
});
