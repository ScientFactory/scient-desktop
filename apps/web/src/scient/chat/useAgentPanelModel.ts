import { historicalSubagentsToRuntime } from "@t3tools/client-runtime/state/historicalSubagentRuntime";
import {
  deriveAgentPanelModel as deriveRuntimeAgentPanelModel,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";

/** The agents panel model: live subagents plus the ones recorded in the thread history. */
export function deriveAgentPanelModel(
  serverProjection: Pick<ThreadStructure, "subagents" | "turnItems" | "visibleTurnItems"> | null,
) {
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
