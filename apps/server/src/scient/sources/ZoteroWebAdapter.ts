// @effect-diagnostics nodeBuiltinImport:off -- zotero.org HTTPS transport and temporary PDF copies for import.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ZoteroConnectionStatus } from "@scientfactory/scient-sources";
import * as Schema from "effect/Schema";

import { METADATA_USER_AGENT } from "./metadataHttp.ts";
import type { ZoteroResponse, ZoteroTransport } from "./ZoteroLibraryReader.ts";

const ZOTERO_API_ORIGIN = "https://api.zotero.org";
const ZOTERO_API_HOST = "api.zotero.org";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export interface ZoteroWebRequest {
  readonly method: "GET" | "POST" | "PATCH";
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

function nodeRequest(request: ZoteroWebRequest): Promise<ZoteroResponse> {
  if (request.url.protocol !== "https:" || request.url.hostname !== ZOTERO_API_HOST) {
    return Promise.reject(new Error("Zotero web requests must go to api.zotero.org."));
  }
  return new Promise((resolve, reject) => {
    const outgoing = NodeHttps.request(
      request.url,
      {
        method: request.method,
        headers: {
          ...request.headers,
          ...(request.body === undefined
            ? {}
            : { "Content-Length": String(Buffer.byteLength(request.body)) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            outgoing.destroy(new Error("Zotero returned more data than Scient can safely accept."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: headersOf(response),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
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
  redirects = 0,
): Promise<{ readonly status: number }> {
  if (url.protocol !== "https:") return Promise.reject(new Error("Zotero files must use HTTPS."));
  if (redirects > MAX_REDIRECTS) {
    return Promise.reject(new Error("Zotero redirected the file too many times."));
  }
  return new Promise((resolve, reject) => {
    const outgoing = NodeHttps.get(
      url,
      { headers: withoutKeyOffZotero(url, headers) },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          const next = new URL(response.headers.location, url);
          void nodeDownload(next, headers, destination, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          resolve({ status });
          return;
        }
        const file = NodeFS.createWriteStream(destination, { flags: "wx", mode: 0o600 });
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_PDF_BYTES) {
            outgoing.destroy(new Error("The Zotero PDF is larger than Scient can import."));
          }
        });
        response.pipe(file);
        file.on("finish", () => resolve({ status }));
        file.on("error", reject);
        response.on("error", reject);
      },
    );
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error("Timed out while downloading a Zotero file."));
    });
    outgoing.on("error", reject);
  });
}

export const nodeZoteroWebHttp: ZoteroWebHttp = { request: nodeRequest, download: nodeDownload };

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
    }),
  ),
});
const decodeZoteroKeyInfo = Schema.decodeUnknownSync(ZoteroKeyInfo);

/** What a zotero.org key may do in its owner's personal library. */
export interface ZoteroWebAccount {
  readonly userId: string;
  readonly username: string | null;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canReadFiles: boolean;
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
  return {
    state: "ready",
    account: {
      userId: String(info.userID),
      username: info.username?.trim() || null,
      canRead: user?.library === true,
      canWrite: user?.write === true,
      canReadFiles: user?.files === true,
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
  if (result.state === "rejected" || !result.account.canRead) {
    return {
      state: "access-disabled",
      apiVersion: null,
      connection: "web",
      message:
        "zotero.org refused the Zotero key in Accounts. Create a key that can read your library.",
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

/** Reads and writes the key owner's personal library on zotero.org. */
export function makeZoteroWebLibrary(input: {
  readonly apiKey: string;
  readonly account: ZoteroWebAccount;
  readonly http?: ZoteroWebHttp;
  readonly temporaryDirectory?: string;
}) {
  const http = input.http ?? nodeZoteroWebHttp;
  const libraryUrl = (path: string) =>
    new URL(`${ZOTERO_API_ORIGIN}/users/${encodeURIComponent(input.account.userId)}${path}`);
  const headers = apiHeaders(input.apiKey);

  const transport: ZoteroTransport = {
    connection: "web",
    get: (path) => http.request({ method: "GET", url: libraryUrl(path), headers }),
    attachmentFile: async (attachment) => {
      if (!input.account.canReadFiles || attachment.data.linkMode === "linked_file") return null;
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
      throw new Error("The Zotero key in Accounts cannot write to your library.");
    }
    if (response.status === 429 || response.status === 503) {
      throw new Error("zotero.org is busy. Try again in a minute.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`zotero.org returned HTTP ${response.status}.`);
    }
    return response;
  };

  return {
    account: input.account,
    transport,
    /** Creates items in one request; the write token makes a retried request create nothing new. */
    createItems: async (
      items: ReadonlyArray<Readonly<Record<string, unknown>>>,
      writeToken: string,
    ): Promise<ReadonlyArray<{ readonly key: string; readonly version: number } | null>> => {
      const response = await write("POST", "/items", items, { "Zotero-Write-Token": writeToken });
      const parsed = JSON.parse(response.body) as {
        readonly successful?: Record<
          string,
          { readonly key?: unknown; readonly version?: unknown }
        >;
        readonly unchanged?: Record<string, unknown>;
      };
      return items.map((_, index) => {
        const created = parsed.successful?.[String(index)];
        return typeof created?.key === "string" && typeof created.version === "number"
          ? { key: created.key, version: created.version }
          : null;
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
  };
}
export type ZoteroWebLibrary = ReturnType<typeof makeZoteroWebLibrary>;
