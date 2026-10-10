import { randomUUID } from "~/lib/utils";
import type { MarkdownPersistenceSnapshot } from "@scientfactory/scient-markdown";

export interface MarkdownDraftCheckpoint {
  readonly token: string;
  readonly baselineSource: string;
  readonly baselineRevision: string;
  readonly draftSource: string;
  readonly publicationSource?: string | null;
  /**
   * Whether a conflict was open when this copy was taken. Absent in copies
   * written before it was recorded; only an explicit `false` counts as evidence.
   */
  readonly conflict?: boolean;
}

/**
 * A copy that provably holds nothing to recover: taken with no conflict open,
 * no unsaved source and no publication other than its baseline. Copies that
 * predate the conflict field never qualify.
 */
export function checkpointHoldsNothing(checkpoint: MarkdownDraftCheckpoint): boolean {
  return (
    checkpoint.conflict === false &&
    checkpoint.draftSource === checkpoint.baselineSource &&
    (checkpoint.publicationSource == null ||
      checkpoint.publicationSource === checkpoint.baselineSource)
  );
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
    // Absent or malformed is unknown, never evidence of a clean copy.
    ...("conflict" in value && typeof value.conflict === "boolean"
      ? { conflict: value.conflict }
      : {}),
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
  private latest: { snapshot: MarkdownPersistenceSnapshot; keep: boolean } | undefined;
  private lastSource: string | undefined;
  private lastBaseline: string | undefined;
  private lastPublication: string | null = null;
  private lastConflict = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  private disabled = false;
  private retired = false;

  constructor(
    private readonly key: string,
    private readonly store: MarkdownDraftCheckpointStore,
    initial?: MarkdownDraftCheckpoint,
  ) {
    this.token = initial?.token;
  }

  /**
   * `pendingOnlyForRename`: the document is pending only because a rename holds
   * it. Such a snapshot has nothing to recover and is never written.
   */
  update(snapshot: MarkdownPersistenceSnapshot, pendingOnlyForRename = false): void {
    if (this.disabled || this.retired) return;
    const keep = snapshot.pending && !pendingOnlyForRename;
    const source = keep ? snapshot.draftSource : undefined;
    const conflict = snapshot.conflict !== null;
    if (
      source === this.lastSource &&
      snapshot.baselineRevision === this.lastBaseline &&
      snapshot.publicationSource === this.lastPublication &&
      conflict === this.lastConflict
    )
      return;
    this.lastPublication = snapshot.publicationSource;
    this.lastSource = source;
    this.lastBaseline = snapshot.baselineRevision;
    this.lastConflict = conflict;
    this.latest = { snapshot, keep };
    if (!keep && this.token === undefined && this.writing === undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.latest = undefined;
      return;
    }
    // Leading deadline, not an endlessly postponed debounce during typing.
    if (this.timer === undefined && this.writing === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 200);
  }

  /**
   * Before an in-place rename: waits for a copy being written, then removes
   * this writer's copy, which must not outlive the old name. True once no copy
   * of this writer remains; false if one with unsaved work is due, or removal
   * failed (the caller then renames the ordinary way).
   */
  async settle(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.latest?.keep) return false;
    this.latest = undefined;
    if (this.token === undefined) return true;
    if (this.disabled) return false;
    try {
      if (await this.store.replace(this.key, this.token, undefined)) {
        this.token = undefined;
        return true;
      }
    } catch (error) {
      console.error("Markdown recovery checkpoint could not be removed before a rename:", error);
    }
    return false;
  }

  /**
   * The document left this path (a rename). Stops further copies, waits for one
   * already being written, then removes only the copy this writer owns.
   */
  async retire(): Promise<void> {
    if (this.retired) return;
    this.retired = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
    while (this.writing !== undefined) await this.writing;
    if (this.disabled || this.token === undefined) return;
    try {
      if (await this.store.replace(this.key, this.token, undefined)) this.token = undefined;
    } catch (error) {
      // The copy stays. If it holds nothing, admission discards it later.
      console.error("Markdown recovery checkpoint could not be removed after a rename:", error);
    }
  }

  private drain(): Promise<void> {
    if (this.writing !== undefined || this.disabled || this.retired || !this.latest)
      return this.writing ?? Promise.resolve();
    const { snapshot, keep } = this.latest;
    this.latest = undefined;
    const next = keep
      ? {
          token: randomUUID(),
          baselineSource: snapshot.baselineSource,
          baselineRevision: snapshot.baselineRevision,
          draftSource: snapshot.draftSource,
          publicationSource: snapshot.publicationSource,
          conflict: snapshot.conflict !== null,
        }
      : undefined;
    const write = (async () => {
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
      }
    })();
    this.writing = write.finally(() => {
      this.writing = undefined;
      if (this.latest && !this.disabled && !this.retired) void this.drain();
    });
    return this.writing;
  }
}
