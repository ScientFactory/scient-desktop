// @effect-diagnostics nodeBuiltinImport:off -- zotero.org HTTPS transport and temporary PDF copies for import.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import type { ZoteroConnectionStatus, ZoteroGroup } from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

import { METADATA_USER_AGENT } from "./metadataHttp.ts";
import {
  readBoundedNodeResponse,
  withRequestDeadline,
  type NodeHttpRequest,
} from "./nodeHttpResponse.ts";
import { decodeZoteroRawItem, type ZoteroRawItem } from "./ZoteroItems.ts";
import type { ZoteroResponse, ZoteroTransport } from "./ZoteroLibraryReader.ts";
import type { ZoteroItemTemplate } from "./ZoteroWrite.ts";

const ZOTERO_API_ORIGIN = "https://api.zotero.org";
const ZOTERO_API_HOST = "api.zotero.org";
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_DEADLINE_MS = 60_000;
/** Long enough for the largest file at under 1 MB a second. */
const DOWNLOAD_DEADLINE_MS = 10 * 60_000;
const UPLOAD_DEADLINE_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export interface ZoteroWebRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The HTTPS boundary, replaceable in tests with recorded responses. */
export interface ZoteroWebHttp {
  readonly request: (request: ZoteroWebRequest) => Promise<ZoteroResponse>;
  /** Streams a file to `destination`; redirects never carry the API key off zotero.org. */
  readonly download: (
    url: URL,
    headers: Readonly<Record<string, string>>,
    destination: string,
  ) => Promise<{ readonly status: number }>;
  /** Posts a file between Zotero's `prefix` and `suffix` to the storage Zotero named; never the key. */
  readonly upload: (url: URL, contentType: string, body: ZoteroUploadBody) => Promise<number>;
}

interface ZoteroUploadBody {
  readonly prefix: string;
  readonly path: string;
  readonly suffix: string;
}

function headersOf(response: { readonly headers: NodeJS.Dict<string | string[]> }) {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

function withoutKeyOffZotero(url: URL, headers: Readonly<Record<string, string>>) {
  if (url.hostname === ZOTERO_API_HOST) return headers;
  const { "Zotero-API-Key": _key, ...rest } = headers;
  return rest;
}

function nodeRequest(
  request: ZoteroWebRequest,
  send: NodeHttpRequest,
  signal: AbortSignal,
): Promise<ZoteroResponse> {
  if (request.url.protocol !== "https:" || request.url.hostname !== ZOTERO_API_HOST) {
    return Promise.reject(new Error("Zotero web requests must go to api.zotero.org."));
  }
  return new Promise((resolve, reject) => {
    const outgoing = send(
      request.url,
      {
        method: request.method,
        signal,
        headers: {
          ...request.headers,
          ...(request.body === undefined
            ? {}
            : { "Content-Length": String(Buffer.byteLength(request.body)) }),
        },
      },
      (response) => {
        void readBoundedNodeResponse(response, {
          maxBytes: MAX_RESPONSE_BYTES,
          tooLargeMessage: "Zotero returned more data than Scient can safely accept.",
        }).then(
          (body) =>
            resolve({
              status: response.statusCode ?? 0,
              headers: headersOf(response),
              body: body.toString("utf8"),
            }),
          (error: unknown) => {
            outgoing.destroy();
            reject(error);
          },
        );
      },
    );
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error("Timed out while contacting zotero.org."));
    });
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });
}

