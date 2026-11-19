import { preferredReasoningLevel } from "@t3tools/shared/model";
import {
  droidAdaptiveClaudeLevels,
  type CustomModelConnection,
  type CustomModelProtocol,
  type ModelConnectionReadiness,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/**
 * A status line with what to try when an agent does not list an attached model. The other
 * agents look models up by ID, so a wrong ID or limits hide it; Droid lists every model Scient
 * gives it, so an absent one means its list predates the change.
 */
export function modelUnavailableHint(
  driver: string | undefined,
  status: string,
  resolve: MessageResolver = m,
): string {
  return driver === "droid"
    ? resolve(msg("{status}. Use Check again to refresh Droid's list", { status }))
    : resolve(msg("{status}. Check the model ID and limits in Edit", { status }));
}

/**
 * Whether any agent reports this connection's saved key missing or unusable.
 * It is read from the agents' assessments, not from a status label: an agent
 * that is also signed out or failing is labelled by that, and the key is
 * missing all the same.
 */
export function connectionKeyMissing(
  providers:
    | ReadonlyArray<{
        readonly modelConnections?:
          | ReadonlyArray<Pick<ModelConnectionReadiness, "connectionId" | "state" | "reason">>
          | undefined;
      }>
    | null
    | undefined,
  connectionId: string,
): boolean {
  return (providers ?? []).some((provider) =>
    provider.modelConnections?.some(
      (entry) =>
        entry.connectionId === connectionId &&
        entry.state === "needs_setup" &&
        entry.reason === "credential",
    ),
  );
}

/** A connection's saved key is gone or unusable; only re-entering it helps. */
export const MISSING_KEY_STATUS = msg("Saved key missing. Re-enter it");
const NEEDS_SETUP_STATUS = msg("Needs setup", { $context: "custom model status" });
const CHECK_AGENT_STATUS = msg("Check agent", { $context: "custom model status" });

/** What a custom model's attachment to one agent needs; the label is only for display. */
export type ModelConnectionStatusKind =
  | "disabled"
  | "not-installed"
  | "checking"
  | "check-agent"
  | "missing-key"
  | "needs-setup";

export function modelConnectionStatusKind(
  provider:
    | Pick<ServerProvider, "enabled" | "installed" | "probePending" | "status" | "auth">
    | undefined,
  assessment: ModelConnectionReadiness | undefined,
): ModelConnectionStatusKind | undefined {
  if (provider?.enabled === false) return "disabled";
  if (provider && !provider.installed && !provider.probePending) return "not-installed";
  if (provider?.probePending) return "checking";
  if (provider?.status === "error" || provider?.auth.status === "unauthenticated")
    return "check-agent";
  if (assessment?.state === "needs_setup")
    return assessment.reason === "credential" ? "missing-key" : "needs-setup";
  if (assessment?.state === "available") return undefined;
  return "checking";
}

export function modelConnectionStatusLabel(
  kind: ModelConnectionStatusKind,
  resolve: MessageResolver = m,
): string {
  switch (kind) {
    case "disabled":
      return resolve(msg("Disabled", { $context: "custom model status: the agent is off" }));
    case "not-installed":
      return resolve(msg("Not installed", { $context: "custom model status" }));
    case "checking":
      return resolve(msg("Checking", { $context: "custom model status" }));
    case "check-agent":
      return resolve(CHECK_AGENT_STATUS);
    case "missing-key":
      return resolve(MISSING_KEY_STATUS);
    case "needs-setup":
      return resolve(NEEDS_SETUP_STATUS);
  }
}

export function modelConnectionStatus(
  provider:
    | Pick<ServerProvider, "enabled" | "installed" | "probePending" | "status" | "auth">
    | undefined,
  assessment: ModelConnectionReadiness | undefined,
  resolve: MessageResolver = m,
): string | undefined {
  const kind = modelConnectionStatusKind(provider, assessment);
  return kind === undefined ? undefined : modelConnectionStatusLabel(kind, resolve);
}

export const CUSTOM_MODEL_PRESETS: ReadonlyArray<{
  id: string;
  name: string;
  protocol: CustomModelProtocol;
  baseUrl: string;
}> = [
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  },
  {
    id: "spacexai",
    name: "SpaceXAI",
    protocol: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
  },
  // `msg()`: resolve preset names where they show; the others are product names.
  {
    id: "custom",
    name: msg("Local / custom endpoint"),
    protocol: "openai-completions",
    baseUrl: "",
  },
];

