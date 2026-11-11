import type { ConnectorSummary } from "@t3tools/contracts";

/** What an agent is told a connector needs, in one word. */
export const AGENT_CONNECTOR_STATUSES = [
  "ready",
  "needs-setup",
  "needs-sign-in",
  "error",
  "off",
] as const;
export type AgentConnectorStatus = (typeof AGENT_CONNECTOR_STATUSES)[number];

/** Sign-in and setup come before a stored error: they are what to do next. */
export const agentStatusOf = (summary: ConnectorSummary): AgentConnectorStatus => {
  if (!summary.enabled) return "off";
  if (summary.local?.problem !== undefined) return "error";
  if (summary.status === "needs-auth" || summary.local?.signIn?.state === "needs-user")
    return "needs-sign-in";
  if (summary.status === "needs-credential" || (summary.local?.missing.length ?? 0) > 0)
    return "needs-setup";
  return summary.lastError === undefined ? "ready" : "error";
};

/** A stored error as one short line. */
export const oneLine = (text: string, limit = 300) => {
  const line =
    text
      .split(/\r?\n/u)
      .find((part) => part.trim() !== "")
      ?.trim() ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
};
