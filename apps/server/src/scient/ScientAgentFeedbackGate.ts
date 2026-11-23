/**
 * Keeps T3's agent feedback off in Scient: its reports carry agent-written text that Scient's
 * analytics gateway and privacy page do not cover. Remove when the owner enables it.
 *
 * @module ScientAgentFeedbackGate
 */
import type { AgentFeedbackMode } from "@t3tools/contracts";

export const withScientAgentFeedbackOff = <
  S extends { readonly agentFeedback: { readonly mode: AgentFeedbackMode } },
>(
  settings: S,
): S =>
  settings.agentFeedback.mode === "off"
    ? settings
    : { ...settings, agentFeedback: { ...settings.agentFeedback, mode: "off" } };
