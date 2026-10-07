import { historicalSubagentsToRuntime } from "@t3tools/client-runtime/state/historicalSubagentRuntime";
import {
  deriveAgentPanelModel,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { useMemo } from "react";

/** The agents panel model: live subagents plus the ones recorded in the thread history. */
export function useAgentPanelModel(serverProjection: OrchestrationV2ThreadProjection | null) {
  return useMemo(
    () =>
      deriveAgentPanelModel({
        agents: [],
        v2Projection: [
          ...projectedSubagentsToRuntime(serverProjection?.subagents ?? []),
          ...historicalSubagentsToRuntime(
            serverProjection?.turnItems ?? [],
            serverProjection?.visibleTurnItems ?? [],
          ),
        ],
      }),
    [serverProjection?.subagents, serverProjection?.turnItems, serverProjection?.visibleTurnItems],
  );
}