function nodeDownload(
  url: URL,
  headers: Readonly<Record<string, string>>,
  destination: string,
  send: NodeHttpRequest,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ readonly status: number }> {
  if (url.protocol !== "https:") return Promise.reject(new Error("Zotero files must use HTTPS."));
  if (redirects > MAX_REDIRECTS) {
    return Promise.reject(new Error("Zotero redirected the file too many times."));
  }
  return new Promise((resolve, reject) => {
    let receiving = false;
    const outgoing = send(
      url,
      { method: "GET", headers: withoutKeyOffZotero(url, headers), signal },
      (response) => {
        receiving = true;
        const status = response.statusCode ?? 0;
        const receive = async () => {
          if (status !== 200) {
            await readBoundedNodeResponse(response, {
              maxBytes: MAX_RESPONSE_BYTES,
              tooLargeMessage: "Zotero returned more data than Scient can safely accept.",
              discardBody: true,
            });
            if (status >= 300 && status < 400 && response.headers.location) {
              return nodeDownload(
                new URL(response.headers.location, url),
                headers,
                destination,
                send,
                signal,
                redirects + 1,
              );
            }
            return { status };
          }
          const file = NodeFS.createWriteStream(destination, { flags: "wx", mode: 0o600 });
          await NodeStreamPromises.pipeline(
            response,
            async function* (source) {
              let bytes = 0;
              for await (const chunk of source) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                bytes += buffer.byteLength;
                if (bytes > MAX_PDF_BYTES) {
                  throw new Error("The Zotero PDF is larger than Scient can import.");
                }
                yield buffer;
              }
            },
            file,
            { signal },
          );
          if (!response.complete) throw new Error("The Zotero file ended before it was complete.");
          return { status };
        };
        void receive().then(resolve, (error: unknown) => {
          outgoing.destroy();
          reject(error);
        });
      },
    );
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error("Timed out while downloading a Zotero file."));
    });
    outgoing.on("error", (error) => {
      if (!receiving) reject(error);
    });
    outgoing.end();
  });
}

async function nodeUpload(
  url: URL,
  contentType: string,
  body: ZoteroUploadBody,
  send: NodeHttpRequest,
  signal: AbortSignal,
): Promise<number> {
  if (url.protocol !== "https:") throw new Error("Zotero files must use HTTPS.");
  const { size } = await NodeFSP.stat(body.path);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  let file: NodeFS.ReadStream | undefined;
  let settled = false;
  const closeFile = async () => {
    if (!file) return;
    file.destroy();
    await NodeStreamPromises.finished(file, { cleanup: true }).catch(() => undefined);
  };
  const onAbort = () => {
    fail(signal.reason ?? new Error("Timed out while sending a PDF to Zotero."));
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    outgoing.destroy();
    void closeFile().then(() => reject(error));
  };
  const outgoing = send(
    url,
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(
          Buffer.byteLength(body.prefix) + size + Buffer.byteLength(body.suffix),
        ),
        "User-Agent": METADATA_USER_AGENT,
      },
    },
    (response) => {
      void readBoundedNodeResponse(response, {
        maxBytes: MAX_RESPONSE_BYTES,
        tooLargeMessage: "Zotero returned more data than Scient can safely accept.",
        discardBody: true,
      }).then(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        outgoing.destroy();
        void closeFile().then(() => resolve(response.statusCode ?? 0));
      }, fail);
    },
  );
  signal.addEventListener("abort", onAbort, { once: true });
  outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
    fail(new Error("Timed out while sending a PDF to Zotero."));
  });
  outgoing.on("error", fail);
  // Streamed, so a large PDF is never held whole in memory.
  file = NodeFS.createReadStream(body.path);
  file.on("error", fail);
  file.on("end", () => {
    if (!settled) outgoing.end(body.suffix);
  });
  outgoing.write(body.prefix);
  file.pipe(outgoing, { end: false });
  if (signal.aborted) onAbort();
  return promise;
}

/** Socket injection keeps loopback fixtures separate from production URL and credential rules. */
export function makeNodeZoteroWebHttp(
  send: NodeHttpRequest = NodeHttps.request,
  /** Tests only: shorter budgets. */
  deadlines: {
    readonly requestMs: number;
    readonly downloadMs: number;
    readonly uploadMs?: number;
  } = {
    requestMs: REQUEST_DEADLINE_MS,
    downloadMs: DOWNLOAD_DEADLINE_MS,
    uploadMs: UPLOAD_DEADLINE_MS,
  },
): ZoteroWebHttp {
  return {
    request: (request) =>
      withRequestDeadline(deadlines.requestMs, "Timed out while contacting zotero.org.", (signal) =>
        nodeRequest(request, send, signal),
      ),
    download: (url, headers, destination) =>
      withRequestDeadline(
        deadlines.downloadMs,
        "Timed out while downloading a Zotero file.",
        (signal) => nodeDownload(url, headers, destination, send, signal),
      ),
    upload: (url, contentType, body) =>
      withRequestDeadline(
        deadlines.uploadMs ?? deadlines.downloadMs,
        "Timed out while sending a PDF to Zotero.",
        (signal) => nodeUpload(url, contentType, body, send, signal),
      ),
  };
}

