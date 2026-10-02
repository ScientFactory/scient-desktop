import { preferredReasoningLevel } from "@t3tools/shared/model";
import {
  droidAdaptiveClaudeLevels,
  type CustomModelConnection,
  type CustomModelProtocol,
  type ModelConnectionReadiness,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * What to try when an agent does not list an attached model. The other agents
 * look models up by ID, so a wrong ID or limits hide it; Droid lists every
 * model Scient gives it, so an absent one means its list predates the change.
 */
export function modelUnavailableHint(driver: string | undefined): string {
  return driver === "droid"
    ? " — use Check again to refresh Droid's list"
    : " — check the model ID and limits in Edit";
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
export const MISSING_KEY_STATUS = "Saved key missing — re-enter it";

export function modelConnectionStatus(
  provider:
    | Pick<ServerProvider, "enabled" | "installed" | "probePending" | "status" | "auth">
    | undefined,
  assessment: ModelConnectionReadiness | undefined,
): string | undefined {
  if (provider?.enabled === false) return "Disabled";
  if (provider && !provider.installed && !provider.probePending) return "Not installed";
  if (provider?.probePending) return "Checking";
  if (provider?.status === "error" || provider?.auth.status === "unauthenticated")
    return "Check agent";
  if (assessment?.state === "needs_setup")
    return assessment.reason === "credential" ? MISSING_KEY_STATUS : "Needs setup";
  if (assessment?.state === "available") return undefined;
  return "Checking";
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
  { id: "custom", name: "Local / custom endpoint", protocol: "openai-completions", baseUrl: "" },
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
const levelLabel = (level: string) =>
  level === "xhigh" ? "Extra-high" : level.charAt(0).toUpperCase() + level.slice(1);
const listLabels = (levels: ReadonlyArray<string>, conjunction: "and" | "or") =>
  levels.length < 2
    ? levels.map(levelLabel).join("")
    : `${levels.slice(0, -1).map(levelLabel).join(", ")} ${conjunction} ${levelLabel(levels.at(-1)!)}`;

/**
 * The levels of a custom model that Droid applies, in the model's own order
 * and without Off. Droid (0.213.0 to 0.230.0) sends an effort API whatever
 * level the model is configured with. For Messages the model ID decides
 * (`droidAdaptiveClaudeLevels`): Low, Medium and High, plus the extra levels
 * of a Claude model Droid knows as adaptive.
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
export function droidDefaultReasoningNote(input: {
  readonly protocol: CustomModelProtocol;
  readonly modelId: string;
  readonly levels: ReadonlyArray<string>;
  readonly defaultLevel: string | undefined;
  /** The endpoint's or the manual override's own default level. */
  readonly metadataDefault?: string | undefined;
}): string | undefined {
  if (input.defaultLevel === undefined) return undefined;
  const applied = droidDefaultReasoningLevels(input);
  if (applied.includes(input.defaultLevel)) return undefined;
  const used = preferredReasoningLevel(applied, input.metadataDefault);
  return `Droid cannot apply ${levelLabel(input.defaultLevel)} to this model and uses ${
    used === undefined ? "no reasoning level" : `${levelLabel(used)} instead`
  }.`;
}

/**
 * What a Droid thread can pick among a custom model's reasoning levels. Droid
 * (0.213.0 to 0.230.0) offers Low, Medium and High for every custom model. For
 * effort APIs it sends one other level, the model's default. For Messages the
 * model ID decides (`droidAdaptiveClaudeLevels`): an adaptive Claude model
 * also gets Off and the extra levels Droid sends for it, any other model
 * nothing more.
 */
export function droidReasoningNote(input: {
  readonly protocol: CustomModelProtocol;
  readonly mode: "effort" | "adaptive" | "budget" | undefined;
  readonly modelId: string;
  readonly levels: ReadonlyArray<string>;
}): string | undefined {
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
  const base = offered.length
    ? `Droid offers ${listLabels(offered, "and")} for this model`
    : "Droid offers no level for this model";
  if (messages)
    return adaptive
      ? `${base}.`
      : `${base}. It sends other levels only to the Claude models it knows as adaptive.`;
  return input.mode === "effort"
    ? `${base}, and ${listLabels(extra, "or")} only as its default level.`
    : `${base}.`;
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
export function modelTestGuidance(agentNames: ReadonlyArray<string>): string {
  if (agentNames.length === 0)
    return "To test this model, enable an agent that supports custom models and select it under Use with (Edit).";
  const names =
    agentNames.length < 2
      ? agentNames.join("")
      : `${agentNames.slice(0, -1).join(", ")} or ${agentNames.at(-1)!}`;
  return `To test this model, select an enabled agent under Use with (Edit): ${names}.`;
}
