import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { Atom } from "effect/reactivity";
import {
  AccountId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { EditableCustomModelsContent } from "./CustomModelsPanel";

const fixture = vi.hoisted(() => ({
  accounts: [] as AccountSummary[],
  save: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: {} })),
}));
vi.mock("~/scient/accounts/useAccounts", async (original) => ({
  ...(await original<typeof import("~/scient/accounts/useAccounts")>()),
  useAccounts: () => ({ data: { accounts: fixture.accounts }, canWrite: true }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => fixture.save }));
vi.mock("~/state/server", async (original) => {
  const module = await original<typeof import("~/state/server")>();
  return {
    ...module,
    serverEnvironment: {
      ...module.serverEnvironment,
      settingsValueAtom: () => settingsAtom,
      providersValueAtom: () => providersAtom,
    },
  };
});

const environmentId = EnvironmentId.make("synthetic");
const accountId = AccountId.make("acc_synthetic_models");
const origin = "https://models.example.test";
const connection = {
  id: "research-chat",
  name: "Research chat",
  accountId,
  credentialId: null,
  protocol: "openai-completions" as const,
  baseUrl: origin + "/v1",
  models: [
    {
      id: "research",
      name: "Research model",
      modelId: "research-model",
      images: false,
      reasoning: false,
      instanceIds: [],
    },
  ],
};
const settingsAtom = Atom.make({
  ...DEFAULT_SERVER_SETTINGS,
  customModels: {
    revision: 1,
    connections: [
      connection,
      {
        ...connection,
        id: "local",
        name: "Local models",
        accountId: undefined,
        baseUrl: "http://localhost:8080/v1",
      },
      {
        ...connection,
        id: "archive",
        name: "Archive chat",
        accountId: AccountId.make("acc_unavailable_key"),
      },
    ],
  },
});
const providersAtom = Atom.make([]);

it("shows saved, unauthenticated, and reconnect states and chooses only an eligible key", async () => {
  await page.viewport(1050, 800);
  fixture.accounts = [
    {
      accountId,
      name: "Research gateway",
      details: { kind: "api-key", sites: [origin], auth: { type: "bearer" } },
      controls: defaultAccountControls("api-key"),
      secrets: { token: { source: { type: "scient" } } },
      status: "ready",
      createdAt: "2026-11-23T00:00:00.000Z",
      updatedAt: "2026-11-23T00:00:00.000Z",
    },
  ];
  fixture.accounts.push({
    ...fixture.accounts[0]!,
    accountId: AccountId.make("acc_unavailable_key"),
    name: "Other endpoint",
    details: { kind: "api-key", sites: ["https://other.example.test"], auth: { type: "bearer" } },
  });
  await using _screen = await render(
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <h1 className="text-lg font-medium">Custom models</h1>
      <EditableCustomModelsContent environmentId={environmentId} />
    </main>,
  );
  await expect.element(page.getByText("API key · Research gateway")).toBeVisible();
  await expect.element(page.getByText("No key needed")).toBeVisible();
  const directory = import.meta.env.VITE_SCIENT_CREDENTIALS_SCREENSHOTS;
  if (directory) {
    await page.screenshot({ path: directory + "/custom-models-light.png" });
    const background = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "var(--background)";
    document.documentElement.classList.add("dark");
    try {
      await page.screenshot({ path: directory + "/custom-models-dark.png" });
    } finally {
      document.documentElement.classList.remove("dark");
      document.body.style.backgroundColor = background;
    }
  }
  const archive = page.getByRole("region", { name: "Archive chat" });
  await expect.element(archive.getByText("Reconnect")).toBeVisible();
  await archive.getByRole("button", { name: "Choose a saved key…" }).click();
  await expect.element(page.getByRole("button", { name: "Add a key in Accounts…" })).toBeVisible();
  await page.getByRole("combobox", { name: "Saved key" }).click();
  await expect
    .element(page.getByRole("option", { name: "Other endpoint" }))
    .not.toBeInTheDocument();
  await page.getByRole("option", { name: "Research gateway" }).click();
  await page.getByRole("button", { name: "Use this key for Archive chat" }).click();
  expect(fixture.save).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ accountId }),
  });
});
