import type { ScientSourceIdentifier } from "@scientfactory/scient-sources";
import type { AccountSummary } from "@t3tools/contracts";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

import { AccountsService } from "../accounts/AccountsService.ts";
import {
  SourceIdentifierLookup,
  type ResearchKeys,
  type ResolveSourceIdentifier,
} from "./SourceIdentifierResolver.ts";

/** Where each research service takes its key, matched against the Accounts row's sites. */
const SERVICE_URLS = {
  openAlex: "https://api.openalex.org/",
  semanticScholar: "https://api.semanticscholar.org/",
  ncbi: "https://eutils.ncbi.nlm.nih.gov/",
  googleBooks: "https://www.googleapis.com/books/",
  unpaywallEmail: "https://api.unpaywall.org/",
} as const satisfies Record<keyof ResearchKeys, string>;

const keyAccount = (accounts: ReadonlyArray<AccountSummary>, url: string) =>
  accounts.find(
    (account) =>
      account.details.kind === "api-key" &&
      account.controls.access !== "off" &&
      account.secrets.token !== undefined &&
      anySiteMatches(account.details.sites, url),
  );

/**
 * The user's research keys from Accounts, for Scient's own registry requests. A key the user
 * turned off is not used. Values stay redacted and never reach tool output or logs.
 */
export const readResearchKeys = Effect.fn("Sources.readResearchKeys")(function* () {
  const service = yield* Effect.serviceOption(AccountsService);
  if (Option.isNone(service)) return {};
  const accounts = yield* service.value.snapshot.pipe(
    Effect.map((snapshot) => snapshot.accounts),
    Effect.orElseSucceed((): ReadonlyArray<AccountSummary> => []),
  );
  const keys: { -readonly [K in keyof ResearchKeys]: Redacted.Redacted<string> } = {};
  for (const [name, url] of Object.entries(SERVICE_URLS) as Array<[keyof ResearchKeys, string]>) {
    const account = keyAccount(accounts, url);
    if (!account) continue;
    const secrets = yield* service.value
      .resolveSecrets(account.accountId, ["token"])
      .pipe(Effect.orElseSucceed(() => ({}) as Record<string, Redacted.Redacted<string>>));
    const token = secrets.token;
    if (token) keys[name] = token;
  }
  return keys;
});

/** The resolver as tools use it: with whatever keys the user saved in Accounts. */
export const keyedIdentifierLookup = Effect.fn("Sources.keyedIdentifierLookup")(function* () {
  const lookup = yield* SourceIdentifierLookup;
  const keys = yield* readResearchKeys();
  const resolve: ResolveSourceIdentifier = (identifiers) => lookup(identifiers, keys);
  return resolve;
});

/** A batch lookup with the user's keys, as identifier adds, citing and the reference check use it. */
export const keyedBatchLookup = Effect.fn("Sources.keyedBatchLookup")(function* <A>(
  lookup: (identifiers: ReadonlyArray<ScientSourceIdentifier>, keys?: ResearchKeys) => Promise<A>,
) {
  const keys = yield* readResearchKeys();
  return (identifiers: ReadonlyArray<ScientSourceIdentifier>) => lookup(identifiers, keys);
});

/** Reads the keys again at each call, for work outside a request: background passes and HTTP routes. */
export const researchKeysReader = Effect.fn("Sources.researchKeysReader")(function* () {
  const context = yield* Effect.context<never>();
  return (): Promise<ResearchKeys> => Effect.runPromiseWith(context)(readResearchKeys());
});
