import "~/index.css";
import type { ScientSourceDetailResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SourceDetails } from "./SourceDetails";

vi.mock("@scientfactory/scient-citations", () => ({ formatSourceReference: () => "Reference" }));

const record: ScientSourceDetailResult = {
  formatVersion: 1,
  sourceId: "source_library",
  projectId: "project_test",
  revision: 7,
  type: "article",
  title: "A paper in the personal Library",
  creators: [],
  issuedRaw: null,
  issuedYear: 2024,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: null,
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  tags: [],
  externalReferences: [],
  attachments: [],
  fieldProvenance: [],
  importedAt: "2026-11-12T00:00:00.000Z",
  note: "Why I cite this here",
  pinned: true,
  projectNote: "Why I cite this here",
  personalNote: null,
  readingStatus: "unread",
  starred: false,
};

it("saves My note against the library record's revision, apart from this project's note", async () => {
  const savePersonalNote = vi.fn(async (note: string | null, _expectedRevision: number) => ({
    outcome: "updated",
    record: { ...record, revision: 8, personalNote: note },
  }));
  const saveProjectNote = vi.fn(async () => ({ outcome: "unchanged" as const, record }));
  await using _screen = await render(
    <SourceDetails
      record={record}
      diagnostics={[]}
      library={{ canSavePersonalNote: true, onSavePersonalNote: savePersonalNote }}
      onBack={() => undefined}
      onEdit={() => undefined}
      onSaveNote={saveProjectNote}
      onRefreshMetadata={async () => undefined}
      onRemove={async () => undefined}
      onOpenPdf={() => undefined}
    />,
  );

  await userEvent.click(page.getByRole("textbox", { name: "My note" }));
  await userEvent.keyboard("Read the methods first");
  await userEvent.tab();

  await vi.waitFor(() =>
    expect(savePersonalNote).toHaveBeenCalledWith("Read the methods first", 7, expect.anything()),
  );
  expect(saveProjectNote).not.toHaveBeenCalled();
});

it("keeps both texts when this project's note changed elsewhere, and saves mine only when asked", async () => {
  const saveProjectNote = vi
    .fn<
      (
        note: string | null,
        expectedRevision: number,
        context: { readonly base: string | null; readonly session: string },
      ) => Promise<{ outcome: "stale" | "updated"; record: ScientSourceDetailResult }>
    >()
    .mockResolvedValueOnce({
      outcome: "stale",
      record: {
        ...record,
        note: "Changed in another window",
        projectNote: "Changed in another window",
      },
    })
    .mockImplementation(async (note) => ({
      outcome: "updated",
      record: { ...record, ...(note ? { note } : {}), projectNote: note },
    }));
  await using _screen = await render(
    <SourceDetails
      record={record}
      diagnostics={[]}
      library={{
        canSavePersonalNote: false,
        onSavePersonalNote: async () => ({ outcome: "unchanged", record }),
      }}
      onBack={() => undefined}
      onEdit={() => undefined}
      onSaveNote={saveProjectNote}
      onRefreshMetadata={async () => undefined}
      onRemove={async () => undefined}
      onOpenPdf={() => undefined}
    />,
  );

  await userEvent.click(page.getByRole("button", { name: "Edit note for this project" }));
  await userEvent.keyboard(", mine");
  await userEvent.tab();

  await expect.element(page.getByText("Saved elsewhere")).toBeVisible();
  await expect.element(page.getByText("Changed in another window")).toBeVisible();
  expect(saveProjectNote).toHaveBeenLastCalledWith(
    "Why I cite this here, mine",
    7,
    expect.objectContaining({ base: "Why I cite this here" }),
  );

  await userEvent.click(page.getByRole("button", { name: "Keep mine" }));
  await vi.waitFor(() =>
    expect(saveProjectNote).toHaveBeenLastCalledWith(
      "Why I cite this here, mine",
      7,
      expect.objectContaining({ base: "Changed in another window" }),
    ),
  );
  await expect.element(page.getByText("Saved elsewhere")).not.toBeInTheDocument();
});
