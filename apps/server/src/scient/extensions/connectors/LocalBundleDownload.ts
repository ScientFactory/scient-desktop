// @effect-diagnostics nodeBuiltinImport:off -- A downloaded bundle is hashed and written as it streams.
/**
 * An MCP Bundle an MCP Registry entry lists by address and SHA-256: fetched under the connector
 * egress rules (public https only, every redirect checked) and kept only when its bytes match.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { ExtensionsError, type LocalBundleDownload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type ConnectorFetch,
  isConnectorEgressRejected,
  makeConnectorFetch,
  STRICT_EGRESS_POLICY,
} from "./ConnectorOutbound.ts";

const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

/** Registry bundles: public https addresses only; redirects are re-checked at each hop. */
export const bundleFetch: ConnectorFetch = makeConnectorFetch({
  policy: STRICT_EGRESS_POLICY,
  redirect: "unauthenticated-get",
  timeoutMs: 5 * 60_000,
  maxResponseBytes: MAX_BUNDLE_BYTES,
});

const unreachable = (message: string) => new ExtensionsError({ reason: "unreachable", message });
const invalid = (message: string) => new ExtensionsError({ reason: "invalid-input", message });

/** Why a download failed, in the user's words; never the server's own text. */
const downloadFailure = (error: unknown) => {
  const reason = error instanceof TypeError && error.cause !== undefined ? error.cause : error;
  if (isConnectorEgressRejected(reason))
    return reason.reason === "response-too-large"
      ? invalid("The bundle is larger than 200 MB.")
      : unreachable(`Scient could not download the bundle: ${reason.message}`);
  return reason instanceof Error && reason.name === "TimeoutError"
    ? unreachable("The bundle took too long to download.")
    : unreachable("Scient could not download the bundle.");
};

/** Writes the bundle to `destination` (which must not exist); removes it unless the hash matches. */
export const downloadBundle = Effect.fn("LocalBundleDownload.download")(function* (
  bundle: LocalBundleDownload,
  destination: string,
  fetch: ConnectorFetch,
) {
  const response = yield* Effect.tryPromise({
    try: () => fetch(bundle.url),
    catch: downloadFailure,
  });
  if (response.status !== 200 || response.body === null) {
    yield* Effect.promise(
      () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
    );
    return yield* unreachable(`The bundle's address answered with HTTP ${response.status}.`);
  }
  const body = response.body;
  const hash = NodeCrypto.createHash("sha256");
  const written = yield* Effect.tryPromise({
    try: async () => {
      const file = await NodeFSP.open(destination, "wx", 0o600);
      const reader = body.getReader();
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          hash.update(read.value);
          await file.write(read.value);
        }
      } finally {
        reader.releaseLock();
        await file.close();
      }
    },
    catch: downloadFailure,
  }).pipe(Effect.exit);
  const matches = written._tag === "Success" && hash.digest("hex") === bundle.sha256;
  if (!matches) yield* Effect.promise(() => NodeFSP.rm(destination, { force: true }));
  if (written._tag === "Failure") return yield* written;
  if (!matches)
    return yield* invalid(
      "The downloaded bundle doesn't match the checksum the MCP Registry lists, so Scient didn't add it.",
    );
});
