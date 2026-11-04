import "../../index.css";

import { RegistryContext } from "@effect/atom-react";
import {
  AccountId,
  EnvironmentId,
  defaultAccountControls,
  type AccountSaveInput,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const server = vi.hoisted(() => ({
  accounts: [] as Array<unknown>,
  /** Snapshots wait here, as behind a slow source-control discovery, until released. */
  gate: Promise.resolve() as Promise<void>,
  release: () => {},
  failNext: false,
  holdSnapshots() {
    server.gate = new Promise<void>((resolve) => (server.release = resolve));
  },
}));

// Stubs only the transport: the accounts atoms' own lanes and hooks do the rest.
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => {
  const runtime = await original();
  const accounts = (label: string) => label.startsWith("accounts:");
  const snapshotFamily = Atom.family((_key: string) =>
    Atom.make(
      Effect.tryPromise(async () => {
        await server.gate;
        if (server.failNext) {
          server.failNext = false;
          throw new Error("Synthetic snapshot failure");
        }
        return { ...base, accounts: [...server.accounts] } as AccountsSnapshot;
      }),
    ),
  );
  type Options = {
    readonly label: string;
    readonly scheduler?: unknown;
    readonly concurrency?: unknown;
    readonly onSuccess?: (
      target: unknown,
      registry: AtomRegistry.AtomRegistry,
      value: unknown,
    ) => Effect.Effect<void>;
  };
  const handle = (label: string, input: unknown) => {
    if (label === "accounts:plainKeys") return [];
    if (label !== "accounts:save") return {};
    const save = input as AccountSaveInput;
    const accountId = AccountId.make(`acc_synthetic${server.accounts.length}`);
    const account = summary(accountId, save.name, save.details);
    server.accounts.push(account);
    return { accountId, account };
  };
  return {
    ...runtime,
    createEnvironmentRpcQueryAtomFamily: ((rpcRuntime: never, options: Options) =>
      accounts(options.label)
        ? (target: unknown) => snapshotFamily(JSON.stringify(target))
        : runtime.createEnvironmentRpcQueryAtomFamily(rpcRuntime, options as never)) as never,
    createEnvironmentRpcSubscriptionAtomFamily: ((rpcRuntime: never, options: Options) =>
      accounts(options.label)
        ? () => Atom.make(AsyncResult.initial())
        : runtime.createEnvironmentRpcSubscriptionAtomFamily(
            rpcRuntime,
            options as never,
          )) as never,
    createEnvironmentRpcCommand: ((rpcRuntime: never, options: Options) =>
      accounts(options.label)
        ? {
            ...runtime.createRuntimeCommand(Atom.runtime(Layer.empty), {
              ...(options as Pick<Options, "label" | "scheduler" | "concurrency">),
              // As the real command does: success settles only after its onSuccess.
              execute: (target: { readonly input: unknown }, registry: AtomRegistry.AtomRegistry) =>
                Effect.sync(() => handle(options.label, target.input)).pipe(
                  Effect.tap(
                    (value) => options.onSuccess?.(target, registry, value) ?? Effect.void,
                  ),
                ),
            } as never),
            permissionAtom: () => Atom.make(true),
          }
        : runtime.createEnvironmentRpcCommand(rpcRuntime, options as never)) as never,
  };
});
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => environmentId,
}));

import { AccountsPage } from "./AccountsPage";
import { accountsState } from "./accountsState";

const environmentId = EnvironmentId.make("synthetic");
const base: AccountsSnapshot = {
  agentAccess: true,
  accounts: [],
  profiles: [],
  approvals: [],
  recentActivity: [],
  customModelKeys: [],
  stores: {
    scient: { protection: "file" },
    keychain: { available: false, platform: "linux" },
    onePassword: { state: "not-connected" },
  },
};
function summary(
  accountId: AccountId,
  name: string,
  details: AccountSaveInput["details"],
): AccountSummary {
  return {
    accountId,
    name,
    details,
    secrets: { password: { source: { type: "scient" } } },
    controls: defaultAccountControls("website"),
    status: "ready",
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
  };
}

