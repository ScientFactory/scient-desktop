import { historicalSubagentsToRuntime } from "@t3tools/client-runtime/state/historicalSubagentRuntime";
import {
  deriveAgentPanelModel as deriveRuntimeAgentPanelModel,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** The agents panel model: live subagents plus the ones recorded in the thread history. */
export function deriveAgentPanelModel(serverProjection: OrchestrationV2ThreadProjection | null) {
  return deriveRuntimeAgentPanelModel({
    agents: [],
    v2Projection: [
      ...projectedSubagentsToRuntime(serverProjection?.subagents ?? []),
      ...historicalSubagentsToRuntime(
        serverProjection?.turnItems ?? [],
        serverProjection?.visibleTurnItems ?? [],
      ),
    ],
  });
}
