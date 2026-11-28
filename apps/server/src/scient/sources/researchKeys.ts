import type { ScientSourceIdentifier } from "@scientfactory/scient-sources";
import { type AccountSummary, agentsMayUseEverywhere } from "@t3tools/contracts";
import { libraryKeyFits } from "@t3tools/shared/scientLibraryKeys";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { AccountsService } from "../accounts/AccountsService.ts";
import { type LibraryKeyCaller, libraryKey } from "./libraryKeys.ts";
import {
  SourceIdentifierLookup,
  type ResearchKeys,
  type ResolveSourceIdentifier,
} from "./SourceIdentifierResolver.ts";

const RESEARCH_KEY_USES = [
  "openAlex",
  "semanticScholar",
  "ncbi",
  "googleBooks",
  "unpaywallEmail",
] as const satisfies ReadonlyArray<keyof ResearchKeys>;

/**
 * The user's research keys from Accounts, for Scient's own registry requests: the key the
 * Library chose for each service, or the first one fitting it, kept as the choice. Agents'
 * lookups skip a key that is Off; the person's own don't. Values stay redacted and never reach
 * tool output or logs.
 */
export const readResearchKeys = Effect.fn("Sources.readResearchKeys")(function* (
  caller: LibraryKeyCaller = "agent",
) {
  const service = yield* Effect.serviceOption(AccountsService);
  if (Option.isNone(service)) return {};
  const snapshot = yield* service.value.snapshot.pipe(Effect.orElseSucceed(() => undefined));
  const accounts: ReadonlyArray<AccountSummary> = snapshot?.accounts ?? [];
  const read: Array<{
    readonly name: (typeof RESEARCH_KEY_USES)[number];
    readonly account: AccountSummary;
    readonly token: Redacted.Redacted<string>;
  }> = [];
  for (const name of RESEARCH_KEY_USES) {
    const account = yield* libraryKey({
      use: name,
      caller,
      candidates: accounts.filter((account) => libraryKeyFits(name, account)),
      pick: (fitting) => fitting[0],
      // Agents' lookups carry no project, so only a key for every project goes with them.
      agentMayUse: (account) => agentsMayUseEverywhere(account, snapshot?.agentAccess ?? false),
    });
    if (!account) continue;
    const secrets = yield* service.value
      .resolveSecrets(account.accountId, ["token"])
      .pipe(Effect.orElseSucceed(() => ({}) as Record<string, Redacted.Redacted<string>>));
    if (secrets.token) read.push({ name, account, token: secrets.token });
  }
  // An agent's keys pass the use-time gate once every key is read, right before the lookup
  // sends them: Off, Remove, a scope short of every project or a new value since wins.
  const gate = (account: AccountSummary) =>
    service.value
      .authorizeUse(
        { projectId: undefined, unattended: true },
        { type: "account", accountId: account.accountId },
        { linked: true, since: account },
      )
      .pipe(Effect.isSuccess);
  const keys: {
    -readonly [K in Exclude<keyof ResearchKeys, "beforeSend">]?: Redacted.Redacted<string>;
  } = {};
  const sent: Array<{ readonly account: AccountSummary; readonly value: string }> = [];
  for (const { name, account, token } of read) {
    if (caller !== "person" && !(yield* gate(account))) continue;
    keys[name] = token;
    sent.push({ account, value: Redacted.value(token) });
  }
  if (caller === "person" || sent.length === 0) return keys;
  // And again as each request carrying one of them leaves, since a lookup's later requests wait
  // on its earlier ones. Hidden, so the keys still list only the services they serve.
  const context = yield* Effect.context<never>();
  const carried = (url: URL, headers: Readonly<Record<string, string>>, value: string) =>
    [...url.searchParams.values(), ...Object.values(headers)].some((field) =>
      field.includes(value),
    );
  const beforeSend: NonNullable<ResearchKeys["beforeSend"]> = (url, headers) =>
    Effect.runPromiseWith(context)(
      Effect.forEach(
        sent.filter(({ value }) => carried(url, headers, value)),
        ({ account }) => gate(account),
      ).pipe(Effect.map((answers) => answers.every(Boolean))),
    );
  Object.defineProperty(keys, "beforeSend", { value: beforeSend, enumerable: false });
  return keys as ResearchKeys;
});

/** The resolver as tools use it: with the keys the user saved in Accounts, read at each lookup. */
export const keyedIdentifierLookup = Effect.fn("Sources.keyedIdentifierLookup")(function* () {
  const lookup = yield* SourceIdentifierLookup;
  const keys = yield* researchKeysReader();
  const resolve: ResolveSourceIdentifier = (identifiers) =>
    keys().then((current) => lookup(identifiers, current));
  return resolve;
});

/** A batch lookup with the user's keys, as identifier adds, citing and the reference check use it. */
export const keyedBatchLookup = Effect.fn("Sources.keyedBatchLookup")(function* <A>(
  lookup: (identifiers: ReadonlyArray<ScientSourceIdentifier>, keys?: ResearchKeys) => Promise<A>,
) {
  const keys = yield* researchKeysReader();
  return (identifiers: ReadonlyArray<ScientSourceIdentifier>) =>
    keys().then((current) => lookup(identifiers, current));
});

/** Reads the keys again at each call, for work outside a request: background passes and HTTP routes. */
export const researchKeysReader = Effect.fn("Sources.researchKeysReader")(function* (
  caller: LibraryKeyCaller = "agent",
) {
  const context = yield* Effect.context<never>();
  return (): Promise<ResearchKeys> => Effect.runPromiseWith(context)(readResearchKeys(caller));
});
