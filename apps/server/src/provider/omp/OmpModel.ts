import type { ServerProviderModel } from "@t3tools/contracts";
import { preferredReasoningLevel } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

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

/**
 * The reasoning levels a model offers, from what Oh My Pi reports and nothing
 * else. OMP 18.x sends `thinking.efforts` (its `getSupportedEfforts`); the
 * older `thinkingLevels` field is read only when `thinking` is absent. A model
 * without either offers no selector: the six-level list is never invented.
 * "off" is not an effort; OMP represents it as the absence of reasoning.
 */
export const ompModelThinkingLevels = (
  model: OmpRpcModel,
): ReadonlyArray<(typeof THINKING_LEVELS)[number]> => {
  if (model.reasoning !== true) return [];
  const reported = model.thinking ? (model.thinking.efforts ?? []) : (model.thinkingLevels ?? []);
  return THINKING_LEVELS.filter((level) => reported.includes(level));
};

/**
 * The level a new selection of this model starts at: Oh My Pi's own default
 * (which carries a custom model's configured preference), then the shared
 * preference order. OMP cannot express an "off" default on the wire, and
 * Scient's reasoning selector is concrete, so no "off" overlay is needed.
 */
const ompModelDefaultThinkingLevel = (model: OmpRpcModel): string | undefined => {
  const levels = ompModelThinkingLevels(model);
  const reported = model.thinking?.defaultLevel;
  return preferredReasoningLevel(
    levels,
    reported !== undefined && levels.some((level) => level === reported) ? reported : undefined,
  );
};

export const ompModelToServerModel = (
  model: OmpRpcModel,
  selected?: { readonly provider: string; readonly modelId: string },
): ServerProviderModel | undefined => {
  const slug = encodeOmpModelSlug(model.provider, model.id);
  const name = model.name?.trim() || model.id;
  if (!slug || !validSegment(name)) return undefined;
  const thinkingLevels = ompModelThinkingLevels(model);
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
        : thinkingLevelCapabilities(thinkingLevels, ompModelDefaultThinkingLevel(model)),
  };
};

/**
 * Oh My Pi did not confirm that it registered Scient's current custom models.
 * `timeout`: no acknowledgement arrived in time. `retired`: the model bridge
 * closed because the connections changed. `failed`: the extension reported
 * that registering them failed.
 */
export class OmpModelRefreshError extends Schema.TaggedError<OmpModelRefreshError>()(
  "OmpModelRefreshError",
  {
    reason: Schema.Literals(["timeout", "retired", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A keyed connection added after the process started cannot be used until the next one. */
export const OMP_PENDING_CONNECTION_DETAIL =
  "This model connection was added after the conversation started. Start a new conversation to use this connection.";
