// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Cached zotero.org key checks are keyed by a digest, never the key, and expire by wall clock.
import * as NodeCrypto from "node:crypto";

import type { ZoteroConnection, ZoteroConnectionStatus } from "@scientfactory/scient-sources";

import type { ZoteroKeyLookup } from "./ZoteroAccountKey.ts";
import type { ZoteroTransport } from "./ZoteroLibraryReader.ts";
import { inspectZoteroConnection, localZoteroTransport } from "./ZoteroLocalAdapter.ts";
import {
  inspectZoteroWebKey,
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
}

export const localOnlyZoteroAccess: ZoteroAccess = { webKey: async () => null };

const ZOTERO_KEY_MISSING_MESSAGE =
  "Add your Zotero API key in Accounts to use your library on zotero.org.";

const checkedAccounts = new Map<
  string,
  { readonly at: number; readonly account: ZoteroWebAccount }
>();

async function checkWebKey(apiKey: string, http: ZoteroWebHttp): Promise<ZoteroWebAccountResult> {
  const digest = NodeCrypto.createHash("sha256").update(apiKey).digest("hex");
  const cached = checkedAccounts.get(digest);
  if (cached && Date.now() - cached.at < ACCOUNT_CHECK_TTL_MS) {
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

async function zoteroWebLibrary(access: ZoteroAccess): Promise<ZoteroWebLibrary> {
  const apiKey = await access.webKey();
  if (!apiKey) throw new Error(ZOTERO_KEY_MISSING_MESSAGE);
  const http = access.http ?? nodeZoteroWebHttp;
  const result = await checkWebKey(apiKey, http);
  if (result.state === "unreachable") throw new Error("Scient could not reach zotero.org.");
  if (result.state === "rejected" || !result.account.canRead) {
    throw new Error("zotero.org refused the Zotero key in Accounts.");
  }
  return makeZoteroWebLibrary({ apiKey, account: result.account, http });
}

export async function zoteroTransport(
  access: ZoteroAccess,
  connection: ZoteroConnection = "local",
): Promise<ZoteroTransport> {
  if (connection === "local") return access.local ?? localZoteroTransport;
  return (await zoteroWebLibrary(access)).transport;
}
