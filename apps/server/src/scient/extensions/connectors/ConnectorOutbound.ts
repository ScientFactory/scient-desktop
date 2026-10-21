// @effect-diagnostics nodeBuiltinImport:off -- Connector egress controls DNS resolution and sockets.
/**
 * The one egress policy for every connector request (probe, OAuth discovery,
 * token, registration, revocation, test and proxy). See
 * docs/internals/scient-extensions.md "Outbound safety".
 *
 * - `https` only. The single exception is the exact loopback origin the user
 *   typed as a connector address; it never extends to any other origin,
 *   including metadata, authorization-server or redirect URLs that origin names.
 * - Every other host must resolve to public addresses. The check runs inside
 *   the socket's own DNS lookup, so the address that is checked is the
 *   address that is connected to (no DNS rebinding window).
 * - Only unauthenticated GET/HEAD requests (OAuth metadata discovery) follow
 *   redirects, each hop re-checked. Credentialed and body-carrying requests
 *   (probe, token, registration, revocation, proxied MCP) never do, so no
 *   credential or token-request body can be replayed to another origin.
 * - Responses are bounded in size and time.
 */
import * as NodeDns from "node:dns";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import type * as Undici from "undici";

export const CONNECTOR_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const CONNECTOR_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const CONNECTOR_PROXY_TIMEOUT_MS = 5 * 60_000;
/** Probe, discovery, token and revocation requests. */
export const CONNECTOR_CONTROL_TIMEOUT_MS = 30_000;
export const CONNECTOR_CONTROL_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Request headers a redirect may carry: nothing that identifies or authenticates the caller. */
const REDIRECTABLE_HEADERS: Readonly<Record<string, true>> = {
  accept: true,
  "accept-language": true,
  "mcp-protocol-version": true,
  "user-agent": true,
};

export type ConnectorFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectorEgressPolicy {
  /**
   * The loopback origin the user typed as this connector's address, if any.
   * Plain http and loopback addresses are allowed for exactly this origin.
   */
  readonly loopbackOrigin: string | undefined;
}

export const STRICT_EGRESS_POLICY: ConnectorEgressPolicy = { loopbackOrigin: undefined };

export class ConnectorEgressRejected extends Error {
  override readonly name = "ConnectorEgressRejected";
  readonly reason: "blocked-url" | "blocked-address" | "redirect" | "response-too-large";
  constructor(reason: ConnectorEgressRejected["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

// undici stays external to the CLI bundle; only `require` loads it from disk
// inside a single executable (see outboundHttp.ts).
const requireUndici = NodeModule.createRequire(import.meta.url);
let undiciModule: typeof Undici | undefined;
const undici = (): typeof Undici => (undiciModule ??= requireUndici("undici") as typeof Undici);

/** IPv4 ranges that are not globally routable unicast (RFC 6890 and successors). */
const NON_PUBLIC_IPV4 = (() => {
  const list = new NodeNet.BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  return list;
})();

const isPublicIpv4 = (address: string) =>
  NodeNet.isIPv4(address) && !NON_PUBLIC_IPV4.check(address, "ipv4");

/** Eight 16-bit groups of a valid IPv6 address (zone id and embedded IPv4 handled). */
const ipv6Groups = (address: string): ReadonlyArray<number> => {
  let text = address.toLowerCase().split("%")[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => "0"),
          ...tailGroups,
        ];
  return groups.map((group) => Number.parseInt(group, 16));
};

const ipv4FromGroups = (high: number, low: number) =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/**
 * Allow-list classification: only global unicast (`2000::/3`) outside the
 * special-purpose blocks is public. IPv4-mapped addresses are judged by their
 * IPv4 address, 6to4 by its embedded IPv4 address; NAT64, IPv4-compatible,
 * ULA, link- and site-local, Teredo, documentation and benchmarking ranges are
 * not public.
 */
const isPublicIpv6 = (address: string): boolean => {
  const g = ipv6Groups(address);
  if (g.length !== 8 || g.some((group) => Number.isNaN(group))) return false;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPublicIpv4(ipv4FromGroups(g[6]!, g[7]!));
  }
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // 2001::/23 IETF protocol assignments (Teredo 2001::/32, benchmarking, ORCHID, …).
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false;
  if (g[0] === 0x2002) return isPublicIpv4(ipv4FromGroups(g[1]!, g[2]!));
  return true;
};

export const isPublicAddress = (address: string): boolean => {
  switch (NodeNet.isIP(address)) {
    case 4:
      return isPublicIpv4(address);
    case 6:
      return isPublicIpv6(address);
    default:
      return false;
  }
};

const LOOPBACK = (() => {
  const list = new NodeNet.BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");
  return list;
})();

const isLoopbackAddress = (address: string): boolean => {
  const family = NodeNet.isIP(address);
  if (family === 4) return LOOPBACK.check(address, "ipv4");
  if (family !== 6) return false;
  const g = ipv6Groups(address);
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) {
    return LOOPBACK.check(ipv4FromGroups(g[6]!, g[7]!), "ipv4");
  }
  return LOOPBACK.check(address, "ipv6");
};