export const CUSTOM_MODEL_PROTOCOLS: ReadonlyArray<{ id: CustomModelProtocol; name: string }> = [
  { id: "openai-completions", name: "OpenAI Chat Completions" },
  { id: "openai-responses", name: "OpenAI Responses" },
  { id: "anthropic-messages", name: "Anthropic Messages" },
];

export function customModelPresetId(connection: CustomModelConnection): string {
  const endpoint = connection.baseUrl.replace(/\/+$/, "");
  return (
    CUSTOM_MODEL_PRESETS.find(
      (preset) =>
        preset.id !== "custom" &&
        endpoint === preset.baseUrl &&
        (connection.protocol === preset.protocol ||
          ((preset.id === "openai" || preset.id === "spacexai") &&
            connection.protocol === "openai-completions")),
    )?.id ?? "custom"
  );
}

const DROID_LADDER = new Set(["low", "medium", "high"]);

const REASONING_LEVEL_NAMES: Readonly<Record<string, string>> = {
  off: msg("Off", { $context: "reasoning effort level" }),
  none: msg("None", { $context: "reasoning effort level" }),
  minimal: msg("Minimal", { $context: "reasoning effort level" }),
  low: msg("Low", { $context: "reasoning effort level" }),
  medium: msg("Medium", { $context: "reasoning effort level" }),
  high: msg("High", { $context: "reasoning effort level" }),
  xhigh: msg("Extra-high", { $context: "reasoning effort level" }),
  max: msg("Max", { $context: "reasoning effort level" }),
};

/** A reasoning level's name: "Extra-high" for xhigh; an unknown level is capitalized. */
export function reasoningLevelName(level: string, resolve: MessageResolver = m): string {
  const known = REASONING_LEVEL_NAMES[level];
  return known === undefined ? level.charAt(0).toUpperCase() + level.slice(1) : resolve(known);
}

/** "Low, Medium and High" or "Low or High", in the UI language. */
function listLevels(
  levels: ReadonlyArray<string>,
  conjunction: "and" | "or",
  resolve: MessageResolver,
): string {
  const names = levels.map((level) => reasoningLevelName(level, resolve));
  if (names.length < 2) return names.join("");
  const items = names.slice(0, -1).join(", ");
  const last = names.at(-1)!;
  return conjunction === "and"
    ? resolve(msg("{items} and {last}", { items, last, $context: "joins the last item of a list" }))
    : resolve(msg("{items} or {last}", { items, last, $context: "joins the last item of a list" }));
}

/**
 * Droid sends a configured effort level directly, but Messages levels depend on whether it
 * recognizes the model as adaptive. Off is outside this configured-level list.
 */
