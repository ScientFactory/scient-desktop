import type { AccountSummary, AccountsSnapshot, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { AccountsService, type AccountsServiceShape } from "../accounts/AccountsService.ts";
import { libraryKey } from "./libraryKeys.ts";
import { libraryKeyFits } from "@t3tools/shared/scientLibraryKeys";

/** Who is asking Sources to reach zotero.org; agents follow the Accounts switches. */
export type ZoteroKeyUse =
  | { readonly actor: "user" }
  | { readonly actor: "agent"; readonly projectId?: ProjectId | undefined };

function agentMayUse(account: AccountSummary, snapshot: AccountsSnapshot, use: ZoteroKeyUse) {
  if (use.actor === "user") return true;
  if (account.controls.access === "off" || !snapshot.agentAccess) return false;
  const scope = account.controls.scope;
  // Like a connector binding: the user's saved key is the approval, so Ask counts as allowed.
  return (
    scope.type === "all-projects" ||
    (use.projectId !== undefined && scope.projectIds.includes(use.projectId))
  );
}

/**
 * The Zotero key the Library chose, by its site or its ZOTERO_API_KEY variable; the newest such
 * key not Off becomes the choice when there is none.
 */
export const zoteroAccountFor = Effect.fn("ZoteroAccountKey.account")(function* (
  snapshot: AccountsSnapshot,
  use: ZoteroKeyUse,
) {
  return yield* libraryKey({
    use: "zotero",
    caller: use.actor === "user" ? "person" : "agent",
    candidates: snapshot.accounts.filter((account) => libraryKeyFits("zotero", account)),
    pick: (keys) =>
      keys.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0],
    agentMayUse: (account) => agentMayUse(account, snapshot, use),
  });
});

export type ZoteroKeyLookup = () => Promise<string | null>;

// One import reads the key for every step; Accounts activity shows one use per stretch of work.
const USE_RECORD_INTERVAL_MS = 10 * 60_000;
const lastRecordedUse = new Map<string, number>();

/** Reads the Zotero key from Accounts; the value never leaves the server's request headers. */
export const readZoteroApiKey = Effect.fn("ZoteroAccountKey.read")(function* (
  accounts: Pick<
    AccountsServiceShape,
    "snapshot" | "resolveSecrets" | "recordUse" | "authorizeUse"
  >,
  use: ZoteroKeyUse,
) {
  const snapshot = yield* accounts.snapshot;
  const account = yield* zoteroAccountFor(snapshot, use);
  if (!account) return Option.none<Redacted.Redacted<string>>();
  const { token } = yield* accounts.resolveSecrets(account.accountId, ["token"]);
  if (!token || !Redacted.value(token).trim()) return Option.none<Redacted.Redacted<string>>();
  // An agent's key passes the use-time gate after the read, as the lookup sends it: Off, Remove,
  // a narrower scope or a new value since the row was read wins.
  if (
    use.actor === "agent" &&
    !(yield* accounts
      .authorizeUse(
        { projectId: use.projectId, unattended: true },
        { type: "account", accountId: account.accountId },
        { linked: true, since: account },
      )
      .pipe(Effect.isSuccess))
  )
    return Option.none<Redacted.Redacted<string>>();
  const now = yield* Clock.currentTimeMillis;
  const recordKey = `${account.accountId}\0${use.actor}`;
  if (now - (lastRecordedUse.get(recordKey) ?? -Infinity) >= USE_RECORD_INTERVAL_MS) {
    lastRecordedUse.set(recordKey, now);
    yield* accounts.recordUse({
      target: { type: "account", accountId: account.accountId },
      action: "request",
      detail: "Library · api.zotero.org",
      outcome: "ok",
      ...(use.actor === "agent" && use.projectId !== undefined ? { projectId: use.projectId } : {}),
    });
  }
  return Option.some(token);
});

/** A Promise lookup for the Sources coordinator; Scient without Accounts has no web key. */
export const zoteroKeyLookup = Effect.fn("ZoteroAccountKey.lookup")(function* (use: ZoteroKeyUse) {
  const accounts = yield* Effect.serviceOption(AccountsService);
  const context = yield* Effect.context<never>();
  const lookup: ZoteroKeyLookup = () =>
    Option.isNone(accounts)
      ? Promise.resolve(null)
      : Effect.runPromiseWith(context)(
          readZoteroApiKey(accounts.value, use).pipe(
            Effect.map(Option.match({ onNone: () => null, onSome: Redacted.value })),
            Effect.orElseSucceed(() => null),
          ),
        );
  return lookup;
});
