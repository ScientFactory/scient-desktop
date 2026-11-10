// @effect-diagnostics nodeBuiltinImport:off -- This is the fixed-loopback Zotero transport boundary.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";

import type { ZoteroConnectionStatus } from "@scientfactory/scient-sources";

import type { ZoteroResponse, ZoteroTransport } from "./ZoteroLibraryReader.ts";

const ZOTERO_HOST = "127.0.0.1";
const ZOTERO_PORT = 23_119;
const ZOTERO_API_VERSION = 3;
const REQUEST_TIMEOUT_MS = 4_000;
const BETTER_BIBTEX_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LIBRARY_PATH = "/api/users/0";
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

async function libraryGet(path: string): Promise<ZoteroResponse> {
  const response = await localRequest(`${LIBRARY_PATH}${path}`);
  const version = Number.parseInt(response.headers["zotero-api-version"] ?? "", 10);
  if (response.status === 200 && version !== ZOTERO_API_VERSION) {
    throw new Error("ZOTERO_INCOMPATIBLE");
  }
  return response;
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

export const localZoteroTransport: ZoteroTransport = {
  connection: "local",
  get: libraryGet,
  attachmentFile: async (attachment) => {
    const response = await libraryGet(`/items/${attachment.key}/file/view/url`);
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
    const response = await localRequest(BETTER_BIBTEX_PATH, {
      body: JSON.stringify({ jsonrpc: "2.0", method: "item.citationkey", params: [itemKeys] }),
      timeoutMs: BETTER_BIBTEX_TIMEOUT_MS,
    });
    return response.status === 200 ? betterBibTexCitationKeys(response.body) : new Map();
  },
};

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
