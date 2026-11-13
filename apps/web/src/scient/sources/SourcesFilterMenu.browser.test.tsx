import { render } from "../../../test/render";
import "../../index.css";

import type { ScientSourcesOrganization } from "@scientfactory/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SourcesFilterMenu } from "./SourcesFilterMenu";
import { useSourcesOrganize } from "./useSourcesOrganize";

vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));
vi.mock("./client", () => ({
  organizeScientSources: vi.fn(),
  bulkUpdateScientSources: vi.fn(),
}));

const longName = "Methods for the long-term follow-up of the fjord sediment cores";
const organization: ScientSourcesOrganization = {
  collections: [
    {
      collectionId: "collection_long",
      name: longName,
      sourceIds: [],
      updatedAt: "2026-11-12T00:00:00.000Z",
      updatedBy: "user",
    },
  ],
  savedSearches: [],
};

function Harness() {
  const [query, setQuery] = useState("");
  const organize = useSourcesOrganize({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    organization,
    query,
    setQuery,
    refreshOverview: async () => undefined,
  });
  return (
    <SourcesFilterMenu organize={organize} records={[]} query={query} onRequestName={() => {}} />
  );
}

describe("SourcesFilterMenu", () => {
  it("shows a truncated collection's full name to a keyboard user", async () => {
    await using _screen = await render(<Harness />, { router: false });

    await userEvent.click(page.getByRole("button", { name: "Filter sources" }));
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("menuitem", { name: /Collection/u })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("menuitemradio", { name: /All sources/u })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");

    await expect.element(page.getByRole("menuitemradio", { name: /long-term/u })).toHaveFocus();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(longName),
    );
  });
});
