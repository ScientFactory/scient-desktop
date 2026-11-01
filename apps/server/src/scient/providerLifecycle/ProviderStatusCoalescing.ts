/**
 * Coalesces provider-status updates into fixed windows, so a stream of
 * runtime-download progress cannot hide the final status from clients.
 *
 * @module ProviderStatusCoalescing
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";

const PROVIDER_STATUS_COALESCE_MAX_CHUNK = 256;
const PROVIDER_STATUS_COALESCE_WINDOW = Duration.millis(200);

/**
 * Trailing debounce can indefinitely postpone status during continuous download progress. Use fixed
 * windows that publish the latest snapshot while collapsing byte-level noise, including final
 * success/failure.
 */
export const coalesceProviderStatusUpdates = <E, R>(
  updates: Stream.Stream<ReadonlyArray<ServerProvider>, E, R>,
): Stream.Stream<ReadonlyArray<ServerProvider>, E, R> =>
  updates.pipe(
    Stream.groupedWithin(PROVIDER_STATUS_COALESCE_MAX_CHUNK, PROVIDER_STATUS_COALESCE_WINDOW),
    Stream.map((batch) => batch[batch.length - 1]!),
  );
