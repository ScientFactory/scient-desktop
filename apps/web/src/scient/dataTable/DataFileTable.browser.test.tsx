import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AssetUrlState } from "~/assets/assetUrls";
import { render } from "../../../test/render";

const { grid } = vi.hoisted(() => ({
  grid: { asset: null as unknown, revisions: [] as string[] },
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => grid.asset as AssetUrlState,
}));
// The grid reads its rows again whenever its revision changes; what matters is the revision.
vi.mock(import("./DataGrid"), () => ({
  DataGrid: ({ revision }: { revision: string }) => {
    if (grid.revisions.at(-1) !== revision) grid.revisions.push(revision);
    return <p>{revision}</p>;
  },
}));

import { DataFileTable } from "./DataFileTable";

const success = (fileRevision?: string) => ({
  _tag: "Success",
  url: "https://environment.test/table.csv",
  refresh: () => undefined,
  ...(fileRevision === undefined ? {} : { fileRevision }),
});

/** Starts a test with no rows read and the file check in `asset`. */
function setup(asset: unknown) {
  grid.asset = asset;
  grid.revisions.length = 0;
}

const table = (refreshToken: string, reloadKey = "0") => (
  <DataFileTable
    environmentId={EnvironmentId.make("environment")}
    absolutePath="/p/table.csv"
    name="table.csv"
    threadId={ThreadId.make("thread")}
    refreshToken={refreshToken}
    reloadKey={reloadKey}
  />
);

// regression: every agent command or edit in the project blanked the table and read it again.
describe("DataFileTable", () => {
  it("reads its rows again only when the file changed or the reader asks", async () => {
    setup(success("r1"));
    await using screen = await render(table("a"));
    await screen.rerender(table("b"));
    await screen.rerender(table("c"));
    expect(grid.revisions).toHaveLength(1);
    grid.asset = success("r2");
    await screen.rerender(table("d"));
    expect(grid.revisions).toHaveLength(2);
    await screen.rerender(table("d", "1"));
    expect(grid.revisions).toHaveLength(3);
  });

  it("reads its rows on every possible change when the environment reports no revision", async () => {
    setup(success());
    await using screen = await render(table("a"));
    await screen.rerender(table("b"));
    expect(grid.revisions).toHaveLength(2);
  });
});