async function setup() {
  server.accounts = [
    summary(AccountId.make("acc_synthetic_first"), "example.com", {
      kind: "website",
      sites: ["example.com"],
      username: "first",
    }),
  ];
  server.gate = Promise.resolve();
  server.failNext = false;
  const registry = AtomRegistry.make();
  const screen = await render(
    <RegistryContext.Provider value={registry}>
      <AccountsPage />
    </RegistryContext.Provider>,
  );
  await expect.element(page.getByText("1 site", { exact: true })).toBeVisible();
  return { screen, registry };
}

/** Saves a password through Add an account, resolving with the Saved passwords count the moment its form closes. */
async function savePassword(site: string) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add an account…" }).click();
  await page.getByRole("searchbox", { name: "Find an account" }).fill(site);
  await page.getByText("Website sign-in").first().click();
  await page.getByRole("textbox", { name: "Username" }).fill("synthetic");
  await page.getByLabelText("Password", { exact: true }).fill("synthetic-password");
  const countWhenClosed = new Promise<string | undefined>((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-accounts-dialog]")) return;
      observer.disconnect();
      resolve(document.body.textContent?.match(/Saved passwords(\d+ sites?)/)?.[1]);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  return countWhenClosed;
}

it("closes a saved password's form onto the new count while the refresh is still slow", async () => {
  const { screen } = await setup();
  await using _screen = screen;
  server.holdSnapshots();
  expect(await savePassword("example.org")).toBe("2 sites");
  server.release();
  await expect.element(page.getByText("2 sites", { exact: true })).toBeVisible();
});

it("keeps two quick saves in the count before either refresh arrives", async () => {
  const { screen } = await setup();
  await using _screen = screen;
  server.holdSnapshots();
  expect(await savePassword("example.org")).toBe("2 sites");
  expect(await savePassword("example.net")).toBe("3 sites");
  server.release();
  await expect.element(page.getByText("3 sites", { exact: true })).toBeVisible();
});

it("lets the next snapshot decide the count after a refresh fails", async () => {
  const { screen, registry } = await setup();
  await using _screen = screen;
  server.holdSnapshots();
  server.failNext = true;
  expect(await savePassword("example.org")).toBe("2 sites");
  server.release();
  await expect.element(page.getByText("1 site", { exact: true })).not.toBeInTheDocument();
  // Removed on another computer meanwhile: the next snapshot, not the saved copy, is shown.
  server.accounts.pop();
  registry.refresh(accountsState.snapshot({ environmentId, input: {} }));
  await expect.element(page.getByText("1 site", { exact: true })).toBeVisible();
});

it("keeps a session row in Browser sign-ins once it is named, and says what it is", async () => {
  const session = (
    id: string,
    site: string,
    patch: Partial<AccountSummary> & { readonly username?: string } = {},
  ): AccountSummary => {
    const { username, ...rest } = patch;
    return {
      ...summary(AccountId.make(id), site, {
        kind: "website",
        sites: [site],
        profileId: "work",
        origin: "browser-session",
        ...(username ? { username } : {}),
      }),
      secrets: {},
      ...rest,
    };
  };
  server.accounts = [
    session("acc_synthetic_imported", "github.com", {
      signIn: {
        state: "unknown",
        at: "2026-11-04T00:00:00.000Z",
        detail: "Imported from Chrome · Person",
        by: "look",
        from: "import",
      },
    }),
    // What a Check leaves once the page names who is signed in.
    session("acc_synthetic_named", "overleaf.com", {
      username: "person@example.com",
      signIn: { state: "signed-in", at: "2026-11-04T00:00:00.000Z", by: "look" },
    }),
  ];
  server.gate = Promise.resolve();
  await using _screen = await render(
    <RegistryContext.Provider value={AtomRegistry.make()}>
      <AccountsPage />
    </RegistryContext.Provider>,
  );
  await expect
    .element(page.getByText("Passwords work in every profile.", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("2 sites", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Saved passwords")).not.toBeInTheDocument();
  await page.getByText("Browser sign-ins").click();
  await expect.element(page.getByText("Imported", { exact: true })).toBeVisible();
  // The named row is still listed here, not moved out once it has a username.
  expect(page.getByRole("dialog").element().textContent).toContain("Signed in as");
});
