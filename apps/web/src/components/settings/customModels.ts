import type {
  CustomModelConnection,
  CustomModelProtocol,
  ModelConnectionReadiness,
  ServerProvider,
} from "@t3tools/contracts";

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
  if (assessment?.state === "needs_setup") return "Needs setup";
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
