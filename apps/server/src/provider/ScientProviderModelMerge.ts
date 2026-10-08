/**
 * Scient's model-merge policy for providers whose catalogs are authoritative:
 * Claude's curated catalog, and the live inventories of Droid, Pi and Scient
 * Agent.
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";

/** Whether a refresh keeps models it no longer lists, or undefined for the default policy. */
export const scientRetainMissingProviderModels = (
  provider: ServerProvider,
): boolean | undefined => {
  // Claude's probe returns T3's curated versioned catalog together with the
  // current settings-defined custom models. Treat it as authoritative so SDK
  // aliases or models from an older catalog cannot survive a refresh.
  if (provider.driver === ProviderDriverKind.make("claudeAgent")) {
    return false;
  }

  // Droid's ACP catalog is likewise authoritative: models are discovered live
  // from the CLI, and a model Factory removes or revokes must not linger in
  // the picker. Same state-aware policy as OpenCode below — retain during
  // pending initial probes and failed installed-probe refreshes, replace on
  // successful discovery.
  // Scient Agent lists its models live from the running agent, the same way.
  if (
    provider.driver === ProviderDriverKind.make("droid") ||
    provider.driver === ProviderDriverKind.make("pi") ||
    provider.driver === ProviderDriverKind.make("scient")
  ) {
    const isPendingInitialProbe =
      provider.enabled && !provider.installed && provider.status === "warning";
    const didInstalledProviderProbeFail = provider.installed && provider.status === "error";
    return isPendingInitialProbe || didInstalledProviderProbeFail;
  }

  return undefined;
};

/** The merged model for a Scient-managed driver, or undefined for the default merge. */
export const mergeScientProviderModel = (
  provider: ServerProvider,
  model: ServerProvider["models"][number],
  previousBySlug: ReadonlyMap<string, ServerProvider["models"][number]>,
): ServerProvider["models"][number] | undefined => {
  // A successful Pi or Scient Agent inventory explicitly describes the
  // current model's options, including that it has none.
  if (
    provider.driver === ProviderDriverKind.make("pi") ||
    provider.driver === ProviderDriverKind.make("scient")
  ) {
    return model;
  }
  if (provider.driver === ProviderDriverKind.make("droid")) {
    const previousModel = previousBySlug.get(model.slug);
    // Droid uses the contract's nullable capability shape as an authority
    // marker: null means the per-model ladder was not observed, while an
    // empty descriptor list means the model was observed and has no effort
    // selector. Only the unknown state may inherit a last-known value.
    if (previousModel && model.capabilities === null && previousModel.capabilities !== null) {
      return { ...model, capabilities: previousModel.capabilities };
    }
    return model;
  }
  return undefined;
};