export const nodeZoteroWebHttp: ZoteroWebHttp = makeNodeZoteroWebHttp();

const GroupKeyAccess = Schema.Struct({
  library: Schema.optionalKey(Schema.Boolean),
  write: Schema.optionalKey(Schema.Boolean),
});

const ZoteroKeyInfo = Schema.Struct({
  userID: Schema.Number,
  username: Schema.optionalKey(Schema.String),
  access: Schema.optionalKey(
    Schema.Struct({
      user: Schema.optionalKey(
        Schema.Struct({
          library: Schema.optionalKey(Schema.Boolean),
          files: Schema.optionalKey(Schema.Boolean),
          notes: Schema.optionalKey(Schema.Boolean),
          write: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      // `all`, or a group ID, to what the key may do there.
      groups: Schema.optionalKey(Schema.Record(Schema.String, GroupKeyAccess)),
    }),
  ),
});
const decodeZoteroKeyInfo = Schema.decodeUnknownSync(ZoteroKeyInfo);

/** What a zotero.org key may do in its owner's personal library and in groups. */
export interface ZoteroWebAccount {
  readonly userId: string;
  readonly username: string | null;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canReadFiles: boolean;
  readonly groupAccess: Readonly<
    Record<string, { readonly read: boolean; readonly write: boolean }>
  >;
}

export function keyGroupAccess(account: ZoteroWebAccount, groupId: string) {
  return account.groupAccess[groupId] ?? account.groupAccess.all ?? { read: false, write: false };
}

/** A key may read groups without reading its owner's personal library. */
export const keyReadsSomeLibrary = (account: ZoteroWebAccount): boolean =>
  account.canRead || Object.values(account.groupAccess).some((access) => access.read);

const ZoteroWebGroups = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    data: Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      owner: Schema.optionalKey(Schema.Number),
      libraryEditing: Schema.optionalKey(Schema.String),
      admins: Schema.optionalKey(Schema.Array(Schema.Number)),
    }),
  }),
);
const decodeZoteroWebGroups = Schema.decodeUnknownSync(ZoteroWebGroups);
const MAX_GROUP_PAGES = 10;

/**
 * The groups the key can read. Writing needs the key's write access and a role the group lets
 * edit: members, or only admins and the owner.
 */
export async function listZoteroWebGroups(input: {
  readonly apiKey: string;
  readonly account: ZoteroWebAccount;
  readonly http?: ZoteroWebHttp;
}): Promise<ReadonlyArray<ZoteroGroup>> {
  const http = input.http ?? nodeZoteroWebHttp;
  const userId = Number(input.account.userId);
  const groups: ZoteroGroup[] = [];
  for (let page = 0, start = 0; page < MAX_GROUP_PAGES; page += 1) {
    const parameters = new URLSearchParams({ format: "json", limit: "100", start: String(start) });
    const response = await http.request({
      method: "GET",
      url: new URL(
        `${ZOTERO_API_ORIGIN}/users/${encodeURIComponent(input.account.userId)}/groups?${parameters.toString()}`,
      ),
      headers: apiHeaders(input.apiKey),
    });
    if (response.status === 403 || response.status === 404) return groups;
    if (response.status !== 200) throw new Error(`zotero.org returned HTTP ${response.status}.`);
    const entries = decodeZoteroWebGroups(JSON.parse(response.body));
    for (const entry of entries) {
      const groupId = String(entry.id);
      const access = keyGroupAccess(input.account, groupId);
      if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || !access.read) continue;
      const editing = entry.data.libraryEditing ?? "members";
      const editor =
        editing === "members" ||
        (editing === "admins" &&
          (entry.data.owner === userId || (entry.data.admins ?? []).includes(userId)));
      groups.push({
        groupId,
        name: entry.data.name?.trim() || `Group ${groupId}`,
        canWrite: access.write && editor,
      });
    }
    start += entries.length;
    const total = Number.parseInt(response.headers["total-results"] ?? "", 10);
    if (entries.length === 0 || !Number.isFinite(total) || start >= total) break;
  }
  return groups;
}

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Zotero-API-Version": "3",
    "Zotero-API-Key": apiKey,
    "User-Agent": METADATA_USER_AGENT,
  };
}

