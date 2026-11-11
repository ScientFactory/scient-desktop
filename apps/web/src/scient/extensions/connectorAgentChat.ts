import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";

import { toastManager } from "../../components/ui/toast";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import { recordScientAnalytics } from "../analytics/client";

/** Scient's built-in guide for making connectors, selected by name in the first message. */
const AUTHORING = "$connector-authoring";

/** Why a chat about a connector was opened. */
export type ConnectorChatPurpose = "make" | "fix" | "improve";

/**
 * Opens a new chat, outside any project, with a first message written for the user. They read
 * it, can add to it, and send it; the default agent then works on the connector.
 */
export function useConnectorAgentChat(environmentId: EnvironmentId) {
  const newThread = useNewThreadHandler();
  const { openScratchProject, scratchWorkspaceRootFor } = useScratchProject();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  if (!canOperate || scratchWorkspaceRootFor(environmentId) === null) return undefined;
  const record = (purpose: ConnectorChatPurpose, outcome: "ok" | "error") =>
    recordScientAnalytics(readPreparedConnection(environmentId), {
      name: "feature.used",
      properties: { feature: "connectors.agent_chat", variant: purpose, outcome },
    });
  return async (prompt: string, purpose: ConnectorChatPurpose) => {
    try {
      const project = await openScratchProject(environmentId);
      const opened = project
        ? await newThread(scopeProjectRef(project.environmentId, project.id), { prompt })
        : null;
      record(purpose, opened ? "ok" : "error");
      if (!opened) toastManager.add({ type: "error", title: "Could not open a new chat" });
      return opened !== null;
    } catch {
      record(purpose, "error");
      toastManager.add({ type: "error", title: "Could not open a new chat" });
      return false;
    }
  };
}

/** The user finishes the sentence: what to connect to. */
export const MAKE_CONNECTOR_PROMPT = `${AUTHORING} Make a connector for `;

const named = (name: string, serverName: string) => `“${name}” (${serverName})`;

/** Repair a connector that stopped with an error. */
export const fixConnectorPrompt = (name: string, serverName: string, problem: string) =>
  `${AUTHORING} My connector ${named(name, serverName)} stopped working. Scient says: ${problem} Fix it, starting with scient_connector_copy {"connector":"${serverName}"}.`;

/** Improve one of the user's connectors. */
export const improveConnectorPrompt = (name: string, serverName: string) =>
  `${AUTHORING} Help me improve my connector ${named(name, serverName)}. Ask me what I want changed if I have not said, then start with scient_connector_copy {"connector":"${serverName}"}.`;

/** Build a connector for a Discover entry Scient can't add as it is. */
export const makeFromEntryPrompt = (entry: {
  readonly title: string;
  readonly registryName: string;
  readonly repositoryUrl?: string | undefined;
  readonly reason?: string | undefined;
}) =>
  `${AUTHORING} Make a connector for “${entry.title}” (MCP Registry: ${entry.registryName}${entry.repositoryUrl ? `, code: ${entry.repositoryUrl}` : ""}). Scient can't add it as it is${entry.reason ? `: ${entry.reason}` : ""}.`;
