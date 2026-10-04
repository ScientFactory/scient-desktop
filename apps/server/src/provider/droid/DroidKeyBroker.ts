// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Node request handlers own and clear their transport deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";
import * as NodeZlib from "node:zlib";
import type { CustomModelProtocol } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { AcpRequestError } from "effect-acp/errors";

import type { ResolvedModelConnection } from "../../customModels.ts";

/**
 * The header each Droid BYOK provider sends the configured `apiKey` in, and
 * the one the upstream API expects, and the API paths Droid appends to
 * `baseUrl`. Only those paths are forwarded (to the same path under the real
 * `baseUrl`), so a capability can call the connection's models and nothing
 * else on that account. Verified against Droid 0.228.0 with a local capture.
 */
const PROTOCOL_WIRE: Record<
  CustomModelProtocol,
  { readonly header: "authorization" | "x-api-key"; readonly paths: ReadonlySet<string> }
> = {
  "openai-completions": { header: "authorization", paths: new Set(["/chat/completions"]) },
  "openai-responses": { header: "authorization", paths: new Set(["/responses"]) },
  "anthropic-messages": {
    header: "x-api-key",
    paths: new Set(["/v1/messages", "/v1/messages/count_tokens"]),
  },
};

/** Tool definitions a request may carry, across the three wire formats. */
const TOOL_REQUEST_FIELDS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
] as const;

/**
 * Per-turn request limits for Scient custom models. Droid answers a response
 * that stopped at the output limit with "Continue where you left off." and
 * retries without bound (thousands of requests a minute when every response
 * is truncated). A long answer legitimately needs a few continuations, so five
 * consecutive truncated responses mark a loop. The absolute ceiling is far
 * above a long agentic turn (one request per tool call, including subagents)
 * and exists only to bound a loop the truncation rule cannot see.
 */
const DROID_TURN_REQUEST_LIMITS = {
  consecutiveTruncatedResponses: 5,
  upstreamRequests: 1_000,
} as const;

export interface DroidRequestLimitBreach {
  readonly reason: "truncated-responses" | "upstream-requests";
  readonly message: string;
}

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/**
 * An error body is checked this many times the longest secret's length past
 * the bound, so a key that begins before the bound is seen whole even when
 * it is escaped or encoded several times over.
 */
const ERROR_BODY_SECRET_MARGIN = 16;
const MAX_SCANNED_LINE_BYTES = 8 * 1024 * 1024;
/** Matches Droid's own turn idle watchdog; a streaming model sends far more often. */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;
/**
 * How long establishing the connection (TCP, and TLS for HTTPS) may take. A
 * reachable endpoint is connected in well under a second; this leaves room for
 * a slow network or proxy and stays well inside what a caller waits for an
 * answer (the Test action 45 s, background generation 180 s), so a connection
 * that stalls is reported with its cause. An established connection is not
 * bounded by it: a slow model has the idle bound above.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  // The broker asks for an uncompressed response (see `upstreamHeaders`).
  "accept-encoding",
  "authorization",
  "x-api-key",
  "cookie",
]);

/** Response metadata Droid may use. Never cookies, redirects or encodings of the original body. */
const forwardedResponseHeader = (name: string) =>
  name === "content-type" ||
  name === "cache-control" ||
  name === "retry-after" ||
  name === "request-id" ||
  name === "x-request-id" ||
  name.startsWith("openai-") ||
  name.startsWith("anthropic-") ||
  name.startsWith("x-ratelimit-");

type ResponseFinish = "truncated" | "finished";

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? (value as Record<string, unknown>)[key] : undefined;

/**
 * How one model response ended, across the three wire formats: Chat
 * Completions `finish_reason`, Anthropic `stop_reason` (streamed in
 * `message_delta`), and Responses `status` with `incomplete_details`.
 */
function responseFinish(event: unknown): ResponseFinish | undefined {
  let finish: ResponseFinish | undefined;
  const note = (truncated: boolean) => {
    finish = truncated || finish === "truncated" ? "truncated" : "finished";
  };
  const choices = field(event, "choices");
  if (Array.isArray(choices))
    for (const choice of choices) {
      const reason = field(choice, "finish_reason");
      if (typeof reason === "string") note(reason === "length");
    }
  const stop = field(field(event, "delta"), "stop_reason") ?? field(event, "stop_reason");
  if (typeof stop === "string") note(stop === "max_tokens");
  const response = field(event, "object") === "response" ? event : field(event, "response");
  const status = field(response, "status");
  if (status === "completed") note(false);
  if (status === "incomplete")
    note(field(field(response, "incomplete_details"), "reason") === "max_output_tokens");
  return finish;
}