export type ZoteroWebAccountResult =
  | { readonly state: "ready"; readonly account: ZoteroWebAccount }
  | { readonly state: "rejected" }
  | { readonly state: "unreachable" };

export async function inspectZoteroWebKey(
  apiKey: string,
  http: ZoteroWebHttp = nodeZoteroWebHttp,
): Promise<ZoteroWebAccountResult> {
  let response: ZoteroResponse;
  try {
    response = await http.request({
      method: "GET",
      url: new URL(`${ZOTERO_API_ORIGIN}/keys/current`),
      headers: apiHeaders(apiKey),
    });
  } catch {
    return { state: "unreachable" };
  }
  if (response.status === 403 || response.status === 404) return { state: "rejected" };
  if (response.status !== 200) return { state: "unreachable" };
  // The response repeats the key itself; only the fields below are kept.
  const info = decodeZoteroKeyInfo(JSON.parse(response.body));
  const user = info.access?.user;
  const groupAccess = Object.fromEntries(
    Object.entries(info.access?.groups ?? {}).map(([id, access]) => [
      id,
      { read: access.library === true, write: access.write === true },
    ]),
  );
  return {
    state: "ready",
    account: {
      userId: String(info.userID),
      username: info.username?.trim() || null,
      canRead: user?.library === true,
      canWrite: user?.write === true,
      canReadFiles: user?.files === true,
      groupAccess,
    },
  };
}

export function zoteroWebStatus(result: ZoteroWebAccountResult): ZoteroConnectionStatus {
  if (result.state === "unreachable") {
    return {
      state: "unreachable",
      apiVersion: null,
      connection: "web",
      message: "Scient could not reach zotero.org. Check the connection, then try again.",
    };
  }
  if (result.state === "rejected" || !keyReadsSomeLibrary(result.account)) {
    return {
      state: "access-disabled",
      apiVersion: null,
      connection: "web",
      message:
        "zotero.org refused the Zotero key in Accounts. Create a key that can read your library.",
    };
  }
  if (!result.account.canRead) {
    return {
      state: "ready",
      apiVersion: 3,
      connection: "web",
      canWrite: false,
      myLibrary: false,
      message: "Using the Zotero groups your key can read on zotero.org.",
    };
  }
  return {
    state: "ready",
    apiVersion: 3,
    connection: "web",
    canWrite: result.account.canWrite,
    message: result.account.username
      ? `Using ${result.account.username}'s library on zotero.org.`
      : "Using your library on zotero.org.",
  };
}

const ZoteroUploadAuthorization = Schema.Union([
  Schema.Struct({ exists: Schema.Number }),
  Schema.Struct({
    url: Schema.String,
    contentType: Schema.String,
    prefix: Schema.String,
    suffix: Schema.String,
    uploadKey: Schema.String,
  }),
]);
const decodeUploadAuthorization = Schema.decodeUnknownSync(ZoteroUploadAuthorization);

interface ZoteroUploadFile {
  readonly path: string;
  readonly fileName: string;
  readonly md5: string;
  readonly size: number;
  /** Milliseconds, as Zotero asks. */
  readonly mtime: number;
}

/** How an upload ended: sent, or why Zotero did not take the file. */
export type ZoteroUpload = "sent" | "forbidden" | "full" | "busy" | "failed";