export function droidDefaultReasoningLevels(input: {
  readonly protocol: CustomModelProtocol;
  readonly modelId: string;
  readonly levels: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const levels = input.levels.filter((level) => level !== "off");
  if (input.protocol !== "anthropic-messages") return levels;
  const adaptive: ReadonlyArray<string> | undefined = droidAdaptiveClaudeLevels(
    input.modelId.trim(),
  );
  return levels.filter((level) => DROID_LADDER.has(level) || adaptive?.includes(level));
}

/**
 * What Droid does with a default level it cannot apply to the model: it
 * starts threads at the endpoint's own default when it applies that one,
 * otherwise at the level Scient configures (`preferredReasoningLevel`).
 * Undefined when Droid applies the chosen default.
 */
export function droidDefaultReasoningNote(
  input: {
    readonly protocol: CustomModelProtocol;
    readonly modelId: string;
    readonly levels: ReadonlyArray<string>;
    readonly defaultLevel: string | undefined;
    /** The endpoint's or the manual override's own default level. */
    readonly metadataDefault?: string | undefined;
  },
  resolve: MessageResolver = m,
): string | undefined {
  if (input.defaultLevel === undefined) return undefined;
  const applied = droidDefaultReasoningLevels(input);
  if (applied.includes(input.defaultLevel)) return undefined;
  const used = preferredReasoningLevel(applied, input.metadataDefault);
  const level = reasoningLevelName(input.defaultLevel, resolve);
  return used === undefined
    ? resolve(
        msg("Droid cannot apply {level} to this model and uses no reasoning level.", { level }),
      )
    : resolve(
        msg("Droid cannot apply {level} to this model and uses {used} instead.", {
          level,
          used: reasoningLevelName(used, resolve),
        }),
      );
}

/**
 * Droid offers Low/Medium/High for custom models plus an effort API's configured default. Messages
 * gets Off/extra levels only when Droid recognizes the model as adaptive.
 */
export function droidReasoningNote(
  input: {
    readonly protocol: CustomModelProtocol;
    readonly mode: "effort" | "adaptive" | "budget" | undefined;
    readonly modelId: string;
    readonly levels: ReadonlyArray<string>;
  },
  resolve: MessageResolver = m,
): string | undefined {
  const levels = input.levels.filter((level) => level !== "off");
  const messages = input.protocol === "anthropic-messages";
  const adaptive = messages && droidAdaptiveClaudeLevels(input.modelId.trim()) !== undefined;
  const offered = [
    // Off turns adaptive (Messages) thinking off; for effort APIs it is not offered.
    ...(adaptive ? ["off"] : []),
    ...(messages
      ? droidDefaultReasoningLevels(input)
      : levels.filter((level) => DROID_LADDER.has(level))),
  ];
  const extra = levels.filter((level) => !offered.includes(level));
  if (extra.length === 0) return undefined;
  const offeredLevels = listLevels(offered, "and", resolve);
  const plain =
    offered.length > 0
      ? resolve(msg("Droid offers {levels} for this model.", { levels: offeredLevels }))
      : resolve(msg("Droid offers no level for this model."));
  if (messages)
    return adaptive
      ? plain
      : offered.length > 0
        ? resolve(
            msg(
              "Droid offers {levels} for this model. It sends other levels only to the Claude models it knows as adaptive.",
              { levels: offeredLevels },
            ),
          )
        : resolve(
            msg(
              "Droid offers no level for this model. It sends other levels only to the Claude models it knows as adaptive.",
            ),
          );
  if (input.mode !== "effort") return plain;
  const extraLevels = listLevels(extra, "or", resolve);
  return offered.length > 0
    ? resolve(
        msg("Droid offers {levels} for this model, and {extra} only as its default level.", {
          levels: offeredLevels,
          extra: extraLevels,
        }),
      )
    : resolve(
        msg("Droid offers no level for this model, and {extra} only as its default level.", {
          extra: extraLevels,
        }),
      );
}

interface ModelAgent {
  readonly id: ProviderInstanceId;
  readonly name: string;
}

/**
 * Agents a new model starts attached to: the agent whose "Connect models"
 * opened the editor, otherwise every enabled agent that can use custom models.
 * An agent that is not set up is not attached until the user selects it.
 */
export function defaultModelAgents(input: {
  readonly agents: ReadonlyArray<ModelAgent>;
  readonly isEnabled: (id: ProviderInstanceId) => boolean;
  readonly openedFrom?: ProviderInstanceId | undefined;
}): ReadonlyArray<ProviderInstanceId> {
  if (input.openedFrom !== undefined && input.agents.some((a) => a.id === input.openedFrom))
    return [input.openedFrom];
  return input.agents.filter((agent) => input.isEnabled(agent.id)).map((agent) => agent.id);
}

/** Agents a model can be tested through: enabled and attached, the opening agent first. */
export function modelTestAgents<Agent extends ModelAgent>(input: {
  readonly agents: ReadonlyArray<Agent>;
  readonly attached: ReadonlyArray<ProviderInstanceId>;
  readonly isEnabled: (id: ProviderInstanceId) => boolean;
  readonly openedFrom?: ProviderInstanceId | undefined;
}): ReadonlyArray<Agent> {
  const candidates = input.agents.filter(
    (agent) => input.attached.includes(agent.id) && input.isEnabled(agent.id),
  );
  const opening = candidates.filter((agent) => agent.id === input.openedFrom);
  return [...opening, ...candidates.filter((agent) => agent.id !== input.openedFrom)];
}

/**
 * A Test failure names the agent it ran through. The server does for failures
 * of the request itself; one before any request (a missing key, a changed
 * catalog, the RPC) arrives without a name.
 */
export function namedTestFailure(agentName: string, message: string): string {
  return message.startsWith(`${agentName}:`) ? message : `${agentName}: ${message}`;
}

/**
 * How to make a model testable when no enabled agent it is attached to can
 * run a Test (not attached, only removed agents, or only disabled ones).
 * `agentNames` are the agents that can use custom models.
 */
export function modelTestGuidance(
  agentNames: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): string {
  if (agentNames.length === 0)
    return resolve(
      msg(
        "To test this model, enable an agent that supports custom models and select it under Use with (Edit).",
      ),
    );
  const names =
    agentNames.length < 2
      ? agentNames.join("")
      : resolve(
          msg("{items} or {last}", {
            items: agentNames.slice(0, -1).join(", "),
            last: agentNames.at(-1)!,
            $context: "joins the last item of a list",
          }),
        );
  return resolve(
    msg("To test this model, select an enabled agent under Use with (Edit): {names}.", { names }),
  );
}
