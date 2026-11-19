import { RegistryProvider } from "@effect/atom-react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

vi.mock(import("../../env"), () => ({
  isElectron: true,
  isSecretsFeatureEnabled: false,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map(({ environmentId }) => environmentId))) as never,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: { keybindings: [], keybindingsConfigPath: null, availableEditors: [] },
    };
    return {
      scope: { kind: "environment" },
      environment,
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import { searchSettings } from "./settingsSearch";

it("finds the fixed native shortcut from another section and filters it without an empty state", async () => {
  await using screen = await render(
    <RegistryProvider>
      <KeybindingsSettingsPanel />
    </RegistryProvider>,
    { router: "/#authoring" },
  );
  const search = screen.getByRole("searchbox", { name: "Search shortcuts" });
  await userEvent.fill(search, "alpha");
  const result = searchSettings("new window")[0]!;
  expect(result.id).toBe("keybinding-new-window");
  await act(async () => {
    await screen.router!.navigate({ hash: result.id });
  });
  await expect.element(search).toHaveValue("");
  await expect.element(screen.getByText("New Window", { exact: true })).toBeVisible();
  await userEvent.fill(search, "window");
  await expect.element(screen.getByText("New Window", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("No shortcuts match your search.")).not.toBeInTheDocument();
  await userEvent.fill(search, "no such shortcut");
  await expect.element(screen.getByText("New Window", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("No shortcuts match your search.")).toBeVisible();
});
