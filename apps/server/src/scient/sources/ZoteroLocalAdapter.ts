// @effect-diagnostics nodeBuiltinImport:off -- This is the fixed-loopback Zotero transport boundary.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import type { ZoteroConnectionStatus, ZoteroGroup } from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

import type { ZoteroResponse, ZoteroTransport } from "./ZoteroLibraryReader.ts";

const ZOTERO_HOST = "127.0.0.1";
const ZOTERO_PORT = 23_119;
const ZOTERO_API_VERSION = 3;
const REQUEST_TIMEOUT_MS = 4_000;
const BETTER_BIBTEX_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const USER_LIBRARY_PATH = "/api/users/0";
const BETTER_BIBTEX_PATH = "/better-bibtex/json-rpc";

function localRequest(
  path: string,
  options: { readonly body?: string; readonly timeoutMs?: number } = {},
): Promise<ZoteroResponse> {
  const allowed =
    options.body === undefined ? path.startsWith("/api/") : path === BETTER_BIBTEX_PATH;
  if (!allowed) throw new Error("Zotero path must remain under the local API.");
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: ZOTERO_HOST,
        port: ZOTERO_PORT,
        method: options.body === undefined ? "GET" : "POST",
        path,
        headers: {
          Accept: "application/json",
          "Zotero-API-Version": String(ZOTERO_API_VERSION),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Zotero returned more data than Scient can safely accept."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Timed out while contacting Zotero."));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

async function libraryGet(libraryPath: string, path: string): Promise<ZoteroResponse> {
  const response = await localRequest(`${libraryPath}${path}`);
  const version = Number.parseInt(response.headers["zotero-api-version"] ?? "", 10);
  if (response.status === 200 && version !== ZOTERO_API_VERSION) {
    throw new Error("ZOTERO_INCOMPATIBLE");
  }
  return response;
}

const LocalGroups = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    name: Schema.optionalKey(Schema.String),
    data: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
  }),
);
const decodeLocalGroups = Schema.decodeUnknownSync(LocalGroups);

/** Zotero on this computer lists the groups it syncs; items there are read-only to Scient. */
export function localZoteroGroupsFrom(body: string): ReadonlyArray<ZoteroGroup> {
  const parsed = JSON.parse(body) as unknown;
  const entries = decodeLocalGroups(
    Array.isArray(parsed) ? parsed : ((parsed as { readonly data?: unknown } | null)?.data ?? []),
  );
  return entries.flatMap((entry) => {
    if (!Number.isSafeInteger(entry.id) || entry.id <= 0) return [];
    const name = (entry.data?.name ?? entry.name ?? "").trim() || `Group ${entry.id}`;
    return [{ groupId: String(entry.id), name, canWrite: false }];
  });
}

export async function listLocalZoteroGroups(): Promise<ReadonlyArray<ZoteroGroup>> {
  const response = await libraryGet(USER_LIBRARY_PATH, "/groups?format=json");
  if (response.status === 404) return [];
  if (response.status !== 200) throw new Error(`Zotero returned HTTP ${response.status}.`);
  return localZoteroGroupsFrom(response.body);
}

const BetterBibTexLibraries = Schema.Array(
  Schema.Struct({ id: Schema.Number, name: Schema.optionalKey(Schema.String) }),
);
const decodeBetterBibTexLibraries = Schema.decodeUnknownSync(BetterBibTexLibraries);

/**
 * Better BibTeX names group items by Zotero's own library number, which the local API never
 * shows; its library list gives the number for the group's name when only one library has it.
 */
export function betterBibTexLibraryId(body: string, groupName: string): number | null {
  const parsed = JSON.parse(body) as { readonly result?: unknown };
  const matches = decodeBetterBibTexLibraries(parsed.result ?? []).filter(
    (library) => library.name?.trim() === groupName,
  );
  return matches.length === 1 && matches[0] ? matches[0].id : null;
}