const FINISH_FIELD = /"(?:finish_reason|stop_reason|status)"\s*:\s*"/;

/** Observes a response body as it streams past, without holding it. */
function makeFinishScanner(contentType: string) {
  const eventStream = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let pending = "";
  let overflow = false;
  let finish: ResponseFinish | undefined;
  const inspect = (text: string) => {
    if (!FINISH_FIELD.test(text)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const next = responseFinish(parsed);
    if (next) finish = finish === "truncated" ? finish : next;
  };
  const inspectLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") inspect(payload);
  };
  return {
    push: (bytes: Uint8Array) => {
      if (overflow) return;
      pending += decoder.decode(bytes, { stream: true });
      if (eventStream) {
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) inspectLine(line.trimEnd());
      }
      if (pending.length > MAX_SCANNED_LINE_BYTES) {
        // A single oversized event (or JSON body) is not inspected.
        pending = "";
        overflow = !eventStream;
      }
    },
    finish: (): ResponseFinish | undefined => {
      pending += decoder.decode();
      if (overflow) return finish;
      if (eventStream) inspectLine(pending.trimEnd());
      else inspect(pending);
      return finish;
    },
  };
}

/** Decodes each run of `%XX` escapes as UTF-8; malformed escapes stay as they are. */
const percentDecode = (text: string) =>
  text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    new TextDecoder().decode(
      Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16)),
    ),
  );

