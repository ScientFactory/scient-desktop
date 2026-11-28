import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { AccountId, EnvironmentId, ThreadId, type AccountHandoff } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { AccountHandoffs } from "./AccountApprovals";
import { accountsState } from "./accountsState";

const state = vi.hoisted(() => ({
  cancel: vi.fn(),
  show: vi.fn(),
  insert: vi.fn(),
  typeSaved: vi.fn(),
  protocol: 2,
  sessions: {} as object,
}));
vi.mock("~/previewStateStore", async (original) => ({
  ...(await original<typeof import("~/previewStateStore")>()),
  useThreadPreviewState: () => ({ sessions: state.sessions, desktopByTabId: {}, serverEpoch: 0 }),
}));
vi.mock("~/browser/previewRuntime", async (original) => ({
  ...(await original<typeof import("~/browser/previewRuntime")>()),
  useRendersServerTabNatively: () => false,
}));
vi.mock("~/browser/ServerBrowserSurface", () => ({ ServerBrowserSurface: () => null }));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: { accountsProtocol: state.protocol }, canWrite: true }),
  useAccountCommand: (command: unknown) =>
    command === accountsState.cancelHandoff
      ? state.cancel
      : command === accountsState.insertHandoffCode
        ? state.insert
        : command === accountsState.typeSavedInHandoff
          ? state.typeSaved
          : state.show,
}));

it("shows one compact line, the browser or its fallback, and cancels the identified wait", async () => {
  state.cancel.mockReset();
  state.show.mockReset();
  state.sessions = {};
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
  await expect.element(page.getByText("Approve on your phone", { exact: false })).toBeVisible();
  await expect.element(page.getByText("Tap 42", { exact: true })).toBeVisible();
  // This client has no view of the tab, so it offers to open the browser instead.
  await page.getByRole("button", { name: "Open browser" }).click();
  expect(state.show).toHaveBeenCalledWith({ handoffId: handoff.handoffId });
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  expect(state.cancel).toHaveBeenCalledWith({ handoffId: handoff.handoffId });
  for (const [kind, instruction, refused, choose] of [
    ["code", "Enter the code"],
    ["captcha", "Solve the check."],
    // The site refused the password: that, not the check it still shows, is what to fix.
    ["captcha", "Password refused. Type it again.", "password"],
    ["passkey", "Use your passkey"],
    ["other", "Finish signing in."],
    ["other", "Choose an account.", undefined, "account"],
  ] as const) {
    await screen.rerender(
      <AccountHandoffs
        environmentId={environmentId}
        handoffs={[
          {
            ...handoff,
            kind,
            tabId: undefined,
            ...(refused ? { refused } : {}),
            ...(choose ? { choose } : {}),
          },
        ]}
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

it("says why an agent asked, and what is typed in a tab streamed from the server isn't kept", async () => {
  state.sessions = { "synthetic-tab": { runtime: "server" } };
  const handoff: AccountHandoff = {
    handoffId: "synthetic-streamed",
    threadId: ThreadId.make("synthetic-thread"),
    accountId: AccountId.make("acc_synthetic01"),
    accountName: "Synthetic account",
    site: "example.com",
    kind: "other",
    tabId: "synthetic-tab",
    reason: "To read the project's issues.",
    startedAt: "2026-10-27T00:00:00Z",
    expiresAt: "2026-10-27T00:15:00Z",
  };
  await using _screen = await render(
    <AccountHandoffs
      environmentId={EnvironmentId.make("synthetic")}
      handoffs={[handoff]}
      canWrite
    />,
  );
  await expect.element(page.getByText("What you type here isn't kept.")).toBeVisible();
  await expect.element(page.getByText("To read the project's issues.")).toBeVisible();
});

it("inserts the code the person picks, by its id, when Scient couldn't be sure which", async () => {
  state.insert.mockReset();
  const handoff: AccountHandoff = {
    handoffId: "synthetic-code",
    threadId: ThreadId.make("synthetic-thread"),
    accountId: AccountId.make("acc_synthetic01"),
    accountName: "Synthetic account",
    site: "example.com",
    kind: "code",
    codes: [
      { codeId: "first", source: "messages", at: "2026-10-27T00:00:10Z" },
      { codeId: "second", source: "mail", at: "2026-10-27T00:00:20Z" },
    ],
    startedAt: "2026-10-27T00:00:00Z",
    expiresAt: "2026-10-27T00:03:00Z",
  };
  // A server older than protocol 2 can't take the click: no Insert.
  state.protocol = 1;
  await using screen = await render(
    <AccountHandoffs
      environmentId={EnvironmentId.make("synthetic")}
      handoffs={[handoff]}
      canWrite
    />,
  );
  await expect.element(page.getByRole("button", { name: /Insert/ })).not.toBeInTheDocument();
  state.protocol = 2;
  await screen.rerender(
    <AccountHandoffs
      environmentId={EnvironmentId.make("synthetic")}
      handoffs={[{ ...handoff }]}
      canWrite
    />,
  );
  await page.getByRole("button", { name: /Insert · Mail/ }).click();
  expect(state.insert).toHaveBeenCalledWith({ handoffId: "synthetic-code", codeId: "second" });
});

it("sends the card's own revision with Use saved, and offers none without one", async () => {
  state.typeSaved.mockReset();
  state.sessions = {};
  const handoff: AccountHandoff = {
    handoffId: "synthetic-saved",
    threadId: ThreadId.make("synthetic-thread"),
    accountId: AccountId.make("acc_synthetic01"),
    accountName: "Synthetic account",
    site: "example.com",
    kind: "code",
    useSaved: "dana",
    useSavedRevision: "r2",
    startedAt: "2026-10-27T00:00:00Z",
    expiresAt: "2026-10-27T00:03:00Z",
  };
  const environmentId = EnvironmentId.make("synthetic");
  await using screen = await render(
    <AccountHandoffs environmentId={environmentId} handoffs={[handoff]} canWrite />,
  );
  await page.getByRole("button", { name: "Use saved dana" }).click();
  // regression: the click named only the hand-off, so a newer box under it could take it.
  expect(state.typeSaved).toHaveBeenCalledWith({ handoffId: handoff.handoffId, revision: "r2" });
  const { useSavedRevision: _revision, ...unbound } = handoff;
  await screen.rerender(
    <AccountHandoffs environmentId={environmentId} handoffs={[unbound]} canWrite />,
  );
  await expect
    .element(page.getByRole("button", { name: "Use saved dana" }))
    .not.toBeInTheDocument();
});
