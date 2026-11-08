/**
 * Opened documents (a parsed PDF, a laid-out Word file) cost seconds to build and little to keep,
 * while their drawn pages cost much to keep and little to redraw. A reader leases the document it
 * shows; leaving it keeps the document for a while, so coming back skips opening it again. The
 * reader still drops its drawn pages.
 */

export interface DocumentLease<T> {
  readonly value: Promise<T>;
  /** The document was kept from an earlier reader, already open. */
  readonly kept: boolean;
  /** Ends this reader's use. `discard` drops the document instead of keeping it (a failed one). */
  readonly release: (options?: { readonly discard?: boolean }) => void;
}

export interface DocumentKind<T> {
  /** Releases everything the document holds. */
  readonly dispose: (value: T) => void;
  /** About how much memory the document holds while kept, in bytes. */
  readonly size: (value: T) => number;
  /** Lets the document shed what it can rebuild cheaply while no reader shows it. */
  readonly idle?: (value: T) => void;
  /** False for a kept document that broke while no reader showed it: it is opened afresh. */
  readonly healthy?: (value: T) => boolean;
}

interface Entry {
  readonly value: Promise<unknown>;
  readonly abort: AbortController;
  readonly kind: DocumentKind<unknown>;
  settled: { readonly value: unknown } | null;
  leased: boolean;
  gone: boolean;
}

export interface DocumentCacheLimits {
  /** Documents kept with no reader. */
  readonly count: number;
  /** Their estimated memory, in bytes. A larger document is never kept. */
  readonly bytes: number;
}

export function createDocumentCache(limits: DocumentCacheLimits) {
  // Idle entries in the order they were left, oldest first, after any in use.
  const entries = new Map<string, Entry>();
  let closed = false;

  const drop = (key: string | null, entry: Entry) => {
    if (entry.gone) return;
    entry.gone = true;
    if (key !== null && entries.get(key) === entry) entries.delete(key);
    if (entry.settled) entry.kind.dispose(entry.settled.value);
    else {
      entry.abort.abort();
      void entry.value.then(entry.kind.dispose, () => undefined);
    }
  };

  const trim = () => {
    let count = 0;
    let bytes = 0;
    const idle = [...entries].filter(([, entry]) => !entry.leased);
    for (const [, entry] of idle) {
      count += 1;
      bytes += entry.kind.size(entry.settled!.value);
    }
    for (const [key, entry] of idle) {
      if (count <= limits.count && bytes <= limits.bytes) break;
      count -= 1;
      bytes -= entry.kind.size(entry.settled!.value);
      drop(key, entry);
    }
  };

  const open = <T>(
    key: string | null,
    start: (signal: AbortSignal) => Promise<T>,
    kind: DocumentKind<T>,
  ): DocumentLease<T> => {
    const abort = new AbortController();
    const entry: Entry = {
      value: start(abort.signal),
      abort,
      kind: kind as DocumentKind<unknown>,
      settled: null,
      leased: true,
      gone: false,
    };
    entry.value.then(
      (value) => {
        entry.settled = { value };
      },
      () => {
        // A failed open is never kept, and what it started is stopped.
        if (key !== null && entries.get(key) === entry) entries.delete(key);
        entry.gone = true;
        entry.abort.abort();
      },
    );
    if (key !== null) entries.set(key, entry);
    return lease(key, entry, false);
  };

  const lease = <T>(key: string | null, entry: Entry, kept: boolean): DocumentLease<T> => {
    let released = false;
    return {
      value: entry.value as Promise<T>,
      kept,
      release: (options) => {
        if (released) return;
        released = true;
        entry.leased = false;
        // Unkept: closed cache, no key, discarded, still opening, or larger than all kept may be.
        if (
          closed ||
          key === null ||
          options?.discard ||
          !entry.settled ||
          entry.kind.size(entry.settled.value) > limits.bytes
        ) {
          drop(key, entry);
          return;
        }
        if (entry.gone) return;
        entries.delete(key);
        entries.set(key, entry);
        entry.kind.idle?.(entry.settled.value);
        trim();
      },
    };
  };

  return {
    /**
     * Leases the document at `key`, opening it with `start` unless it is kept. A document has one
     * reader at a time: a second reader of the same key opens its own copy, which is not kept
     * (a PDF's form values, for one, belong to the reader typing them). A null key is never kept.
     */
    acquire<T>(
      key: string | null,
      start: (signal: AbortSignal) => Promise<T>,
      kind: DocumentKind<T>,
    ): DocumentLease<T> {
      let kept = key === null ? undefined : entries.get(key);
      if (
        kept &&
        !kept.leased &&
        kept.settled &&
        kept.kind.healthy?.(kept.settled.value) === false
      ) {
        drop(key, kept);
        kept = undefined;
      }
      if (kept && !kept.leased && kept.settled) {
        kept.leased = true;
        trim();
        return lease(key, kept, true);
      }
      // Kept documents may have grown since they were left (Word lays out in the background).
      trim();
      return open(kept ? null : key, start, kind);
    },
    /** Drops every kept document whose key matches, as when its file is gone. */
    forget(matches: (key: string) => boolean) {
      for (const [key, entry] of entries) if (!entry.leased && matches(key)) drop(key, entry);
    },
    /** Drops every kept document; documents in use stay with their readers. */
    clear() {
      for (const [key, entry] of entries) if (!entry.leased) drop(key, entry);
    },
    /** Ends the cache: kept documents go now, documents in use when their readers leave. */
    close() {
      closed = true;
      for (const [key, entry] of entries) if (!entry.leased) drop(key, entry);
    },
    /** The keys kept with no reader, oldest first. For tests and measurement. */
    idleKeys: () => [...entries].filter(([, entry]) => !entry.leased).map(([key]) => key),
  };
}

export type DocumentCache = ReturnType<typeof createDocumentCache>;

/**
 * The window's cache: two documents with no reader, within 64 MB per GB of the computer's memory
 * (128 to 512 MB), as each kind estimates what it holds.
 */
export const documentCache = createDocumentCache({
  count: 2,
  bytes: keptBytes((globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory),
});

/** The memory documents with no reader may hold, from the computer's memory in GB. */
export function keptBytes(deviceMemory: number | undefined) {
  return Math.min(8, Math.max(2, deviceMemory ?? 4)) * 64 * 1024 * 1024;
}

// A replaced module's cache must not take back documents its readers still hold.
if (import.meta.hot) import.meta.hot.dispose(() => documentCache.close());
