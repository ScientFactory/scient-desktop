import { render } from "../../../test/render";
import "../../index.css";

import type { ScientSourcesOrganization } from "@scientfactory/scient-sources";
import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SourcesActiveFilters } from "./SourcesActiveFilters";
import { SourcesBulkBar, type SourcesBulkLibrary } from "./SourcesBulkBar";
import { SourcesNameDialog, type SourcesNameRequest } from "./SourcesNameDialog";
import { useSourcesOrganize } from "./useSourcesOrganize";

const mocks = vi.hoisted(() => ({
  organizeScientSources: vi.fn(),
  bulkUpdateScientSources: vi.fn(),
}));

vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));
vi.mock("./client", () => ({
  organizeScientSources: mocks.organizeScientSources,
  bulkUpdateScientSources: mocks.bulkUpdateScientSources,
  restoreScientSource: vi.fn(),
}));

type SourceSummary = ScientSourcesOverviewResult["records"][number];

function source(sourceId: string, tags: ReadonlyArray<string>): SourceSummary {
  return {
    sourceId,
    revision: 1,
    type: "article",
    title: `Source ${sourceId}`,
    creators: [],
    issuedYear: 2024,
    identifiers: [],
    containerTitle: null,
    url: null,
    tags,
    externalReferences: [],
    attachments: [],
    importedAt: "2026-11-10T00:00:00.000Z",
  };
}

const records = [source("a", ["RCT"]), source("b", ["RCT"]), source("c", [])];
const organization: ScientSourcesOrganization = {
  collections: [
    {
      collectionId: "collection_methods",
      name: "Methods",
      sourceIds: ["a"],
      updatedAt: "2026-11-10T00:00:00.000Z",
      updatedBy: "user",
    },
  ],
  savedSearches: [
    {
      searchId: "search_rct",
      name: "Trials",
      filter: { text: "sepsis", tags: ["RCT"] },
      updatedAt: "2026-11-10T00:00:00.000Z",
      updatedBy: "agent",
    },
  ],
};

