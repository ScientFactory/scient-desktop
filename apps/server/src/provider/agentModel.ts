import type { ServerProviderModel } from "@t3tools/contracts";

/**
 * Model plumbing for providers that name a model with a `provider/model` slug,
 * as Pi does, and project a reasoning level set into Scient's capability
 * shape. It holds only the pure formatting and codec core; a provider keeps
 * its own wire client, RPC layer, and level policy.
 */
const validSegment = (value: string): boolean => value.length > 0 && value.trim() === value;

/** A model slug segment must be non-empty and already trimmed. */
export const isValidModelSegment = validSegment;

export const encodeAgentModelSlug = (provider: string, modelId: string): string | undefined => {
  if (!validSegment(provider) || !validSegment(modelId)) return undefined;
  return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
};

/**
 * Split an encoded slug. Whether a non-canonical but unencoded slug is
 * accepted is provider policy, so the provider's own decoder decides.
 */
export const splitAgentModelSlug = (
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
  const delimiter = slug.indexOf("/");
  if (delimiter < 0 || delimiter !== slug.lastIndexOf("/")) return undefined;
  const encodedProvider = slug.slice(0, delimiter);
  const encodedModelId = slug.slice(delimiter + 1);
  if (!encodedProvider || !encodedModelId) return undefined;
  try {
    const provider = decodeURIComponent(encodedProvider);
    const modelId = decodeURIComponent(encodedModelId);
    if (!validSegment(provider) || !validSegment(modelId)) return undefined;
    return { provider, modelId };
  } catch {
    return undefined;
  }
};

export const reasoningLevelLabel = (level: string): string =>
  level === "xhigh" ? "Extra-high" : level.charAt(0).toUpperCase() + level.slice(1);

/** The "Reasoning" option descriptor for a model's thinking levels. */
export const thinkingLevelCapabilities = (
  levels: ReadonlyArray<string>,
  defaultLevel: string | undefined,
): NonNullable<ServerProviderModel["capabilities"]> => ({
  optionDescriptors: [
    {
      id: "thinkingLevel",
      label: "Reasoning",
      type: "select",
      strictSelection: true,
      concreteReasoning: true,
      emptySelectionLabel: "Reasoning",
      options: levels.map((level) => ({
        id: level,
        label: reasoningLevelLabel(level),
        ...(level === defaultLevel ? { isDefault: true } : {}),
      })),
    },
  ],
});
