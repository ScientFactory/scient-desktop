import type { AccountSummary, AccountsSnapshot, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { AccountsService, type AccountsServiceShape } from "../accounts/AccountsService.ts";

const ZOTERO_ENV_NAME = "ZOTERO_API_KEY";

/** Who is asking Sources to reach zotero.org; agents follow the Accounts switches. */
export type ZoteroKeyUse =
  | { readonly actor: "user" }
  | { readonly actor: "agent"; readonly projectId?: ProjectId | undefined };

function isZoteroSite(site: string): boolean {
  const host = site.replace(/^https:\/\//u, "").replace(/[:/].*$/u, "");
  return host === "zotero.org" || host.endsWith(".zotero.org");
}

function allowedFor(account: AccountSummary, snapshot: AccountsSnapshot, use: ZoteroKeyUse) {
  if (account.controls.access === "off") return false;
  if (use.actor === "user") return true;
  if (!snapshot.agentAccess) return false;
  const scope = account.controls.scope;
  // Like a connector binding: the user's saved key is the approval, so Ask counts as allowed.
  return (
    scope.type === "all-projects" ||
    (use.projectId !== undefined && scope.projectIds.includes(use.projectId))
  );
}

/** The newest usable Zotero API key account, by its site or its ZOTERO_API_KEY variable. */
export function zoteroAccountFor(
  snapshot: AccountsSnapshot,
  use: ZoteroKeyUse,
): AccountSummary | undefined {
  return snapshot.accounts
    .filter(
      (account) =>
        account.details.kind === "api-key" &&
        account.secrets.token !== undefined &&
        (account.details.sites.some(isZoteroSite) || account.details.envName === ZOTERO_ENV_NAME),
    )
    .filter((account) => allowedFor(account, snapshot, use))
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export type ZoteroKeyLookup = () => Promise<string | null>;

// One import reads the key for every step; Accounts activity shows one use per stretch of work.
const USE_RECORD_INTERVAL_MS = 10 * 60_000;
const lastRecordedUse = new Map<string, number>();

/** Reads the Zotero key from Accounts; the value never leaves the server's request headers. */
export const readZoteroApiKey = Effect.fn("ZoteroAccountKey.read")(function* (
  accounts: Pick<AccountsServiceShape, "snapshot" | "resolveSecrets" | "recordUse">,
  use: ZoteroKeyUse,
) {
  const snapshot = yield* accounts.snapshot;
  const account = zoteroAccountFor(snapshot, use);
  if (!account) return Option.none<Redacted.Redacted<string>>();
  const { token } = yield* accounts.resolveSecrets(account.accountId, ["token"]);
  if (!token || !Redacted.value(token).trim()) return Option.none<Redacted.Redacted<string>>();
  const now = yield* Clock.currentTimeMillis;
  const recordKey = `${account.accountId}\0${use.actor}`;
  if (now - (lastRecordedUse.get(recordKey) ?? -Infinity) >= USE_RECORD_INTERVAL_MS) {
    lastRecordedUse.set(recordKey, now);
    yield* accounts.recordUse({
      target: { type: "account", accountId: account.accountId },
      action: "request",
      detail: "Sources · api.zotero.org",
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
