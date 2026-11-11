import { modelKey } from "@scientfactory/analytics";
import type { ServerProvider, TurnTokenUsage } from "@t3tools/contracts";

import { catalogModelLabel } from "./ProviderDimensions.ts";

/**
 * The name analytics reports for a model an agent used: its vendor catalog slug when one names
 * it, otherwise the agent's own name for it, so models newer than the bundled manifest and
 * models from the user's own configuration are still named.
 */
export function reportedModelLabel(
  providers: ReadonlyArray<ServerProvider>,
  model: string,
): string {
  return catalogModelLabel(providers, model) ?? modelKey(decodedModelSlug(model));
}

// Agent model slugs escape each `provider/model` segment.
function decodedModelSlug(model: string): string {
  try {
    return decodeURIComponent(model);
  } catch {
    return model;
  }
}

/**
 * The model that did a turn's main work and how many distinct models the turn used. A turn
 * lists its main model first (see `TurnTokenUsage.models`).
 */
export function turnModelProperties(
  usage: Pick<TurnTokenUsage, "models"> | undefined,
  label: (model: string) => string | undefined,
): { readonly mainModel?: string; readonly modelCount?: number } {
  const labels = (usage?.models ?? []).flatMap((model) => label(model) ?? []);
  const mainModel = labels[0];
  return mainModel === undefined ? {} : { mainModel, modelCount: new Set(labels).size };
}
