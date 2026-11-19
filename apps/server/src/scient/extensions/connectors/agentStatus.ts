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

/**
 * Who gives a connector what it still needs, so no advice names a tool that refuses that
 * connector: Scient's setup (a local connector's settings, keys and sign-in), its sign-in
 * control (a service the user signs in to), or the person (a hosted key or Source Control
 * account that is gone, which only they can bring back).
 */
export type SetupRoute = "setup" | "sign-in" | "person" | "nothing";

const setupRouteOf = (summary: ConnectorSummary): SetupRoute => {
  const status = agentStatusOf(summary);
  if (status === "needs-sign-in") return "sign-in";
  if (status !== "needs-setup") return "nothing";
  return summary.local !== undefined ? "setup" : "person";
};

/** The next step for a connector that needs setup or a sign-in, as the agent reads it. */
export const setupAdvice = (summary: ConnectorSummary): string => {
  const name = summary.displayName;
  const server = summary.serverName;
  switch (setupRouteOf(summary)) {
    case "setup":
      return `${name} still needs ${summary.local?.missing.join(", ") || "setup"}: call scient_connector_setup {"connector":"${server}"}.`;
    case "sign-in":
      return `${name} needs the user to sign in: call scient_connector_control {"connector":"${server}","action":"sign-in"}.`;
    case "person":
      return summary.auth.type === "source-control"
        ? `${name} no longer has the user's GitHub account from Source Control. Ask the user to sign in to GitHub again in Settings → Source Control.`
        : `${name}'s key is gone. Ask the user to remove ${name} in Settings → Extensions and add it again with its key.`;
    case "nothing":
      return `${name} needs no setup.`;
  }
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
