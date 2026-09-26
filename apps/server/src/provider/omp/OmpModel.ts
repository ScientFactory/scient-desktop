import type { ServerProviderModel } from "@t3tools/contracts";
import { preferredReasoningLevel } from "@t3tools/shared/model";

import type { OmpRpcModel, OmpThinkingLevel } from "effect-omp-rpc/schema";

import {
  encodeAgentModelSlug,
  isValidModelSegment,
  splitAgentModelSlug,
  thinkingLevelCapabilities,
} from "../agentModel.ts";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const validSegment = isValidModelSegment;

export const encodeOmpModelSlug = encodeAgentModelSlug;

export const decodeOmpModelSlug = (
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
  // Oh My Pi also accepts an unencoded but otherwise well-formed slug.
  if (slug.startsWith("/")) return undefined;
  const decoded = splitAgentModelSlug(slug);
  if (!decoded) return undefined;
  const canonical = encodeOmpModelSlug(decoded.provider, decoded.modelId);
  const raw = `${decoded.provider}/${decoded.modelId}`;
  return canonical === slug || raw === slug ? decoded : undefined;
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
        : thinkingLevelCapabilities(thinkingLevels, selectedDefault),
  };
};
