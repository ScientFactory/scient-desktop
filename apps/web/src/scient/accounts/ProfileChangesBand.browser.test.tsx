import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const undone = vi.hoisted(() => [] as unknown[]);
vi.mock("./useAccounts", async (original) => ({
  ...(await original<typeof import("./useAccounts")>()),
  useAccountCommand: () => async (input: unknown) => {
    undone.push(input);
    return { ok: true, value: {} };
  },
}));

const { ProfileChangesBand } = await import("./ProfileChangesBand");

it("keeps each Undo for its hour once the work has ended, an agent's too", async () => {
  vi.setSystemTime(new Date("2026-11-26T10:30:00.000Z"));
  const hour = "2026-11-26T11:00:00.000Z";
  const at = "2026-11-26T10:00:00.000Z";
  await using _screen = await render(
    <ProfileChangesBand
      environmentId={EnvironmentId.make("synthetic")}
      canWrite
      snapshot={{
        profiles: [
          { profileId: "profile-lab", name: "Lab" },
          { profileId: "profile-home", name: "Home" },
        ] as never,
        profileOperations: [
          // Ended, part of it not copied: said so beside its Undo.
          {
            operationId: "op-copy",
            kind: "copy",
            profileId: "profile-lab",
            into: "profile-home",
            at,
            until: hour,
            server: { state: "done", uncovered: ["bank.example"] },
          },
          // Still being done: no Undo yet.
          {
            operationId: "op-pending",
            kind: "clear",
            profileId: "profile-home",
            at,
            until: hour,
            server: { state: "pending" },
          },
          // Undone already, or past its hour: gone.
          {
            operationId: "op-undone",
            kind: "clear",
            profileId: "profile-lab",
            at,
            until: hour,
            undone: { at },
          },
          {
            operationId: "op-old",
            kind: "clear",
            profileId: "profile-lab",
            at: "2000-01-01T00:00:00.000Z",
            until: "2000-01-01T01:00:00.000Z",
          },
          // An agent's refresh, ended in its hour: no Undo, its Activity line is the record (6m).
          {
            operationId: "op-refresh",
            kind: "refresh",
            profileId: "profile-home",
            at,
            until: hour,
            desktop: { state: "done", copied: 3 },
          },
        ] as never,
      }}
    />,
    { router: false },
  );
  await expect.element(page.getByText("Copied Lab to Home")).toBeVisible();
  await expect.element(page.getByText("Not copied: bank.example")).toBeVisible();
  // regression (6m): a refresh's Undo could restore cookies a page or sign-out changed since.
  expect(page.getByText("Refreshed Home").elements()).toEqual([]);
  expect(page.getByRole("button", { name: "Undo" }).all()).toHaveLength(1);
  await page.getByRole("button", { name: "Undo" }).click();
  expect(undone).toEqual([{ operationId: "op-copy" }]);
  vi.useRealTimers();
});
