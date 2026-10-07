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
 * Bound provider-status traffic without waiting for the entire stream to go
 * quiet. Runtime downloads can publish progress continuously, so a trailing
 * debounce can indefinitely hide the final succeeded/failed snapshot from
 * connected clients. Fixed windows preserve the latest snapshot at least once
 * per window while still collapsing noisy byte-level progress updates.
 */
export const coalesceProviderStatusUpdates = <E, R>(
  updates: Stream.Stream<ReadonlyArray<ServerProvider>, E, R>,
): Stream.Stream<ReadonlyArray<ServerProvider>, E, R> =>
  updates.pipe(
    Stream.groupedWithin(PROVIDER_STATUS_COALESCE_MAX_CHUNK, PROVIDER_STATUS_COALESCE_WINDOW),
    Stream.map((batch) => batch[batch.length - 1]!),
  );
