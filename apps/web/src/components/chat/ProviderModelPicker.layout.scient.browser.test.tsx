import { useState } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerPickerFooter } from "./ComposerModelEffort";
import { ProviderModelPicker } from "./ProviderModelPicker";

const instanceId = ProviderInstanceId.make("scient-layout");
const models = [
  {
    slug: "openai-codex/gpt-6.1-sol",
    name: "GPT-6.1 Sol with a deliberately long distinguishing model suffix",
    subProvider: "openai-codex",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Speed", type: "boolean", currentValue: false }],
    }),
  },
];
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver: ProviderDriverKind.make("scient"),
    displayName: "Scient Agent",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-09T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  },
]);
function Picker({
  disabled = false,
  onFork = () => {},
}: {
  disabled?: boolean;
  onFork?: () => void;
}) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  return (
    <div className="fixed bottom-8 left-4">
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={models[0]!.slug}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map([[instanceId, models]])}
        onInstanceModelChange={() => {}}
        onContinueInNewChat={onFork}
        continueInNewChatDisabled={disabled}
        triggerAriaLabel="Choose model"
        effortColumn={<div>Reasoning</div>}
        footer={
          <ComposerPickerFooter
            traits={{
              provider: ProviderDriverKind.make("scient"),
              instanceId,
              models,
              model: models[0]!.slug,
              modelOptions: options,
              planModeEnabled: false,
              onModelOptionsChange: (next) => setOptions(next ?? []),
            }}
            runtimeMode="full-access"
            runtimeModeOptions={[{ mode: "full-access", ...runtimeModeConfig["full-access"] }]}
            onRuntimeModeChange={() => {}}
          />
        }
      />
    </div>
  );
}
it("puts the company below a readable model name and shares one bottom footer", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const company = page.getByText("OpenAI", { exact: true });
  await expect.element(company).toBeVisible();
  const name = page.getByText(models[0]!.name, { exact: false });
  const fork = page.getByRole("button", { name: "Fork to continue in a new chat" });
  const speed = page.getByRole("group", { name: "Speed" });
  const access = page.getByRole("button", { name: "Permissions: Full access" });
  await expect.element(speed).toBeVisible();
  await expect
    .poll(
      () =>
        company.element().getBoundingClientRect().top >=
        name.element().getBoundingClientRect().bottom,
    )
    .toBe(true);
  expect(name.element().scrollWidth).toBeLessThanOrEqual(name.element().clientWidth);
  const footer = fork.element().closest("[data-model-picker-footer]")!;
  expect(footer.contains(speed.element())).toBe(true);
  expect(footer.contains(access.element())).toBe(true);
  expect(fork.element().getBoundingClientRect().right).toBeLessThan(
    speed.element().getBoundingClientRect().left,
  );
  expect(speed.element().getBoundingClientRect().right).toBeLessThanOrEqual(
    access.element().getBoundingClientRect().left,
  );
  expect(fork.element().textContent).toBe("Fork to continue in a new chat");
  expect(fork.element().lastElementChild?.tagName).toBe("svg");
  await expect
    .poll(() => getComputedStyle(footer.closest("[data-slot=popover-popup]")!).opacity)
    .toBe("1");
  await page.viewport(390, 844);
  await expect.element(fork).toBeVisible();
  await expect.poll(() => footer.getBoundingClientRect().right).toBeLessThanOrEqual(390);
  await expect.element(access).toBeVisible();
});
it("closes the picker and forks once, and disables forking while busy", async () => {
  await page.viewport(1280, 800);
  const onFork = vi.fn();
  await using screen = await render(<Picker disabled onFork={onFork} />);
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect
    .element(page.getByRole("button", { name: "Fork to continue in a new chat" }))
    .toBeDisabled();
  expect(onFork).not.toHaveBeenCalled();
  await screen.rerender(<Picker onFork={onFork} />);
  await page.getByRole("button", { name: "Fork to continue in a new chat" }).click();
  expect(onFork).toHaveBeenCalledTimes(1);
  await expect.element(page.getByPlaceholder("Search models...")).not.toBeInTheDocument();
});

it("keeps one speed selected when toggling the shared segmented control", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const group = page.getByRole("group", { name: "Speed" });
  const standard = group.getByRole("button", { name: "Standard", exact: true });
  const fast = group.getByRole("button", { name: "Fast", exact: true });
  await expect.element(standard).toHaveAttribute("aria-pressed", "true");
  await fast.click();
  await expect.element(fast).toHaveAttribute("aria-pressed", "true");
  await expect.element(standard).toHaveAttribute("aria-pressed", "false");
  await fast.click();
  await expect.element(fast).toHaveAttribute("aria-pressed", "true");
  await standard.click();
  await expect.element(standard).toHaveAttribute("aria-pressed", "true");
  await expect.element(fast).toHaveAttribute("aria-pressed", "false");
});
