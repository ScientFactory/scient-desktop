import type { AcpAdapterV2ApplicationBridge } from "@t3tools/provider-acp/server/adapter";

import { toMcpCapabilities } from "../../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { buildScientAcpPromptWithInstructions } from "../../provider/ScientProviderInstructions.ts";
import { buildScientRuntimeInstructions } from "../../provider/ScientRuntimeInstructions.ts";
import {
  isPreAcceptanceRejectionCode,
  nativeTurnAcceptance,
} from "../scient-provider/NativeTurnReceipts.ts";

/** Shared Scient prompt and native-delivery behavior; awareness is added only where supported. */
export const scientAcpProviderBridge = {
  nativeTurnAcceptance,
  isPreAcceptanceRejectionCode,
  composePrompt: buildScientAcpPromptWithInstructions,
  runtimeInstructions: buildScientRuntimeInstructions,
} satisfies Pick<
  AcpAdapterV2ApplicationBridge,
  "nativeTurnAcceptance" | "isPreAcceptanceRejectionCode" | "composePrompt" | "runtimeInstructions"
>;

/**
 * Adds awareness only for flavors whose native launcher has a real prompt or
 * rules seam. Callers without one use `scientAcpProviderBridge` instead.
 */
export const scientAcpAwarenessBridge = {
  scientAwareness: (capabilities) =>
    buildScientAwareness(capabilities === undefined ? undefined : toMcpCapabilities(capabilities)),
} satisfies Pick<AcpAdapterV2ApplicationBridge, "scientAwareness">;

/** Full bridge for ACP flavors that can deliver a Scient prompt. */
export const scientAcpApplicationBridge = {
  ...scientAcpProviderBridge,
  ...scientAcpAwarenessBridge,
} satisfies AcpAdapterV2ApplicationBridge;
