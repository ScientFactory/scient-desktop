import { useState } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { createModelCapabilities } from "@t3tools/shared/model";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerEffortColumn, ComposerPickerFooter } from "./ComposerModelEffort";
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
  withUltracode = false,
}: {
  disabled?: boolean;
  onFork?: () => void;
  withUltracode?: boolean;
}) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const pickerModels = withUltracode
    ? models.map((model) => ({
        ...model,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            { id: "fastMode", label: "Speed", type: "boolean", currentValue: false },
            { id: "ultracode", label: "Ultracode", type: "boolean", currentValue: false },
          ],
        }),
      }))
    : models;
  return (
    <div className="fixed bottom-8 left-4">
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={models[0]!.slug}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map([[instanceId, pickerModels]])}
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
              models: pickerModels,
              model: models[0]!.slug,
              modelOptions: options,
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
  const fork = page.getByRole("button", { name: "Fork to switch, continue in a new chat" });
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
    .element(page.getByRole("button", { name: "Fork to switch, continue in a new chat" }))
    .toBeDisabled();
  expect(onFork).not.toHaveBeenCalled();
  await screen.rerender(<Picker onFork={onFork} />);
  await page.getByRole("button", { name: "Fork to switch, continue in a new chat" }).click();
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

it("preserves speed and Ultracode when options move between the toolbar and overflow", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(<Picker withUltracode />);
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("button", { name: "Speed: Standard" }).click();
  await page.getByRole("menuitemradio", { name: "Fast", exact: true }).click();
  const ultracode = page.getByRole("button", { name: "Ultracode", exact: true });
  await ultracode.click();
  await expect.element(ultracode).toHaveAttribute("aria-pressed", "true");

  await page.viewport(390, 844);
  await expect
    .element(page.getByRole("button", { name: "Permissions: Full access" }))
    .toBeVisible();
  await page.getByRole("button", { name: "More model options, Ultracode on" }).click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Fast", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  const overflowUltracode = page.getByRole("menuitemcheckbox", { name: "Ultracode", exact: true });
  await expect.element(overflowUltracode).toHaveAttribute("aria-checked", "true");
  await overflowUltracode.click();
  await page.getByRole("button", { name: "More model options" }).click();
  await page.getByRole("menuitemradio", { name: "Standard", exact: true }).click();

  await page.viewport(1280, 800);
  await expect.element(page.getByRole("button", { name: "Speed: Standard" })).toBeVisible();
  await expect.element(ultracode).toHaveAttribute("aria-pressed", "false");
});

const agentInstanceId = ProviderInstanceId.make("antigravity-layout");
const thinkingLevel = {
  id: "thinking_level",
  label: "Thinking Level",
  type: "select" as const,
  role: "reasoning" as const,
  currentValue: "high",
  options: ["low", "medium", "high", "extra"].map((id) => ({
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
  })),
};
const agentModels = [
  "Gemini 4 Argon",
  "Gemini 4 Hydrogen",
  "Gemini 3.8 Flash",
  "Claude Opus 5.5",
].map((name) => ({
  slug: name.toLowerCase().replaceAll(" ", "-"),
  name,
  isCustom: false,
  capabilities: createModelCapabilities({ optionDescriptors: [thinkingLevel] }),
}));
const agentEntries = deriveProviderInstanceEntries([
  {
    instanceId: agentInstanceId,
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "Antigravity",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-13T00:00:00.000Z",
    models: agentModels,
    slashCommands: [],
    skills: [],
  },
]);
// The jump badges take room from each name, as they do in the app.
const jumpKeys = compileResolvedKeybindingsConfig(
  (["1", "2", "3", "4"] as const).map((index) => ({
    key: `mod+${index}`,
    command: `modelPicker.jump.${index}` as const,
    when: "modelPickerOpen",
  })),
);
function AgentPicker() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits = {
    provider: ProviderDriverKind.make("antigravity"),
    instanceId: agentInstanceId,
    models: agentModels,
    model: agentModels[1]!.slug,
    modelOptions: options,
    onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) =>
      setOptions(next ?? []),
  };
  return (
    <div className="fixed bottom-8 left-4">
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={agentInstanceId}
        model={agentModels[1]!.slug}
        lockedProvider={null}
        instanceEntries={agentEntries}
        modelOptionsByInstance={new Map([[agentInstanceId, agentModels]])}
        onInstanceModelChange={() => {}}
        triggerAriaLabel="Choose model"
        keybindings={jumpKeys}
        effortColumn={<ComposerEffortColumn traits={traits} />}
      />
    </div>
  );
}
const singleLine = (element: HTMLElement) =>
  element.getBoundingClientRect().height < parseFloat(getComputedStyle(element).lineHeight) * 1.5;

// Windows and Linux label the jump keys "Ctrl+2", which is wider than "⌘2".
it.each([
  ["MacIntel", "⌘2"],
  ["Win32", "Ctrl+2"],
])("keeps model names and the reasoning header on one line on %s", async (platform, jumpLabel) => {
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  onTestFinished(() => platformSpy.mockRestore());
  await page.viewport(1280, 800);
  await using _screen = await render(<AgentPicker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByText(jumpLabel, { exact: true })).toBeVisible();
  const header = page.getByText("Reasoning", { exact: true });
  await expect.element(header).toBeVisible();
  await expect.element(page.getByText("Thinking Level", { exact: true })).not.toBeInTheDocument();
  expect(singleLine(header.element() as HTMLElement)).toBe(true);
  for (const model of agentModels) {
    const name = page.getByText(model.name, { exact: false });
    await expect.element(name).toBeVisible();
    expect(singleLine(name.element() as HTMLElement), model.name).toBe(true);
  }
});
