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