/** Reads and writes the key owner's personal library on zotero.org, or one of their groups. */
export function makeZoteroWebLibrary(input: {
  readonly apiKey: string;
  readonly account: ZoteroWebAccount;
  readonly groupId?: string;
  readonly http?: ZoteroWebHttp;
  readonly temporaryDirectory?: string;
}) {
  const http = input.http ?? nodeZoteroWebHttp;
  const { groupId } = input;
  const libraryPath = groupId
    ? `/groups/${encodeURIComponent(groupId)}`
    : `/users/${encodeURIComponent(input.account.userId)}`;
  const libraryUrl = (path: string) => new URL(`${ZOTERO_API_ORIGIN}${libraryPath}${path}`);
  const headers = apiHeaders(input.apiKey);
  // Group files follow the group's library access; the key has no separate file switch there.
  const canReadFiles = groupId
    ? keyGroupAccess(input.account, groupId).read
    : input.account.canReadFiles;

  const transport: ZoteroTransport = {
    connection: "web",
    get: (path) => http.request({ method: "GET", url: libraryUrl(path), headers }),
    attachmentFile: async (attachment) => {
      if (!canReadFiles || attachment.data.linkMode === "linked_file") return null;
      const directory = await NodeFSP.mkdtemp(
        NodePath.join(input.temporaryDirectory ?? NodeOS.tmpdir(), "scient-zotero-"),
      );
      const release = () => NodeFSP.rm(directory, { recursive: true, force: true });
      try {
        const destination = NodePath.join(directory, `${NodeCrypto.randomUUID()}.pdf`);
        const { status } = await http.download(
          libraryUrl(`/items/${attachment.key}/file`),
          headers,
          destination,
        );
        if (status === 404) {
          await release();
          return null;
        }
        if (status !== 200) throw new Error(`zotero.org returned HTTP ${status} for a PDF.`);
        return { path: destination, fileName: attachment.data.filename?.trim() || null, release };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };

  const write = async (
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
    extra: Readonly<Record<string, string>>,
  ) => {
    const response = await http.request({
      method,
      url: libraryUrl(path),
      headers: { ...headers, "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
    if (response.status === 412) return response;
    if (response.status === 403) {
      throw new Error(
        groupId
          ? "The Zotero key in Accounts cannot write to this group."
          : "The Zotero key in Accounts cannot write to your library.",
      );
    }
    if (response.status === 429 || response.status === 503) {
      throw new Error("zotero.org is busy. Try again in a minute.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`zotero.org returned HTTP ${response.status}.`);
    }
    return response;
  };

  const templates = new Map<string, Promise<ZoteroItemTemplate | null>>();
  const askTemplate = async (itemType: string): Promise<ZoteroItemTemplate | null> => {
    const ask = async (path: string) => {
      const response = await http.request({
        method: "GET",
        url: new URL(`${ZOTERO_API_ORIGIN}${path}?itemType=${encodeURIComponent(itemType)}`),
        headers,
      });
      return response.status === 200 ? (JSON.parse(response.body) as unknown) : null;
    };
    const [template, roles] = await Promise.all([ask("/items/new"), ask("/itemTypeCreatorTypes")]);
    if (typeof template !== "object" || template === null || !Array.isArray(roles)) return null;
    return {
      fields: new Set(Object.keys(template)),
      roles: roles.flatMap((role: unknown) =>
        typeof role === "object" &&
        role !== null &&
        typeof (role as { creatorType?: unknown }).creatorType === "string"
          ? [(role as { creatorType: string }).creatorType]
          : [],
      ),
    };
  };

  const fileForm = (attachmentKey: string, fields: Readonly<Record<string, string>>) =>
    http.request({
      method: "POST",
      url: libraryUrl(`/items/${attachmentKey}/file`),
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      },
      body: new URLSearchParams(fields).toString(),
    });

  return {
    account: input.account,
    groupId: groupId ?? null,
    transport,
    /** False for a personal library whose key has no file access; a group answers per upload. */
    canAddFiles: groupId ? true : input.account.canReadFiles,
    /**
     * The fields and creator roles Zotero accepts for an item type, asked once per type; null
     * when Zotero does not say, and the caller then sends only what every type has.
     */
    itemTemplate: (itemType: string): Promise<ZoteroItemTemplate | null> => {
      const known = templates.get(itemType);
      if (known) return known;
      const asked = askTemplate(itemType).catch(() => null);
      templates.set(itemType, asked);
      return asked;
    },
    /** Creates items in one request; the write token makes a retried request create nothing new. */
    createItems: async (
      items: ReadonlyArray<Readonly<Record<string, unknown>>>,
      writeToken: string,
    ): Promise<
      ReadonlyArray<{
        readonly key: string;
        readonly version: number;
        readonly item?: ZoteroRawItem;
      } | null>
    > => {
      const response = await write("POST", "/items", items, { "Zotero-Write-Token": writeToken });
      // A reused token: an earlier request made these items, and Zotero does not say which.
      if (response.status === 412) {
        throw new Error(
          "Zotero already has what an earlier Send of this source made, but Scient did not record it. Look for the item in Zotero before you send this source again.",
        );
      }
      const parsed = JSON.parse(response.body) as {
        readonly successful?: Record<
          string,
          { readonly key?: unknown; readonly version?: unknown }
        >;
        readonly unchanged?: Record<string, unknown>;
      };
      return items.map((_, index) => {
        const created = parsed.successful?.[String(index)];
        if (typeof created?.key !== "string" || typeof created.version !== "number") return null;
        let item: ZoteroRawItem | undefined;
        try {
          item = decodeZoteroRawItem(created);
        } catch {
          item = undefined;
        }
        return { key: created.key, version: created.version, ...(item ? { item } : {}) };
      });
    },
    /** Replaces the given fields only if the item is still at `version`. */
    updateItem: async (
      itemKey: string,
      version: number,
      data: Readonly<Record<string, unknown>>,
    ): Promise<
      { readonly outcome: "updated"; readonly version: number } | { readonly outcome: "changed" }
    > => {
      const response = await write("PATCH", `/items/${itemKey}`, data, {
        "If-Unmodified-Since-Version": String(version),
      });
      if (response.status === 412) return { outcome: "changed" };
      const next = Number.parseInt(response.headers["last-modified-version"] ?? "", 10);
      return { outcome: "updated", version: Number.isFinite(next) ? next : version };
    },
    /**
     * Zotero's upload for an attachment that has no file yet: authorise, send the bytes to the
     * storage Zotero names, register. Zotero answers `exists` when it already holds the bytes.
     */
    uploadFile: async (attachmentKey: string, file: ZoteroUploadFile): Promise<ZoteroUpload> => {
      const refused = (status: number): ZoteroUpload =>
        status === 403
          ? "forbidden"
          : status === 413
            ? "full"
            : status === 409 || status === 429 || status === 503
              ? "busy"
              : "failed";
      const authorised = await fileForm(attachmentKey, {
        md5: file.md5,
        filename: file.fileName,
        filesize: String(file.size),
        mtime: String(file.mtime),
      });
      if (authorised.status !== 200) return refused(authorised.status);
      const answer = decodeUploadAuthorization(JSON.parse(authorised.body));
      if ("exists" in answer) return "sent";
      const stored = await http.upload(new URL(answer.url), answer.contentType, {
        prefix: answer.prefix,
        path: file.path,
        suffix: answer.suffix,
      });
      if (stored < 200 || stored >= 300) return "failed";
      const registered = await fileForm(attachmentKey, { upload: answer.uploadKey });
      return registered.status === 204 ? "sent" : refused(registered.status);
    },
    /** Deletes an item only if it is still at `version`; true when it is gone. */
    deleteItem: async (itemKey: string, version: number): Promise<boolean> => {
      const response = await http.request({
        method: "DELETE",
        url: libraryUrl(`/items/${itemKey}`),
        headers: { ...headers, "If-Unmodified-Since-Version": String(version) },
      });
      return response.status === 204;
    },
  };
}
export type ZoteroWebLibrary = ReturnType<typeof makeZoteroWebLibrary>;
