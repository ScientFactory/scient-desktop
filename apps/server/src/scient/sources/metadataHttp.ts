// @effect-diagnostics nodeBuiltinImport:off -- Registry metadata lookups use bounded HTTPS requests.
import * as NodeHttps from "node:https";

import packageJson from "../../../package.json" with { type: "json" };

import { readBoundedNodeResponse, type NodeHttpRequest } from "./nodeHttpResponse.ts";

const METADATA_TIMEOUT_MS = 5_000;
const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_REDIRECTS = 4;

export const METADATA_USER_AGENT = `Scient/${packageJson.version} (https://github.com/ScientFactory/scient-desktop; source metadata resolution)`;

// The only hosts that receive the contact email: their polite pools take it as mailto.
const MAILTO_HOSTS = new Set(["api.crossref.org", "api.openalex.org"]);

let registryContact: string | null = null;

/** Set from the Library settings; null sends no email anywhere. */
export function setRegistryContactEmail(email: string | null): void {
  registryContact = email;
}

/** The user's registry contact email, for adapters that pass it their own way (Unpaywall). */
export function registryContactEmail(): string | null {
  return registryContact;
}

/** Adds the contact email to a registry URL that accepts mailto, when one is set. */
export function withRegistryContact(url: URL): URL {
  if (!registryContact || !MAILTO_HOSTS.has(url.hostname) || url.searchParams.has("mailto")) {
    return url;
  }
  const contacted = new URL(url);
  contacted.searchParams.set("mailto", registryContact);
  return contacted;
}

/** One request hop with the contact added for the hosts that receive it. */
export function contactedRegistryRequest(
  url: URL,
  headers: Readonly<Record<string, string>>,
): { readonly url: URL; readonly headers: Readonly<Record<string, string>> } {
  const target = withRegistryContact(url);
  return { url: target, headers: withContactUserAgent(target, headers) };
}

function withContactUserAgent(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const agent = headers["User-Agent"];
  if (!registryContact || !MAILTO_HOSTS.has(url.hostname) || !agent || agent.includes("mailto:")) {
    return headers;
  }
  const contacted = agent.endsWith(")")
    ? `${agent.slice(0, -1)}; mailto:${registryContact})`
    : `${agent} (mailto:${registryContact})`;
  return { ...headers, "User-Agent": contacted };
}

export interface MetadataResponse {
  readonly status: number;
  /** Empty unless the final status is 2xx. */
  readonly body: string;
  readonly url: URL;
}

/** Larger downloads, such as the citation style catalogue, raise these. */
export interface MetadataRequestLimits {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export type MetadataRequest = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  limits?: MetadataRequestLimits,
) => Promise<MetadataResponse>;

export const makeMetadataRequest =
  (send: NodeHttpRequest = NodeHttps.request): MetadataRequest =>
  (url, headers, limits = {}) =>
    requestFollowing(url, headers, 0, limits, send);

export const requestMetadata: MetadataRequest = makeMetadataRequest();

async function requestFollowing(
  url: URL,
  headers: Readonly<Record<string, string>>,
  redirects: number,
  limits: MetadataRequestLimits,
  send: NodeHttpRequest,
): Promise<MetadataResponse> {
  if (url.protocol !== "https:") {
    return Promise.reject(new Error("Metadata requests must use HTTPS."));
  }
  if (redirects > MAX_METADATA_REDIRECTS) {
    return Promise.reject(new Error("The metadata service redirected too many times."));
  }
  const { promise, resolve, reject } = Promise.withResolvers<MetadataResponse>();
  const hop = contactedRegistryRequest(url, headers);
  const request = send(hop.url, { method: "GET", headers: hop.headers }, (response) => {
    const receive = async (): Promise<MetadataResponse> => {
      const status = response.statusCode ?? 0;
      const body = await readBoundedNodeResponse(response, {
        maxBytes: limits.maxBytes ?? MAX_METADATA_RESPONSE_BYTES,
        tooLargeMessage: "The metadata service returned too much data.",
        discardBody: status < 200 || status >= 300,
      });
      if (status >= 300 && status < 400 && response.headers.location) {
        const next = new URL(response.headers.location, url);
        return requestFollowing(
          next,
          next.hostname === url.hostname ? headers : publicHeaders(headers),
          redirects + 1,
          limits,
          send,
        );
      }
      return { status, body: body.toString("utf8"), url };
    };
    void receive().then(resolve, (error: unknown) => {
      request.destroy();
      reject(error);
    });
  });
  request.setTimeout(limits.timeoutMs ?? METADATA_TIMEOUT_MS, () => {
    request.destroy(new Error("The metadata request timed out."));
  });
  request.on("error", reject);
  request.end();
  return promise;
}

/** A redirect to another host carries no key or token, only what any client sends. */
function publicHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => /^(?:user-agent|accept)$/iu.test(name)),
  );
}

export async function requestMetadataText(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  const response = await requestMetadata(url, headers);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The metadata service returned HTTP ${response.status}.`);
  }
  return response.body;
}

export async function requestMetadataJson(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<unknown> {
  return JSON.parse(await requestMetadataText(url, headers)) as unknown;
}