const bareHostname = (hostname: string) =>
  (hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  ).toLowerCase();

const isLoopbackHostname = (hostname: string): boolean => {
  const host = bareHostname(hostname);
  return host === "localhost" || isLoopbackAddress(host);
};

/**
 * The policy for a connector address. Only a URL the user typed whose own host
 * is loopback earns the loopback exception, and only for that exact origin.
 */
export const egressPolicyFor = (
  url: string,
  source: { readonly type: string },
): ConnectorEgressPolicy => {
  if (source.type !== "url" || !URL.canParse(url)) return STRICT_EGRESS_POLICY;
  const parsed = new URL(url);
  return isLoopbackHostname(parsed.hostname)
    ? { loopbackOrigin: parsed.origin }
    : STRICT_EGRESS_POLICY;
};

const blockedAddress = () =>
  new ConnectorEgressRejected(
    "blocked-address",
    "Connectors cannot reach private, link-local or loopback addresses.",
  );

/** Validates a connector-reachable URL. Returns the parsed URL without its fragment. */
export const checkConnectorUrl = (
  raw: string | URL,
  policy: ConnectorEgressPolicy,
): URL | ConnectorEgressRejected => {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return new ConnectorEgressRejected("blocked-url", "The address is not a valid URL.");
  }
  if (url.username !== "" || url.password !== "") {
    return new ConnectorEgressRejected(
      "blocked-url",
      "Connector addresses cannot contain a user name or password.",
    );
  }
  const typedLoopback = policy.loopbackOrigin !== undefined && url.origin === policy.loopbackOrigin;
  if (url.protocol === "http:") {
    if (!typedLoopback) {
      return new ConnectorEgressRejected(
        "blocked-url",
        "Connectors must use https. Plain http is allowed only for the local server address you typed.",
      );
    }
  } else if (url.protocol !== "https:") {
    return new ConnectorEgressRejected("blocked-url", "Connectors must use https.");
  }
  const host = bareHostname(url.hostname);
  if (!typedLoopback) {
    if (isLoopbackHostname(host)) return blockedAddress();
    if (NodeNet.isIP(host) !== 0 && !isPublicAddress(host)) return blockedAddress();
  }
  url.hash = "";
  return url;
};

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | ReadonlyArray<NodeDns.LookupAddress>,
  family?: number,
) => void;

/**
 * Resolves like `dns.lookup`, then refuses the connection when any resolved
 * address is not public. Loopback is tolerated only for the typed loopback
 * host; its port is enforced by `checkConnectorUrl` before every request.
 */
const makeGuardedLookup =
  (policy: ConnectorEgressPolicy) =>
  (hostname: string, options: NodeDns.LookupOptions, callback: LookupCallback): void => {
    const typedHost =
      policy.loopbackOrigin !== undefined &&
      bareHostname(new URL(policy.loopbackOrigin).hostname) === bareHostname(hostname);
    NodeDns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      const allowed = (address: string) =>
        isPublicAddress(address) || (typedHost && isLoopbackAddress(address));
      if (addresses.length === 0 || !addresses.every((entry) => allowed(entry.address))) {
        const blocked: NodeJS.ErrnoException = new ConnectorEgressRejected(
          "blocked-address",
          `Connectors cannot reach ${hostname}: it resolves to a private, link-local or loopback address.`,
        );
        blocked.code = "ECONNREFUSED";
        callback(blocked, []);
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses;
      callback(null, first!.address, first!.family);
    });
  };

const agents = new Map<string, Undici.Agent>();
const agentFor = (policy: ConnectorEgressPolicy): Undici.Agent => {
  const key = policy.loopbackOrigin ?? "";
  const existing = agents.get(key);
  if (existing) return existing;
  const agent = new (undici().Agent)({
    allowH2: false,
    connect: { lookup: makeGuardedLookup(policy) as never },
  });
  agents.set(key, agent);
  return agent;
};