const unicodeDecode = (text: string) =>
  text.replace(/\\u([0-9A-Fa-f]{4})/g, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** Deeper than any real nesting; each pass is linear, an adversarial body needs thousands. */
const MAX_DECODING_PASSES = 8;

/** Decodes until nothing changes; undefined if the text still changes after the last pass. */
const untilStable = (decode: (text: string) => string) => (text: string) => {
  for (let pass = 0; pass < MAX_DECODING_PASSES; pass++) {
    const next = decode(text);
    if (next === text) return text;
    text = next;
  }
  return undefined;
};

const withoutBackslashes = (text: string) => text.replaceAll("\\", "");

/**
 * The spellings under which an error body is checked for a secret, each
 * applied to both. Removing every backslash undoes JSON escaping at any depth;
 * the decoders undo URL encoding and `\uXXXX` escapes, repeatedly. Undefined:
 * the text could not be decoded to a fixed point.
 */
const SECRET_NORMALIZATIONS: ReadonlyArray<(text: string) => string | undefined> = [
  (text) => text,
  withoutBackslashes,
  untilStable(percentDecode),
  untilStable(unicodeDecode),
  (text) => {
    const decoded = untilStable((next) => unicodeDecode(percentDecode(next)))(text);
    return decoded === undefined ? undefined : withoutBackslashes(decoded);
  },
];

/** Where a UTF-8 text cut at `bound` bytes ends without splitting a character. */
function characterBoundary(bytes: Uint8Array, bound: number): number {
  let end = Math.min(bound, bytes.byteLength);
  // A continuation byte (10xxxxxx) past the cut belongs to a character it would split.
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

interface BrokerRoute {
  readonly id: string;
  readonly connectionId: string;
  readonly protocol: CustomModelProtocol;
  readonly models: ReadonlySet<string>;
  readonly upstream: string;
  readonly apiKey: string | undefined;
  readonly capability: string;
  readonly capabilityDigest: Buffer;
}

interface TurnBudget {
  requests: number;
  consecutiveTruncated: number;
  breach: DroidRequestLimitBreach | undefined;
  readonly breached: Deferred.Deferred<DroidRequestLimitBreach>;
  /** The turn's first upstream status Droid answers by retrying. */
  readonly retrying: Deferred.Deferred<number>;
}

const newBudget = (): TurnBudget => ({
  requests: 0,
  consecutiveTruncated: 0,
  breach: undefined,
  breached: Deferred.makeUnsafe<DroidRequestLimitBreach>(),
  retrying: Deferred.makeUnsafe<number>(),
});

/** Keeps one current Scient run budget per thread across native process replacement. */
export const makeDroidRunBudgetStore = () => {
  const threads = new Map<string, { readonly runId: string; readonly budget: TurnBudget }>();
  return {
    forRun: (threadId: string, runId: string) => {
      const current = threads.get(threadId);
      if (current?.runId === runId) return current.budget;
      const budget = newBudget();
      threads.set(threadId, { runId, budget });
      return budget;
    },
  };
};

/**
 * Droid retries these itself, silently: 429 about 6 times over 20 s and 5xx
 * about 21 times over 200 s before the turn fails (verified against Droid
 * 0.229.0 with a stub).
 */
const isRetriedStatus = (status: number) => status === 429 || status >= 500;

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();

/**
 * The certificate authorities the Droid instance's environment trusts beyond
 * the defaults. Droid reads NODE_EXTRA_CA_CERTS (0.213.0 and 0.231.0) and
 * SSL_CERT_FILE (0.213.0) for its own model requests, which the broker makes
 * in its place. A file that cannot be read adds nothing, as in Node, and is
 * named when a certificate then fails (`unreadable`).
 */
function instanceCertificateAuthorities(environment: NodeJS.ProcessEnv | undefined) {
  const extra: Array<string> = [];
  const unreadable: Array<string> = [];
  for (const variable of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    const file = environment?.[variable];
    if (!file) continue;
    try {
      extra.push(NodeFS.readFileSync(file, "utf8"));
    } catch {
      unreadable.push(` The CA file ${file} named by ${variable} could not be read.`);
    }
  }
  return {
    options: extra.length > 0 ? { ca: [...NodeTls.getCACertificates("default"), ...extra] } : {},
    unreadable: unreadable.join(""),
  };
}

/** Why a request got no answer, from the error's code: the cause, in words where it is common. */
const NETWORK_FAILURES: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ENOTFOUND: "host not found",
  EAI_AGAIN: "host not found",
  ETIMEDOUT: "connection timed out",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
};
const isCertificateFailure = (code: unknown): code is string =>
  typeof code === "string" && /CERT|SIGNATURE|TLS|SSL/.test(code);
function networkFailure(cause: unknown): string {
  const code = field(cause, "code");
  if (typeof code !== "string") return "network error";
  if (isCertificateFailure(code)) return `its TLS certificate could not be verified (${code})`;
  return NETWORK_FAILURES[code] ?? code;
}

/**
 * The response body, with a compression undone that the endpoint applied
 * although the broker asked for none. Undefined: an encoding it cannot undo.
 */
function decodedBody(upstream: NodeHttp.IncomingMessage): NodeStream.Readable | undefined {
  const encoding = upstream.headers["content-encoding"]?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return upstream;
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? NodeZlib.createGunzip()
      : encoding === "deflate"
        ? NodeZlib.createInflate()
        : encoding === "br"
          ? NodeZlib.createBrotliDecompress()
          : encoding === "zstd"
            ? NodeZlib.createZstdDecompress()
            : undefined;
  // An upstream error ends the decoder with it, where the relay loop sees it.
  return decoder && NodeStream.pipeline(upstream, decoder, () => undefined);
}

export interface DroidKeyBroker {
  /** Overlay coordinates for a loaded connection: a broker URL and a capability, never its key. */
  readonly route: (
    connectionId: string,
  ) => { readonly baseUrl: string; readonly apiKey: string } | undefined;
  /** Starts a fresh request budget for the next turn. */
  readonly beginTurn: Effect.Effect<void>;
  readonly beginRunBudget: (threadId: string, runId: string) => Effect.Effect<void>;
  /** Completes when the current turn's request budget is exhausted. */
  readonly turnBreached: Effect.Effect<DroidRequestLimitBreach>;
  readonly currentBreach: () => DroidRequestLimitBreach | undefined;
  /** Completes with the current turn's first upstream 429 or 5xx status. */
  readonly turnRetrying: Effect.Effect<number>;
}

/**
 * A loopback proxy that lets one Droid process use Scient's custom models
 * without ever holding their keys. Each connection gets a route and a random
 * capability; the overlay Droid reads carries only those. The broker checks
 * the capability (constant time), asks the owner whether the configuration is
 * still current (so a rotated or removed key is refused even when a request
 * races the retirement), replaces the capability with the real key in the
 * protocol's header, and streams the upstream response back unbuffered.
 * The listener, its routes and all in-flight upstream requests end with the
 * owning runtime scope.
 *
 * This is the only place Droid code unwraps a real key, and it sends it only
 * upstream, so a key can reach Droid only inside an upstream response. A
 * successful one holds a key only if the model already had it from elsewhere,
 * where Droid holds it anyway, so its content is relayed unchanged. An error is
 * where services echo keys: one that holds any configured key or capability
 * is withheld whole (see `errorBody`). Droid's own output is not redacted: the
 * only secret Droid holds is its capability, which works only on loopback,
 * only for its connections and only while its process lives, so seeing it in
 * a transcript or native log grants nothing the agent does not already have.
 */
export const makeDroidKeyBroker = Effect.fn("DroidKeyBroker.make")(function* (input: {
  readonly connections: ReadonlyArray<ResolvedModelConnection>;
  /**
   * Whether this process's configuration is still the committed one, read
   * synchronously in the same step that starts each upstream request: a
   * rotation or removal commits either before it (refused) or after the
   * request started (in flight, like any request already sent).
   */
  readonly isCurrent: () => boolean;
  /** Retires the owning runtime once `isCurrent` failed. */
  readonly retire: Effect.Effect<void>;
  /** Remove tool definitions from every model request, so the model cannot call tools. */
  readonly withoutTools?: boolean;
  /**
   * The Droid instance's environment. Its HTTP_PROXY, HTTPS_PROXY and NO_PROXY
   * (either case) route upstream requests as they routed Droid's own, and its
   * CA files are trusted as Droid trusted them.
   */
  readonly environment?: NodeJS.ProcessEnv;
  readonly runBudgetStore?: ReturnType<typeof makeDroidRunBudgetStore>;
  readonly limits?: {
    readonly consecutiveTruncatedResponses: number;
    readonly upstreamRequests: number;
  };
  readonly upstreamTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}) {
  const limits = input.limits ?? DROID_TURN_REQUEST_LIMITS;
  const upstreamTimeoutMs = input.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const context = yield* Effect.context<never>();
  const routes = new Map<string, BrokerRoute>();
  for (const connection of input.connections) {
    if (connection.credentialError !== undefined) continue;
    const capability = `scient-cap-${NodeCrypto.randomBytes(32).toString("base64url")}`;
    const id = NodeCrypto.randomBytes(12).toString("hex");
    routes.set(id, {
      id,
      connectionId: connection.id,
      protocol: connection.protocol,
      models: new Set(connection.models.map((model) => model.modelId)),
      upstream: connection.baseUrl.replace(/\/+$/, ""),
      apiKey: connection.apiKey ? Redacted.value(connection.apiKey) : undefined,
      capability,
      capabilityDigest: digest(capability),
    });
  }
  // Nothing to broker (no custom model attached, or none with a usable key):
  // this Droid process gets no listener.
  if (routes.size === 0)
    return {
      route: () => undefined,
      beginTurn: Effect.void,
      beginRunBudget: () => Effect.void,
      turnBreached: Effect.never,
      currentBreach: () => undefined,
      turnRetrying: Effect.never,
    } satisfies DroidKeyBroker;
  const proxy = input.environment ? { proxyEnv: input.environment } : {};
  const instanceCa = instanceCertificateAuthorities(input.environment);
  const agents = {
    http: new NodeHttp.Agent({ keepAlive: true, ...proxy }),
    https: new NodeHttps.Agent({
      keepAlive: true,
      ...proxy,
      ...instanceCa.options,
      // Said here, or Node takes it from the server's own NODE_TLS_REJECT_UNAUTHORIZED.
      rejectUnauthorized: true,
    }),
  };
  const secrets = [...routes.values()].flatMap((route) =>
    route.apiKey ? [route.capability, route.apiKey] : [route.capability],
  );
  const normalizedSecrets = SECRET_NORMALIZATIONS.map((normalize) =>
    secrets.flatMap((secret) => normalize(secret) || []),
  );
  /**
   * Whether `text` holds any key or capability, in any spelling an error body
   * uses, or cannot be checked because it does not decode to a fixed point.
   */
  const secretCheck = (text: string): "clean" | "secret" | "unchecked" => {
    let unchecked = false;
    for (const [index, normalize] of SECRET_NORMALIZATIONS.entries()) {
      const normalized = normalize(text);
      if (normalized === undefined) unchecked = true;
      else if (normalizedSecrets[index]!.some((secret) => normalized.includes(secret)))
        return "secret";
    }
    return unchecked ? "unchecked" : "clean";
  };
  const errorBodyWindow =
    MAX_ERROR_BODY_BYTES +
    ERROR_BODY_SECRET_MARGIN * Math.max(0, ...secrets.map((secret) => Buffer.byteLength(secret)));

  const runBudgets = input.runBudgetStore ?? makeDroidRunBudgetStore();
  let budget = newBudget();
  const breach = (current: TurnBudget, next: DroidRequestLimitBreach) => {
    if (current.breach) return;
    current.breach = next;
    Deferred.doneUnsafe(current.breached, Exit.succeed(next));
  };

  let revoked = false;
  const inFlight = new Set<AbortController>();
  let port = 0;

  const reject = (
    response: NodeHttp.ServerResponse,
    status: number,
    message: string,
    options?: { readonly closeConnection?: boolean },
  ) => {
    if (response.headersSent || response.destroyed) return void response.destroy();
    const body = JSON.stringify({ error: { type: "scient_broker", message } });
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      // An unread request body must not keep streaming into this connection.
      ...(options?.closeConnection ? { connection: "close" } : {}),
    });
    response.end(body);
  };

  const authenticate = (route: BrokerRoute, request: NodeHttp.IncomingMessage) => {
    const header = PROTOCOL_WIRE[route.protocol].header;
    const raw = request.headers[header];
    const value = typeof raw === "string" ? raw : "";
    const supplied = header === "authorization" ? value.replace(/^Bearer\s+/i, "") : value;
    return NodeCrypto.timingSafeEqual(digest(supplied), route.capabilityDigest);
  };

  /** The request for one of this connection's models, as it will be sent upstream. */
  const upstreamBody = (route: BrokerRoute, body: Buffer): Uint8Array | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return undefined;
    }
    const model = field(parsed, "model");
    if (typeof model !== "string" || !route.models.has(model)) return undefined;
    if (!input.withoutTools) return new Uint8Array(body);
    const request = parsed as Record<string, unknown>;
    for (const name of TOOL_REQUEST_FIELDS) delete request[name];
    return new TextEncoder().encode(JSON.stringify(request));
  };

  const waitForDrain = (response: NodeHttp.ServerResponse) =>
    new Promise<void>((resolve) => {
      const done = () => {
        response.off("drain", done);
        response.off("close", done);
        resolve();
      };
      response.on("drain", done);
      response.on("close", done);
    });

  const readBody = async (request: NodeHttp.IncomingMessage): Promise<Buffer | undefined> => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) return undefined;
    const chunks: Array<Buffer> = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) return undefined;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  };

  const upstreamHeaders = (
    route: BrokerRoute,
    request: NodeHttp.IncomingMessage,
    body: Uint8Array,
  ): NodeHttp.OutgoingHttpHeaders => {
    const headers: NodeHttp.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP_REQUEST_HEADERS.has(name)) continue;
      if (name.startsWith("proxy-")) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    if (route.apiKey !== undefined) {
      if (PROTOCOL_WIRE[route.protocol].header === "authorization")
        headers.authorization = `Bearer ${route.apiKey}`;
      else headers["x-api-key"] = route.apiKey;
    }
    // Relayed and scanned as sent; an endpoint that compresses anyway is decoded.
    headers["accept-encoding"] = "identity";
    headers["content-length"] = body.byteLength;
    return headers;
  };

  /** Starts the upstream request; resolves with its response head. Redirects are not followed. */
  const sendUpstream = (
    route: BrokerRoute,
    request: NodeHttp.IncomingMessage,
    body: Uint8Array,
    target: string,
    signal: AbortSignal,
  ) =>
    new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
      const url = new URL(route.upstream + target);
      const secure = url.protocol === "https:";
      const upstream = (secure ? NodeHttps : NodeHttp).request(url, {
        method: "POST",
        headers: upstreamHeaders(route, request, body),
        agent: secure ? agents.https : agents.http,
        signal,
      });
      // Bounds only the connecting, from the start: through an HTTPS proxy the
      // request gets its socket only once CONNECT and the tunnelled handshake
      // are done (until then destroying it emits no error, hence the reject).
      // A kept-alive or tunnelled socket arrives established.
      const connecting = setTimeout(() => {
        const timeout = Object.assign(new Error("connect"), { code: "ETIMEDOUT" });
        reject(timeout);
        upstream.destroy(timeout);
      }, connectTimeoutMs);
      const established = () => clearTimeout(connecting);
      upstream.once("close", established);
      upstream.once("socket", (socket) => {
        if (socket.connecting) socket.once(secure ? "secureConnect" : "connect", established);
        else established();
      });
      upstream.once("response", resolve);
      upstream.once("error", reject);
      upstream.end(body);
    });

  /**
   * What Droid receives for an upstream error: the body as sent, cut to
   * `MAX_ERROR_BODY_BYTES` at a character boundary, unless it holds a key or
   * capability in any spelling (checked a margin past the cut, so a key the
   * cut would split is still seen), in which case the whole body is withheld
   * and replaced by a Scient error in the protocol's shape with the same
   * status. Never partially redacted. A short placeholder key that happens to
   * occur also withholds; that loses an error message, never a key.
   *
   * Threat model: this catches an honest service echoing the key by accident,
   * in the spellings services use (raw, JSON-escaped, percent- or
   * \u-encoded). An endpoint that deliberately obfuscates the key, with mixed
   * or nested encodings or by spelling it past the checked window, already
   * holds it (it just received it) and gains nothing by getting it to Droid,
   * so adversarial encodings are out of scope.
   */
  const errorBody = async (
    route: BrokerRoute,
    status: number,
    upstream: NodeHttp.IncomingMessage,
  ): Promise<{ readonly withheld: boolean; readonly body: Uint8Array }> => {
    const withheld = (reason: string) => {
      const message = `The model endpoint returned HTTP ${status}. Scient withheld its response because ${reason}.`;
      const error = { type: "scient_withheld", message };
      return {
        withheld: true,
        body: new TextEncoder().encode(
          JSON.stringify(
            route.protocol === "anthropic-messages" ? { type: "error", error } : { error },
          ),
        ),
      };
    };
    const unchecked = "it could not be checked for your API key";
    const encoding = upstream.headers["content-encoding"]?.trim().toLowerCase();
    // Sent compressed although the broker asked for none.
    if (encoding && encoding !== "identity") return withheld(unchecked);
    const chunks: Array<Buffer> = [];
    let size = 0;
    for await (const chunk of upstream) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).byteLength;
      if (size >= errorBodyWindow) break;
    }
    const bytes = Buffer.concat(chunks, size);
    const check = secretCheck(bytes.toString("utf8"));
    if (check !== "clean")
      return withheld(check === "secret" ? "it contained your API key" : unchecked);
    return {
      withheld: false,
      body: bytes.subarray(0, characterBoundary(bytes, MAX_ERROR_BODY_BYTES)),
    };
  };

  const relay = async (
    route: BrokerRoute,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    turn: TurnBudget,
    body: Uint8Array,
    target: string,
    controller: AbortController,
  ) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    };
    try {
      arm();
      const upstream = await sendUpstream(route, request, body, target, controller.signal);
      const status = upstream.statusCode ?? 502;
      const headers: Record<string, string> = { "cache-control": "no-store" };
      // A gateway can echo the credential in a header, on any status: such a
      // header is dropped, like a header that cannot be checked.
      for (const [name, value] of Object.entries(upstream.headers))
        if (
          typeof value === "string" &&
          forwardedResponseHeader(name) &&
          secretCheck(value) === "clean"
        )
          headers[name] = value;
      if (status < 200 || status >= 300) {
        if (isRetriedStatus(status)) Deferred.doneUnsafe(turn.retrying, Exit.succeed(status));
        const error = await errorBody(route, status, upstream);
        upstream.destroy();
        if (error.withheld) headers["content-type"] = "application/json";
        response.writeHead(status, headers);
        response.end(error.body);
        return;
      }
      // Relayed unchanged: see the note on `makeDroidKeyBroker`.
      const content = decodedBody(upstream);
      if (content === undefined) {
        upstream.destroy();
        return reject(
          response,
          400,
          "The model endpoint compressed its response in a way Scient cannot read.",
        );
      }
      response.writeHead(status, headers);
      const scanner = makeFinishScanner(headers["content-type"] ?? "");
      for await (const chunk of content) {
        arm();
        scanner.push(chunk as Buffer);
        if (!response.write(chunk)) {
          await waitForDrain(response);
          if (response.destroyed) throw new Error("Droid closed the response.");
        }
      }
      response.end();
      const finish = scanner.finish();
      if (finish === "finished") turn.consecutiveTruncated = 0;
      if (finish === "truncated") {
        turn.consecutiveTruncated += 1;
        if (turn.consecutiveTruncated >= limits.consecutiveTruncatedResponses)
          breach(turn, {
            reason: "truncated-responses",
            message: `The model stopped at its output limit ${turn.consecutiveTruncated} times in a row and Droid kept asking it to continue. Scient ended the turn to stop the request loop.`,
          });
      }
    } catch (cause) {
      // The endpoint gave no answer. Droid retries a 5xx for minutes without a
      // word and ends the turn on a 4xx with its message (verified against
      // Droid 0.213.0 and 0.231.0), so the cause is said once, as a 400.
      if (!response.headersSent)
        reject(
          response,
          400,
          `Scient could not connect to ${new URL(route.upstream).host}: ${
            controller.signal.aborted ? "no response in time" : networkFailure(cause)
          }.${isCertificateFailure(field(cause, "code")) ? instanceCa.unreadable : ""}`,
        );
      else response.destroy();
    } finally {
      clearTimeout(timer);
    }
  };

  const handle = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    // Browsers attach Origin to cross-origin requests; a rebound DNS name shows in Host.
    if (
      revoked ||
      request.method !== "POST" ||
      request.headers.origin !== undefined ||
      request.headers.host !== `127.0.0.1:${port}`
    )
      return reject(response, 403, "Request rejected.");
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const [, routeId = "", ...segments] = url.pathname.split("/");
    const path = `/${segments.join("/")}`;
    const route = routes.get(routeId);
    if (!route || !PROTOCOL_WIRE[route.protocol].paths.has(path))
      return reject(response, 404, "Unknown model route.");
    if (!authenticate(route, request)) return reject(response, 401, "Invalid model credential.");
    // From here Droid hanging up, or the runtime closing, cancels the request
    // wherever it is: reading, authorizing or relaying.
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once("close", onClose);
    inFlight.add(controller);
    try {
      const received = await readBody(request);
      if (received === undefined)
        return reject(response, 413, "Request is too large.", { closeConnection: true });
      const body = upstreamBody(route, received);
      if (body === undefined)
        return reject(response, 403, "This model is not configured for this connection.");
      if (controller.signal.aborted) return reject(response, 499, "Request cancelled.");
      // No await from here until the upstream request has started.
      if (revoked || !input.isCurrent()) {
        Effect.runForkWith(context)(input.retire);
        return reject(response, 403, "Model connections changed. Start a new turn.");
      }
      const turn = budget;
      if (!turn.breach && turn.requests >= limits.upstreamRequests)
        breach(turn, {
          reason: "upstream-requests",
          message: `Droid sent ${turn.requests} model requests in one turn. Scient ended the turn at its per-turn request limit.`,
        });
      if (turn.breach) return reject(response, 400, turn.breach.message);
      turn.requests += 1;
      await relay(route, request, response, turn, body, path + url.search, controller);
    } finally {
      response.off("close", onClose);
      inFlight.delete(controller);
    }
  };

  const server = NodeHttp.createServer((request, response) => {
    handle(request, response).catch(() => reject(response, 500, "Request failed."));
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        }),
      catch: () =>
        new AcpRequestError({
          code: -32603,
          errorMessage: "Could not prepare Droid model connections.",
        }),
    }),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            revoked = true;
            for (const controller of inFlight) controller.abort();
            agents.http.destroy();
            agents.https.destroy();
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    return yield* new AcpRequestError({
      code: -32603,
      errorMessage: "Could not prepare Droid model connections.",
    });
  port = address.port;
  const byConnection = new Map([...routes.values()].map((route) => [route.connectionId, route]));

  return {
    route: (connectionId) => {
      const route = byConnection.get(connectionId);
      return route
        ? { baseUrl: `http://127.0.0.1:${port}/${route.id}`, apiKey: route.capability }
        : undefined;
    },
    beginTurn: Effect.sync(() => {
      budget = newBudget();
    }),
    beginRunBudget: (threadId, runId) =>
      Effect.sync(() => {
        budget = runBudgets.forRun(threadId, runId);
      }),
    turnBreached: Effect.suspend(() => Deferred.await(budget.breached)),
    currentBreach: () => budget.breach,
    turnRetrying: Effect.suspend(() => Deferred.await(budget.retrying)),
  } satisfies DroidKeyBroker;
});
