import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { getAntigravityModelGroups } from "@t3tools/client-runtime/antigravity-model-presentation";
import { createModelSelection, resolveSelectableModel } from "@t3tools/shared/model";

/** Translate a historical agy family selection only against this instance's live ACP variants. */
export function resolveAntigravityDraftSelection(
  selection: ModelSelection,
  provider: ServerProvider,
  hiddenModels: ReadonlyArray<string> = [],
): ModelSelection | null {
  if (
    provider.driver !== "antigravity" ||
    provider.instanceId !== selection.instanceId ||
    !provider.enabled ||
    !provider.installed ||
    provider.status !== "ready" ||
    resolveSelectableModel(provider.driver, selection.model, provider.models) !== null
  )
    return null;

  const renamed = resolveLegacyThinkingVariant(selection, provider, hiddenModels);
  if (renamed !== undefined) return renamed;

  const group = getAntigravityModelGroups(provider.driver, provider.models).find((candidate) =>
    candidate.models.some(
      ({ slug }) => slug.replace(/-(low|medium|high)$/, "") === selection.model,
    ),
  );
  if (!group) return null;
  const efforts =
    selection.options?.filter(({ id }) => id === "reasoning" || id === "effort") ?? [];
  if (new Set(efforts.map(({ value }) => value)).size > 1) return null;
  const effort = efforts[0]?.value;
  // agy's default was medium, or its first available effort (low -> medium -> high).
  const variant =
    effort === undefined
      ? (group.models.find(({ label }) => label === "Medium") ?? group.models[0])
      : group.models.find(({ slug }) => slug === `${selection.model}-${effort}`);
  if (!variant || hiddenModels.includes(variant.slug)) return null;
  return createModelSelection(
    selection.instanceId,
    variant.slug,
    selection.options?.filter(({ id }) => id !== "reasoning" && id !== "effort"),
  );
}

/**
 * Runtime 1.4 lists `gemini-3.8-flash` with a thinking option where 1.3 listed
 * `gemini-3.8-flash-high`. Map a saved 1.3 ID to its family and level; `undefined`
 * means the selection is not such an ID.
 */
function resolveLegacyThinkingVariant(
  selection: ModelSelection,
  provider: ServerProvider,
  hiddenModels: ReadonlyArray<string>,
): ModelSelection | null | undefined {
  const family = provider.models
    .filter((model) => !model.isCustom && selection.model.startsWith(`${model.slug}-`))
    .toSorted((left, right) => right.slug.length - left.slug.length)[0];
  if (!family) return undefined;
  const level = selection.model.slice(family.slug.length + 1);
  const thinking = family.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
  );
  // Without a thinking option the level no longer applies; with one, only a listed level does.
  const known =
    thinking?.type === "select"
      ? thinking.options.some((option) => option.id === level)
      : LEGACY_THINKING_LEVELS.has(level);
  if (!known || hiddenModels.includes(family.slug)) return null;
  const others =
    selection.options?.filter(
      ({ id }) => id !== "reasoning" && id !== "effort" && id !== thinking?.id,
    ) ?? [];
  return createModelSelection(
    selection.instanceId,
    family.slug,
    thinking ? [...others, { id: thinking.id, value: level }] : others,
  );
}

const LEGACY_THINKING_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
