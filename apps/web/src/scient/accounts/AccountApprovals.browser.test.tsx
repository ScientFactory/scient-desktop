import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { AccountId, EnvironmentId, ThreadId, type AccountHandoff } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { AccountHandoffs } from "./AccountApprovals";
import { accountsState } from "./accountsState";

const state = vi.hoisted(() => ({ cancel: vi.fn(), show: vi.fn() }));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: null, canWrite: true }),
  useAccountCommand: (command: unknown) =>
    command === accountsState.cancelHandoff ? state.cancel : state.show,
}));

it("shows one compact line, the browser or its fallback, and cancels the identified wait", async () => {
  state.cancel.mockReset();
  state.show.mockReset();
  const handoff: AccountHandoff = {
    handoffId: "synthetic-wait",
    threadId: ThreadId.make("synthetic-thread"),
    accountId: AccountId.make("acc_synthetic01"),
    accountName: "Synthetic account",
    site: "example.com",
    kind: "push",
    number: "42",
    tabId: "synthetic-tab",
    startedAt: "2026-10-27T00:00:00Z",
    expiresAt: "2026-10-27T00:03:00Z",
  };
  const environmentId = EnvironmentId.make("synthetic");
  await using screen = await render(
    <AccountHandoffs environmentId={environmentId} handoffs={[handoff]} canWrite />,
  );
  await expect
    .element(page.getByText("Approve the sign-in on your phone.", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("Tap 42", { exact: true })).toBeVisible();
  // This client has no view of the tab, so it offers to open the browser instead.
  await page.getByRole("button", { name: "Open browser" }).click();
  expect(state.show).toHaveBeenCalledWith({ handoffId: handoff.handoffId });
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  expect(state.cancel).toHaveBeenCalledWith({ handoffId: handoff.handoffId });
  for (const [kind, instruction] of [
    ["code", "Type the code you were sent."],
    ["captcha", "Complete the check."],
    ["passkey", "Use your passkey or Touch ID."],
    ["other", "Finish signing in."],
  ] as const) {
    await screen.rerender(
      <AccountHandoffs
        environmentId={environmentId}
        handoffs={[{ ...handoff, kind, tabId: undefined }]}
        canWrite={false}
      />,
    );
    await expect.element(page.getByText(instruction, { exact: false })).toBeVisible();
    await expect.element(page.getByText("Tap 42", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Open browser" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Cancel sign-in" })).toBeDisabled();
  }
});
