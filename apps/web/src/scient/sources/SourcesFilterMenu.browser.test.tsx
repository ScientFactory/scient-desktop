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
const collection = (collectionId: string, name: string, parentCollectionId?: string) => ({
  collectionId,
  name,
  ...(parentCollectionId ? { parentCollectionId } : {}),
  sourceIds: [],
  updatedAt: "2026-11-12T00:00:00.000Z",
  updatedBy: "user" as const,
});
const organization: ScientSourcesOrganization = {
  collections: [
    collection("collection_long", longName),
    collection("collection_thesis", "Thesis"),
    collection("collection_methods", "Scanning", "collection_thesis"),
    collection("collection_fmri", "fMRI", "collection_methods"),
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

  it("unfolds the collection tree level by level, by keyboard and by the arrow, without leaving the menu", async () => {
    await using _screen = await render(<Harness />, { router: false });
    // A row's name ends with its count.
    const row = (name: string) => page.getByRole("menuitemradio", { name: `${name} 0` });

    await userEvent.click(page.getByRole("button", { name: "Filter sources" }));
    await userEvent.keyboard("{ArrowDown}{ArrowRight}");
    await expect.element(row("Thesis")).toHaveAttribute("aria-expanded", "false");
    await expect.element(row("Scanning")).not.toBeInTheDocument();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect.element(row("Thesis")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{ArrowRight}");
    await expect.element(row("fMRI")).toBeInTheDocument();

    // Left folds the row it is on; the submenu stays open.
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(row("fMRI")).not.toBeInTheDocument();
    await expect.element(row("Scanning")).toHaveFocus();

    // The arrow folds without choosing the collection.
    await userEvent.click(row("Thesis").element().querySelector("svg")!.parentElement!);
    await expect.element(row("Scanning")).not.toBeInTheDocument();
    await expect.element(row("Thesis")).toHaveAttribute("aria-checked", "false");
  });
});
