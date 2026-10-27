import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  ProviderInstanceId,
  VaultSecretRef,
  type PluginKeyState,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { PluginKeys } from "./PluginKeys";

const state = vi.hoisted(() => ({
  data: null as PluginKeyState | null,
  canWrite: true,
  storeInstalled: false,
  bind: vi.fn(),
  unbind: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useClientSettings: () => [],
}));
vi.mock("./ExtensionRow", () => ({ ExtensionIcon: () => null }));
vi.mock("./ExtensionsPage", () => ({
  useExtensionsEnvironment: () => ({
    environmentId: "synthetic",
    canWrite: state.canWrite,
    providerInventory: {
      providers: state.storeInstalled
        ? [
            {
              instanceId: "synthetic-agent",
              plugins: [{ id: "sample@synthetic", name: "sample@synthetic" }],
            },
          ]
        : [],
    },
  }),
}));
vi.mock("./ExtensionDetailPages", () => ({
  DetailSection: ({
    title,
    status,
    children,
  }: {
    title: string;
    status?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section aria-label={title}>
      <h2>
        {title}
        {status ? <span role="status">{status}</span> : null}
      </h2>
      {children}
    </section>
  ),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.data, error: null }),
}));
vi.mock("./extensionsState", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    extensionsPluginKeys: () => null,
    bindPluginKey: { kind: "bind", permissionAtom: () => Atom.make(true) },
    unbindPluginKey: { kind: "unbind" },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "bind" ? state.bind : state.unbind,
}));
vi.mock("../accounts/useAccounts", () => ({
  useAccounts: () => ({ data: snapshot, canWrite: state.canWrite }),
  useAccountCommand: () => state.save,
  usePasswordStorePermission: () => true,
}));
const snapshot: AccountsSnapshot = {
  agentAccess: true,
  accounts: [],
  profiles: [],
  approvals: [],
  recentActivity: [],
  customModelKeys: [],
  stores: {
    scient: { protection: "keychain" },
    keychain: { available: false, platform: "linux" },
    onePassword: { state: "not-connected" },
  },
};
const existing = VaultSecretRef.make("account:acc_synthetic01:token");
const input = {
  instanceId: ProviderInstanceId.make("synthetic-agent"),
  pluginId: "sample@synthetic",
};
function setup() {
  state.canWrite = true;
  state.storeInstalled = false;
  state.data = {
    status: "needs-key",
    requirementsKnown: true,
    writable: true,
    keys: [{ envName: "TOKEN", available: false, origins: ["https://api.example.com"] }],
    accounts: [{ ref: existing, name: "Existing API key" }],
  };
  state.bind.mockReset().mockImplementation(async ({ input: binding }) => {
    state.data = {
      ...state.data!,
      status: "ready",
      keys: [
        {
          envName: "TOKEN",
          available: true,
          accountRef: binding.accountRef,
          accountName: "Existing API key",
        },
      ],
    };
    return { _tag: "Success", value: state.data };
  });
  state.unbind.mockReset().mockImplementation(async () => {
    state.data = {
      ...state.data!,
      status: "needs-key",
      keys: [{ envName: "TOKEN", available: false, origins: ["https://api.example.com"] }],
    };
    return { _tag: "Success", value: state.data };
  });
  state.save
    .mockReset()
    .mockResolvedValue({ ok: true, value: { accountId: AccountId.make("acc_created001") } });
}

it("binds an existing account, reflects revocation, and unbinds without copying a value", async () => {
  setup();
  await using screen = await render(<PluginKeys pluginName="GitHub" input={input} />);
  await expect.element(page.getByRole("status")).toHaveTextContent("Needs a key");
  await page.getByRole("combobox", { name: "TOKEN account" }).selectOptions(existing);
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(state.bind.mock.calls[0]?.[0]).toEqual({
    environmentId: EnvironmentId.make("synthetic"),
    input: {
      agent: input.instanceId,
      pluginId: input.pluginId,
      envName: "TOKEN",
      accountRef: existing,
    },
  });
  state.data = {
    ...state.data!,
    status: "needs-key",
    keys: [{ envName: "TOKEN", available: false, accountRef: existing }],
  };
  await screen.rerender(<PluginKeys pluginName="GitHub" input={input} />);
  await expect.element(page.getByRole("status")).toHaveTextContent("Needs a key");
  await page.getByRole("combobox", { name: "TOKEN account" }).selectOptions("");
  await expect.element(page.getByRole("combobox", { name: "TOKEN account" })).toHaveValue("");
  expect(state.unbind.mock.calls[0]?.[0].input).toEqual({
    agent: input.instanceId,
    pluginId: input.pluginId,
    envName: "TOKEN",
  });
});

