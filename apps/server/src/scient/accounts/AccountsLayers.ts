import { Layer } from "effect";
import * as AccountsSecretStore from "./AccountsSecretStore.ts";
import * as AccountVault from "./AccountVault.ts";
import * as AccountPersistence from "./AccountPersistence.ts";
import * as AccountSources from "./AccountSources.ts";
import * as AccountsServiceLive from "./AccountsServiceLive.ts";
import * as GitHubSourceControlCredential from "../extensions/connectors/GitHubSourceControlCredential.ts";

export const AccountVaultLive = AccountVault.layer;
export const ScientAccountsLayerLive = AccountsServiceLive.layer.pipe(
  Layer.provide(AccountPersistence.layer),
  Layer.provide(GitHubSourceControlCredential.layer),
  Layer.provide(AccountSources.layer.pipe(Layer.provide(AccountsSecretStore.layer))),
  Layer.provideMerge(AccountVaultLive),
);
