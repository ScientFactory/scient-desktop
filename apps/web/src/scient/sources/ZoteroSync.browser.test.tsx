import type { EnvironmentId } from "@t3tools/contracts";
import type { ScientSourceZoteroRefreshItem } from "@scientfactory/scient-sources";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useZoteroSync, ZoteroRefreshDialog } from "./ZoteroSync";

const mocks = vi.hoisted(() => ({
  readZoteroStatus: vi.fn(),
  refreshZoteroSources: vi.fn(),
  sendSourcesToZotero: vi.fn(),
}));

vi.mock("./client", () => mocks);

const conflicted: ScientSourceZoteroRefreshItem = {
  sourceId: "source_a",
  title: "Engines",
  outcome: "unchanged",
  changedFields: [],
  addedPdfCount: 0,
  conflicts: [{ field: "title", local: "Mine", zotero: "Theirs" }],
  message: null,
};

function setup() {
  mocks.readZoteroStatus.mockReset().mockResolvedValue({
    state: "ready",
    apiVersion: 3,
    connection: "local",
    message: "Ready.",
  });
  mocks.refreshZoteroSources
    .mockReset()
    .mockResolvedValueOnce({ connection: "local", items: [conflicted] })
    .mockResolvedValueOnce({
      connection: "local",
      items: [{ ...conflicted, outcome: "updated", changedFields: ["title"], conflicts: [] }],
    });
  return { onChanged: vi.fn() };
}

function Harness(props: { readonly onChanged: () => void }) {
  const sync = useZoteroSync({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    onChanged: props.onChanged,
  });
  return (
    <>
      <button type="button" onClick={() => void sync.startRefresh()}>
        Start
      </button>
      <ZoteroRefreshDialog
        state={sync.refresh}
        resolving={sync.resolving}
        onClose={sync.closeRefresh}
        onResolve={(sourceId, field, side) => void sync.resolveConflict(sourceId, field, side)}
      />
    </>
  );
}

describe("Refresh from Zotero", () => {
  it("shows a clash and takes Zotero's value for just that field", async () => {
    const { onChanged } = setup();
    await using _screen = await render(<Harness onChanged={onChanged} />, { router: false });

    await page.getByRole("button", { name: "Start" }).click();
    await expect.element(page.getByText("Here: Mine")).toBeVisible();
    await page.getByRole("button", { name: "Use Zotero's" }).click();

    await expect.element(page.getByText("Here: Mine")).not.toBeInTheDocument();
    expect(mocks.refreshZoteroSources).toHaveBeenLastCalledWith("environment-1", {
      root: "/project",
      sourceIds: ["source_a"],
      connection: "local",
      useZotero: ["title"],
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("explains why Zotero cannot be read instead of refreshing", async () => {
    const { onChanged } = setup();
    mocks.readZoteroStatus.mockResolvedValue({
      state: "unreachable",
      apiVersion: null,
      connection: "local",
      message: "Open Zotero on the computer running this project, then check again.",
    });
    await using _screen = await render(<Harness onChanged={onChanged} />, { router: false });

    await page.getByRole("button", { name: "Start" }).click();

    await expect.element(page.getByText(/^Open Zotero on the computer/u)).toBeVisible();
    expect(mocks.refreshZoteroSources).not.toHaveBeenCalled();
  });
});
