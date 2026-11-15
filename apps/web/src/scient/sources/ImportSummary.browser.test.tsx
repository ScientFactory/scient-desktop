import "../../index.css";

import type { ScientSourceImportOperation } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { importResultContent, RunningImportBody } from "./ImportSummary";
import type { SourcesResultContent } from "./sourcesFeedback";

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

function Receipt(props: { readonly content: SourcesResultContent }) {
  return (
    <div>
      <p>{props.content.summary}</p>
      {props.content.details}
      {props.content.actions}
    </div>
  );
}

const fields = ["place", "edition", "numPages", "series", "shortTitle", "callNumber"];

describe("a finished Zotero import's receipt", () => {
  it("lists what was not brought with how many references, shows them on request, and the rest on request", async () => {
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
    const content = importResultContent({
      operation: operation(items),
      outcome: null,
      referenceFile: null,
      target: "library",
      onShowSources,
    });
    await using _screen = await render(<Receipt content={content} />, { router: false });

    // The summary counts the exceptions; the details say each once.
    await expect
      .element(page.getByText("2 references imported and added to My Library. 1 exception."))
      .toBeVisible();
    await expect
      .element(page.getByText("Zotero holds more for some references than was brought."))
      .toBeVisible();
    await expect.element(page.getByText("Not brought from Zotero")).toBeVisible();
    await expect.element(page.getByText("15 on 2 references")).toBeVisible();
    await expect.element(page.getByText("Place of publication:", { exact: false })).toBeVisible();
    // Five kinds first; the rest, with what belongs to no reference, on request.
    await expect.element(page.getByText("Short title:", { exact: false })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Show all (8)" }));
    await expect.element(page.getByText("Short title:", { exact: false })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Show: Place of publication" }));
    expect(onShowSources).toHaveBeenCalledWith(
      ["source_1", "source_2"],
      "References this was not brought for: Place of publication",
    );
    await expect
      .element(page.getByRole("button", { name: "Show: Notes that belong to no reference" }))
      .not.toBeInTheDocument();
  });

  it("goes on with a large import after a stop, saying how many remain", async () => {
    const pending: Item = { itemKey: "ITEM2", state: "pending", sourceId: null, message: null };
    const { notBrought: _none, ...stopped } = operation([imported(1, []), pending], "cancelled");
    const onImport = vi.fn();
    const content = importResultContent({
      operation: stopped,
      outcome: null,
      referenceFile: null,
      target: "library",
      rest: { count: 4613, onImport },
    });
    await using _screen = await render(<Receipt content={content} />, { router: false });
    await expect
      .element(page.getByText("1 reference imported and added to My Library. 2 exceptions."))
      .toBeVisible();
    await expect
      .element(page.getByText("The import was stopped; 1 was not imported."))
      .toBeVisible();
    await expect.element(page.getByText("4,613 more are not imported yet.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Import the rest (4,613)" }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});

describe("a running import in Activity", () => {
  it("says how far it is and what later parts bring, and stops on request", async () => {
    const run = { runId: "run", part: 1, remaining: 4612, scope: { kind: "library" as const } };
    const pending: Item = { itemKey: "ITEM2", state: "pending", sourceId: null, message: null };
    const onCancel = vi.fn();
    await using _screen = await render(
      <RunningImportBody
        operation={{ ...operation([imported(1, []), pending], "running"), run }}
        cancelling={false}
        onCancel={onCancel}
      />,
      { router: false },
    );
    await expect.element(page.getByText("Importing 1 of 2 · 4,612 more to follow")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel after current item" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
