import { ProviderDriverKind } from "@t3tools/contracts";
import { makeOpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { turnStartErrorKeepingReceipt } from "../orchestration-v2/scient-provider/NativeTurnReceipts.ts";
import { toMcpCapabilities } from "../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "./ScientAwareness.ts";
import { buildScientOrchestrationSystemPrompt } from "./ScientProviderInstructions.ts";
import { buildScientRuntimeInstructions } from "./ScientRuntimeInstructions.ts";

export type OpenCodeCompositionEnv = OpenCodeDriverEnv;

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

/** OpenCode 1.x and 2.x call this per prompt with that session's granted tools. */
export const buildOpenCodeRuntimeGuidance = (capabilities?: ReadonlySet<string>): string =>
  buildScientAwareness(capabilities === undefined ? undefined : toMcpCapabilities(capabilities));

export const mapOpenCodeTurnStartError = (
  input: Pick<ProviderAdapterV2TurnInput, "threadId" | "providerThread" | "runId">,
  cause: unknown,
): ProviderAdapterTurnStartError => turnStartErrorKeepingReceipt(OPENCODE_DRIVER, input)(cause);

/** The production registration keeps Scient prompts and typed native receipts app-owned. */
export const OpenCodeDriver = makeOpenCodeDriver({
  runtimeGuidance: buildOpenCodeRuntimeGuidance,
  orchestrationSystemPrompt: buildScientOrchestrationSystemPrompt,
  runtimeInstructions: buildScientRuntimeInstructions,
  mapTurnStartError: mapOpenCodeTurnStartError,
});
