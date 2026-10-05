import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const encoder = new TextEncoder();
const encodeNativeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface NativeEventQueueLimits {
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly globalFactor: number;
}

/** Charge buffered native updates and canonical batches until their reader takes them. */
export function makeNativeEventQueueBudget(limits?: NativeEventQueueLimits) {
  const owners = new Set<{
    bytes: number;
    items: number;
    closed: boolean;
    released: boolean;
    readonly overflow: Effect.Effect<void>;
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
    open: (overflow: Effect.Effect<void>) => {
      const owner = { bytes: 0, items: 0, closed: false, released: false, overflow };
      owners.add(owner);
      const close = (target: typeof owner) => {
        target.closed = true;
        return target.overflow;
      };
      return {
        get closed() {
          return owner.closed;
        },
        // Refuse a single oversized update before allocating its projected entities.
        inspect: (event: unknown) => {
          if (owner.closed) return { admitted: false, containment: undefined };
          if (limits && bytesOf(event) > limits.maxBytes)
            return { admitted: false, containment: close(owner) };
          return { admitted: true, containment: undefined };
        },
        admit: (event: unknown, control: boolean, items = 1) => {
          const bytes = bytesOf(event);
          let containment: Effect.Effect<void> | undefined;
          if (!control && owner.closed) return { admitted: false, bytes, items, containment };
          if (!control && limits) {
            if (owner.bytes + bytes > limits.maxBytes || owner.items + items > limits.maxItems)
              return { admitted: false, bytes, items, containment: close(owner) };
            if (
              totalBytes + bytes > limits.maxBytes * limits.globalFactor ||
              totalItems + items > limits.maxItems * limits.globalFactor
            ) {
              const largest = [...owners]
                .filter((candidate) => !candidate.closed)
                .reduce<typeof owner | undefined>(
                  (current, candidate) =>
                    !current || candidate.bytes > current.bytes ? candidate : current,
                  undefined,
                );
              if (!largest || largest === owner)
                return { admitted: false, bytes, items, containment: close(owner) };
              containment = close(largest);
            }
          }
          owner.bytes += bytes;
          owner.items += items;
          totalBytes += bytes;
          totalItems += items;
          return { admitted: true, bytes, items, containment };
        },
        delivered: (bytes: number, items = 1) => {
          if (owner.released) return;
          owner.bytes = Math.max(0, owner.bytes - bytes);
          owner.items = Math.max(0, owner.items - items);
          totalBytes = Math.max(0, totalBytes - bytes);
          totalItems = Math.max(0, totalItems - items);
        },
        // Containment retains queued receipts. Only owner-scope release retires its reader debt.
        release: () => {
          if (owner.released) return;
          owner.closed = true;
          owner.released = true;
          owners.delete(owner);
          totalBytes = Math.max(0, totalBytes - owner.bytes);
          totalItems = Math.max(0, totalItems - owner.items);
          owner.bytes = 0;
          owner.items = 0;
        },
      };
    },
  };
}
