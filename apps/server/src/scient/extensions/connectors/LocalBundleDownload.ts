// @effect-diagnostics nodeBuiltinImport:off -- A downloaded bundle is hashed and written as it streams.
/**
 * An MCP Bundle an MCP Registry entry lists by address and SHA-256: downloaded to a file and kept
 * only when its bytes match the hash, so where it was served from does not matter.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { ExtensionsError, type LocalBundleDownload } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = Duration.minutes(5);

const unreachable = (message: string) => new ExtensionsError({ reason: "unreachable", message });
const invalid = (message: string) => new ExtensionsError({ reason: "invalid-input", message });

/** Writes the bundle to `destination` (which must not exist); removes it unless the hash matches. */
export const downloadBundle = Effect.fn("LocalBundleDownload.download")(
  function* (bundle: LocalBundleDownload, destination: string) {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
    const response = yield* client
      .execute(HttpClientRequest.get(bundle.url))
      .pipe(Effect.mapError(() => unreachable("Scient could not download the bundle.")));
    if (response.status !== 200)
      return yield* unreachable(`The bundle's address answered with HTTP ${response.status}.`);
    const hash = NodeCrypto.createHash("sha256");
    const file = yield* Effect.tryPromise({
      try: () => NodeFSP.open(destination, "wx", 0o600),
      catch: () => unreachable("Scient could not save the bundle."),
    });
    const written = yield* response.stream.pipe(
      Stream.mapError(() => unreachable("The bundle's download stopped.")),
      Stream.runFoldEffect(
        () => 0,
        (size, chunk: Uint8Array) => {
          const total = size + chunk.byteLength;
          if (total > MAX_BUNDLE_BYTES)
            return Effect.fail(invalid("The bundle is larger than 200 MB."));
          hash.update(chunk);
          return Effect.tryPromise({
            try: () => file.write(chunk).then(() => total),
            catch: () => unreachable("Scient could not save the bundle."),
          });
        },
      ),
      Effect.ensuring(Effect.promise(() => file.close())),
      Effect.exit,
    );
    const matches = written._tag === "Success" && hash.digest("hex") === bundle.sha256;
    if (!matches) yield* Effect.promise(() => NodeFSP.rm(destination, { force: true }));
    if (written._tag === "Failure") return yield* written;
    if (!matches)
      return yield* invalid(
        "The downloaded bundle doesn't match the checksum the MCP Registry lists, so Scient didn't add it.",
      );
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: DOWNLOAD_TIMEOUT,
        orElse: () => Effect.fail(unreachable("The bundle took too long to download.")),
      }),
    ),
);
