import { openDocumentRecoveryDatabase } from "./markdownDraftCheckpoint";

/** Unconverted editor input uses the document recovery database and its atomic
 * ownership transaction. Blocks are separate so a keystroke writes only the
 * changed block, not a cloned copy of every formula/table in the document.
 */
export interface DocumentInputCheckpoint {
  readonly token: string;
  readonly envelope: string;
  readonly blocks: readonly string[];
  readonly bytes: number;
  readonly pending: boolean;
}
export interface DocumentInputCheckpointUpdate {
  readonly checkpoint: DocumentInputCheckpoint;
  /** Present only when the baseline changed. */
  readonly baseSource?: string;
  readonly changed: ReadonlyMap<string, string>;
}
const OWNERS = "document-input-owners",
  BLOCKS = "document-input-blocks";
const MAX_BYTES = 4 * 1024 * 1024,
  MAX_OWNERS = 32;
const baselineId = "baseline";

function decode(value: unknown): DocumentInputCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("Unconverted writing could not be read.");
  const record = value as Partial<DocumentInputCheckpoint>;
  if (
    typeof record.token !== "string" ||
    !record.token ||
    typeof record.envelope !== "string" ||
    !Array.isArray(record.blocks) ||
    record.blocks.some((id) => typeof id !== "string" || id === baselineId) ||
    typeof record.pending !== "boolean" ||
    new Set(record.blocks).size !== record.blocks.length ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes! < 0 ||
    record.bytes! > MAX_BYTES
  )
    throw new Error("Unconverted writing could not be read; its owner and copy are preserved.");
  return record as DocumentInputCheckpoint;
}

export const indexedDbDocumentInputs = {
  async read(
    key: string,
  ): Promise<{ checkpoint: DocumentInputCheckpoint; snapshot: string } | undefined> {
    const db = await openDocumentRecoveryDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([OWNERS, BLOCKS], "readonly");
      let result: { checkpoint: DocumentInputCheckpoint; snapshot: string } | undefined;
      let error: unknown;
      transaction.addEventListener("complete", () => resolve(result));
      transaction.addEventListener("abort", () =>
        reject(error ?? transaction.error ?? new Error("Document input recovery was interrupted.")),
      );
      transaction.addEventListener("error", () => reject(transaction.error));
      const request = transaction.objectStore(OWNERS).get(key);
      request.addEventListener("success", () => {
        let checkpoint: DocumentInputCheckpoint | undefined;
        try {
          checkpoint = decode(request.result);
        } catch (cause) {
          error = cause;
          transaction.abort();
          return;
        }
        if (!checkpoint) return;
        if (!checkpoint.pending) {
          result = { checkpoint, snapshot: "" };
          return;
        }
        const ids = [baselineId, ...checkpoint.blocks];
        const values: string[] = [];
        let pending = ids.length;
        ids.forEach((id, index) => {
          const part = transaction.objectStore(BLOCKS).get([key, id]);
          part.addEventListener("success", () => {
            if (typeof part.result !== "string") {
              error = new Error(
                "A retained writing block could not be read; its copy is preserved.",
              );
              transaction.abort();
              return;
            }
            values[index] = part.result;
            if (--pending === 0) {
              const content =
                values.length > 1
                  ? `${checkpoint.envelope.slice(0, -1)},"content":[${values.slice(1).join(",")}]}`
                  : checkpoint.envelope;
              result = {
                checkpoint,
                snapshot: `{"baseSource":${JSON.stringify(values[0])},"content":${content}}`,
              };
            }
          });
        });
      });
    });
  },
  async replace(
    key: string,
    expectedToken: string | undefined,
    next?: DocumentInputCheckpointUpdate,
  ): Promise<boolean> {
    if (next) {
      decode(next.checkpoint);
      JSON.parse(next.checkpoint.envelope);
      if (next.checkpoint.bytes > MAX_BYTES)
        throw new Error("Unconverted writing exceeds its recovery storage budget.");
    }
    const db = await openDocumentRecoveryDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([OWNERS, BLOCKS], "readwrite");
      const owners = transaction.objectStore(OWNERS),
        blocks = transaction.objectStore(BLOCKS);
      let accepted = false,
        error: unknown;
      transaction.addEventListener("complete", () => resolve(accepted));
      transaction.addEventListener("abort", () =>
        reject(error ?? transaction.error ?? new Error("Document input recovery was interrupted.")),
      );
      transaction.addEventListener("error", () => reject(transaction.error));
      const request = owners.get(key);
      request.addEventListener("success", () => {
        let before: DocumentInputCheckpoint | undefined;
        try {
          before = decode(request.result);
        } catch (cause) {
          error = cause;
          transaction.abort();
          return;
        }
        if (before?.token !== expectedToken) return;
        const write = () => {
          const retained = new Set(next?.checkpoint.blocks ?? []);
          const previousIds = new Set(before?.blocks ?? []);
          for (const id of before?.blocks ?? []) if (!retained.has(id)) blocks.delete([key, id]);
          if (!next) {
            owners.delete(key);
            blocks.delete([key, baselineId]);
          } else {
            if (!before && next.baseSource === undefined) {
              transaction.abort();
              return;
            }
            for (const id of retained)
              if (!previousIds.has(id) && !next.changed.has(id)) {
                transaction.abort();
                return;
              }
            if (next.baseSource !== undefined) blocks.put(next.baseSource, [key, baselineId]);
            for (const [id, value] of next.changed) {
              if (!retained.has(id) || typeof value !== "string") {
                transaction.abort();
                return;
              }
              blocks.put(value, [key, id]);
            }
            owners.put(next.checkpoint, key);
          }
          accepted = true;
        };
        if (before || !next) {
          write();
          return;
        }
        const count = owners.count();
        count.addEventListener("success", () => {
          if (count.result >= MAX_OWNERS) transaction.abort();
          else write();
        });
      });
    });
  },
};
