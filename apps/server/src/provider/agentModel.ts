import type { ServerProviderModel } from "@t3tools/contracts";

/**
 * Shared model plumbing for the Pi-family providers (Pi and Oh My Pi).
 *
 * Both agents identify a model as a `provider/model` slug, and both project a
 * reasoning level set into the same Scient capability shape. The wire clients,
 * their RPC layers, and their level policies stay separate; only this pure
 * formatting and codec core is shared.
 */
const validSegment = (value: string): boolean => value.length > 0 && value.trim() === value;

/** A model slug segment must be non-empty and already trimmed. */
export const isValidModelSegment = validSegment;

export const encodeAgentModelSlug = (provider: string, modelId: string): string | undefined => {
  if (!validSegment(provider) || !validSegment(modelId)) return undefined;
  return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
};

/**
 * Split an encoded slug. Decoding stays with each provider: the two agents
 * disagree on whether a non-canonical but unencoded slug is accepted, and that
 * difference is provider policy rather than shared mechanics.
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

/** The shared "Reasoning" option descriptor both Pi-family models project. */
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