function Harness(props: {
  readonly selected?: ReadonlyArray<string>;
  readonly saved?: boolean;
  readonly library?: SourcesBulkLibrary;
  readonly onRemove?: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState<SourcesNameRequest | null>(null);
  const organize = useSourcesOrganize({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    organization,
    query,
    setQuery,
    refreshOverview: async () => undefined,
  });
  const [started, setStarted] = useState(false);
  if (!started) {
    setStarted(true);
    if (props.selected) organize.setSelection(props.selected);
    if (props.saved) organize.applySavedSearch("search_rct");
  }
  return (
    <>
      <output data-testid="query">{query}</output>
      {organize.selection.size > 0 ? (
        <SourcesBulkBar
          organize={organize}
          records={records}
          visibleSourceIds={records.map((record) => record.sourceId)}
          onRequestName={setRequest}
          onRemove={props.onRemove ?? (async () => undefined)}
          {...(props.library ? { library: props.library } : {})}
        />
      ) : (
        <SourcesActiveFilters organize={organize} matchCount={2} onRequestName={setRequest} />
      )}
      <SourcesNameDialog request={request} onClose={() => setRequest(null)} />
    </>
  );
}

function setup() {
  mocks.organizeScientSources.mockReset();
  mocks.bulkUpdateScientSources.mockReset();
  mocks.bulkUpdateScientSources.mockResolvedValue({ sources: [], collections: [] });
}

describe("Sources bulk edit and saved searches", () => {
  it("removes a tag every selected source has and adds one only some have", async () => {
    setup();
    await using _screen = await render(<Harness selected={["a", "b"]} />, { router: false });

    await userEvent.click(page.getByRole("button", { name: "Tag" }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "RCT" }));
    await vi.waitFor(() =>
      expect(mocks.bulkUpdateScientSources).toHaveBeenCalledWith("environment-1", {
        root: "/project",
        change: { sourceIds: ["a", "b"], removeTags: ["RCT"] },
      }),
    );
  });

  it("adds a shared tag to a mixed selection and puts sources into a collection", async () => {
    setup();
    await using _screen = await render(<Harness selected={["a", "c"]} />, { router: false });

    await userEvent.click(page.getByRole("button", { name: "Tag" }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "RCT" }));
    await vi.waitFor(() =>
      expect(mocks.bulkUpdateScientSources).toHaveBeenLastCalledWith("environment-1", {
        root: "/project",
        change: { sourceIds: ["a", "c"], addTags: ["RCT"] },
      }),
    );
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Collection" }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Methods" }));
    await vi.waitFor(() =>
      expect(mocks.bulkUpdateScientSources).toHaveBeenLastCalledWith("environment-1", {
        root: "/project",
        change: { sourceIds: ["a", "c"], addToCollectionIds: ["collection_methods"] },
      }),
    );
  });

  it("restores a saved search's query and updates that search, not a new one", async () => {
    setup();
    mocks.organizeScientSources.mockResolvedValue({
      outcome: "updated",
      savedSearch: { ...organization.savedSearches[0]!, name: "Sepsis trials" },
    });
    await using screen = await render(<Harness saved />, { router: false });

    await expect.element(screen.getByTestId("query")).toHaveTextContent("sepsis");
    await expect.element(screen.getByText("Trials")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Filter actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Update saved search…" }));
    const input = page.getByRole("textbox", { name: "Search name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Sepsis trials");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(mocks.organizeScientSources).toHaveBeenCalledWith("environment-1", {
        root: "/project",
        change: {
          action: "save-search",
          name: "Sepsis trials",
          filter: { tags: ["RCT"], text: "sepsis" },
          searchId: "search_rct",
        },
      }),
    );
  });

  it("marks the whole selection read in one request on a personal Library", async () => {
    setup();
    const onSetReadingState = vi.fn(async () => undefined);
    await using _screen = await render(
      <Harness
        selected={["a", "b", "c"]}
        library={{
          listed: "library",
          onSetReadingState,
          onAddToProject: async () => undefined,
          onRemoveFromProject: async () => true,
        }}
      />,
      { router: false },
    );

    await userEvent.click(page.getByRole("button", { name: "Mark" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Mark read" }));
    await vi.waitFor(() => expect(onSetReadingState).toHaveBeenCalledTimes(1));
    expect(onSetReadingState).toHaveBeenCalledWith(["a", "b", "c"], { readingStatus: "read" });
  });

  it("offers no reading change to a session that may not make one", async () => {
    setup();
    await using screen = await render(
      <Harness
        selected={["a"]}
        library={{
          listed: "library",
          onAddToProject: async () => undefined,
          onRemoveFromProject: async () => true,
        }}
      />,
      { router: false },
    );

    await expect.element(screen.getByText("1 selected")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Mark" })).not.toBeInTheDocument();
  });

  it("takes sources out of this project in This project, without moving them to Trash", async () => {
    setup();
    const onRemoveFromProject = vi.fn(async () => true);
    const onRemove = vi.fn(async () => undefined);
    await using screen = await render(
      <Harness
        selected={["a", "b"]}
        onRemove={onRemove}
        library={{ listed: "project", onAddToProject: async () => undefined, onRemoveFromProject }}
      />,
      { router: false },
    );

    await expect
      .element(screen.getByRole("button", { name: /Move .* to Trash/u }))
      .not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from this project: 2 selected" }),
    );
    await vi.waitFor(() => expect(onRemoveFromProject).toHaveBeenCalledTimes(1));
    expect(onRemoveFromProject).toHaveBeenCalledWith([records[0], records[1]]);
    expect(onRemove).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Remove from this project: 2 selected" }))
      .not.toBeInTheDocument();
  });

  it("keeps the selection when removing from this project is cancelled", async () => {
    setup();
    const onRemoveFromProject = vi.fn(async () => false);
    await using screen = await render(
      <Harness
        selected={["a", "b"]}
        library={{ listed: "project", onAddToProject: async () => undefined, onRemoveFromProject }}
      />,
      { router: false },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove from this project: 2 selected" }),
    );
    await vi.waitFor(() => expect(onRemoveFromProject).toHaveBeenCalledTimes(1));
    await expect
      .element(page.getByRole("button", { name: "Remove from this project: 2 selected" }))
      .toBeInTheDocument();
  });
});
