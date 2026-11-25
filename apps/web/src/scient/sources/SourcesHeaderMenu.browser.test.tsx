import { render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SourcesHeaderMenu } from "./SourcesHeaderMenu";

vi.mock("./ProjectPackageMenu", () => ({
  RecoverPreMoveItem: () => <div role="menuitem">Recover sources from before the move</div>,
  SaveProjectPackageItem: () => null,
}));
vi.mock("./SourceTrash", () => ({ SourceTrashPopover: () => null }));
vi.mock("./sourcesCommands", async (original) => ({
  ...(await original<typeof import("./sourcesCommands")>()),
  useCanChangeLibrary: () => true,
  useCanRunSourcesCommand: () => true,
}));

const menu = (canRecoverPreMove: boolean, unfinishedDeletions?: number) => (
  <SourcesHeaderMenu
    environmentId={"environment-1" as EnvironmentId}
    root="/project"
    totalCount={3}
    exportScope={null}
    trashedCount={0}
    {...(unfinishedDeletions ? { unfinishedDeletions } : {})}
    onTrashChanged={async () => undefined}
    missingPdfCount={0}
    onGetMissingPdfs={() => undefined}
    onOpenReviews={() => undefined}
    onOpenSource={() => undefined}
    onBackUp={() => undefined}
    canChangeProject
    canRecoverPreMove={canRecoverPreMove}
  />
);

it.each([false, true])(
  "offers Recover sources from before the move only where a copy was kept (%s)",
  async (kept) => {
    await using _screen = await render(menu(kept), { router: false });
    await userEvent.click(page.getByRole("button", { name: "More Library actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Backup and recovery" }));
    await expect.element(page.getByRole("menuitem", { name: /Back up My Library/u })).toBeVisible();
    const recover = page.getByRole("menuitem", { name: "Recover sources from before the move" });
    if (kept) await expect.element(recover).toBeVisible();
    else await expect.element(recover).not.toBeInTheDocument();
  },
);

it("offers the Trash while a deletion for good is unfinished, even with nothing listed", async () => {
  await using _screen = await render(menu(false, 1), { router: false });
  await userEvent.click(page.getByRole("button", { name: "More Library actions" }));
  await expect.element(page.getByRole("menuitem", { name: "Trash" })).toBeVisible();
});
