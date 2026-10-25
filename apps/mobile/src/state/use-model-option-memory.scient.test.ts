import { rememberModelOptions, rememberedModelOptions } from "./use-model-option-memory";
const XHIGH = [{ id: "thinking", value: "xhigh" }] as const;
const HIGH = [{ id: "thinking", value: "high" }] as const;

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { modelOptionMemoryAtom } from "./use-composer-drafts";
import { withRememberedModelOptions } from "./use-model-option-memory";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("withRememberedModelOptions", () => {
  it("preserves the incoming selection and option order when memory is semantically equal", () => {
    appAtomRegistry.set(modelOptionMemoryAtom, {
      pi: {
        "xai/grok-4.6": [
          { id: "thinking", value: "high" },
          { id: "search", value: true },
        ],
      },
    });
    try {
      const selection = {
        instanceId: ProviderInstanceId.make("pi"),
        model: "xai/grok-4.6",
        options: [
          { id: "search", value: true },
          { id: "thinking", value: "high" },
        ],
      };
      expect(withRememberedModelOptions(selection)).toBe(selection);
      expect(selection.options.map((option) => option.id)).toEqual(["search", "thinking"]);
    } finally {
      appAtomRegistry.set(modelOptionMemoryAtom, {});
    }
  });

  // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)
  it("keeps incoming selections when nothing is remembered", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("pi"),
      model: "openai-codex/gpt-5.6-sol",
    };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });

  // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)
  it("keeps incoming selections that already match memory", () => {
    rememberModelOptions("pi", "xai/grok-4.6", [...XHIGH]);
    const selection = {
      instanceId: ProviderInstanceId.make("pi"),
      model: "xai/grok-4.6",
      options: [...XHIGH],
    };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });
});

describe("model option memory state", () => {
  // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)
  it("records and looks up options per instance and model", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    rememberModelOptions("codex", "gpt-5.4", [...HIGH]);
    expect(rememberedModelOptions("codex", "gpt-5.3-codex")).toEqual(XHIGH);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toEqual(HIGH);
    expect(rememberedModelOptions("pi", "gpt-5.3-codex")).toBeUndefined();
  });

  // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)
  it("ignores empty option sets when recording", () => {
    rememberModelOptions("codex", "gpt-5.4", []);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toBeUndefined();
  });
});
