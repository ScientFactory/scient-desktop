import { ProviderInstanceId, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";
import { expect, it } from "vite-plus/test";
import { isReasoningSelect } from "./modelTraits.ts";
import { formatModelSelectionEffort } from "./state/threadExecution.ts";

it("recognizes legacy native-agent reasoning without changing its selection identity", () => {
  const reasoning: ProviderOptionDescriptor = {
    id: "thinkingLevel",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
    ],
  };
  expect(isReasoningSelect(reasoning)).toBe(true);
  expect(isReasoningSelect({ ...reasoning, id: "sessionMode", label: "Mode" })).toBe(false);
  expect(isReasoningSelect({ ...reasoning, id: "agent_effort", role: "reasoning" })).toBe(true);
  const selection = createModelSelection(
    ProviderInstanceId.make("scient"),
    "openai-codex/gpt-6-luna",
    [{ id: "thinkingLevel", value: "high" }],
  );
  const models = [
    {
      slug: selection.model,
      name: "GPT-6 Luna",
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [reasoning] }),
    },
  ];
  expect(formatModelSelectionEffort(selection, models)).toBe("High");
  expect(formatModelSelectionEffort({ ...selection, options: [] }, models)).toBeNull();
});
