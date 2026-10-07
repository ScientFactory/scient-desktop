import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const encoder = new TextEncoder();
const encodeNativeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface NativeEventQueueLimits {
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly globalFactor: number;
}
export interface NativeEventQueueCharge {
  readonly bytes: number;
  readonly items: number;
  readonly release: () => void;
}

/** Count resident receipts; containment must reclaim their memory before admitting more pressure. */
export function makeNativeEventQueueBudget(limits?: NativeEventQueueLimits) {
  const permit = Semaphore.makeUnsafe(1);
  const owners = new Set<{
    bytes: number;
    items: number;
    closed: boolean;
    released: boolean;
    readonly overflow: Effect.Effect<void>;
    readonly reclaim: Effect.Effect<boolean>;
  }>();
  let totalBytes = 0;
  let totalItems = 0;
  const bytesOf = (event: unknown) => {
    if (!limits) return 0;
    try {
      return encoder.encode(encodeNativeJson(event)).byteLength;
    } catch {
      return limits.maxBytes + 1;
    }
  };
  return {
    get usage() {
      return { bytes: totalBytes, items: totalItems };
    },
    open: (overflow: Effect.Effect<void>, reclaim: Effect.Effect<boolean>) => {
      const owner = { bytes: 0, items: 0, closed: false, released: false, overflow, reclaim };
      owners.add(owner);
      const close = Effect.fnUntraced(function* (target: typeof owner) {
        const first = !target.closed;
        target.closed = true;
        // The queue's spill/clear returns its actual charges. Failed reclamation
        // leaves debt visible and retryable instead of selecting a healthy owner.
        yield* target.reclaim;
        if (first && !target.released) yield* target.overflow;
      });
      return {
        get closed() {
          return owner.closed;
        },
        seal: () => {
          owner.closed = true;
        },
        inspect: (event: unknown) =>
          permit.withPermit(
            Effect.gen(function* () {
              if (owner.closed) return { admitted: false };
              if (limits && bytesOf(event) > limits.maxBytes) {
                yield* close(owner);
                return { admitted: false };
              }
              return { admitted: true };
            }),
          ),
        admit: (
          event: unknown,
          control: boolean,
          items = 1,
          retain?: (charge: NativeEventQueueCharge) => Effect.Effect<void>,
        ) =>
          permit.withPermit(
            Effect.gen(function* () {
              const bytes = bytesOf(event);
              if (owner.released || (!control && owner.closed))
                return { admitted: false, charge: undefined };
              if (!control && limits) {
                if (
                  owner.bytes + bytes > limits.maxBytes ||
                  owner.items + items > limits.maxItems
                ) {
                  yield* close(owner);
                  return { admitted: false, charge: undefined };
                }
                const bytePressure = totalBytes + bytes > limits.maxBytes * limits.globalFactor;
                const itemPressure = totalItems + items > limits.maxItems * limits.globalFactor;
                if (bytePressure || itemPressure) {
                  const score = (candidate: typeof owner) =>
                    bytePressure && itemPressure
                      ? Math.max(
                          candidate.bytes / limits.maxBytes,
                          candidate.items / limits.maxItems,
                        )
                      : bytePressure
                        ? candidate.bytes
                        : candidate.items;
                  const largest = [...owners]
                    .filter(
                      (candidate) =>
                        !candidate.released && (candidate.bytes > 0 || candidate.items > 0),
                    )
                    .reduce<typeof owner | undefined>(
                      (current, candidate) =>
                        !current || score(candidate) > score(current) ? candidate : current,
                      undefined,
                    );
                  if (!largest || largest === owner) {
                    yield* close(owner);
                    return { admitted: false, charge: undefined };
                  }
                  yield* close(largest);
                  // A failed spill (or insufficient one-owner relief) must not admit
                  // uncharged excess. Refuse this producer rather than silently grow.
                  if (
                    totalBytes + bytes > limits.maxBytes * limits.globalFactor ||
                    totalItems + items > limits.maxItems * limits.globalFactor
                  ) {
                    yield* close(owner);
                    return { admitted: false, charge: undefined };
                  }
                }
              }
              if (owner.released) return { admitted: false, charge: undefined };
              owner.bytes += bytes;
              owner.items += items;
              totalBytes += bytes;
              totalItems += items;
              let delivered = false;
              const charge: NativeEventQueueCharge = {
                bytes,
                items,
                release: () => {
                  if (delivered || owner.released) return;
                  delivered = true;
                  owner.bytes -= bytes;
                  owner.items -= items;
                  totalBytes -= bytes;
                  totalItems -= items;
                },
              };
              // Publish the receipt under the pressure gate: another owner must
              // not reclaim a charge whose payload has not reached its queue yet.
              if (retain) yield* retain(charge);
              return { admitted: true, charge };
            }).pipe(Effect.uninterruptible),
          ),
        release: () => {
          if (owner.released) return;
          owner.closed = true;
          owner.released = true;
          owners.delete(owner);
          totalBytes -= owner.bytes;
          totalItems -= owner.items;
          owner.bytes = 0;
          owner.items = 0;
        },
      };
    },
  };
}
