import "../../index.css";

import { EnvironmentId, type ScientSourceDetailResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { I18nProvider } from "~/i18n/I18nProvider";
import { setI18nLanguage, startI18n } from "~/i18n/runtime";
import { act, render } from "../../../test/render";
import { SourceEditor } from "./SourceEditor";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("./client", () => ({ updateScientSourceMetadata: mocks.update }));

const record: ScientSourceDetailResult = {
  formatVersion: 2,
  sourceId: "source_book",
  revision: 3,
  type: "book",
  title: "Statistical methods in medical research",
  creators: [
    { creatorType: "author", givenName: "Peter", familyName: "Armitage", literalName: null },
  ],
  issuedRaw: "2002",
  issuedYear: 2002,
  identifiers: [],
  abstract: null,
  containerTitle: null,
  publisher: "Blackwell Science",
  volume: null,
  issue: null,
  pages: null,
  language: null,
  url: null,
  more: { "publisher-place": "Oxford" },
  tags: [],
  externalReferences: [],
  attachments: [],
  fieldProvenance: [],
  importedAt: "2026-11-15T09:00:00.000Z",
};

describe("the editor's further details", () => {
  it("adds one from the list, changes one, removes one, and saves exactly those", async () => {
    mocks.update.mockReset().mockResolvedValue({ outcome: "updated", record });
    const onSaved = vi.fn();
    await using _screen = await render(
      <SourceEditor
        environmentId={EnvironmentId.make("environment_test")}
        root="/project"
        record={record}
        onCancel={() => undefined}
        onRefreshed={() => undefined}
        onSaved={onSaved}
      />,
      { router: false },
    );

    await expect
      .element(page.getByRole("textbox", { name: "Place of publication" }))
      .toHaveValue("Oxford");
    // A detail the book lacks is added from the list, under the name a person knows.
    await userEvent.click(page.getByRole("combobox", { name: "Add a detail" }));
    await userEvent.click(page.getByRole("option", { name: "Edition" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Edition" }), "4");
    // It is offered once: with a row of its own it leaves the list.
    await userEvent.click(page.getByRole("combobox", { name: "Add a detail" }));
    await expect.element(page.getByRole("option", { name: "Edition" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("option", { name: "Number of pages" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Number of pages" }), "817");
    await userEvent.click(page.getByRole("button", { name: "Remove Place of publication" }));
    await expect
      .element(page.getByRole("textbox", { name: "Place of publication" }))
      .not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]?.[1]).toMatchObject({
      sourceId: "source_book",
      expectedRevision: 3,
      metadata: { more: { edition: "4", "number-of-pages": "817" } },
    });
    expect(mocks.update.mock.calls[0]?.[1].metadata.more).not.toHaveProperty("publisher-place");
  });

  it("saves when a detail's text was erased: the blank row is a detail removed", async () => {
    mocks.update.mockReset().mockResolvedValue({ outcome: "updated", record });
    await using _screen = await render(
      <SourceEditor
        environmentId={EnvironmentId.make("environment_test")}
        root="/project"
        record={record}
        onCancel={() => undefined}
        onRefreshed={() => undefined}
        onSaved={() => undefined}
      />,
      { router: false },
    );
    await userEvent.fill(page.getByRole("textbox", { name: "Place of publication" }), "   ");
    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    // Not sent as an empty entry, which the server would refuse.
    expect(mocks.update.mock.calls[0]?.[1].metadata.more).toEqual({});
  });
});

describe("the editor's type and creators", () => {
  it("shows names a person knows, saves the roles the record uses, and can say a list is complete", async () => {
    await using locale = new AsyncDisposableStack();
    locale.defer(() => act(() => setI18nLanguage("en")));
    startI18n();
    await setI18nLanguage("en");
    mocks.update.mockReset().mockResolvedValue({ outcome: "updated", record });
    await using _screen = await render(
      <I18nProvider>
        <SourceEditor
          environmentId={EnvironmentId.make("environment_test")}
          root="/project"
          record={{
            ...record,
            type: "book-chapter",
            creators: [
              ...record.creators,
              { creatorType: "compiler", givenName: "Ann", familyName: "Lee", literalName: null },
            ],
            incompleteCreatorRoles: ["author"],
          }}
          onCancel={() => undefined}
          onRefreshed={() => undefined}
          onSaved={() => undefined}
        />
      </I18nProvider>,
      { router: false },
    );

    await expect.element(page.getByText("Book chapter")).toBeVisible();
    const [author, compiler] = page.getByRole("combobox", { name: "Role" }).all();
    await expect.element(author!).toHaveValue("Author");
    // A role the list does not know stays as it was written.
    await expect.element(compiler!).toHaveValue("compiler");
    await userEvent.click(page.getByRole("button", { name: "The author list is complete" }));
    await expect
      .element(page.getByRole("button", { name: "The author list is complete" }))
      .not.toBeInTheDocument();
    await act(() => setI18nLanguage("de"));
    const [localizedAuthor] = page.getByRole("combobox", { name: "Rolle" }).all();
    await expect.element(localizedAuthor!).toHaveValue("Autor");
    await userEvent.fill(localizedAuthor!, "Editor");
    await userEvent.keyboard("{Escape}");
    await expect.element(localizedAuthor!).toHaveValue("Herausgeber");
    await userEvent.click(page.getByRole("button", { name: "Speichern", exact: true }));
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]?.[1].metadata).toMatchObject({
      type: "book-chapter",
      creators: [{ creatorType: "editor" }, { creatorType: "compiler" }],
      incompleteCreatorRoles: [],
    });
  });
});
