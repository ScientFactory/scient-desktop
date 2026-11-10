import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ServerProvider,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { providerTurnProperties } from "./ProviderUsageAnalytics.ts";
import { reportedModelLabel } from "./ScientModelLabels.ts";

const providers = [
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: "claudeAgent",
    models: [{ slug: "claude-opus-5-5", isCustom: false }],
  } as unknown as ServerProvider,
];
const label = (model: string) => reportedModelLabel(providers, model);

const turnProperties = (driver: string, selected: string, models?: ReadonlyArray<string>) =>
  providerTurnProperties(
    {
      driver,
      context: { modelSelection: { instanceId: ProviderInstanceId.make(driver), model: selected } },
      providerTurn: {
        id: ProviderTurnId.make("turn"),
        providerThreadId: ProviderThreadId.make("provider-thread"),
        nodeId: NodeId.make("node"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: DateTime.makeUnsafe(1_000),
        completedAt: DateTime.makeUnsafe(2_000),
        turnTokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
          inputTokens: 10,
          outputTokens: 2,
          ...(models === undefined ? {} : { models }),
        } as TurnTokenUsage,
      },
    },
    label,
  );

describe("Scient provider turn models", () => {
  it("names a model the bundled manifest does not list, for every driver", () => {
    for (const driver of ["omp", "pi", "scient", "codex"]) {
      expect(turnProperties(driver, "google/gemini-4-argon", ["gemini-4-argon"])).toMatchObject({
        provider: driver,
        model: "gemini-4-argon",
        mainModel: "gemini-4-argon",
        modelCount: 1,
      });
    }
    expect(turnProperties("pi", "openrouter/qwen%2Fqwen-5")).toMatchObject({
      model: "openrouter/qwen/qwen-5",
    });
    expect(turnProperties("pi", "/Users/someone/models/local.gguf")).toMatchObject({
      model: "other",
    });
  });

  it("reports the main model and the model count of a turn that used several", () => {
    const mixed = turnProperties("claudeAgent", "claude-opus-5-5", [
      "claude-opus-5-5-20261001",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(mixed).toMatchObject({ mainModel: "claude-opus-5-5", modelCount: 2 });
    expect(turnProperties("claudeAgent", "claude-opus-5-5")).not.toHaveProperty("modelCount");
  });
});
