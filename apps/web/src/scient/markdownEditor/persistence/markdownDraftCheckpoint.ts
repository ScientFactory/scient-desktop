import { randomUUID } from "~/lib/utils";
import type { MarkdownPersistenceSnapshot } from "@scientfactory/scient-markdown";

export interface MarkdownDraftCheckpoint {
  readonly token: string;
  readonly baselineSource: string;
  readonly baselineRevision: string;
  readonly draftSource: string;
  readonly publicationSource?: string | null;
}

export interface MarkdownDraftCheckpointStore {
  read(key: string): Promise<MarkdownDraftCheckpoint | undefined>;
  /** Compare and replace in one storage transaction; never erase another owner's draft. */
  replace(
    key: string,
    expectedToken: string | undefined,
    next: MarkdownDraftCheckpoint | undefined,
  ): Promise<boolean>;
}

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINTS = 32;
let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open("scient-markdown-drafts", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("drafts"));
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      failed = true;
      database = undefined;
      reject(new Error("Markdown recovery storage is blocked."));
    });
    request.addEventListener("success", () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.addEventListener("versionchange", () => {
        db.close();
        database = undefined;
      });
      resolve(db);
    });
  }));
}

function decode(value: unknown): MarkdownDraftCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("baselineSource" in value) ||
    typeof value.baselineSource !== "string" ||
    !("baselineRevision" in value) ||
    typeof value.baselineRevision !== "string" ||
    !("draftSource" in value) ||
    typeof value.draftSource !== "string"
  ) {
    throw new Error("Markdown recovery data could not be read; it has been preserved.");
  }
  return {
    token: value.token,
    baselineSource: value.baselineSource,
    baselineRevision: value.baselineRevision,
    draftSource: value.draftSource,
    publicationSource:
      "publicationSource" in value && typeof value.publicationSource === "string"
        ? value.publicationSource
        : null,
  };
}

export const indexedDbMarkdownDrafts: MarkdownDraftCheckpointStore = {
  async read(key) {
    const db = await openDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    return decode(value);
  },
  async replace(key, expectedToken, next) {
    if (
      next &&
      2 *
        (next.baselineSource.length +
          next.draftSource.length +
          (next.publicationSource?.length ?? 0)) >
        MAX_CHECKPOINT_BYTES
    ) {
      throw new Error("Markdown recovery checkpoint exceeds its storage budget.");
    }
    const db = await openDatabase();
    return new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      const store = transaction.objectStore("drafts");
      let accepted = false;
      transaction.addEventListener("complete", () => resolve(accepted));
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Markdown recovery write was interrupted.")),
      );
      transaction.addEventListener("error", () => reject(transaction.error));
      const request = store.get(key);
      request.addEventListener("success", () => {
        let before: MarkdownDraftCheckpoint | undefined;
        try {
          before = decode(request.result);
        } catch {
          transaction.abort();
          return;
        }
        if (before?.token !== expectedToken) return;
        const write = () => {
          if (next) store.put(next, key);
          else store.delete(key);
          accepted = true;
        };
        if (before || !next) {
          write();
          return;
        }
        const count = store.count();
        count.addEventListener("success", () => {
          if (count.result >= MAX_CHECKPOINTS) transaction.abort();
          else write();
        });
      });
    });
  },
};

/** A coalesced recovery copy, never a second publisher of the Markdown file. */
export class MarkdownDraftCheckpointWriter {
  private token: string | undefined;
  private latest: MarkdownPersistenceSnapshot | undefined;
  private lastSource: string | undefined;
  private lastBaseline: string | undefined;
  private lastPublication: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing = false;
  private disabled = false;

  constructor(
    private readonly key: string,
    private readonly store: MarkdownDraftCheckpointStore,
    initial?: MarkdownDraftCheckpoint,
  ) {
    this.token = initial?.token;
  }

  update(snapshot: MarkdownPersistenceSnapshot): void {
    if (this.disabled) return;
    const source = snapshot.pending ? snapshot.draftSource : undefined;
    if (
      source === this.lastSource &&
      snapshot.baselineRevision === this.lastBaseline &&
      snapshot.publicationSource === this.lastPublication
    )
      return;
    this.lastPublication = snapshot.publicationSource;
    this.lastSource = source;
    this.lastBaseline = snapshot.baselineRevision;
    this.latest = snapshot;
    if (!snapshot.pending && this.token === undefined && !this.writing) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.latest = undefined;
      return;
    }
    // Leading deadline, not an endlessly postponed debounce during typing.
    if (this.timer === undefined && !this.writing)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 200);
  }

  private async drain(): Promise<void> {
    if (this.writing || this.disabled || !this.latest) return;
    this.writing = true;
    const snapshot = this.latest;
    this.latest = undefined;
    const next = snapshot.pending
      ? {
          token: randomUUID(),
          baselineSource: snapshot.baselineSource,
          baselineRevision: snapshot.baselineRevision,
          draftSource: snapshot.draftSource,
          publicationSource: snapshot.publicationSource,
        }
      : undefined;
    try {
      if (this.token !== undefined || next !== undefined) {
        if (!(await this.store.replace(this.key, this.token, next))) {
          this.disabled = true;
          throw new Error(
            "Another editor owns this file's recovery checkpoint; its draft has been preserved.",
          );
        }
        this.token = next?.token;
      }
    } catch (error) {
      // File publication and its departure guard remain authoritative. A failed
      // recovery copy must neither acknowledge a save nor stop normal saving.
      console.error("Markdown recovery checkpoint failed:", error);
    } finally {
      this.writing = false;
      if (this.latest && !this.disabled) void this.drain();
    }
  }
}
