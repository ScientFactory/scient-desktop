// Polite HTTP for connectors, with no dependencies (Node 20+ fetch).
//
// - One request at a time per host, with a gap between requests (set it below the service's limit).
// - A timeout on every request, and the agent's cancel passed through.
// - GET and HEAD are retried on 429, 502, 503, 504 and network errors, honouring Retry-After,
//   within an overall deadline. Other methods are never retried: they may change data.
// - URLs in messages and logs have secret-looking query values hidden.

import { ToolError } from "./mcp.mjs";

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const SECRET_PARAM =
  /^(api[_-]?key|key|token|access[_-]?token|wstoken|auth|sig|signature|session|sid|password|secret)$/i;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** The URL with secret-looking query values replaced, for messages and logs. */
export function safeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) parsed.searchParams.set(name, "hidden");
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "(a URL)";
  }
}

/** Seconds or an HTTP date, as milliseconds from now; undefined when absent or unreadable. */
function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const anySignal = (signals) => {
  const present = signals.filter(Boolean);
  if (present.length <= 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};

/**
 * Makes a polite fetch.
 *
 * @param {object} [options]
 * @param {string} [options.userAgent] Say honestly who is calling, e.g. "openalex-connector/0.1".
 * @param {number} [options.minGapMs] Gap between requests to one host. 200 ms = at most 5 per second.
 * @param {number} [options.timeoutMs] Per attempt.
 * @param {number} [options.maxRetries] For GET and HEAD.
 * @param {number} [options.deadlineMs] Overall, retries and waits included.
 * @param {Record<string, number>} [options.hostGapMs] Per-host gaps, e.g. {"export.arxiv.org": 3000}.
 */
export function createHttp({
  userAgent,
  minGapMs = 200,
  timeoutMs = 30_000,
  maxRetries = 2,
  deadlineMs = 90_000,
  hostGapMs = {},
} = {}) {
  const queues = new Map(); // host -> promise of the last request's turn
  const nextAt = new Map(); // host -> earliest time for the next request

  /** Waits for this host's turn, so requests to one host go one at a time and spaced. */
  async function turn(host, signal) {
    const previous = queues.get(host) ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => (release = resolve));
    queues.set(
      host,
      previous.then(() => mine),
    );
    await previous;
    const wait = (nextAt.get(host) ?? 0) - Date.now();
    try {
      if (wait > 0) await sleep(wait, signal);
    } catch (error) {
      release();
      throw error;
    }
    return () => {
      nextAt.set(host, Date.now() + (hostGapMs[host] ?? minGapMs));
      release();
    };
  }

  /**
   * Like fetch, with pacing, a timeout and retries. `signal` is the agent's cancel (from the tool
   * handler's context). Network failures become a ToolError the agent can read.
   */
  return async function politeFetch(url, init = {}, { signal } = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    if (userAgent && !headers.has("user-agent")) headers.set("user-agent", userAgent);
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const done = await turn(host, signal);
      let response;
      try {
        response = await fetch(url, {
          ...init,
          method,
          headers,
          signal: anySignal([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        done();
        if (signal?.aborted) throw error;
        const timedOut = error?.name === "TimeoutError";
        const retry = SAFE_METHODS.has(method) && attempt < maxRetries;
        if (retry && Date.now() - started < deadlineMs) {
          await sleep(1000 * 2 ** attempt, signal);
          continue;
        }
        const why = timedOut
          ? `no answer within ${Math.round(timeoutMs / 1000)} s`
          : (error?.cause?.code ?? error?.message ?? "network error");
        throw new ToolError(
          `Could not reach ${host} (${why}) for ${safeUrl(url)}. Try again later.`,
        );
      }
      done();
      if (!RETRY_STATUSES.has(response.status) || !SAFE_METHODS.has(method)) return response;
      const wait = retryAfterMs(response) ?? 1000 * 2 ** attempt + Math.random() * 250;
      if (attempt >= maxRetries || Date.now() - started + wait > deadlineMs) return response;
      await response.body?.cancel().catch(() => {});
      await sleep(wait, signal);
    }
  };
}

/**
 * Reads a JSON response, turning HTTP errors into a ToolError with a short, useful message.
 * `what` names the thing for the message, e.g. "OpenAlex".
 */
export async function readJson(response, what) {
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!response.ok) {
    const wait = retryAfterMs(response);
    const hint =
      response.status === 429
        ? `${what} is limiting requests${wait ? `; wait ${Math.ceil(wait / 1000)} s` : ""} and try again with fewer calls.`
        : response.status === 401 || response.status === 403
          ? `${what} refused the request (${response.status}). The key may be wrong or missing: call scient_connector_setup with replaceKeys.`
          : response.status === 404
            ? `${what} has nothing at that address (404). Check the id.`
            : `${what} answered ${response.status}.`;
    throw new ToolError(`${hint} ${snippet(body)}`.trim());
  }
  if (!/json/i.test(type) && !/^\s*[[{]/.test(body)) {
    throw new ToolError(`${what} sent ${type || "something"} instead of JSON: ${snippet(body)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ToolError(`${what} sent JSON that could not be read: ${snippet(body)}`);
  }
}

/** The start of a body, on one line, for error messages. */
export const snippet = (text, max = 300) => {
  const line = String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};
