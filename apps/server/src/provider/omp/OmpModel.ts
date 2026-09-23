import type { ServerProviderModel } from "@t3tools/contracts";
import { preferredReasoningLevel } from "@t3tools/shared/model";

import type { OmpRpcModel, OmpThinkingLevel } from "effect-omp-rpc/schema";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const validSegment = (value: string): boolean => value.length > 0 && value.trim() === value;

export const encodeOmpModelSlug = (provider: string, modelId: string): string | undefined => {
  if (!validSegment(provider) || !validSegment(modelId)) return undefined;
  return `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
};

export const decodeOmpModelSlug = (
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
  const delimiter = slug.indexOf("/");
  if (delimiter <= 0 || delimiter !== slug.lastIndexOf("/")) return undefined;
  try {
    const provider = decodeURIComponent(slug.slice(0, delimiter));
    const modelId = decodeURIComponent(slug.slice(delimiter + 1));
    if (!validSegment(provider) || !validSegment(modelId)) return undefined;
    const canonical = encodeOmpModelSlug(provider, modelId);
    const raw = `${provider}/${modelId}`;
    if (canonical !== slug && raw !== slug) return undefined;
    return { provider, modelId };
  } catch {
    return undefined;
  }
};

export const ompModelSupportsImages = (model: OmpRpcModel): boolean =>
  model.input?.includes("image") === true;

export const ompThinkingLevel = (value: string | undefined): OmpThinkingLevel | undefined =>
  value === "off" ||
  value === "minimal" ||
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "xhigh" ||
  value === "max"
    ? value
    : undefined;

export const ompModelToServerModel = (
  model: OmpRpcModel,
  selected?: { readonly provider: string; readonly modelId: string },
): ServerProviderModel | undefined => {
  const slug = encodeOmpModelSlug(model.provider, model.id);
  const name = model.name?.trim() || model.id;
  if (!slug || !validSegment(name)) return undefined;
  const thinkingLevels = (
    model.thinkingLevels ?? (model.reasoning ? [...THINKING_LEVELS] : [])
  ).filter((level): level is (typeof THINKING_LEVELS)[number] =>
    THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number]),
  );
  const selectedDefault = preferredReasoningLevel(thinkingLevels);
  return {
    slug,
    name,
    subProvider: model.provider,
    isCustom: false,
    ...(selected?.provider === model.provider && selected.modelId === model.id
      ? { isDefault: true }
      : {}),
    capabilities:
      thinkingLevels.length === 0
        ? null
        : {
            optionDescriptors: [
              {
                id: "thinkingLevel",
                label: "Reasoning",
                type: "select" as const,
                strictSelection: true,
                concreteReasoning: true,
                emptySelectionLabel: "Reasoning",
                options: thinkingLevels.map((level) => ({
                  id: level,
                  label:
                    level === "xhigh"
                      ? "Extra-high"
                      : level.charAt(0).toUpperCase() + level.slice(1),
                  ...(level === selectedDefault ? { isDefault: true } : {}),
                })),
              },
            ],
          },
  };
};
