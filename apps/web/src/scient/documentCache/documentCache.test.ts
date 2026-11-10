import { describe, expect, it, vi } from "vite-plus/test";

import { createDocumentCache, keptBytes, type DocumentKind } from "./documentCache";

interface Doc {
  readonly name: string;
  readonly size: number;
}

function setup(limits = { count: 2, bytes: 100 }) {
  const cache = createDocumentCache(limits);
  const disposed: string[] = [];
  const idled: string[] = [];
  const kind: DocumentKind<Doc> = {
    dispose: (doc) => disposed.push(doc.name),
    size: (doc) => doc.size,
    idle: (doc) => idled.push(doc.name),
  };
  const opened: string[] = [];
  const open = (name: string, size = 10) =>
    cache.acquire(
      name,
      async () => {
        opened.push(name);
        return { name, size };
      },
      kind,
    );
  return { cache, kind, open, opened, disposed, idled };
}

describe("documentCache", () => {
  it("keeps a document its reader left and gives it back without opening it again", async () => {
    const { cache, open, opened, disposed, idled } = setup();
    const first = open("a");
    const doc = await first.value;
    first.release();
    expect(idled).toEqual(["a"]);
    expect(cache.idleKeys()).toEqual(["a"]);
    const again = open("a");
    expect(await again.value).toBe(doc);
    expect(opened).toEqual(["a"]);
    expect(cache.idleKeys()).toEqual([]);
    expect(disposed).toEqual([]);
  });

  it("gives a second reader of a document in use its own copy, which is not kept", async () => {
    const { open, opened, disposed, cache } = setup();
    const first = open("a");
    await first.value;
    const second = open("a");
    expect(await second.value).not.toBe(await first.value);
    expect(opened).toEqual(["a", "a"]);
    second.release();
    expect(disposed).toEqual(["a"]);
    first.release();
    expect(cache.idleKeys()).toEqual(["a"]);
  });

  it("drops the document left longest ago past the count", async () => {
    const { open, disposed, cache } = setup();
    for (const name of ["a", "b", "c"]) {
      const lease = open(name);
      await lease.value;
      lease.release();
    }
    expect(disposed).toEqual(["a"]);
    expect(cache.idleKeys()).toEqual(["b", "c"]);
    // Reading b again makes it the most recently left.
    const b = open("b");
    await b.value;
    b.release();
    expect(cache.idleKeys()).toEqual(["c", "b"]);
  });

  it("keeps the documents' estimated memory within its budget", async () => {
    const { open, disposed, cache } = setup({ count: 5, bytes: 100 });
    for (const [name, size] of [
      ["a", 40],
      ["b", 40],
      ["c", 40],
    ] as const) {
      const lease = open(name, size);
      await lease.value;
      lease.release();
    }
    expect(disposed).toEqual(["a"]);
    // One document larger than the whole budget is never kept.
    const huge = open("huge", 200);
    await huge.value;
    huge.release();
    expect(disposed).toEqual(["a", "huge"]);
    expect(cache.idleKeys()).toEqual(["b", "c"]);
  });

  it("stops a document still opening when its reader leaves, and disposes it once open", async () => {
    const cache = createDocumentCache({ count: 2, bytes: 100 });
    const dispose = vi.fn();
    const opened = Promise.withResolvers<Doc>();
    let signal: AbortSignal | undefined;
    const lease = cache.acquire(
      "a",
      (abort) => {
        signal = abort;
        return opened.promise;
      },
      { dispose, size: () => 1 },
    );
    lease.release();
    expect(signal?.aborted).toBe(true);
    expect(cache.idleKeys()).toEqual([]);
    opened.resolve({ name: "a", size: 1 });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it("opens a failed document again, and drops a discarded one", async () => {
    const { cache, kind, open, disposed } = setup();
    const failing = cache.acquire("a", async () => Promise.reject(new Error("broken")), kind);
    await expect(failing.value).rejects.toThrow("broken");
    failing.release();
    const retry = open("a");
    await retry.value;
    retry.release({ discard: true });
    expect(disposed).toEqual(["a"]);
    expect(cache.idleKeys()).toEqual([]);
  });

  it("never keeps a document without a key, and releases each lease once", async () => {
    const { cache, kind, disposed } = setup();
    const lease = cache.acquire(null, async () => ({ name: "loose", size: 1 }), kind);
    await lease.value;
    lease.release();
    lease.release();
    expect(disposed).toEqual(["loose"]);
    expect(cache.idleKeys()).toEqual([]);
  });

  it("forgets matching documents and clears the rest, leaving documents in use", async () => {
    const { cache, open, disposed } = setup({ count: 5, bytes: 100 });
    for (const name of ["a/1", "b/1"]) {
      const lease = open(name);
      await lease.value;
      lease.release();
    }
    const inUse = open("c/1");
    await inUse.value;
    cache.forget((key) => key.startsWith("a/"));
    expect(disposed).toEqual(["a/1"]);
    cache.clear();
    expect(disposed).toEqual(["a/1", "b/1"]);
    inUse.release();
    expect(cache.idleKeys()).toEqual(["c/1"]);
  });

  it("lets kept documents hold 64 MB per GB of the computer's memory, from 128 to 512 MB", () => {
    const MB = 1024 * 1024;
    expect(keptBytes(1)).toBe(128 * MB);
    expect(keptBytes(undefined)).toBe(256 * MB);
    expect(keptBytes(8)).toBe(512 * MB);
    expect(keptBytes(32)).toBe(512 * MB);
  });

  it("stops what a failed open started", async () => {
    const cache = createDocumentCache({ count: 2, bytes: 100 });
    let signal: AbortSignal | undefined;
    const lease = cache.acquire(
      "a",
      async (abort) => {
        signal = abort;
        throw new Error("broken");
      },
      { dispose: () => undefined, size: () => 1 },
    );
    await expect(lease.value).rejects.toThrow("broken");
    expect(signal?.aborted).toBe(true);
  });

  it("opens afresh a kept document that broke while no reader showed it", async () => {
    const cache = createDocumentCache({ count: 2, bytes: 100 });
    const disposed: string[] = [];
    let broken = false;
    let opens = 0;
    const kind: DocumentKind<Doc> = {
      dispose: (doc) => disposed.push(doc.name),
      size: () => 1,
      healthy: () => !broken,
    };
    const open = () =>
      cache.acquire(
        "a",
        async () => {
          opens += 1;
          return { name: `a${opens}`, size: 1 };
        },
        kind,
      );
    const first = open();
    await first.value;
    first.release();
    broken = true;
    const second = open();
    expect((await second.value).name).toBe("a2");
    expect(disposed).toEqual(["a1"]);
  });

  it("disposes, once closed, the documents its readers still held", async () => {
    const { cache, open, disposed } = setup();
    const kept = open("a");
    await kept.value;
    kept.release();
    const inUse = open("b");
    await inUse.value;
    cache.close();
    expect(disposed).toEqual(["a"]);
    inUse.release();
    expect(disposed).toEqual(["a", "b"]);
    expect(cache.idleKeys()).toEqual([]);
  });

  it("asks the hidden reader left longest ago to go past the limits", async () => {
    const { cache, open, disposed } = setup({ count: 2, bytes: 100 });
    const evicted: string[] = [];
    const hide = (name: string) => {
      const lease = open(name);
      return lease.value.then(() => {
        expect(
          lease.park(
            () => evicted.push(name),
            () => 20,
          ),
        ).toBe(true);
        return lease;
      });
    };
    const a = await hide("a");
    await hide("b");
    // c, hidden last, is one too many: the hidden reader of a, left first, is asked to go.
    await hide("c");
    expect(evicted).toEqual(["a"]);
    a.release();
    expect(disposed).toEqual(["a"]);
    expect(cache.idleKeys()).toEqual([]);
  });

  // regression: a PDF reader reopens its document once its URL is renewed; for that moment the
  // document counted as left, one too many, and the oldest hidden view was dropped.
  it("lets documents kept without a reader go before a hidden reader", async () => {
    const { cache, open, disposed } = setup({ count: 2, bytes: 100 });
    const evicted: string[] = [];
    for (const name of ["a", "b"]) {
      const lease = open(name);
      await lease.value;
      lease.park(
        () => evicted.push(name),
        () => 20,
      );
    }
    const c = open("c");
    await c.value;
    c.release();
    expect(evicted).toEqual([]);
    expect(disposed).toEqual(["c"]);
    expect(cache.idleKeys()).toEqual([]);
  });

  it("keeps a hidden reader's document at its age when the reader goes", async () => {
    const { cache, open } = setup({ count: 5, bytes: 100 });
    const a = open("a");
    await a.value;
    expect(
      a.park(
        () => undefined,
        () => 0,
      ),
    ).toBe(true);
    const b = open("b");
    await b.value;
    b.release();
    a.release();
    expect(cache.idleKeys()).toEqual(["a", "b"]);
  });

  it("parks only an open document with a key, within the budget with its view", async () => {
    const { cache, kind, open } = setup({ count: 2, bytes: 100 });
    const loose = cache.acquire(null, async () => ({ name: "loose", size: 1 }), kind);
    await loose.value;
    expect(
      loose.park(
        () => undefined,
        () => 0,
      ),
    ).toBe(false);
    const opening = open("opening");
    expect(
      opening.park(
        () => undefined,
        () => 0,
      ),
    ).toBe(false);
    const large = open("large", 60);
    await large.value;
    expect(
      large.park(
        () => undefined,
        () => 50,
      ),
    ).toBe(false);
  });
});
