import type { ServerProviderModel } from "@t3tools/contracts";

/**
 * Pure model-name plumbing for providers that identify models as
 * `provider/model`, and for projecting reasoning levels into the shared
 * provider capability shape. Provider packages retain their own wire policy.
 */
const validSegment = (value: string): boolean => value.length > 0 && value.trim() === value;

export const isValidModelSegment = validSegment;

export const encodeAgentModelSlug = (provider: string, modelId: string): string | undefined => {
  if (!validSegment(provider) || !validSegment(modelId)) return undefined;
  return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
};

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