async function betterBibTex(method: string, params: ReadonlyArray<unknown>) {
  return localRequest(BETTER_BIBTEX_PATH, {
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    timeoutMs: BETTER_BIBTEX_TIMEOUT_MS,
  });
}

async function groupCitationKeys(
  groupId: string,
  itemKeys: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> {
  const group = (await listLocalZoteroGroups()).find((entry) => entry.groupId === groupId);
  if (!group) return new Map();
  const libraries = await betterBibTex("user.groups", []);
  if (libraries.status !== 200) return new Map();
  const libraryId = betterBibTexLibraryId(libraries.body, group.name);
  if (libraryId === null) return new Map();
  const response = await betterBibTex("item.citationkey", [
    itemKeys.map((key) => `${libraryId}:${key}`),
  ]);
  return response.status === 200 ? betterBibTexCitationKeys(response.body) : new Map();
}

/** Better BibTeX answers `item.citationkey` with keys by item key, sometimes library-prefixed. */
export function betterBibTexCitationKeys(body: string): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  const parsed = JSON.parse(body) as { readonly result?: unknown };
  if (!parsed.result || typeof parsed.result !== "object") return keys;
  for (const [itemKey, citationKey] of Object.entries(parsed.result)) {
    if (typeof citationKey !== "string" || !citationKey.trim()) continue;
    keys.set(itemKey.replace(/^\d+:/u, ""), citationKey.trim());
  }
  return keys;
}

/** Zotero on this computer: My Library, or the group with this zotero.org group ID. */
export function localZoteroTransportFor(groupId?: string): ZoteroTransport {
  const libraryPath = groupId ? `/api/groups/${groupId}` : USER_LIBRARY_PATH;
  return {
    connection: "local",
    get: (path) => libraryGet(libraryPath, path),
    attachmentFile: async (attachment) => {
      const response = await libraryGet(libraryPath, `/items/${attachment.key}/file/view/url`);
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`Zotero returned HTTP ${response.status}.`);
      const url = new URL(response.body.trim());
      if (url.protocol !== "file:") throw new Error("Zotero returned a non-local attachment URL.");
      return {
        path: NodeURL.fileURLToPath(url),
        fileName: attachment.data.filename?.trim() || null,
        release: async () => undefined,
      };
    },
    citationKeys: async (itemKeys) => {
      if (groupId) return groupCitationKeys(groupId, itemKeys);
      const response = await betterBibTex("item.citationkey", [itemKeys]);
      return response.status === 200 ? betterBibTexCitationKeys(response.body) : new Map();
    },
  };
}

export const localZoteroTransport: ZoteroTransport = localZoteroTransportFor();

export async function inspectZoteroConnection(): Promise<ZoteroConnectionStatus> {
  let response: ZoteroResponse;
  try {
    response = await localRequest("/api/");
  } catch {
    return {
      state: "unreachable",
      apiVersion: null,
      message: "Open Zotero on the computer running this project, then check again.",
    };
  }
  const version = Number.parseInt(response.headers["zotero-api-version"] ?? "", 10);
  if (response.status === 403) {
    return {
      state: "access-disabled",
      apiVersion: Number.isFinite(version) ? version : null,
      message:
        "In Zotero, open Settings → Advanced and enable “Allow other applications on this computer to communicate with Zotero.”",
    };
  }
  if (response.status === 501 || (Number.isFinite(version) && version !== ZOTERO_API_VERSION)) {
    return {
      state: "incompatible",
      apiVersion: Number.isFinite(version) ? version : null,
      message: "This Zotero local API version is not compatible with Scient.",
    };
  }
  if (response.status !== 200 || !Number.isFinite(version)) {
    return {
      state: "malformed",
      apiVersion: null,
      message: "Zotero responded, but Scient could not validate the local API.",
    };
  }
  return { state: "ready", apiVersion: version, message: "Zotero is ready for local import." };
}
