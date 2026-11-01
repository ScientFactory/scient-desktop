// @effect-diagnostics nodeBuiltinImport:off -- Pin public DNS checks to the actual outbound socket.
import * as NodeDns from "node:dns";
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import type * as Undici from "undici";
import { type ApiKeyAuth, AccountsError } from "@t3tools/contracts";
import { isPublicAddress } from "../../extensions/connectors/ConnectorOutbound.ts";
import {
  credentialSet,
  redactJsonText,
  redactString,
  REDACTED,
} from "../../extensions/connectors/ConnectorRedaction.ts";
import { matchesAccountOrigin } from "../signIn/origin.ts";

const require = NodeModule.createRequire(import.meta.url);
const failure = () =>
  new AccountsError({
    reason: "denied",
    message: "The account request was refused or could not be completed.",
  });
export interface AccountRequestInput {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
}

export function checkAccountRequest(
  url: string,
  sites: ReadonlyArray<string>,
  method: string,
  readOnly: boolean,
) {
  const refuse = (message: string) => new AccountsError({ reason: "denied", message });
  if (!URL.canParse(url)) throw refuse("The request URL is invalid.");
  if (!matchesAccountOrigin(url, sites))
    throw refuse(`This account may only be used on ${sites.join(", ")}.`);
  if (readOnly && !["GET", "HEAD"].includes(method.toUpperCase()))
    throw refuse("This account is read-only: only GET and HEAD requests are allowed.");
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (NodeNet.isIP(host) !== 0 && !isPublicAddress(host))
  )
    throw refuse("Requests to local or private addresses are not allowed.");
  return parsed;
}

const redactBytes = (bytes: Uint8Array, values: ReadonlyArray<string>): Uint8Array => {
  let buffer = Buffer.from(bytes);
  for (const value of values.filter(Boolean).toSorted((a, b) => b.length - a.length)) {
    const needle = Buffer.from(value);
    const chunks: Buffer[] = [];
    let start = 0;
    let index = buffer.indexOf(needle, start);
    while (index !== -1) {
      chunks.push(buffer.subarray(start, index), Buffer.from("[redacted]"));
      start = index + needle.length;
      index = buffer.indexOf(needle, start);
    }
    chunks.push(buffer.subarray(start));
    buffer = Buffer.concat(chunks);
  }
  return buffer;
};

export const publicAccountAddresses = (addresses: ReadonlyArray<{ readonly address: string }>) =>
  addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));

function accountTransport() {
  const { Agent, fetch: nativeFetch } = require("undici") as typeof Undici;
  const dispatcher = new Agent({
    allowH2: false,
    connect: {
      lookup: (hostname, options, callback) => {
        NodeDns.lookup(hostname, { all: true }, (error, addresses) => {
          if (error || !publicAccountAddresses(addresses)) {
            callback(
              Object.assign(new Error("Account request address refused."), {
                code: "ECONNREFUSED",
              }),
              [],
              undefined,
            );
          } else if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        });
      },
    },
  });
  return {
    fetch: (url: string | URL, init?: RequestInit) =>
      nativeFetch(url, {
        ...init,
        headers: new Headers(init?.headers) as unknown as Undici.HeadersInit,
        body: init?.body as Undici.BodyInit,
        dispatcher,
      }) as unknown as Promise<Response>,
    close: () => dispatcher.close(),
  };
}

export async function accountRequest(
  input: AccountRequestInput,
  sites: ReadonlyArray<string>,
  readOnly: boolean,
  auth: ApiKeyAuth,
  token: string,
  signal?: AbortSignal,
  transport = accountTransport(),
) {
  try {
    if (!token) throw failure();
    const method = input.method.toUpperCase();
    let url = checkAccountRequest(input.url, sites, method, readOnly);
    const headers = new Headers(input.headers);
    for (const name of [
      "host",
      "cookie",
      "authorization",
      "proxy-authorization",
      "connection",
      "transfer-encoding",
      "content-length",
    ])
      headers.delete(name);
    const sensitive = [
      token,
      encodeURIComponent(token),
      Buffer.from(token).toString("base64"),
      Buffer.from(token).toString("base64url"),
    ];
    switch (auth.type) {
      case "bearer":
        headers.set("authorization", `Bearer ${token}`);
        break;
      case "header":
        if (
          /^(host|connection|content-length|transfer-encoding|proxy-authorization)$/i.test(
            auth.name,
          )
        )
          throw failure();
        headers.set(auth.name, token);
        break;
      case "basic": {
        const encoded = Buffer.from(`${auth.username}:${token}`).toString("base64");
        sensitive.push(encoded);
        headers.set("authorization", `Basic ${encoded}`);
        break;
      }
      case "query":
        url.searchParams.set(auth.name, token);
        sensitive.push(encodeURIComponent(token));
        break;
    }
    const originalOrigin = url.origin;
    let crossedOrigin = false;
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    for (let hop = 0; hop <= 5; hop++) {
      checkAccountRequest(url.href, sites, method, readOnly);
      const response = await transport.fetch(url, {
        method,
        headers,
        ...(input.body === undefined ? {} : { body: input.body }),
        redirect: "manual",
        signal: abort,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop === 5 || !["GET", "HEAD"].includes(method) || input.body !== undefined)
          throw failure();
        const next = checkAccountRequest(new URL(location, url).href, sites, method, readOnly);
        if (next.origin !== url.origin) {
          crossedOrigin = true;
          for (const name of Array.from(headers.keys()))
            if (!["accept", "accept-language", "user-agent"].includes(name)) headers.delete(name);
          for (const [name, value] of Array.from(next.searchParams.entries()))
            if (
              sensitive.some((secret) => value.includes(secret)) ||
              (auth.type === "query" && name === auth.name)
            )
              next.searchParams.delete(name);
        }
        if (crossedOrigin) {
          let decoded = next.href;
          for (let i = 0; i < 3; i++) {
            if (sensitive.some((secret) => decoded.includes(secret))) throw failure();
            try {
              decoded = decodeURIComponent(decoded);
            } catch {
              break;
            }
          }
        } else if (auth.type === "query" && next.origin === originalOrigin)
          next.searchParams.set(auth.name, token);
        url = next;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 32 * 1024 * 1024) throw failure();
          chunks.push(chunk);
        }
      let bytes = redactBytes(Buffer.concat(chunks), sensitive);
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const text = /^(text\/|application\/(json|xml|.*\+json|.*\+xml)(;|$))/i.test(contentType);
      const credentials = credentialSet(sensitive);
      if (/^application\/(json|.*\+json)(;|$)/i.test(contentType)) {
        const json = redactJsonText(Buffer.concat(chunks).toString("utf8"), credentials);
        bytes = Buffer.from(json?.replaceAll(REDACTED, "[redacted]") ?? '"[redacted]"');
      } else if (text) {
        const decoded = new TextDecoder().decode(bytes);
        if (redactString(decoded, credentials) !== decoded) bytes = Buffer.from("[redacted]");
      }
      return { status: response.status, bytes, text };
    }
    throw failure();
  } catch {
    throw failure();
  } finally {
    await transport.close().catch(() => undefined);
  }
}
