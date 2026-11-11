// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Cached zotero.org key checks are keyed by a digest, never the key, and expire by wall clock.
import * as NodeCrypto from "node:crypto";

import type {
  ZoteroConnection,
  ZoteroConnectionStatus,
  ZoteroGroup,
} from "@scientfactory/scient-sources";
import * as Context from "effect/Context";

import type { ZoteroKeyLookup } from "./ZoteroAccountKey.ts";
import type { ZoteroTransport } from "./ZoteroLibraryReader.ts";
import {
  inspectZoteroConnection,
  listLocalZoteroGroups,
  localZoteroTransport,
  localZoteroTransportFor,
} from "./ZoteroLocalAdapter.ts";
import {
  inspectZoteroWebKey,
  keyGroupAccess,
  keyReadsSomeLibrary,
  listZoteroWebGroups,
  makeZoteroWebLibrary,
  nodeZoteroWebHttp,
  zoteroWebStatus,
  type ZoteroWebAccount,
  type ZoteroWebAccountResult,
  type ZoteroWebHttp,
  type ZoteroWebLibrary,
} from "./ZoteroWebAdapter.ts";

const ACCOUNT_CHECK_TTL_MS = 5 * 60_000;

/** How Sources reaches Zotero: the local API always, zotero.org with the key from Accounts. */
export interface ZoteroAccess {
  readonly webKey: ZoteroKeyLookup;
  readonly http?: ZoteroWebHttp;
  readonly inspectLocal?: () => Promise<ZoteroConnectionStatus>;
  readonly local?: ZoteroTransport;
  readonly localGroups?: {
    readonly list: () => Promise<ReadonlyArray<ZoteroGroup>>;
    readonly transport: (groupId: string) => ZoteroTransport;
  };
}

export const localOnlyZoteroAccess: ZoteroAccess = { webKey: async () => null };

/** The transports behind Zotero access; replaced with recorded ones in tests. */
export const ZoteroTransports = Context.Reference<Omit<ZoteroAccess, "webKey">>(
  "scient/sources/ZoteroTransports",
  { defaultValue: () => ({}) },
);

const ZOTERO_KEY_MISSING_MESSAGE =
  "Add your Zotero API key in Accounts to use your library on zotero.org.";

const checkedAccounts = new Map<
  string,
  { readonly at: number; readonly account: ZoteroWebAccount }
>();

async function checkWebKey(
  apiKey: string,
  http: ZoteroWebHttp,
  fresh = false,
): Promise<ZoteroWebAccountResult> {
  const digest = NodeCrypto.createHash("sha256").update(apiKey).digest("hex");
  const cached = checkedAccounts.get(digest);
  if (!fresh && cached && Date.now() - cached.at < ACCOUNT_CHECK_TTL_MS) {
    return { state: "ready", account: cached.account };
  }
  const result = await inspectZoteroWebKey(apiKey, http);
  if (result.state === "ready")
    checkedAccounts.set(digest, { at: Date.now(), account: result.account });
  else checkedAccounts.delete(digest);
  return result;
}

async function inspectWeb(access: ZoteroAccess): Promise<ZoteroConnectionStatus | null> {
  const apiKey = await access.webKey();
  if (!apiKey) return null;
  return zoteroWebStatus(await checkWebKey(apiKey, access.http ?? nodeZoteroWebHttp));
}

/**
 * Without a preference, Zotero on this computer wins when it is ready, then zotero.org when
 * Accounts holds a working key; otherwise the local status explains what to do.
 */
export async function inspectZotero(
  access: ZoteroAccess,
  preferred?: ZoteroConnection,
): Promise<ZoteroConnectionStatus> {
  const inspectLocal = access.inspectLocal ?? inspectZoteroConnection;
  if (preferred === "web") {
    return (
      (await inspectWeb(access)) ?? {
        state: "access-disabled",
        apiVersion: null,
        connection: "web",
        message: ZOTERO_KEY_MISSING_MESSAGE,
      }
    );
  }
  const local = { ...(await inspectLocal()), connection: "local" as const };
  if (preferred === "local" || local.state === "ready") return local;
  const web = await inspectWeb(access);
  return web?.state === "ready" ? web : local;
}

async function readyWebKey(access: ZoteroAccess, fresh?: boolean) {
  const apiKey = await access.webKey();
  if (!apiKey) throw new Error(ZOTERO_KEY_MISSING_MESSAGE);
  const http = access.http ?? nodeZoteroWebHttp;
  const result = await checkWebKey(apiKey, http, fresh);
  if (result.state === "unreachable") throw new Error("Scient could not reach zotero.org.");
  if (result.state === "rejected" || !keyReadsSomeLibrary(result.account)) {
    throw new Error("zotero.org refused the Zotero key in Accounts.");
  }
  return { apiKey, http, account: result.account };
}

/**
 * My Library on zotero.org, or a group the key can read. `fresh` checks the key's permissions
 * again, as a write must.
 */
export async function zoteroWebLibrary(
  access: ZoteroAccess,
  options: { readonly fresh?: boolean; readonly groupId?: string } = {},
): Promise<ZoteroWebLibrary> {
  const { apiKey, http, account } = await readyWebKey(access, options.fresh);
  const groupId = options.groupId;
  if (groupId && !keyGroupAccess(account, groupId).read) {
    throw new Error("The Zotero key in Accounts cannot read this group.");
  }
  if (!groupId && !account.canRead) {
    throw new Error(
      "The Zotero key in Accounts cannot read My Library. Choose a group, or save a key that can read your library.",
    );
  }
  return makeZoteroWebLibrary({ apiKey, account, http, ...(groupId ? { groupId } : {}) });
}

/** The group libraries a connection can read, besides My Library. */
export async function listZoteroGroups(
  access: ZoteroAccess,
  connection: ZoteroConnection = "local",
  options: { readonly fresh?: boolean } = {},
): Promise<ReadonlyArray<ZoteroGroup>> {
  if (connection === "local") return (access.localGroups?.list ?? listLocalZoteroGroups)();
  const { apiKey, http, account } = await readyWebKey(access, options.fresh);
  return listZoteroWebGroups({ apiKey, account, http });
}

export async function zoteroTransport(
  access: ZoteroAccess,
  connection: ZoteroConnection = "local",
  groupId?: string,
): Promise<ZoteroTransport> {
  if (connection === "local") {
    if (!groupId) return access.local ?? localZoteroTransport;
    return access.localGroups?.transport(groupId) ?? localZoteroTransportFor(groupId);
  }
  return (await zoteroWebLibrary(access, groupId ? { groupId } : {})).transport;
}
