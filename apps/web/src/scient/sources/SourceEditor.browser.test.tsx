import "../../index.css";

import { EnvironmentId, type ScientSourceDetailResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { I18nProvider } from "~/i18n/I18nProvider";
import { setI18nLanguage, startI18n } from "~/i18n/runtime";
import { useState } from "react";

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

describe("a draft when the source changes behind it", () => {
  it("keeps the fields the person changed, takes the rest from the newer record, and saves", async () => {
    const newer: ScientSourceDetailResult = { ...record, revision: 4, publisher: "Wiley" };
    mocks.update
      .mockReset()
      .mockResolvedValueOnce({ outcome: "stale", record: newer })
      .mockResolvedValueOnce({ outcome: "updated", record: newer });
    function Host() {
      const [shown, setShown] = useState(record);
      return (
        <SourceEditor
          environmentId={EnvironmentId.make("environment_test")}
          root="/project"
          record={shown}
          onCancel={() => undefined}
          onRefreshed={setShown}
          onSaved={() => undefined}
        />
      );
    }
    await using _screen = await render(<Host />, { router: false });

    // The editor's plain fields have no accessible name; they are found by what they hold.
    const field = (value: string) =>
      page.elementLocator(
        [...document.querySelectorAll("input")].find((input) => input.value === value)!,
      );
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect.element(save).toBeVisible();
    const title = field(record.title!);
    const publisher = field(record.publisher!);
    await userEvent.fill(title, "Statistical methods, fourth edition");
    await userEvent.click(save);
    await expect.element(page.getByText("Your changes are kept", { exact: false })).toBeVisible();
    await expect.element(title).toHaveValue("Statistical methods, fourth edition");
    await expect.element(publisher).toHaveValue("Wiley");

    await expect.element(save).toBeEnabled();
    await userEvent.click(save);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 4,
      metadata: { title: "Statistical methods, fourth edition", publisher: "Wiley" },
    });
  });
});

describe("a draft when the project key is renamed behind it", () => {
  it("shows the new key and saves without renaming it back", async () => {
    const pinned: ScientSourceDetailResult = { ...record, citationKey: "armitage2002old" };
    mocks.update.mockReset().mockResolvedValue({ outcome: "updated", record: pinned });
    let show = (_next: ScientSourceDetailResult) => {};
    function Host() {
      const [shown, setShown] = useState(pinned);
      show = setShown;
      return (
        <SourceEditor
          environmentId={EnvironmentId.make("environment_test")}
          root="/project"
          record={shown}
          onCancel={() => undefined}
          onRefreshed={setShown}
          onSaved={() => undefined}
        />
      );
    }
    await using _screen = await render(<Host />, { router: false });
    const field = (value: string) =>
      page.elementLocator(
        [...document.querySelectorAll("input")].find((input) => input.value === value)!,
      );
    await userEvent.fill(field(record.title!), "Statistical methods, fourth edition");

    // Another window renames the pin's key; pins carry no revision.
    await act(async () => show({ ...pinned, citationKey: "armitage2002new" }));
    await vi.waitFor(() =>
      expect([...document.querySelectorAll("input")].map((input) => input.value)).toContain(
        "armitage2002new",
      ),
    );

    await userEvent.click(page.getByRole("button", { name: "Save", exact: true }));
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0]?.[1].metadata).toMatchObject({
      title: "Statistical methods, fourth edition",
    });
    expect(mocks.update.mock.calls[0]?.[1].metadata).not.toHaveProperty("citationKey");
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
