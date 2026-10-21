/**
 * Icons for Discover entries. Clients never load remote images (desktop CSP,
 * privacy), so the server fetches a pinned https icon through the connector
 * egress policy and returns it only as a `data:` URI. Anything that is not a
 * small PNG, JPEG, WebP or SVG image is dropped and the client draws a letter
 * tile instead.
 */
import { isExtensionIconDataUri, type ExtensionIconDataUri } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  makeConnectorFetch,
  STRICT_EGRESS_POLICY,
  type ConnectorFetch,
} from "../connectors/ConnectorOutbound.ts";

export const MAX_ICON_BYTES = 64 * 1024;
const ICON_TIMEOUT_MS = 10_000;
export const ICON_CACHE_TTL = Duration.hours(24);
export const ICON_FAILURE_TTL = Duration.minutes(10);
export const ICON_CONCURRENCY = 6;

/** Allowed media types and how to recognize their bytes. */
const ICON_SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "image/png": (bytes) =>
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47,
  "image/jpeg": (bytes) =>
    bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/webp": (bytes) =>
    bytes.length > 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP",
  "image/svg+xml": (bytes) => {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString("utf8").trimStart().toLowerCase();
    return (head.startsWith("<svg") || head.startsWith("<?xml")) && head.includes("<svg");
  },
};

/**
 * The signature check for a `Content-Type`, or `undefined` when the type is
 * not allowed. Own keys only: `constructor`, `__proto__`, `toString` and other
 * inherited names are not media types.
 */
const signatureFor = (
  contentType: string | null,
): { readonly mediaType: string; readonly matches: (bytes: Uint8Array) => boolean } | undefined => {
  const mediaType = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return Object.hasOwn(ICON_SIGNATURES, mediaType)
    ? { mediaType, matches: ICON_SIGNATURES[mediaType]! }
    : undefined;
};

/**
 * A `data:` URI for `bytes` when the declared type is allowed, the bytes match
 * it, they fit the size cap, and the result is a valid `ExtensionIconDataUri`;
 * otherwise `undefined`.
 */
