import type { AcpAdapterV2ApplicationBridge } from "@t3tools/provider-acp/server/adapter";
import type { T3AcpInstructionState } from "@t3tools/provider-core/server/orchestrationInstructions";

import { toMcpCapabilities } from "../../mcp/McpInvocationContext.ts";
import {
  buildScientAwareness,
  buildScientPromptAwareness,
} from "../../provider/ScientAwareness.ts";
import { ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS } from "../../provider/antigravity/WorkspaceInstructions.ts";
import { buildScientAcpPromptWithInstructions } from "../../provider/ScientProviderInstructions.ts";
import { buildScientRuntimeInstructions } from "../../provider/ScientRuntimeInstructions.ts";
import {
  isPreAcceptanceRejectionCode,
  nativeTurnAcceptance,
} from "../scient-provider/NativeTurnReceipts.ts";

/** Shared Scient prompt and native-delivery behavior; awareness rides the first prompt. */
export const scientAcpProviderBridge = {
  nativeTurnAcceptance,
  isPreAcceptanceRejectionCode,
  composePrompt: (input) =>
    buildScientAcpPromptWithInstructions(
      input,
      input.state.capabilities === undefined
        ? undefined
        : buildScientPromptAwareness(input.state.capabilities),
    ),
  runtimeInstructions: buildScientRuntimeInstructions,
} satisfies Pick<
  AcpAdapterV2ApplicationBridge,
  "nativeTurnAcceptance" | "isPreAcceptanceRejectionCode" | "composePrompt" | "runtimeInstructions"
>;

/** Antigravity's own file tool writes outside the project, so its prompt says so. */
export const scientAntigravityBridge = {
  ...scientAcpProviderBridge,
  composePrompt: (input) =>
    buildScientAcpPromptWithInstructions(
      input,
      input.state.capabilities === undefined
        ? undefined
        : `${buildScientPromptAwareness(input.state.capabilities)}\n\n${ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS.trim()}`,
    ),
} satisfies typeof scientAcpProviderBridge;

/**
 * Awareness for flavors whose native launcher has a private prompt or rules
 * seam; the prompt then carries no awareness.
 */
export const scientAcpAwarenessBridge = {
  scientAwareness: (capabilities) =>
    buildScientAwareness(capabilities === undefined ? undefined : toMcpCapabilities(capabilities)),
} satisfies Pick<AcpAdapterV2ApplicationBridge, "scientAwareness">;

const withoutDeviceTools = (state: T3AcpInstructionState): T3AcpInstructionState => ({
  ...state,
  hasDeviceTools: false,
});

/** Full bridge for ACP flavors with a private seam for Scient's awareness. */
export const scientAcpApplicationBridge = {
  ...scientAcpProviderBridge,
  ...scientAcpAwarenessBridge,
  // Awareness already carries the device block, so the prompt does not repeat it.
  composePrompt: (input) =>
    buildScientAcpPromptWithInstructions({
      ...input,
      state: withoutDeviceTools(input.state),
      ...(input.previousState === undefined
        ? {}
        : { previousState: withoutDeviceTools(input.previousState) }),
    }),
} satisfies AcpAdapterV2ApplicationBridge;
