import "../../index.css";

import { AccountId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const undone = vi.hoisted(() => [] as unknown[]);
vi.mock("./removeWithUndo", async (original) => ({
  ...(await original<typeof import("./removeWithUndo")>()),
  useRemoveWithUndo: () => ({ undoRemoval: (receipts: unknown) => undone.push(receipts) }),
}));

const { RemovedBand } = await import("./RemovedBand");

it("says an agent removed a row, beside the same Undo", async () => {
  const accountId = AccountId.make("acc_synthetic_removed");
  await using _screen = await render(
    <RemovedBand
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      snapshot={{
        removed: [
          {
            accountId,
            name: "Lab",
            removalId: "synthetic-removal",
            threadId: ThreadId.make("synthetic-thread"),
            until: "2026-11-26T11:00:00.000Z",
          },
        ],
        // regression: the person saw Undo but not who removed it.
        changes: [
          {
            at: "2026-11-26T10:00:00.000Z",
            target: { type: "account", accountId },
            change: "remove",
            threadId: ThreadId.make("synthetic-thread"),
          },
        ],
      }}
    />,
    { router: false },
  );
  await expect.element(page.getByText("Removed by an agent")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  expect(undone).toEqual([[{ accountId, removalId: "synthetic-removal" }]]);
});

it("names no chat for the person's own removal, after an agent's was undone (round 6c)", async () => {
  const accountId = AccountId.make("acc_synthetic_again");
  await using _screen = await render(
    <RemovedBand
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      snapshot={{
        // Removed again, by the person: its receipt names no chat.
        removed: [
          {
            accountId,
            name: "Lab",
            removalId: "synthetic-second",
            until: "2026-11-26T12:00:00.000Z",
          },
        ],
        // regression: the band found the agent's earlier removal, which was undone, by the id.
        changes: [
          {
            at: "2026-11-26T10:00:00.000Z",
            target: { type: "account", accountId },
            change: "remove",
            threadId: ThreadId.make("synthetic-thread"),
          },
          {
            at: "2026-11-26T10:05:00.000Z",
            target: { type: "account", accountId },
            change: "restore",
            threadId: ThreadId.make("synthetic-thread"),
          },
        ],
      }}
    />,
    { router: false },
  );
  await expect.element(page.getByText("Lab")).toBeVisible();
  expect(page.getByText("Removed by an agent").elements()).toEqual([]);
});