it("creates an API-key account in Accounts before binding its returned id", async () => {
  setup();
  await using _screen = await render(<PluginKeys pluginName="GitHub" input={input} />);
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("GitHub");
  await page.getByLabelText("Key", { exact: true }).fill("synthetic-plugin-value");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.save.mock.calls[0]?.[0]).toMatchObject({
    details: { kind: "api-key", envName: "TOKEN", sites: ["https://api.example.com"] },
  });
  expect(state.bind.mock.calls[0]?.[0].input.accountRef).toBe("account:acc_created001:token");
});

it("keeps bindings read-only without the environment write grant", async () => {
  setup();
  state.canWrite = false;
  await using _screen = await render(<PluginKeys pluginName="GitHub" input={input} />);
  await expect.element(page.getByRole("combobox", { name: "TOKEN account" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Add key", exact: true })).toBeDisabled();
});

it("waits for a verified installed identity before showing bindings on a store detail page", async () => {
  setup();
  const storeInput = { instanceId: input.instanceId, entryId: "sample@synthetic" };
  await using screen = await render(<PluginKeys pluginName="GitHub" input={storeInput} />);
  await expect
    .element(page.getByRole("combobox", { name: "TOKEN account" }))
    .not.toBeInTheDocument();
  state.storeInstalled = true;
  await screen.rerender(<PluginKeys pluginName="GitHub" input={storeInput} />);
  await page.getByRole("combobox", { name: "TOKEN account" }).selectOptions(existing);
  expect(state.bind.mock.calls[0]?.[0].input.pluginId).toBe("sample@synthetic");
});

it("explains why binding cannot enable a plugin that passes its key on the command line", async () => {
  setup();
  state.data = { ...state.data!, commandLineBlocked: true, status: "needs-key" };
  await using _screen = await render(<PluginKeys pluginName="GitHub" input={input} />);
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent(
      "Needs a key — this plugin passes its key on the command line, which Scient doesn't allow",
    );
});

it("keeps the new account selected through binding and stale query responses, then follows server changes", async () => {
  setup();
  const pending = Promise.withResolvers<{ _tag: "Success"; value: PluginKeyState }>();
  state.bind.mockImplementation(() => pending.promise);
  await using screen = await render(<PluginKeys pluginName="GitHub" input={input} />);
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await page.getByLabelText("Key", { exact: true }).fill("synthetic-new-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  const picker = page.getByRole("combobox", { name: "TOKEN account" });
  await expect.element(picker).toHaveValue("account:acc_created001:token");
  await expect.element(picker).toBeDisabled();
  pending.resolve({ _tag: "Success", value: state.data! });
  await expect.element(picker).not.toBeDisabled();
  await expect.element(picker).toHaveValue("account:acc_created001:token");
  state.data = {
    ...state.data!,
    status: "ready",
    accounts: [{ ref: VaultSecretRef.make("account:acc_created001:token"), name: "GitHub" }],
    keys: [
      {
        envName: "TOKEN",
        available: true,
        accountRef: VaultSecretRef.make("account:acc_created001:token"),
        accountName: "GitHub",
      },
    ],
  };
  await screen.rerender(<PluginKeys pluginName="GitHub" input={input} />);
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  state.data = {
    ...state.data!,
    status: "needs-key",
    keys: [{ envName: "TOKEN", available: false }],
  };
  await screen.rerender(<PluginKeys pluginName="GitHub" input={input} />);
  await expect.element(picker).toHaveValue("");
});

it("returns to the server's selection if binding the newly created account fails", async () => {
  setup();
  state.bind.mockResolvedValue({ _tag: "Failure" });
  await using _screen = await render(<PluginKeys pluginName="GitHub" input={input} />);
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await page.getByLabelText("Key", { exact: true }).fill("synthetic-new-key");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(page.getByRole("combobox", { name: "TOKEN account" })).toHaveValue("");
});
