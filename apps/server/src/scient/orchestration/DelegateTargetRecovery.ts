import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";

/** Models or instances a refused delegation names. */
export const DELEGATE_HINT_LIMIT = 5;

const leaf = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();

export type DelegateModelMatch =
  | { readonly kind: "found"; readonly model: ServerProviderModel }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<ServerProviderModel> }
  | { readonly kind: "missing" };

/**
 * After exact slugs and aliases miss: the same model written in another case, or without its
 * account prefix (`gpt-6-luna` for `openai-codex/gpt-6-luna`). It never picks a different model,
 * and a name two models share is refused with both.
 */
export function matchDelegateModel(
  models: ReadonlyArray<ServerProviderModel>,
  requested: string,
): DelegateModelMatch {
  const wanted = requested.toLowerCase();
  const sameSlug = models.filter((model) => model.slug.toLowerCase() === wanted);
  const candidates =
    sameSlug.length > 0 || wanted.includes("/")
      ? sameSlug
      : models.filter((model) => leaf(model.slug) === wanted);
  if (candidates.length === 1) return { kind: "found", model: candidates[0]! };
  return candidates.length === 0 ? { kind: "missing" } : { kind: "ambiguous", candidates };
}

const terms = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .filter((term) => term.length > 0);

/** Up to five advertised slugs sharing the most name parts with the request, catalog order on ties. */
function nearestDelegateModels(
  models: ReadonlyArray<ServerProviderModel>,
  requested: string,
): ReadonlyArray<string> {
  const wanted = new Set(terms(leaf(requested)));
  const scored = models
    .filter((model) => model.isLegacy !== true)
    .map((model, index) => {
      const own = new Set(terms(`${leaf(model.slug)} ${model.name}`));
      return { slug: model.slug, index, score: [...wanted].filter((term) => own.has(term)).length };
    });
  const related = scored.filter((entry) => entry.score > 0);
  return (related.length > 0 ? related : scored)
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, DELEGATE_HINT_LIMIT)
    .map((entry) => entry.slug);
}

export function modelUnavailableMessage(provider: ServerProvider, requested: string): string {
  const nearest = nearestDelegateModels(provider.models, requested);
  return `Model ${requested} is not advertised by provider ${provider.instanceId}.${
    nearest.length === 0 ? "" : ` Closest: ${nearest.join(", ")}.`
  } Pass a model id exactly as \`orchestrator_capabilities\` lists it (\`search\` finds others).`;
}

export function ambiguousModelMessage(
  provider: ServerProvider,
  requested: string,
  candidates: ReadonlyArray<ServerProviderModel>,
): string {
  return `Model ${requested} names several models on provider ${provider.instanceId}: ${candidates
    .slice(0, DELEGATE_HINT_LIMIT)
    .map((model) => model.slug)
    .join(", ")}. Pass one of them exactly.`;
}

/** Appended to a provider refusal: where a child task can run instead. */
export function usableInstancesHint(instanceIds: ReadonlyArray<string>): string {
  return instanceIds.length === 0
    ? " No provider instance can run a child task in this project right now."
    : ` Usable here: ${instanceIds.slice(0, DELEGATE_HINT_LIMIT).join(", ")}. Their models are in \`orchestrator_capabilities\`.`;
}
