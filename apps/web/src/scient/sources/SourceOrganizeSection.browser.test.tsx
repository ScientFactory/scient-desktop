import { render } from "../../../test/render";
import "../../index.css";

import type { ScientSourcesOrganization } from "@scientfactory/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SourceFiling } from "./SourceOrganizeSection";
import { useSourcesOrganize } from "./useSourcesOrganize";

const mocks = vi.hoisted(() => ({ canChange: false }));
vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => mocks.canChange }));
vi.mock("./client", () => ({
  organizeScientSources: vi.fn(),
  bulkUpdateScientSources: vi.fn(),
}));

const organization: ScientSourcesOrganization = {
  collections: [
    {
      collectionId: "collection_thesis",
      name: "Thesis",
      sourceIds: ["source_1"],
      updatedAt: "2026-11-12T00:00:00.000Z",
      updatedBy: "user",
    },
  ],
  savedSearches: [],
};

function Harness(props: {
  readonly onShowTag: (tag: string) => void;
  readonly onShowCollection: (collectionId: string) => void;
}) {
  const organize = useSourcesOrganize({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    organization,
    query: "",
    setQuery: () => undefined,
    refreshOverview: async () => undefined,
  });
  return (
    <SourceFiling
      organize={organize}
      sourceId="source_1"
      tags={["methods"]}
      records={[]}
      onShowTag={props.onShowTag}
      onShowCollection={props.onShowCollection}
      onRequestName={() => undefined}
    />
  );
}

it("shows a read-only Library's tags and collections as chips that still list their sources", async () => {
  mocks.canChange = false;
  const onShowTag = vi.fn();
  const onShowCollection = vi.fn();
  await using _screen = await render(
    <Harness onShowTag={onShowTag} onShowCollection={onShowCollection} />,
    { router: false },
  );

  await userEvent.click(page.getByRole("button", { name: "Show sources tagged methods" }));
  await userEvent.click(page.getByRole("button", { name: "Show collection Thesis" }));
  expect(onShowTag).toHaveBeenCalledWith("methods");
  expect(onShowCollection).toHaveBeenCalledWith("collection_thesis");
  for (const name of ["Tag", "Collection", "Remove tag methods", "Remove from Thesis"]) {
    expect(page.getByRole("button", { name, exact: true }).query()).toBeNull();
  }
});
