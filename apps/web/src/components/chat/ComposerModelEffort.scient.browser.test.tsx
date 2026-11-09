import { useState } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { ComposerEffortColumn } from "./ComposerModelEffort";

const models = [
  {
    slug: "openai-codex/gpt-6-luna",
    name: "GPT-6 Luna",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "thinkingLevel",
          label: "Reasoning",
          type: "select",
          strictSelection: true,
          concreteReasoning: true,
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    }),
  },
];
function NativeColumn() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  return (
    <div className="flex h-72 w-38 flex-col">
      <ComposerEffortColumn
        traits={{
          provider: ProviderDriverKind.make("scient"),
          instanceId: ProviderInstanceId.make("scient"),
          models,
          model: models[0]!.slug,
          modelOptions: options,
          onModelOptionsChange: (next) => setOptions(next ?? []),
          planModeEnabled: false,
        }}
      />
    </div>
  );
}
it("shows legacy Scient reasoning levels directly and applies the chosen level", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(<NativeColumn />);
  const levels = page.getByRole("radiogroup", { name: "Reasoning" });
  await expect.element(levels).toBeVisible();
  await expect.element(page.getByRole("button", { name: /^Reasoning:/ })).not.toBeInTheDocument();
  await levels.getByRole("radio", { name: "High", exact: true }).click();
  await expect
    .element(levels.getByRole("radio", { name: "High", exact: true }))
    .toHaveAttribute("aria-checked", "true");
});
