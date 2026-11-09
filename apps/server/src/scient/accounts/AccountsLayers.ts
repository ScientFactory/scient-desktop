import { Layer } from "effect";
import * as AccountsSecretStore from "./AccountsSecretStore.ts";
import * as AccountVault from "./AccountVault.ts";
import * as AccountPersistence from "./AccountPersistence.ts";
import * as AccountSources from "./AccountSources.ts";
import * as AccountsServiceLive from "./AccountsServiceLive.ts";
import * as GitHubSourceControlCredential from "../extensions/connectors/GitHubSourceControlCredential.ts";
import * as SignInAttempts from "./agent/signInAttempts.ts";
import * as AccountAgentService from "./agent/AccountAgentService.ts";

export const AccountVaultLive = AccountVault.layer;
const AccountsLayerLive = AccountsServiceLive.layer.pipe(
  Layer.provide(AccountPersistence.layer),
  Layer.provide(GitHubSourceControlCredential.layer),
  Layer.provide(SignInAttempts.layer),
  Layer.provide(AccountSources.layer.pipe(Layer.provide(AccountsSecretStore.layer))),
  Layer.provideMerge(AccountVaultLive),
);
/** Accounts, with the person's own sign-ins built on it. */
export const ScientAccountsLayerLive = AccountAgentService.layer.pipe(
  Layer.provideMerge(AccountsLayerLive),
);
