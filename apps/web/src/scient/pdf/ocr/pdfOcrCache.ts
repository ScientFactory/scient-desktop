import { msg } from "gt-react";

import { m } from "~/i18n/messages";

import { createIndexedDbConnection } from "../../storage/indexedDbConnection";
import type { PdfOcrPageText } from "./pdfOcrText";

/**
 * Recognized pages, kept in this browser profile. A page is stored under a hash of the
 * image that was read, so identical pages in an edited copy or another file reuse it; a
 * document page (known bytes, page number and rotation) points at its image so reopening a
 * PDF does not render it again.
 */
export interface PdfOcrCache {
  byImage(imageHash: string): Promise<PdfOcrPageText | null>;
  byPage(pageKey: string): Promise<PdfOcrPageText | null>;
  put(imageHash: string, pageKey: string | null, text: PdfOcrPageText): Promise<void>;
}

const PAGES = "pages";
const ALIASES = "aliases";
const MAX_PAGES = 4_000;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

interface StoredPage {
  readonly text: PdfOcrPageText;
  readonly usedAt: number;
}

interface StoredAlias {
  readonly image: string;
  readonly usedAt: number;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.addEventListener("success", () => resolve(value.result));
    value.addEventListener("error", () => reject(value.error));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function deleteOldest(store: IDBObjectStore, count: number): Promise<void> {
  let left = count;
  const cursorRequest = store.index("usedAt").openKeyCursor();
  await new Promise<void>((resolve, reject) => {
    cursorRequest.addEventListener("error", () => reject(cursorRequest.error));
    cursorRequest.addEventListener("success", () => {
      const cursor = cursorRequest.result;
      if (!cursor || left <= 0) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      left -= 1;
      cursor.continue();
    });
  });
}

export function createIndexedDbPdfOcrCache(recognizer: string): PdfOcrCache {
  const database = createIndexedDbConnection({
    name: "scient-pdf-ocr",
    version: 1,
    // Read when the connection is blocked, so it is in the language of that moment.
    get blockedMessage() {
      return m(msg("Recognized text storage is blocked."));
    },
    upgrade: (db) => {
      for (const name of [PAGES, ALIASES]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name).createIndex("usedAt", "usedAt");
        }
      }
    },
  });
  const key = (value: string) => `${recognizer}\n${value}`;
  const read = (imageKey: string) =>
    database.transaction(PAGES, "readonly", (transaction) =>
      request(transaction.objectStore(PAGES).get(imageKey) as IDBRequest<StoredPage | undefined>),
    );
  return {
    async byImage(imageHash) {
      const stored = await read(key(imageHash)).catch(() => undefined);
      if (stored?.text.recognizer !== recognizer) return null;
      // Recency only orders eviction; a day's precision spares a write per page read.
      if (Date.now() - stored.usedAt > TOUCH_AFTER_MS) {
        void database
          .transaction(PAGES, "readwrite", async (transaction) => {
            const store = transaction.objectStore(PAGES);
            // A writer may have evicted the page since the read.
            if ((await request(store.getKey(key(imageHash)))) !== undefined) {
              store.put({ ...stored, usedAt: Date.now() }, key(imageHash));
            }
            return done(transaction);
          })
          .catch(() => undefined);
      }
      return stored.text;
    },
    async byPage(pageKey) {
      try {
        const alias = await database.transaction(ALIASES, "readonly", (transaction) =>
          request(
            transaction.objectStore(ALIASES).get(key(pageKey)) as IDBRequest<
              StoredAlias | undefined
            >,
          ),
        );
        return alias ? await this.byImage(alias.image) : null;
      } catch {
        return null;
      }
    },
    async put(imageHash, pageKey, text) {
      try {
        await database.transaction([PAGES, ALIASES], "readwrite", async (transaction) => {
          const usedAt = Date.now();
          transaction.objectStore(PAGES).put({ text, usedAt } satisfies StoredPage, key(imageHash));
          if (pageKey !== null) {
            transaction
              .objectStore(ALIASES)
              .put({ image: imageHash, usedAt } satisfies StoredAlias, key(pageKey));
          }
          // Enforce the shared limit in this write, including after an app restart.
          for (const name of [PAGES, ALIASES]) {
            const store = transaction.objectStore(name);
            const count = await request(store.count());
            if (count > MAX_PAGES) await deleteOldest(store, count - MAX_PAGES);
          }
          return done(transaction);
        });
      } catch {
        // Unavailable storage only costs a later recognition.
      }
    },
  };
}

/** For browsers without IndexedDB, and tests. */
export function createMemoryPdfOcrCache(): PdfOcrCache {
  const pages = new Map<string, PdfOcrPageText>();
  const aliases = new Map<string, string>();
  return {
    byImage: async (imageHash) => pages.get(imageHash) ?? null,
    byPage: async (pageKey) => {
      const image = aliases.get(pageKey);
      return image === undefined ? null : (pages.get(image) ?? null);
    },
    put: async (imageHash, pageKey, text) => {
      pages.set(imageHash, text);
      if (pageKey !== null) aliases.set(pageKey, imageHash);
    },
  };
}
