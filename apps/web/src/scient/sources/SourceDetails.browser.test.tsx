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

it("saves a restored earlier version as its own checkpoint, apart from this editor's autosave", async () => {
  const saveProjectNote = vi.fn(
    async (
      note: string | null,
      _expectedRevision: number,
      _context: { readonly base: string | null; readonly session: string },
    ) => ({
      outcome: "updated" as const,
      record: { ...record, ...(note ? { note } : {}), projectNote: note },
    }),
  );
  await using _screen = await render(
    <SourceDetails
      record={{
        ...record,
        projectNoteHistory: [
          { note: "The first reason", at: "2026-11-01T00:00:00.000Z", kind: "edit", by: "user" },
          {
            note: "Why I cite this here",
            at: "2026-11-12T00:00:00.000Z",
            kind: "edit",
            by: "user",
          },
        ],
      }}
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
  await userEvent.keyboard(", typed");
  await userEvent.tab();
  await vi.waitFor(() => expect(saveProjectNote).toHaveBeenCalledTimes(1));

  await userEvent.click(page.getByRole("button", { name: "Earlier versions" }));
  await userEvent.click(page.getByRole("menuitem", { name: /The first reason/ }));
  await vi.waitFor(() => expect(saveProjectNote).toHaveBeenCalledTimes(2));
  const [typed, restored] = saveProjectNote.mock.calls;
  expect(restored?.[0]).toBe("The first reason");
  // The same session within ten minutes would replace the typed checkpoint on the server.
  expect(restored?.[2].session).not.toBe(typed?.[2].session);
});

it("reads and restores the note of a merged source's other key on that key", async () => {
  const merged = { ...record, citationKey: "first2026", alsoCitedAs: ["second2026"] };
  const other = {
    ...merged,
    note: "Same text",
    projectNote: "Same text",
    projectNoteHistory: [
      { note: "Why the second copy", at: "2026-11-01T00:00:00.000Z", kind: "edit", by: "user" },
      { note: "Same text", at: "2026-11-12T00:00:00.000Z", kind: "edit", by: "user" },
    ],
  } satisfies ScientSourceDetailResult;
  const loadKeyNote = vi.fn(async (_citationKey: string) => other);
  const saveKeyNote = vi.fn(
    async (
      _citationKey: string,
      note: string | null,
      _expectedRevision: number,
      _context: { readonly base: string | null; readonly session: string },
    ) => ({
      outcome: "updated" as const,
      record: { ...other, note: note ?? "", projectNote: note },
    }),
  );
  const saveProjectNote = vi.fn(async () => ({ outcome: "updated" as const, record: merged }));
  await using _screen = await render(
    <SourceDetails
      record={merged}
      diagnostics={[]}
      library={{
        canSavePersonalNote: false,
        onSavePersonalNote: async () => ({ outcome: "unchanged", record }),
        onLoadKeyNote: loadKeyNote,
        onSaveKeyNote: saveKeyNote,
      }}
      onBack={() => undefined}
      onEdit={() => undefined}
      onSaveNote={saveProjectNote}
      onRefreshMetadata={async () => undefined}
      onRemove={async () => undefined}
      onOpenPdf={() => undefined}
    />,
  );

  await userEvent.click(page.getByRole("button", { name: "second2026" }));
  await expect.element(page.getByText("Note for this project (second2026)")).toBeVisible();
  expect(loadKeyNote).toHaveBeenCalledWith("second2026");
  await userEvent.click(page.getByRole("button", { name: "Earlier versions" }));
  await userEvent.click(page.getByRole("menuitem", { name: /Why the second copy/ }));
  await vi.waitFor(() => expect(saveKeyNote).toHaveBeenCalledTimes(1));
  expect(saveKeyNote.mock.calls[0]?.slice(0, 2)).toEqual(["second2026", "Why the second copy"]);
  expect(saveKeyNote.mock.calls[0]?.[3].base).toBe("Same text");
  expect(saveProjectNote).not.toHaveBeenCalled();
});