const NULL_BODY_STATUSES: Readonly<Record<number, true>> = {
  101: true,
  204: true,
  205: true,
  304: true,
};

const limitBody = (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> => {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(
            new ConnectorEgressRejected(
              "response-too-large",
              "The connector response exceeded the size limit.",
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
};

export interface ConnectorFetchOptions {
  readonly policy: ConnectorEgressPolicy;
  /**
   * `error`: every redirect is refused (proxied MCP). `unauthenticated-get`:
   * only GET/HEAD requests without a body or identifying headers follow
   * redirects, each hop re-checked; everything else is refused.
   */
  readonly redirect: "unauthenticated-get" | "error";
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

const redirectRefused = () =>
  new ConnectorEgressRejected(
    "redirect",
    "The connector answered with a redirect, which Scient does not follow for this request.",
  );

/** A WHATWG fetch bound to the connector egress policy. */
export const makeConnectorFetch =
  (options: ConnectorFetchOptions): ConnectorFetch =>
  async (input, init) => {
    let target = checkConnectorUrl(input, options.policy);
    if (target instanceof ConnectorEgressRejected) throw target;
    const signals = [AbortSignal.timeout(options.timeoutMs)];
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body;
    let redirectable =
      options.redirect === "unauthenticated-get" &&
      (method === "GET" || method === "HEAD") &&
      (body === undefined || body === null);
    headers.forEach((_value, name) => {
      if (REDIRECTABLE_HEADERS[name] !== true) redirectable = false;
    });
    for (let hop = 0; ; hop += 1) {
      const response = await undici().fetch(target, {
        method,
        headers: headers as unknown as Undici.HeadersInit,
        ...(body === undefined || body === null ? {} : { body: body as Undici.BodyInit }),
        redirect: "manual",
        signal,
        dispatcher: agentFor(options.policy),
      });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!redirectable || location === null || hop >= MAX_REDIRECTS) throw redirectRefused();
        const next = checkConnectorUrl(new URL(location, target), options.policy);
        if (next instanceof ConnectorEgressRejected) throw next;
        target = next;
        continue;
      }
      const responseHeaders = new Headers();
      response.headers.forEach((value, name) => responseHeaders.append(name, value));
      const status = response.status < 200 ? 502 : response.status;
      if (NULL_BODY_STATUSES[status] === true || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        return new Response(null, {
          status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      }
      return new Response(
        limitBody(response.body as unknown as ReadableStream<Uint8Array>, options.maxResponseBytes),
        { status, statusText: response.statusText, headers: responseHeaders },
      );
    }
  };

/** Probe, OAuth discovery, token, registration and revocation traffic. */
export const controlFetch = (
  policy: ConnectorEgressPolicy,
  signal?: AbortSignal,
): ConnectorFetch => {
  const fetch = makeConnectorFetch({
    policy,
    redirect: "unauthenticated-get",
    timeoutMs: CONNECTOR_CONTROL_TIMEOUT_MS,
    maxResponseBytes: CONNECTOR_CONTROL_MAX_RESPONSE_BYTES,
  });
  return signal === undefined ? fetch : withSignal(fetch, signal);
};

export const proxyFetch = (policy: ConnectorEgressPolicy): ConnectorFetch =>
  makeConnectorFetch({
    policy,
    redirect: "error",
    timeoutMs: CONNECTOR_PROXY_TIMEOUT_MS,
    maxResponseBytes: CONNECTOR_MAX_RESPONSE_BYTES,
  });

/** Every request through `fetch` is also aborted by `signal` (connector removal). */
const withSignal =
  (fetch: ConnectorFetch, signal: AbortSignal): ConnectorFetch =>
  (url, init) =>
    fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });

/** User-facing description of an egress failure; never includes upstream content. */
export const describeEgressFailure = (error: unknown): string => {
  // undici reports a refused lookup as `TypeError: fetch failed` with the policy error as cause.
  const reason = error instanceof TypeError && error.cause !== undefined ? error.cause : error;
  if (reason instanceof ConnectorEgressRejected) return reason.message;
  return reason instanceof Error && reason.name === "TimeoutError"
    ? "The connector did not answer in time."
    : "The connector could not be reached.";
};
