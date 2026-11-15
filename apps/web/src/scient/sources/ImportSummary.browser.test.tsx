import "../../index.css";

import type { ScientSourceImportOperation } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ImportSummary } from "./ImportSummary";

type Item = ScientSourceImportOperation["items"][number];

const imported = (index: number, notBrought: NonNullable<Item["notBrought"]>): Item => ({
  itemKey: `ITEM${index}`,
  state: "imported",
  sourceId: `source_${index}`,
  message: null,
  notBrought,
});

const operation = (
  items: ScientSourceImportOperation["items"],
  state: ScientSourceImportOperation["state"] = "completed",
): ScientSourceImportOperation => ({
  formatVersion: 2,
  operationId: "zotero-1",
  libraryId: "library_1",
  adapter: "zotero",
  actor: "user",
  intake: "zotero",
  state,
  createdAt: "2026-11-15T09:00:00.000Z",
  updatedAt: "2026-11-15T09:05:00.000Z",
  items,
  notBrought: [{ kind: "notes-alone", count: 5 }],
});

const fields = ["place", "edition", "numPages", "series", "shortTitle", "callNumber"];

describe("what an import says it did not bring", () => {
  it("lists each thing with how many references, shows them on request, and the rest on request", async () => {
    const onShowSources = vi.fn();
    const items = [
      imported(1, [
        ...fields.map((name) => ({ kind: "field" as const, name, count: 1 })),
        { kind: "highlights", count: 12 },
      ]),
      imported(2, [
        { kind: "field", name: "place", count: 1 },
        { kind: "highlights", count: 3 },
      ]),
    ];
    await using _screen = await render(
      <ImportSummary
        operation={operation(items)}
        outcome={null}
        onDismiss={() => undefined}
        onCancel={() => undefined}
        cancelling={false}
        onShowSources={onShowSources}
      />,
      { router: false },
    );

    await expect.element(page.getByText("Not brought from Zotero")).toBeVisible();
    await expect
      .element(page.getByText("All of it is still in Zotero.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText("15 on 2 references")).toBeVisible();
    await expect.element(page.getByText("Place of publication:", { exact: false })).toBeVisible();
    // Five kinds first; the rest, with what belongs to no reference, on request.
    await expect.element(page.getByText("Short title:", { exact: false })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Show all (8)" }));
    await expect.element(page.getByText("Short title:", { exact: false })).toBeVisible();
    await expect
      .element(page.getByText("Notes that belong to no reference:", { exact: false }))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Show: Place of publication" }));
    expect(onShowSources).toHaveBeenCalledWith(
      ["source_1", "source_2"],
      "References this was not brought for: Place of publication",
    );
    // What belongs to no reference has no references to show.
    await expect
      .element(page.getByRole("button", { name: "Show: Notes that belong to no reference" }))
      .not.toBeInTheDocument();
  });

  it("says nothing of it while the import still runs, and nothing at all when all was brought", async () => {
    const running = await render(
      <ImportSummary
        operation={operation([imported(1, [{ kind: "highlights", count: 2 }])], "running")}
        outcome={null}
        onDismiss={() => undefined}
        onCancel={() => undefined}
        cancelling={false}
      />,
      { router: false },
    );
    await expect.element(page.getByText("Importing sources")).toBeVisible();
    await expect.element(page.getByText("Not brought from Zotero")).not.toBeInTheDocument();
    await running.unmount();

    const { notBrought: _none, ...whole } = operation([
      { itemKey: "ITEM1", state: "imported", sourceId: "source_1", message: null },
    ]);
    await using _screen = await render(
      <ImportSummary
        operation={whole}
        outcome={null}
        onDismiss={() => undefined}
        onCancel={() => undefined}
        cancelling={false}
      />,
      { router: false },
    );
    await expect.element(page.getByText("Import complete")).not.toBeInTheDocument();
  });
});
