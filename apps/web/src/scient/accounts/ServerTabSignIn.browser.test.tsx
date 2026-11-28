import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { render } from "../../../test/render";
import { accountsState } from "./accountsState";
import { ServerTabSignIn } from "./ServerTabSignIn";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  signIn: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async (_input: { accountId: string }) => ({
    ok: true,
    value: { removalId: "synthetic-removal" },
  })),
  accounts: [] as ReadonlyArray<object>,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: { accountsProtocol: 2, accounts: state.accounts }, canWrite: true }),
  useAccountCommand: (command: unknown) =>
    command === accountsState.signInAsPerson
      ? state.signIn
      : command === accountsState.remove
        ? state.remove
        : vi.fn(),
}));

const login = (accountId: string, username: string, profileId = "main") =>
  ({
    accountId: AccountId.make(accountId),
    name: "idp.example.edu",
    details: { kind: "website", sites: ["idp.example.edu"], username, profileId },
    secrets: { password: { source: { type: "scient" } } },
    controls: defaultAccountControls("website"),
    status: "ok",
  }) as unknown as AccountSummary;

it("opens the login the person chose, on its computer, from the server tab's key", async () => {
  state.accounts = [
    login("acc_synthid1", "123456789"),
    login("acc_synthmail", "person@example.edu"),
  ];
  const environmentId = EnvironmentId.make("synthetic-computer");
  await using _screen = await render(
    <ServerTabSignIn
      environmentId={environmentId}
      threadRef={scopeThreadRef(environmentId, ThreadId.make("synthetic-thread"))}
      previewTabId="synthetic-tab"
      profileId="main"
      url="https://idp.example.edu/login"
    />,
    { router: false },
  );
  await page.getByRole("button", { name: "Saved sign-ins for idp.example.edu" }).click();
  await page.getByRole("button", { name: "Fill person@example.edu" }).click();
  expect(state.signIn).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: "acc_synthmail", tabId: "synthetic-tab" }),
  );
  // The filled login's own Edit opens it on its computer.
  await page.getByRole("button", { name: "More for person@example.edu" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/settings/accounts",
    search: { machine: environmentId, account: "acc_synthmail" },
  });
  // Edit in Accounts opens the site's saved passwords.
  await page.getByRole("button", { name: "Edit in Accounts" }).click();
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/settings/accounts",
    search: { machine: environmentId, show: "passwords", site: "https://idp.example.edu" },
  });
});

it("forgets the chosen login on another tab at the same address", async () => {
  state.accounts = [
    login("acc_synthid1", "123456789"),
    login("acc_synthmail", "person@example.edu"),
  ];
  state.navigate.mockClear();
  const environmentId = EnvironmentId.make("synthetic-computer");
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("synthetic-thread"));
  const tab = (previewTabId: string) => (
    <ServerTabSignIn
      environmentId={environmentId}
      threadRef={threadRef}
      previewTabId={previewTabId}
      profileId="main"
      url="https://idp.example.edu/login"
    />
  );
  await using screen = await render(tab("first-tab"), { router: false });
  await page.getByRole("button", { name: "Saved sign-ins for idp.example.edu" }).click();
  await page.getByRole("button", { name: "Fill person@example.edu" }).click();
  // The same controls now show another tab on the same page: nothing was filled there.
  await expect
    .element(page.getByRole("button", { name: "Filled with person@example.edu" }))
    .toBeVisible();
  await screen.rerender(tab("second-tab"));
  await expect
    .element(page.getByRole("button", { name: "Saved sign-ins for idp.example.edu" }))
    .toBeVisible();
  expect(
    page.getByRole("button", { name: "Filled with person@example.edu" }).elements(),
  ).toHaveLength(0);
});

it("offers copies of one login as one choice", async () => {
  state.accounts = [
    // regression: one login imported twice, as CC\\corcosy and cc\\corcosy, was two choices.
    login("acc_synthupper", "CC\\corcosy"),
    login("acc_synthlower", "cc\\corcosy"),
    // With or without the domain may be one login saved twice: still two choices, for the person.
    login("acc_synthbare", "corcosy"),
  ];
  state.signIn.mockClear();
  const environmentId = EnvironmentId.make("synthetic-computer");
  await using _screen = await render(
    <ServerTabSignIn
      environmentId={environmentId}
      threadRef={scopeThreadRef(environmentId, ThreadId.make("synthetic-thread"))}
      previewTabId="synthetic-tab"
      profileId="main"
      url="https://idp.example.edu/login"
    />,
    { router: false },
  );
  await page.getByRole("button", { name: "Saved sign-ins for idp.example.edu" }).click();
  const fills = page.getByRole("button", { name: /^Fill / }).elements();
  expect(
    fills.map((button) => button.getAttribute("aria-label")?.toLowerCase()).toSorted(),
  ).toEqual(["fill cc\\corcosy", "fill corcosy"]);
  await page.getByRole("button", { name: /^Fill cc\\corcosy$/i }).click();
  expect(state.signIn).toHaveBeenCalledTimes(1);
});

it("removes the whole login from the key, its copies in other profiles too", async () => {
  state.accounts = [
    login("acc_synthmain1", "ada@example.edu"),
    login("acc_synthwork1", "Ada@Example.edu", "work"),
  ];
  state.remove.mockClear();
  const environmentId = EnvironmentId.make("synthetic-computer");
  await using _screen = await render(
    <ServerTabSignIn
      environmentId={environmentId}
      threadRef={scopeThreadRef(environmentId, ThreadId.make("synthetic-thread"))}
      previewTabId="synthetic-tab"
      profileId="main"
      url="https://idp.example.edu/login"
    />,
    { router: false },
  );
  await page.getByRole("button", { name: "Saved sign-ins for idp.example.edu" }).click();
  await page.getByRole("button", { name: "More for ada@example.edu" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  // regression: only the copy that fills here went; Work's copy stayed in Saved passwords.
  await vi.waitFor(() =>
    expect(state.remove.mock.calls.map(([input]) => input.accountId).toSorted()).toEqual([
      "acc_synthmain1",
      "acc_synthwork1",
    ]),
  );
});