export function iconDataUri(
  contentType: string | null,
  bytes: Uint8Array,
): ExtensionIconDataUri | undefined {
  const signature = signatureFor(contentType);
  if (signature === undefined || bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) {
    return undefined;
  }
  if (!signature.matches(bytes)) return undefined;
  const uri = `data:${signature.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  return isExtensionIconDataUri(uri) ? uri : undefined;
}

/** Icon traffic: public https only, unauthenticated GET redirects re-checked, 64 KiB, 10 s. */
export const iconFetch: ConnectorFetch = makeConnectorFetch({
  policy: STRICT_EGRESS_POLICY,
  redirect: "unauthenticated-get",
  timeoutMs: ICON_TIMEOUT_MS,
  maxResponseBytes: MAX_ICON_BYTES,
});

/** Fetch one icon; every failure (network, status, type, size) yields `undefined`. */
export async function fetchIconDataUri(
  fetch: ConnectorFetch,
  url: string,
  signal?: AbortSignal,
): Promise<ExtensionIconDataUri | undefined> {
  try {
    const response = await fetch(url, {
      headers: { accept: Object.keys(ICON_SIGNATURES).join(", ") },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const contentType = response.headers.get("content-type");
    if (signatureFor(contentType) === undefined) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return iconDataUri(contentType, new Uint8Array(await response.arrayBuffer()));
  } catch {
    return undefined;
  }
}

export interface IconStore {
  /**
   * Icons for `urls` that are ready within `budget`; the rest are left out and
   * keep loading. A cached icon is served at once, even past its lifetime
   * while it is being refreshed.
   */
  readonly resolveWithin: (
    urls: ReadonlyArray<string>,
    budget: Duration.Input,
  ) => Effect.Effect<ReadonlyMap<string, ExtensionIconDataUri>>;
  /** Start loading `urls` in the background; never waits. */
  readonly warm: (urls: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Emits once per batch of background loads that made at least one new icon available. */
  readonly changes: Stream.Stream<void>;
}

interface CachedIcon {
  readonly value: ExtensionIconDataUri | undefined;
  readonly expiresAtMs: number;
}

/**
 * Single-flight, bounded icon loading. Loads run in `scope` (the server's), so
 * a caller that stops waiting never cancels or duplicates them.
 */
export const makeIconStore = Effect.fn("DiscoverIcons.makeIconStore")(function* (
  fetchIcon: (url: string, signal: AbortSignal) => Promise<string | undefined>,
  scope: Scope.Scope,
) {
  const cached = new Map<string, CachedIcon>();
  const loading = new Map<string, Deferred.Deferred<void>>();
  const permits = yield* Semaphore.make(ICON_CONCURRENCY);
  const changes = yield* PubSub.unbounded<void>();

  const load = (url: string) =>
    permits
      .withPermits(1)(
        Effect.tryPromise((signal) => fetchIcon(url, signal)).pipe(
          Effect.orElseSucceed(() => undefined),
        ),
      )
      .pipe(
        // Only a valid icon data URI is admitted; anything else counts as a failure.
        Effect.map((fetched) => (isExtensionIconDataUri(fetched) ? fetched : undefined)),
        Effect.flatMap((value) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              const previous = cached.get(url)?.value;
              // A failed refresh keeps serving the icon it already had.
              const kept = value ?? previous;
              cached.set(url, {
                value: kept,
                expiresAtMs:
                  now + Duration.toMillis(value === undefined ? ICON_FAILURE_TTL : ICON_CACHE_TTL),
              });
            }),
          ),
        ),
      );

  /** The pending load of `url`, starting one when it is missing or expired. */
  const ensure = Effect.fn("DiscoverIcons.ensure")(function* (url: string) {
    const now = yield* Clock.currentTimeMillis;
    const entry = cached.get(url);
    if (entry !== undefined && entry.expiresAtMs > now) return undefined;
    const pending = loading.get(url);
    if (pending !== undefined) return pending;
    const done = yield* Deferred.make<void>();
    loading.set(url, done);
    yield* load(url).pipe(
      Effect.ensuring(
        Effect.sync(() => loading.delete(url)).pipe(
          Effect.andThen(Deferred.succeed(done, undefined)),
        ),
      ),
      Effect.forkIn(scope),
    );
    return done;
  });

  const ready = (urls: ReadonlyArray<string>): ReadonlyMap<string, string> =>
    new Map(
      urls.flatMap((url) => {
        const value = cached.get(url)?.value;
        return value === undefined ? [] : [[url, value] as const];
      }),
    );

  /**
   * Once every pending load has settled, announce icons that became available
   * since `served` was handed out.
   */
  const announceAfter = (
    pending: ReadonlyArray<Deferred.Deferred<void>>,
    urls: ReadonlyArray<string>,
    served: ReadonlyMap<string, string>,
  ) =>
    Effect.forEach(pending, Deferred.await, { discard: true }).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          urls.some((url) => {
            const value = cached.get(url)?.value;
            return value !== undefined && value !== served.get(url);
          })
            ? PubSub.publish(changes, undefined)
            : Effect.void,
        ),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const start = (urls: ReadonlyArray<string>) =>
    Effect.forEach(urls, ensure).pipe(
      Effect.map((pending) =>
        pending.filter((entry): entry is Deferred.Deferred<void> => entry !== undefined),
      ),
    );

  const resolveWithin: IconStore["resolveWithin"] = (urls, budget) =>
    Effect.gen(function* () {
      const unique = [...new Set(urls)];
      const pending = yield* start(unique);
      // Wait only for icons with nothing to serve yet, and only within the budget.
      const missing = unique.filter((url) => cached.get(url)?.value === undefined);
      if (pending.length > 0 && missing.length > 0) {
        yield* Effect.forEach(pending, Deferred.await, { discard: true }).pipe(
          Effect.timeoutOption(budget),
        );
      }
      const served = ready(unique);
      if (pending.length > 0) yield* announceAfter(pending, unique, served);
      return served;
    });

  const warm: IconStore["warm"] = (urls) =>
    Effect.gen(function* () {
      const unique = [...new Set(urls)];
      const served = ready(unique);
      const pending = yield* start(unique);
      if (pending.length > 0) yield* announceAfter(pending, unique, served);
    });

  return { resolveWithin, warm, changes: Stream.fromPubSub(changes) } satisfies IconStore;
});
