import "../../index.css";

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
import { Atom, AsyncResult, type AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const server = vi.hoisted(() => ({
  accounts: [] as Array<unknown>,
  /** Holds the next snapshot, as a slow source-control discovery does. */
  held: null as null | { readonly release: () => void },
  hold() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.held = { release };
    return gate;
  },
  pending: null as null | Promise<void>,
}));

// Stubs only the transport: the accounts atoms' own lanes decide when a command is done.
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => {
  const runtime = await original();
  const accounts = (label: string) => label.startsWith("accounts:");
  const snapshotFamily = Atom.family((_key: string) =>
    Atom.make(
      Effect.promise(async () => {
        await server.pending;
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
    server.accounts.push(summary(accountId, save.name, save.details));
    server.pending = server.hold();
    return { accountId };
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

it("closes a saved password's form onto the new Saved passwords count", async () => {
  server.accounts = [
    summary(AccountId.make("acc_synthetic_first"), "example.com", {
      kind: "website",
      sites: ["example.com"],
      username: "first",
    }),
  ];
  server.pending = null;
  await using _screen = await render(<AccountsPage />);
  await expect.element(page.getByText("1 site", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add an account…" }).click();
  await page.getByRole("searchbox", { name: "Find an account" }).fill("example.org");
  await page.getByText("Website sign-in").first().click();
  await page.getByRole("textbox", { name: "Username" }).fill("second");
  await page.getByLabelText("Password", { exact: true }).fill("synthetic-password");
  const countWhenClosed = new Promise<string | null | undefined>((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-accounts-dialog]")) return;
      observer.disconnect();
      resolve(document.body.textContent?.match(/Saved passwords(\d+ sites?)/)?.[1]);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(server.held).not.toBeNull());
  server.held?.release();
  expect(await countWhenClosed).toBe("2 sites");
});
