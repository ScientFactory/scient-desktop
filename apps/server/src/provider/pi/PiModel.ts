import type { ModelReasoningMetadata, ServerProviderModel } from "@t3tools/contracts";
import { preferredReasoningLevel } from "@t3tools/shared/model";

import type { PiThinkingLevel } from "./PiRpcSchema.ts";
import {
  encodeAgentModelSlug,
  isValidModelSegment,
  splitAgentModelSlug,
  thinkingLevelCapabilities,
} from "../agentModel.ts";

export interface PiDiscoveredModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning?: boolean;
  readonly reasoningMetadata?: ModelReasoningMetadata | undefined;
  readonly defaultReasoningLevel?: string | undefined;
  readonly thinkingLevelMap?: Readonly<Record<string, string | number | null>> | undefined;
  readonly thinkingLevels?: ReadonlyArray<string>;
}

export interface PiModelDefaults {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: PiThinkingLevel;
}

const validSegment = isValidModelSegment;

export const encodePiModelSlug = encodeAgentModelSlug;

export function decodePiModelSlug(
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined {
  const decoded = splitAgentModelSlug(slug);
  if (!decoded) return undefined;
  // Pi accepts only a canonical encoded slug.
  return encodePiModelSlug(decoded.provider, decoded.modelId) === slug ? decoded : undefined;
}

export function piDiscoveredModelToServerProviderModel(
  model: PiDiscoveredModel,
  defaults?: PiModelDefaults,
): ServerProviderModel | undefined {
  const slug = encodePiModelSlug(model.provider, model.id);
  if (!slug || !validSegment(model.name)) return undefined;
  const supportedLevels = model.reasoningMetadata
    ? model.reasoningMetadata.levels
    : (model.thinkingLevels?.filter(validSegment) ?? piSupportedThinkingLevels(model));
  const thinkingLevels = supportedLevels.filter((level) => level !== "off" && level !== "none");
  const selectedDefault = preferredReasoningLevel(
    thinkingLevels,
    model.reasoningMetadata?.defaultLevel,
    model.defaultReasoningLevel,
  );
  const isDefault = defaults?.provider === model.provider && defaults.modelId === model.id;
  return {
    slug,
    name: model.name,
    subProvider: model.provider,
    isCustom: false,
    ...(isDefault ? { isDefault: true } : {}),
    capabilities:
      thinkingLevels.length === 0 && !model.reasoningMetadata
        ? null
        : thinkingLevelCapabilities(thinkingLevels, selectedDefault),
  };
}

export function mapPiDiscoveredModels(
  models: ReadonlyArray<PiDiscoveredModel>,
  defaults?: PiModelDefaults,
): ReadonlyArray<ServerProviderModel> {
  return models.flatMap((model) => {
    const mapped = piDiscoveredModelToServerProviderModel(model, defaults);
    return mapped ? [mapped] : [];
  });
}

/** Pi 0.84.4 models.ts policy; execution also checks the live RPC answer. */
function piSupportedThinkingLevels(model: PiDiscoveredModel): ReadonlyArray<PiThinkingLevel> {
  if (!model.reasoning) return [];
  return (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
  });
}
