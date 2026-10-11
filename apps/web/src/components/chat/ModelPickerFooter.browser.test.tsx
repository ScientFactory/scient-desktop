import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vitest/browser";

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "./ModelPickerContent";

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  host = undefined;
  root = undefined;
  __resetClientSettingsPersistenceForTests();
});

it.each([1280, 384])("keeps the new-chat footer at the bottom at %ipx", async (width) => {
  await page.viewport(width, 720);
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, favorites: [] });
  const models = Array.from({ length: 30 }, (_, i) => ({
    slug: `model-${i}`,
    name: `Model ${i}`,
    isCustom: false,
    capabilities: null,
  }));
  const providers = [
    "codex",
    "claudeAgent",
    "cursor",
    "droid",
    "grok",
    "antigravity",
    "scient",
    "omp",
    "pi",
  ].map((driver): ServerProvider => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: driver === "antigravity" ? "Antigravity" : driver,
    enabled: true,
    installed: true,
    version: "synthetic",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T00:00:00.000Z",
    models:
      driver === "antigravity"
        ? [models[0]!, ...models.slice(1, 4).map((model) => ({ ...model, isLegacy: true }))]
        : models,
    slashCommands: [],
    skills: [],
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <ModelPickerContent
      activeInstanceId={providers[0]!.instanceId}
      model="model-0"
      lockedProvider={null}
      instanceEntries={deriveProviderInstanceEntries(providers)}
      modelOptionsByInstance={
        new Map(providers.map((provider) => [provider.instanceId, provider.models]))
      }
      terminalOpen={false}
      onInstanceModelChange={() => {}}
      onContinueInNewChat={() => {}}
    />,
  );

  await expect.poll(() => host?.querySelector("[data-model-picker-content]")).toBeTruthy();
  const picker = host.querySelector<HTMLElement>("[data-model-picker-content]")!;
  const footer = picker.querySelector<HTMLButtonElement>(
    'button[aria-label="Continue in a new chat"]',
  )!.parentElement!;
  const footerHeight = footer.getBoundingClientRect().height;
  const expectAnchored = async () => {
    await expect
      .poll(() =>
        Math.abs(picker.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom),
      )
      .toBeLessThan(1);
    expect(footer.getBoundingClientRect().height).toBe(footerHeight);
  };

  await expectAnchored();
  await page.getByRole("button", { name: "Antigravity", exact: true }).click();
  await expect.poll(() => picker.querySelectorAll("[data-slot=combobox-item]").length).toBe(2);
  await expectAnchored();

  await page.getByText("Legacy models", { exact: true }).click();
  await expect.poll(() => picker.querySelectorAll("[data-slot=combobox-item]").length).toBe(5);
  await expectAnchored();
  await page.getByText("Legacy models", { exact: true }).click();
  await expect.poll(() => picker.querySelectorAll("[data-slot=combobox-item]").length).toBe(2);
  await expectAnchored();

  await page.getByPlaceholder("Search models...").fill("no-matching-model-xyz");
  await expect.element(page.getByText("No models found", { exact: true })).toBeVisible();
  await expectAnchored();

  picker.style.setProperty("--available-height", "200px");
  await expect.poll(() => picker.getBoundingClientRect().height).toBeLessThanOrEqual(200);
  await expectAnchored();
});
